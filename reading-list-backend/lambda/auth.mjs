// Passcodes, session tokens, and sign-in limiting.

import { scrypt as scryptCb, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { K, get, put, del, update, conditionFailures } from './db.mjs';
import { CONFIG, clock, nameKey, ipKey, HttpError } from './util.mjs';

const scrypt = promisify(scryptCb);
const SCRYPT = { N: 16384, r: 8, p: 1 };
export const PASS_ALGO = 'scrypt:16384:8:1';

// ---------------------------------------------------------------- passcodes
export async function hashPasscode(passcode, saltB64) {
  const salt = saltB64 ? Buffer.from(saltB64, 'base64') : randomBytes(16);
  const dk = await scrypt(String(passcode).normalize('NFKC'), salt, 32, SCRYPT);
  return { salt: salt.toString('base64'), hash: dk.toString('base64'), algo: PASS_ALGO };
}

async function passcodeMatches(passcode, member) {
  const { hash } = await hashPasscode(passcode, member.salt);
  const a = Buffer.from(hash, 'base64');
  const b = Buffer.from(member.hash, 'base64');
  return a.length === b.length && timingSafeEqual(a, b);
}

// A fixed decoy so an unknown name costs the same time as a real one.
const DECOY = { salt: Buffer.alloc(16).toString('base64'), hash: Buffer.alloc(32).toString('base64') };

// ---------------------------------------------------------------- tokens
let secretCache = null;

export async function signingSecret() {
  if (secretCache) return secretCache;
  const existing = await get(K.config('auth'), true);
  if (existing && existing.secret) return (secretCache = existing.secret);
  const fresh = randomBytes(32).toString('base64');
  try {
    await put({ ...K.config('auth'), secret: fresh }, 'attribute_not_exists(pk)');
    secretCache = fresh;
  } catch (err) {
    if (!conditionFailures(err)) throw err;
    secretCache = (await get(K.config('auth'), true)).secret;  // another container won the race
  }
  return secretCache;
}

const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url').toString('utf8');

async function sign(payload) {
  return createHmac('sha256', await signingSecret()).update(payload).digest('base64url');
}

/**
 * Tokens carry the member's version. Resetting a passcode or deactivating a member
 * bumps it, which ends every session they had without a server-side session list.
 */
export async function makeToken(member) {
  const exp = clock.now() + CONFIG.TOKEN_TTL_DAYS * 86400000;
  const payload = [b64u(member.sk), exp, member.ver || 1].join('.');
  return payload + '.' + (await sign(payload));
}

async function readToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4) return null;
  const payload = parts.slice(0, 3).join('.');
  const expected = Buffer.from(await sign(payload));
  const given = Buffer.from(parts[3]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (Number(parts[1]) < clock.now()) return null;
  return { key: unb64u(parts[0]), ver: Number(parts[2]) };
}

const EXPIRED = () => new HttpError(401, 'Session expired. Sign in again.', { expired: true });

export async function requireMember(token) {
  const t = await readToken(token);
  if (!t) throw EXPIRED();
  const m = await get(K.member(t.key));
  if (!m || m.active === false || (m.ver || 1) !== t.ver) throw EXPIRED();
  return m;
}

export async function requireAdmin(token) {
  const m = await requireMember(token);
  if (!m.admin) throw new HttpError(403, 'Only lab admins can do that.');
  return m;
}

// ---------------------------------------------------------------- limiting
const LOCK_MS = () => CONFIG.LOCKOUT_MINUTES * 60000;

/**
 * Reserve one attempt against a counter before the passcode is checked.
 *
 * The increment is atomic, so twenty parallel requests from one address receive
 * counts 1..20 and only the first three proceed to a passcode check. Checking the
 * passcode first and counting afterwards would let every parallel request through,
 * because each would read the same pre-attempt count.
 *
 * A counter whose window has gone stale, and which is not locked, restarts at 1.
 */
async function reserveAttempt(key) {
  const now = clock.now();
  const ttl = Math.floor((now + LOCK_MS()) / 1000) + 86400;
  try {
    return await update({
      Key: key,
      UpdateExpression: 'SET fails = :one, firstFailAt = :now, lockedUntil = :zero, #ttl = :ttl',
      ConditionExpression: 'attribute_not_exists(pk) OR (firstFailAt < :stale AND lockedUntil < :now)',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':now': now, ':zero': 0, ':ttl': ttl, ':stale': now - LOCK_MS() },
    });
  } catch (err) {
    if (!conditionFailures(err)) throw err;
  }
  return update({
    Key: key,
    UpdateExpression: 'ADD fails :one SET #ttl = :ttl',
    ExpressionAttributeNames: { '#ttl': 'ttl' },
    ExpressionAttributeValues: { ':one': 1, ':ttl': ttl },
  });
}

async function lockNow(key) {
  const now = clock.now();
  try {
    await update({
      Key: key,
      UpdateExpression: 'SET lockedUntil = :until',
      ConditionExpression: 'lockedUntil < :now',          // never extend a running lock
      ExpressionAttributeValues: { ':until': now + LOCK_MS(), ':now': now },
    });
  } catch (err) {
    if (!conditionFailures(err)) throw err;
  }
}

function minutesLeft(until) {
  const m = Math.ceil((until - clock.now()) / 60000);
  return m <= 1 ? '1 minute' : m + ' minutes';
}

const LOCKED = (until) => new HttpError(429,
  'Too many incorrect attempts. Try again in ' + minutesLeft(until) + '.',
  { locked: true });

/**
 * Sign in by name and passcode. Two independent limits apply: attempts from one
 * address, and attempts against one member. Either reaching the cap pauses it for
 * CONFIG.LOCKOUT_MINUTES. Unknown names and wrong passcodes get the same message.
 */
export async function login({ name, passcode }, sourceIp) {
  const key = nameKey(name);
  const pass = String(passcode || '');
  if (!key || !pass) throw new HttpError(400, 'Enter your name and passcode.');

  const max = CONFIG.LOGIN_MAX_ATTEMPTS;
  const ipK = K.ipLock(ipKey(sourceIp));
  const ip = await reserveAttempt(ipK);
  if (ip.lockedUntil > clock.now()) throw LOCKED(ip.lockedUntil);
  if (ip.fails > max) { await lockNow(ipK); throw LOCKED(clock.now() + LOCK_MS()); }

  const member = await get(K.member(key), true);
  let acct = null;
  const acctK = K.acctLock(key);
  if (member) {
    acct = await reserveAttempt(acctK);
    if (acct.lockedUntil > clock.now()) throw LOCKED(acct.lockedUntil);
    if (acct.fails > max) { await lockNow(acctK); throw LOCKED(clock.now() + LOCK_MS()); }
  }

  const ok = member ? await passcodeMatches(pass, member) : (await passcodeMatches(pass, DECOY), false);

  if (ok) {
    await Promise.all([del(ipK), del(acctK)]);
    if (member.active === false) {
      throw new HttpError(403, 'That account is not active. Ask Yi to reactivate it.');
    }
    return member;
  }

  const locks = [];
  if (ip.fails >= max) locks.push(lockNow(ipK));
  if (acct && acct.fails >= max) locks.push(lockNow(acctK));
  if (locks.length) {
    await Promise.all(locks);
    throw LOCKED(clock.now() + LOCK_MS());
  }
  const left = Math.min(max - ip.fails, acct ? max - acct.fails : max);
  throw new HttpError(401,
    'Name or passcode is incorrect. ' + left + (left === 1 ? ' attempt' : ' attempts') +
    ' left before sign-in pauses for ' + CONFIG.LOCKOUT_MINUTES + ' minutes.',
    { attempts_left: left });
}
