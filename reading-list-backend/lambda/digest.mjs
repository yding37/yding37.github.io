// Friday Slack digest for #papers. Invoked by EventBridge Scheduler, or by an admin.

import { K, get, put } from './db.mjs';
import { loadPapers } from './papers.mjs';
import { CONFIG, clock, weekOf, HttpError } from './util.mjs';

const plural = (n, one, many) => n + ' ' + (Math.abs(n) === 1 ? one : many);
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function prettyWeek(week) {
  const d = new Date(week + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export async function buildDigest() {
  const rows = (await loadPapers()).map((r) => ({ ...r.view, submittedAt: r.raw.submittedAt, stateAt: r.raw.stateAt }));
  const week = weekOf();
  const inWeek = (ms) => ms && weekOf(ms) === week;

  const active = rows.filter((p) => p.state === 'active');
  const added = rows.filter((p) => inWeek(p.submittedAt)).length;
  const read = rows.filter((p) => p.state === 'read' && inWeek(p.stateAt)).length;
  const archived = rows.filter((p) => p.state === 'archived' && inWeek(p.stateAt)).length;

  active.sort((a, b) => b.score - a.score || b.up - a.up);
  const top = active.slice(0, CONFIG.DIGEST_TOP_N);

  const counts = [
    plural(added, 'new paper', 'new papers') + ' added this week',
    plural(rows.length, 'paper', 'papers') + ' on the list',
    active.length + ' still to read',
  ];
  if (read) counts.push(read + ' marked read');
  if (archived) counts.push(archived + ' archived');

  const lines = ['*Reading list — week of ' + prettyWeek(week) + '*', counts.join('  ·  '), ''];
  if (top.length) {
    lines.push('*Top ' + top.length + ' right now*');
    top.forEach((p, i) => {
      // "ICML 2026" already carries the year; do not print it twice.
      const where = p.venue && p.year && p.venue.includes(p.year) ? p.venue : [p.venue, p.year].filter(Boolean).join(' ');
      const name = p.link ? '<' + p.link + '|' + esc(p.title) + '>' : esc(p.title);
      lines.push((i + 1) + '. ' + name + (where ? '  _' + esc(where) + '_' : '') +
                 '  — ' + plural(p.score, 'point', 'points'));
    });
  } else {
    lines.push('Nothing left to read. Someone add a paper before Wednesday.');
  }
  lines.push('', '<' + CONFIG.PAGE_URL + '|Open the reading list>');
  return lines.join('\n');
}

export async function slackSettings() {
  const s = await get(K.config('slack'), true);
  const url = (s && s.webhook) || '';
  return { configured: !!url, webhook_hint: url ? '…' + url.slice(-6) : '', last_posted_at: (s && s.lastPostedAt) || null };
}

export async function saveWebhook(url) {
  const u = String(url || '').trim();
  if (u && !/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/.test(u)) {
    throw new HttpError(400, 'That does not look like a Slack incoming webhook URL (https://hooks.slack.com/services/…).');
  }
  const prev = await get(K.config('slack'), true);
  await put({ ...K.config('slack'), webhook: u || undefined, lastPostedAt: prev && prev.lastPostedAt });
  return slackSettings();
}

export async function postDigest() {
  const s = await get(K.config('slack'), true);
  if (!s || !s.webhook) throw new HttpError(400, 'No Slack webhook saved yet. Add one in the admin panel.');
  const text = await buildDigest();
  const r = await fetch(s.webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new HttpError(502, 'Slack returned ' + r.status + ': ' + (await r.text()).slice(0, 200));
  await put({ ...s, lastPostedAt: clock.now() });
  return { ok: true, text };
}
