// Shared constants and pure helpers. Nothing here touches the network or the table.

export const CONFIG = {
  TZ: process.env.TIMEZONE || 'America/New_York', // week boundary: Monday 00:00 here
  UP_PER_WEEK: 3,
  DOWN_PER_WEEK: 3,
  SUBS_PER_WEEK: 10,
  TOKEN_TTL_DAYS: 30,
  LOGIN_MAX_ATTEMPTS: 3,        // per IP and per account, within the window below
  LOCKOUT_MINUTES: 15,
  CONTRIBUTOR_WINDOW_DAYS: 30,
  DIGEST_TOP_N: 5,
  PAGE_URL: process.env.PAGE_URL || 'https://yding37.github.io/reading-list/',
  // Bumped whenever the request/response contract changes. The page checks it on
  // load, so a site and backend that drift apart say so instead of misbehaving.
  API_VERSION: 2,
};

// ---------------------------------------------------------------- clock
// Everything reads time through here so tests can move across week boundaries.
let override = null;
export const clock = {
  now: () => (override == null ? Date.now() : override),
  set: (ms) => { override = ms; },
  reset: () => { override = null; },
};

// ---------------------------------------------------------------- weeks
const ymd = new Intl.DateTimeFormat('en-US', {
  timeZone: CONFIG.TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

function localDate(ms) {
  const p = {};
  for (const part of ymd.formatToParts(new Date(ms))) p[part.type] = part.value;
  return new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
}

/** Monday that starts the week containing `ms`, as yyyy-mm-dd. */
export function weekOf(ms = clock.now()) {
  const d = localDate(ms);
  const dow = d.getUTCDay() || 7;          // Monday = 1 ... Sunday = 7
  d.setUTCDate(d.getUTCDate() - dow + 1);
  return d.toISOString().slice(0, 10);
}

export function weekEnds(week) {
  const d = new Date(week + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

/**
 * DynamoDB TTL (epoch seconds) for items that belong to one week. TTL is cleanup,
 * not logic: reads only ever address the current week's partition, so an old
 * week is unreachable the moment it ends, whenever DynamoDB gets round to it.
 */
export function weekTtl(week) {
  const d = new Date(week + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 9);
  return Math.floor(d.getTime() / 1000);
}

// ---------------------------------------------------------------- strings
export function tidy(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** Stable key for a member name. Sign-in is case-insensitive. */
export function nameKey(s) {
  return tidy(s).toLowerCase();
}

export function clip(s, max) {
  const t = String(s == null ? '' : s).trim();
  return t.length > max ? t.slice(0, max) : t;
}

export function newPaperId() {
  const rand = Math.floor(Math.random() * 46656).toString(36).padStart(3, '0');
  return 'p' + clock.now().toString(36) + rand;
}

// ---------------------------------------------------------------- links
export function normalizeLink(url) {
  let u = tidy(url);
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

export function arxivIdFrom(url) {
  let m = /arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})/i.exec(url);
  if (m) return m[1];
  m = /arxiv\.org\/(?:abs|pdf|html)\/([a-z-]+(?:\.[A-Za-z]{2})?\/\d{7})/i.exec(url);
  if (m) return m[1];
  m = /^\s*(?:arxiv:)?(\d{4}\.\d{4,5})(?:v\d+)?\s*$/i.exec(url);
  return m ? m[1] : null;
}

export function doiFrom(url) {
  let text = String(url || '');
  try { text = decodeURIComponent(text); } catch { /* keep raw */ }
  const m = /(10\.\d{4,9}\/[^\s"'<>&?#]+)/i.exec(text);
  return m ? m[1].replace(/[).,;:]+$/, '') : null;
}

/**
 * Canonical identity of a paper link, for duplicate detection. The same arXiv
 * paper shows up as /abs/, /pdf/, with and without a version suffix; the same DOI
 * sits behind many publisher URLs. Those all collapse to one key.
 */
export function linkKey(url) {
  const u = normalizeLink(url);
  if (!u) return '';
  const ax = arxivIdFrom(u);
  if (ax) return 'arxiv:' + ax.toLowerCase();
  const doi = doiFrom(u);
  if (doi) return 'doi:' + doi.toLowerCase();
  try {
    const x = new URL(u);
    const host = x.hostname.toLowerCase().replace(/^www\./, '');
    const path = x.pathname.replace(/\/+$/, '');
    return 'url:' + host + path + (x.search || '');
  } catch {
    return 'url:' + u.toLowerCase();
  }
}

// ---------------------------------------------------------------- ip
/**
 * Key for per-IP login limiting. IPv4 as-is. IPv6 by /64 prefix, because a single
 * host is routinely handed a whole /64 and could otherwise rotate addresses freely.
 */
export function ipKey(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (!s.includes(':')) return s;
  const [head, tail = ''] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = h.concat(new Array(Math.max(0, 8 - h.length - t.length)).fill('0'), t);
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

export function decodeEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------- errors
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
