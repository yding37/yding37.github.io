import { readFileSync } from 'node:fs';
import { freshTable, post, listPapers, internal, check, section, summary } from './harness.mjs';
import { clock } from '../lambda/util.mjs';

const data = JSON.parse(readFileSync(new URL('../migration/migration.json', import.meta.url)));
const live = JSON.parse(readFileSync(new URL('../migration/live-list.json', import.meta.url)));

await freshTable();
clock.set(Date.parse('2026-09-23T20:00:00Z'));   // during the week the export was taken

section('import');
let r = await internal({ action: 'import', data });
check('import succeeds', r.ok && r.papers === 15 && r.members === 7, r);
r = await internal({ action: 'import', data });
check('second import refused without force', !r.ok && /already has 15/.test(r.error), r);

section('matches the live Google Sheets backend');
const now = await listPapers();
const byId = new Map(now.papers.map((p) => [p.id, p]));
let same = true;
for (const p of live.papers) {
  const q = byId.get(p.id);
  const fields = ['title', 'link', 'venue', 'year', 'summary', 'up', 'down', 'score', 'read'];
  for (const f of fields) {
    if (!q || q[f] !== p[f]) { same = false; console.log('     differs', p.id, f, q && q[f], p[f]); }
  }
  if (!q || Date.parse(q.submitted_at) !== Date.parse(p.submitted_at)) { same = false; console.log('     time differs', p.id); }
}
check('all 15 papers: title, link, venue, year, abstract, up, down, score, read, submitted time', same && now.papers.length === 15);
check('30-day contributor tally identical', JSON.stringify(now.contributors) === JSON.stringify(live.contributors),
  { now: now.contributors, live: live.contributors });
check('read paper imported as state=read with who/when', byId.get('pmtuqnlwa9').state === 'read' && byId.get('pmtuqnlwa9').state_by === 'manish');

section('everyone signs in with their existing passcode');
// Real passcodes are needed to prove the migrated hashes work. They live in the
// git-ignored migration/ folder, never in this file: this repo is public.
// Format: [["yi","..."], ["anjila","..."], ...]. Without it, these checks are skipped.
let creds = [];
try { creds = JSON.parse(readFileSync(new URL('../migration/test-creds.json', import.meta.url))); }
catch { console.log('  (migration/test-creds.json not found: skipping sign-in checks)'); }
const tokens = {};
for (const [i, [name, pass]] of creds.entries()) {
  r = await post({ action: 'login', name, passcode: pass }, { ip: '10.0.0.' + (i + 1) });
  tokens[name] = r.token;
  check(name + ' signs in' + (name === 'yi' ? ' as admin' : ''), r.ok && (name !== 'yi' || r.admin === true), r.error);
}

if (!creds.length) { summary(); process.exit(); }

section('this week carries over');
const q = async (n) => (await post({ action: 'me', token: tokens[n] }));
let m = await q('uthman');
check('uthman: 2 upvotes and 2 submissions already spent', m.me.upvotes_left === 1 && m.me.submissions_left === 8, m.me);
check('uthman holds +1 on both of his ACL papers', m.my_weights.pmucu5y3r2i === 1 && m.my_weights.pmucurpmgsy === 1, m.my_weights);
m = await q('yi');
check('yi holds +1 on Mamba-3, 2 upvotes left', m.my_weights.pmtuuk3l9mz === 1 && m.me.upvotes_left === 2, m);
m = await q('parsa');
check('parsa: untouched budget', m.me.upvotes_left === 3 && m.me.submissions_left === 10, m.me);
m = await q('sazia');
check('sazia: earlier weeks\' votes are not attributed to her', Object.keys(m.my_weights).length === 0, m.my_weights);

section('stacking on imported data');
r = await post({ action: 'vote', token: tokens.yi, paper_id: 'pmtuuk3l9mz', direction: 'up' });
check('yi stacks a 2nd vote on Mamba-3: score 3 -> 4', r.ok && r.my_weight === 2 && r.score === 4, r);
r = await post({ action: 'vote', token: tokens.yi, paper_id: 'pmtuuk3l9mz', direction: 'down' });
r = await post({ action: 'vote', token: tokens.yi, paper_id: 'pmtuuk3l9mz', direction: 'down' });
check('yi takes both back: score 2 (jack + manish remain)', r.ok && r.my_weight === 0 && r.score === 2, r);
r = await post({ action: 'vote', token: tokens.sazia, paper_id: 'pmtuqnlwa9', direction: 'up' });
check('no new votes on the paper already read', r.status === 409, r);

summary();
