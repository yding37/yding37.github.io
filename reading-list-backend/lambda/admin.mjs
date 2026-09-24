// Admin operations (the replacement for editing the Google Sheet by hand), plus the
// two internal actions only reachable by direct invocation: import and set_member.

import { K, get, put, del, update, queryAll, transact, batchPut, conditionFailures } from './db.mjs';
import { hashPasscode } from './auth.mjs';
import { loadPapers } from './papers.mjs';
import { buildDigest, postDigest, slackSettings, saveWebhook } from './digest.mjs';
import { clock, tidy, clip, nameKey, normalizeLink, linkKey, weekTtl, HttpError } from './util.mjs';

// ---------------------------------------------------------------- members
function memberView(m, locks) {
  const lock = locks.get(m.sk);
  return {
    key: m.sk,
    name: m.name,
    admin: !!m.admin,
    active: m.active !== false,
    locked_until: lock && lock.lockedUntil > clock.now() ? new Date(lock.lockedUntil).toISOString() : null,
    failed_attempts: lock && lock.lockedUntil <= clock.now() ? lock.fails || 0 : 0,
  };
}

async function listMembers() {
  const [members, locks] = await Promise.all([queryAll('MEMBER'), queryAll('LOCK#ACCT')]);
  const byKey = new Map(locks.map((l) => [l.sk, l]));
  return members.map((m) => memberView(m, byKey)).sort((a, b) => a.name.localeCompare(b.name));
}

function validName(name) {
  const n = tidy(name);
  if (!n) throw new HttpError(400, 'A name is required.');
  if (n.length > 60) throw new HttpError(400, 'Keep names under 60 characters.');
  if (/[#]/.test(n)) throw new HttpError(400, 'Names cannot contain #.');
  return n;
}

function validPasscode(p) {
  const s = String(p || '');
  if (s.length < 6) throw new HttpError(400, 'Passcodes need at least 6 characters.');
  if (s.length > 200) throw new HttpError(400, 'That passcode is too long.');
  return s;
}

/** Create a member, or update one. A new passcode ends that member's sessions. */
export async function saveMember({ name, passcode, admin }, actor) {
  const display = validName(name);
  const key = nameKey(display);
  const existing = await get(K.member(key), true);

  if (!existing) {
    const pass = validPasscode(passcode);
    const h = await hashPasscode(pass);
    await put({
      ...K.member(key), name: display, admin: !!admin, active: true, ver: 1,
      salt: h.salt, hash: h.hash, algo: h.algo, createdAt: clock.now(),
    }, 'attribute_not_exists(pk)');
    return { ok: true, created: true };
  }

  if (actor && actor.sk === key && admin === false) {
    throw new HttpError(400, 'You cannot remove your own admin access.');
  }
  const sets = ['#n = :n'];
  const names = { '#n': 'name' };
  const values = { ':n': display };
  if (typeof admin === 'boolean') { sets.push('admin = :a'); values[':a'] = admin; }
  if (passcode) {
    const h = await hashPasscode(validPasscode(passcode));
    sets.push('salt = :s', '#h = :h', 'algo = :al', 'ver = if_not_exists(ver, :one) + :one');
    Object.assign(values, { ':s': h.salt, ':h': h.hash, ':al': h.algo, ':one': 1 });
    names['#h'] = 'hash';
  }
  await update({ Key: K.member(key), UpdateExpression: 'SET ' + sets.join(', '), ExpressionAttributeNames: names, ExpressionAttributeValues: values });
  if (passcode) await del(K.acctLock(key));
  return { ok: true, created: false, passcode_reset: !!passcode };
}

async function setActive({ key, active }, actor) {
  const k = nameKey(key);
  if (actor.sk === k && !active) throw new HttpError(400, 'You cannot deactivate yourself.');
  try {
    await update({
      Key: K.member(k),
      // Deactivating bumps the version, which ends the member's open sessions.
      UpdateExpression: active ? 'SET active = :t' : 'SET active = :f, ver = if_not_exists(ver, :one) + :one',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: active ? { ':t': true } : { ':f': false, ':one': 1 },
    });
  } catch (err) {
    if (conditionFailures(err)) throw new HttpError(404, 'No member by that name.');
    throw err;
  }
  return { ok: true };
}

async function clearIpLocks() {
  const locks = await queryAll('LOCK#IP');
  await Promise.all(locks.map((l) => del(K.ipLock(l.sk))));
  return { ok: true, cleared: locks.length };
}

// ---------------------------------------------------------------- papers
async function listAllPapers() {
  const rows = await loadPapers({ includeHidden: true });
  return rows.map(({ raw, view }) => ({ ...view, hidden: !!raw.hidden, submitted_by: raw.submittedBy || '' }))
    .sort((a, b) => (b.submitted_at || '').localeCompare(a.submitted_at || ''));
}

async function savePaper(body) {
  const pid = String(body.paper_id || '').trim();
  const paper = await get(K.paper(pid), true);
  if (!paper) throw new HttpError(404, 'No such paper.');

  const title = clip(tidy(body.title), 500);
  if (!title) throw new HttpError(400, 'A title is required.');
  const link = clip(normalizeLink(body.link), 2000);
  const lk = link ? linkKey(link) : '';

  const ops = [{
    Update: {
      Key: K.paper(pid),
      UpdateExpression: 'SET title = :t, link = :l, venue = :v, #yr = :y, summary = :s, tags = :g' +
                        (lk ? ', linkKey = :lk' : ' REMOVE linkKey'),
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#yr': 'year' },
      ExpressionAttributeValues: {
        ':t': title, ':l': link, ':v': clip(tidy(body.venue), 200), ':y': clip(tidy(body.year), 10),
        ':s': clip(String(body.summary || '').trim(), 10000), ':g': clip(tidy(body.technical_focus), 300),
        ...(lk ? { ':lk': lk } : {}),
      },
    },
  }];
  if (lk !== (paper.linkKey || '')) {
    if (paper.linkKey) ops.push({ Delete: { Key: K.link(paper.linkKey) } });
    if (lk) ops.push({ Put: { Item: { ...K.link(lk), paperId: pid }, ConditionExpression: 'attribute_not_exists(pk)' } });
  }
  try {
    await transact(ops);
  } catch (err) {
    if (conditionFailures(err)) throw new HttpError(409, 'Another paper on the list already uses that link.');
    throw err;
  }
  return { ok: true };
}

async function setHidden({ paper_id, hidden }) {
  try {
    await update({
      Key: K.paper(String(paper_id || '')),
      UpdateExpression: 'SET #hid = :h',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#hid': 'hidden' },   // reserved word
      ExpressionAttributeValues: { ':h': !!hidden },
    });
  } catch (err) {
    if (conditionFailures(err)) throw new HttpError(404, 'No such paper.');
    throw err;
  }
  return { ok: true };
}

// ---------------------------------------------------------------- dispatcher
export async function adminOp(actor, body) {
  switch (body.op) {
    case 'members': return { ok: true, members: await listMembers() };
    case 'member_save': return saveMember(body, actor);
    case 'member_active': return setActive(body, actor);
    case 'member_unlock': await del(K.acctLock(nameKey(body.key))); return { ok: true };
    case 'ip_unlock_all': return clearIpLocks();
    case 'papers': return { ok: true, papers: await listAllPapers() };
    case 'paper_save': return savePaper(body);
    case 'paper_hidden': return setHidden(body);
    case 'slack': return { ok: true, slack: await slackSettings() };
    case 'slack_save': return { ok: true, slack: await saveWebhook(body.webhook) };
    case 'digest_preview': return { ok: true, text: await buildDigest() };
    case 'digest_send': return postDigest();
    default: throw new HttpError(400, 'Unknown admin operation.');
  }
}

// ---------------------------------------------------------------- import
/**
 * One-time load from the Google Sheet export. Only reachable by direct invocation
 * (IAM-authenticated), never through the public URL. Passcodes arrive already
 * hashed. Refuses to run over existing papers unless `force` is set, so a second
 * run cannot silently roll back votes cast since the first.
 */
export async function importData({ data, force }) {
  if (!data || !Array.isArray(data.papers)) throw new HttpError(400, 'Import needs { data: { papers, members, ... } }.');
  const existing = await queryAll('PAPER');
  if (existing.length && !force) {
    throw new HttpError(409, 'The table already has ' + existing.length + ' papers. Re-run with force to overwrite.');
  }

  const items = [];
  const seenLinks = new Map();
  for (const p of data.papers) {
    const lk = p.link ? linkKey(p.link) : '';
    items.push({
      ...K.paper(p.id), title: p.title, link: p.link || '', linkKey: lk || undefined,
      venue: p.venue || '', year: p.year || '', summary: p.summary || '', tags: p.tags || '',
      submittedBy: p.submittedBy, submittedKey: nameKey(p.submittedBy), submittedAt: p.submittedAt,
      state: p.state || 'active', stateAt: p.stateAt || undefined, stateBy: p.stateBy || undefined,
      hidden: !!p.hidden,
    });
    items.push({ ...K.tally(p.id), up: p.up || 0, down: p.down || 0 });
    if (lk) {
      if (seenLinks.has(lk)) throw new HttpError(409, 'Two imported papers share a link: ' + seenLinks.get(lk) + ' and ' + p.id);
      seenLinks.set(lk, p.id);
      items.push({ ...K.link(lk), paperId: p.id });
    }
  }
  for (const m of data.members || []) {
    items.push({
      ...K.member(nameKey(m.name)), name: m.name, admin: !!m.admin, active: m.active !== false, ver: 1,
      salt: m.salt, hash: m.hash, algo: m.algo, createdAt: clock.now(),
    });
  }
  const week = data.week;
  for (const v of data.votes || []) {
    items.push({ ...K.vote(week, nameKey(v.member), v.paperId), weight: v.weight, paperId: v.paperId, ttl: weekTtl(week) });
  }
  for (const u of data.usage || []) {
    items.push({ ...K.usage(week, nameKey(u.member)), up: u.up || 0, down: u.down || 0, subs: u.subs || 0, ttl: weekTtl(week) });
  }
  await batchPut(items);
  return {
    ok: true,
    papers: data.papers.length, members: (data.members || []).length,
    votes: (data.votes || []).length, usage: (data.usage || []).length,
  };
}
