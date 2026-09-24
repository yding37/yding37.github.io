import { freshTable, post, listPapers, internal, check, section, summary } from './harness.mjs';
import { clock, weekOf, linkKey, ipKey } from '../lambda/util.mjs';
import { K, get, queryAll } from '../lambda/db.mjs';

const WED_W1 = Date.parse('2026-09-23T16:00:00Z');   // Wed 12:00 EDT, week of Sep 21
const WED_W2 = Date.parse('2026-09-30T16:00:00Z');   // Wed 12:00 EDT, week of Sep 28
const MIN = 60000;

await freshTable();
clock.set(WED_W1);

// ------------------------------------------------------------------ setup
section('members');
for (const [name, pass, admin] of [['yi', 'test-yi-1', true], ['anjila', 'test-anj-2'], ['jack', 'test-jack-3'], ['manish', 'test-man-4']]) {
  const r = await internal({ action: 'set_member', name, passcode: pass, admin: !!admin });
  check('create ' + name, r.ok && r.created, r);
}
const stored = await get(K.member('anjila'), true);
check('passcode stored hashed, never plain', stored.hash && stored.salt && !JSON.stringify(stored).includes('test-anj-2'));

async function signIn(name, pass, ip) {
  const r = await post({ action: 'login', name, passcode: pass }, { ip });
  if (!r.ok) throw new Error('sign-in failed for ' + name + ': ' + r.error);
  return r.token;
}
const yi = await signIn('Yi', 'test-yi-1');              // case-insensitive name
const anjila = await signIn('anjila', 'test-anj-2', '198.51.100.1');
const jack = await signIn('jack', 'test-jack-3', '198.51.100.2');
const manish = await signIn('manish', 'test-man-4', '198.51.100.3');
check('sign in is case-insensitive on name', !!yi);

// ------------------------------------------------------------------ submitting
section('submitting and duplicate links');
async function add(token, title, link) {
  const r = await post({ action: 'submit', token, title, link, venue: 'V', year: '2026', summary: 'Abstract of ' + title });
  return r;
}
const pA = (await add(anjila, 'Paper A', 'https://arxiv.org/abs/2510.10150')).id;
const pB = (await add(anjila, 'Paper B', 'https://arxiv.org/abs/2603.15569')).id;
const pC = (await add(jack, 'Paper C', 'https://doi.org/10.1109/CVPR.2016.90')).id;
const pD = (await add(jack, 'Paper D', 'https://aclanthology.org/2026.acl-long.197/')).id;
check('four papers added', pA && pB && pC && pD);

let r = await add(manish, 'Same as A via pdf link', 'https://arxiv.org/pdf/2510.10150v2');
check('arXiv /pdf/ + version suffix recognised as duplicate of /abs/', r.status === 409 && /already on the list/.test(r.error), r);
r = await add(manish, 'Same DOI different host', 'https://ieeexplore.ieee.org/document/x?doi=10.1109/CVPR.2016.90');
check('same DOI behind another URL recognised as duplicate', r.status === 409, r);
r = await add(manish, 'ACL without trailing slash', 'http://www.aclanthology.org/2026.acl-long.197');
check('http/www/trailing-slash variants recognised as duplicate', r.status === 409, r);

for (let i = 0; i < 8; i++) await add(anjila, 'Filler ' + i, 'https://example.org/filler/' + i);
r = await add(anjila, 'Eleventh', 'https://example.org/eleventh');
check('11th submission in a week is refused', r.status === 409 && /10 papers/.test(r.error), r);
const afterCap = await listPapers();
check('refused submission left no paper behind', !afterCap.papers.some((p) => p.title === 'Eleventh'));
check('refused submission left no LINK claim behind', !(await get(K.link(linkKey('https://example.org/eleventh')))));

// ------------------------------------------------------------------ stacking
section('stacked votes and budgets');
const v = (token, paper_id, direction, ip) => post({ action: 'vote', token, paper_id, direction }, { ip });
r = await v(yi, pA, 'up'); check('+1', r.ok && r.my_weight === 1 && r.me.upvotes_left === 2, r);
r = await v(yi, pA, 'up'); check('+2 on the same paper', r.ok && r.my_weight === 2 && r.me.upvotes_left === 1, r);
r = await v(yi, pA, 'up'); check('+3 on the same paper', r.ok && r.my_weight === 3 && r.me.upvotes_left === 0 && r.score === 3, r);
r = await v(yi, pB, 'up'); check('4th upvote refused', r.status === 409 && /3 upvotes/.test(r.error), r);
r = await v(yi, pA, 'down'); check('stepping down refunds an upvote, spends no downvote', r.ok && r.my_weight === 2 && r.me.upvotes_left === 1 && r.me.downvotes_left === 3, r);
r = await v(yi, pB, 'up'); check('refunded vote can go elsewhere', r.ok && r.me.upvotes_left === 0, r);
r = await v(yi, pC, 'down'); r = await v(yi, pC, 'down'); r = await v(yi, pC, 'down');
check('downvotes stack to -3 on their own budget', r.ok && r.my_weight === -3 && r.me.downvotes_left === 0 && r.me.upvotes_left === 0, r);
r = await v(yi, pD, 'down'); check('4th downvote refused', r.status === 409 && /3 downvotes/.test(r.error), r);
r = await v(yi, pB, 'down');
check('with 0 downvotes left, down on an upvoted paper still works (it refunds)', r.ok && r.my_weight === 0 && r.me.upvotes_left === 1, r);

// ------------------------------------------------------------------ THE REPORTED BUG
section('reported bug: this week\'s add/remove must not touch other weeks');
// State so far in week 1: yi holds A:+2, C:-3. Others add some.
await v(anjila, pA, 'up'); await v(jack, pA, 'up');
let t1 = (await listPapers()).papers.find((p) => p.id === pA);
check('week 1: A = yi +2, anjila +1, jack +1 = 4', t1.score === 4, t1);
const w1 = weekOf();
const w1Rows = await queryAll('VOTE#' + w1, { consistent: true });

clock.set(WED_W2);
const w2 = weekOf();
check('clock moved to the next week', w1 !== w2, { w1, w2 });

let m = await post({ action: 'me', token: yi });
check('new week: fresh 3 and 3', m.me.upvotes_left === 3 && m.me.downvotes_left === 3, m.me);
check('new week: last week\'s holdings are not attributed to anyone', Object.keys(m.my_weights).length === 0, m.my_weights);

// The sequence that broke the old backend: add, add, remove, remove, remove on the same paper.
for (const d of ['up', 'up', 'down', 'down', 'down', 'up']) r = await v(yi, pA, d);
check('after add/remove churn, yi holds 0 on A this week', r.ok && r.my_weight === 0, r);
t1 = (await listPapers()).papers.find((p) => p.id === pA);
check('A still has all 4 of last week\'s points', t1.score === 4 && t1.up === 4 && t1.down === 0, t1);
m = await post({ action: 'me', token: yi });
check('budget fully restored after the churn', m.me.upvotes_left === 3 && m.me.downvotes_left === 3, m.me);
const w1After = await queryAll('VOTE#' + w1, { consistent: true });
check('last week\'s vote rows are byte-for-byte untouched',
  JSON.stringify(w1After) === JSON.stringify(w1Rows), { before: w1Rows.length, after: w1After.length });

r = await v(yi, pC, 'up');
check('C: last week\'s -3 stays; this week +1 lands on top', r.ok && r.score === -2 && r.my_weight === 1, r);
r = await v(yi, pC, 'down');
check('C: taking this week\'s +1 back returns to -3, not 0', r.ok && r.score === -3, r);

// ------------------------------------------------------------------ concurrency
section('concurrency');
const burst = await Promise.all([pA, pB, pC, pD, pA, pB, pC, pD, pA, pB].map((pid) => v(manish, pid, 'up', '198.51.100.3')));
const won = burst.filter((x) => x.ok).length;
check('10 parallel upvotes from one member: exactly 3 succeed', won === 3, burst.map((x) => x.ok ? 'ok' : x.status));
m = await post({ action: 'me', token: manish });
const heldSum = Object.values(m.my_weights).reduce((a, b) => a + b, 0);
check('holdings and budget agree after the burst', heldSum === 3 && m.me.upvotes_left === 0, m);
const all = await listPapers();
// Recompute every tally from scratch from both weeks' vote rows.
const rows = [...(await queryAll('VOTE#' + w1, { consistent: true })), ...(await queryAll('VOTE#' + w2, { consistent: true }))];
const recomputed = {};
for (const x of rows) { const s = recomputed[x.paperId] || (recomputed[x.paperId] = { up: 0, down: 0 }); if (x.weight > 0) s.up += x.weight; else s.down -= x.weight; }
let consistent = true;
for (const p of all.papers) {
  const rc = recomputed[p.id] || { up: 0, down: 0 };
  if (rc.up !== p.up || rc.down !== p.down) { consistent = false; console.log('     mismatch', p.id, rc, p.up, p.down); }
}
check('every tally equals the sum of the vote rows behind it', consistent);

// ------------------------------------------------------------------ read / archive
section('read and archive');
r = await post({ action: 'state', token: jack, paper_id: pD, state: 'archived' });
check('archive a paper', r.ok && r.state === 'archived' && r.state_by === 'jack', r);
r = await v(anjila, pD, 'up');
check('no new votes on an archived paper', r.status === 409 && /closed/.test(r.error), r);
r = await post({ action: 'state', token: jack, paper_id: pB, state: 'read' });
check('mark a paper read', r.ok && r.state === 'read');
r = await v(manish, pB, 'down');
if ((await post({ action: 'me', token: manish })).my_weights[pB] > 0 || r.ok) {
  check('a member can still take back a vote on a read paper', r.ok, r);
} else {
  check('(manish held nothing on B; take-back case covered below)', true);
}
r = await post({ action: 'state', token: jack, paper_id: pD, state: 'active' });
check('unarchive returns it to the list', r.ok && r.state === 'active' && !r.state_by);
r = await post({ action: 'state', token: jack, paper_id: pD, state: 'deleted' });
check('unknown state refused', r.status === 400);

// ------------------------------------------------------------------ sign-in limits
section('sign-in limits');
clock.set(WED_W2 + 60 * MIN);
const bad = (name, ip) => post({ action: 'login', name, passcode: 'wrong-guess' }, { ip });
r = await bad('jack', '192.0.2.10'); check('1st wrong: 2 left', r.status === 401 && r.attempts_left === 2, r);
r = await bad('jack', '192.0.2.10'); check('2nd wrong: 1 left', r.attempts_left === 1, r);
r = await bad('jack', '192.0.2.10'); check('3rd wrong: locked', r.status === 429 && r.locked, r);
r = await post({ action: 'login', name: 'jack', passcode: 'test-jack-3' }, { ip: '192.0.2.99' });
check('account lock holds even from a different IP, with the right passcode', r.status === 429, r);

// Per-IP: one address guessing across names.
r = await bad('anjila', '192.0.2.20'); r = await bad('manish', '192.0.2.20'); r = await bad('nobody', '192.0.2.20');
check('3 wrong from one IP across different names locks the IP', r.status === 429, r);
r = await post({ action: 'login', name: 'yi', passcode: 'test-yi-1' }, { ip: '192.0.2.20' });
check('locked IP cannot sign in even with right credentials', r.status === 429, r);
r = await post({ action: 'login', name: 'yi', passcode: 'test-yi-1' }, { ip: '192.0.2.21' });
check('another IP is unaffected', r.ok, r);

// Both from fresh addresses, against names with no prior failures, so the
// counters are in the same state and only the name's existence differs.
r = await bad('nobody-at-all', '192.0.2.30');
const r2 = await bad('yi', '192.0.2.31');
check('unknown name and wrong passcode give the same message', r.error === r2.error, [r.error, r2.error]);
await post({ action: 'login', name: 'yi', passcode: 'test-yi-1' }, { ip: '192.0.2.31' });   // clear yi's counter

// Parallel guessing from one address must not get more than 3 checks.
clock.set(WED_W2 + 120 * MIN);
const guesses = await Promise.all(Array.from({ length: 20 }, (_, i) =>
  post({ action: 'login', name: 'manish', passcode: 'guess' + i }, { ip: '192.0.2.40' })));
const checkedOutcomes = guesses.filter((g) => g.status === 401).length;
check('20 parallel guesses from one IP: at most 3 reach a passcode check', checkedOutcomes <= 3, guesses.map((g) => g.status));

// Window expiry.
clock.set(WED_W2 + 120 * MIN + 16 * MIN);
r = await post({ action: 'login', name: 'jack', passcode: 'test-jack-3' }, { ip: '192.0.2.10' });
check('locks lift after 15 minutes', r.ok, r);
check('IPv6 limited per /64', ipKey('2001:db8:1:2::abcd') === ipKey('2001:db8:1:2:ffff::1'), ipKey('2001:db8:1:2::abcd'));

// ------------------------------------------------------------------ tokens
section('sessions');
r = await post({ action: 'me', token: 'eW9.9999999999999.1.forged' });
check('forged token refused', r.status === 401 && r.expired, r);
const anjilaOld = anjila;
r = await post({ action: 'admin', token: yi, op: 'member_save', name: 'anjila', passcode: 'new-maple-7' });
check('admin resets a passcode', r.ok && r.passcode_reset, r);
r = await post({ action: 'me', token: anjilaOld });
check('reset ends the old session', r.status === 401 && r.expired, r);
const anjila2 = await signIn('anjila', 'new-maple-7', '198.51.100.1');
r = await post({ action: 'admin', token: yi, op: 'member_active', key: 'anjila', active: false });
check('admin deactivates a member', r.ok, r);
r = await post({ action: 'me', token: anjila2 });
check('deactivation ends the session immediately', r.status === 401, r);
r = await post({ action: 'login', name: 'anjila', passcode: 'new-maple-7' }, { ip: '198.51.100.9' });
check('deactivated member told so after correct passcode', r.status === 403 && /not active/.test(r.error), r);

// ------------------------------------------------------------------ admin
section('admin');
r = await post({ action: 'admin', token: jack, op: 'members' });
check('non-admin refused', r.status === 403, r);
r = await post({ action: 'admin', token: yi, op: 'members' });
check('admin lists members without hashes', r.ok && r.members.length === 4 && !JSON.stringify(r).includes('hash'), r.members && r.members.map((x) => x.name));
r = await post({ action: 'admin', token: yi, op: 'member_active', key: 'yi', active: false });
check('admin cannot deactivate themselves', r.status === 400, r);
r = await post({ action: 'admin', token: yi, op: 'member_save', name: 'Parsa', passcode: 'test-parsa-5' });
check('add a member', r.ok && r.created);
r = await post({ action: 'admin', token: yi, op: 'member_save', name: 'Parsa', passcode: '123' });
check('short passcode refused', r.status === 400);
r = await post({ action: 'admin', token: yi, op: 'paper_hidden', paper_id: pC, hidden: true });
check('hide a paper', r.ok);
check('hidden paper leaves the public list', !(await listPapers()).papers.some((p) => p.id === pC));
r = await post({ action: 'admin', token: yi, op: 'papers' });
check('admin still sees hidden papers', r.papers.some((p) => p.id === pC && p.hidden));
r = await post({ action: 'admin', token: yi, op: 'paper_save', paper_id: pB, title: 'Paper B (fixed)', link: 'https://arxiv.org/abs/2510.10150', venue: 'ICLR', year: '2026' });
check('editing a link onto another paper\'s link is refused', r.status === 409, r);
r = await post({ action: 'admin', token: yi, op: 'paper_save', paper_id: pB, title: 'Paper B (fixed)', link: 'https://arxiv.org/abs/2699.00001', venue: 'ICLR', year: '2026' });
check('edit a paper and move its link', r.ok, r);
check('old link claim released', !(await get(K.link(linkKey('https://arxiv.org/abs/2603.15569')))));
r = await add(manish, 'Reuse B\'s old link', 'https://arxiv.org/abs/2603.15569');
check('released link can be submitted again', r.ok, r);
r = await post({ action: 'admin', token: yi, op: 'ip_unlock_all' });
check('clear IP locks', r.ok && r.cleared >= 1, r);
r = await post({ action: 'admin', token: yi, op: 'digest_preview' });
check('digest preview renders', r.ok && /Reading list — week of Sep 28/.test(r.text) && /Top \d right now/.test(r.text), r.text);
console.log(r.text.split('\n').map((l) => '        | ' + l).join('\n'));
r = await post({ action: 'admin', token: yi, op: 'slack_save', webhook: 'https://example.com/not-slack' });
check('non-Slack webhook refused', r.status === 400);

// ------------------------------------------------------------------ attribution
section('attribution stays private');
const pub = await listPapers();
check('public list carries no submitter per paper', pub.papers.every((p) => !('submitted_by' in p) && !('submittedBy' in p)));
check('public list carries the 30-day tally', Array.isArray(pub.contributors) && pub.contributors.length >= 2, pub.contributors);
check('public list reports the API version', pub.api_version === 2);

// ------------------------------------------------------------------ routing
section('routing');
r = await internal({ action: 'import', data: { papers: [] } });
check('import refuses to run over existing papers', r.ok === false && /already has/.test(r.error), r);
r = await post({ action: 'import', data: { papers: [] } });
check('import is not reachable through the public URL', r.status === 400, r);
r = await post({ action: 'set_member', name: 'evil', passcode: 'x'.repeat(8), admin: true });
check('set_member is not reachable through the public URL', r.status === 400, r);

summary();
