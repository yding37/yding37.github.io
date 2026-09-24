// Papers, votes, submissions, and read/archive state.

import { K, get, queryAll, transact, update, conditionFailures } from './db.mjs';
import {
  CONFIG, clock, weekOf, weekEnds, weekTtl, tidy, clip, newPaperId,
  normalizeLink, linkKey, HttpError,
} from './util.mjs';

export const STATES = ['active', 'read', 'archived'];
const pos = (n) => (n > 0 ? n : 0);
const neg = (n) => (n < 0 ? -n : 0);

// ---------------------------------------------------------------- reading
function shape(p, t) {
  const up = (t && t.up) || 0;
  const down = (t && t.down) || 0;
  return {
    id: p.sk,
    title: p.title || '',
    link: p.link || '',
    venue: p.venue || '',
    year: p.year || '',
    summary: p.summary || '',
    technical_focus: p.tags || '',
    submitted_at: p.submittedAt ? new Date(p.submittedAt).toISOString() : '',
    state: p.state || 'active',
    state_at: p.stateAt ? new Date(p.stateAt).toISOString() : '',
    state_by: p.stateBy || '',
    read: p.state === 'read',
    up, down, score: up - down,
  };
}

export async function loadPapers({ includeHidden = false } = {}) {
  const [papers, tallies] = await Promise.all([queryAll('PAPER'), queryAll('TALLY')]);
  const tally = new Map(tallies.map((t) => [t.sk, t]));
  return papers
    .filter((p) => includeHidden || !p.hidden)
    .map((p) => ({ raw: p, view: shape(p, tally.get(p.sk)) }));
}

/**
 * Public list. Per-paper attribution is deliberately absent: the record of who
 * submitted what stays in the table, and the page only sees a 30-day aggregate.
 */
export async function list() {
  const rows = await loadPapers();
  const since = clock.now() - CONFIG.CONTRIBUTOR_WINDOW_DAYS * 86400000;
  // Group by the stable member key, not the display name, so renaming "anjila" to
  // "Anjila" does not split one person into two entries. Show the newest spelling.
  const counts = new Map();
  for (const { raw } of rows) {
    if (!raw.submittedBy || !(raw.submittedAt >= since)) continue;
    const key = raw.submittedKey || raw.submittedBy.toLowerCase();
    const c = counts.get(key) || { name: raw.submittedBy, count: 0, at: 0 };
    c.count++;
    if (raw.submittedAt > c.at) { c.at = raw.submittedAt; c.name = raw.submittedBy; }
    counts.set(key, c);
  }
  const contributors = [...counts.values()].map(({ name, count }) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    ok: true,
    api_version: CONFIG.API_VERSION,
    week: weekOf(),
    papers: rows.map((r) => r.view),
    contributors,
    contributor_window_days: CONFIG.CONTRIBUTOR_WINDOW_DAYS,
  };
}

function quotaView(member, usage, week) {
  const u = usage || {};
  return {
    member: member.name,
    admin: !!member.admin,
    week,
    week_ends: weekEnds(week),
    upvotes_left: Math.max(0, CONFIG.UP_PER_WEEK - (u.up || 0)),
    downvotes_left: Math.max(0, CONFIG.DOWN_PER_WEEK - (u.down || 0)),
    upvotes_total: CONFIG.UP_PER_WEEK,
    downvotes_total: CONFIG.DOWN_PER_WEEK,
    submissions_left: Math.max(0, CONFIG.SUBS_PER_WEEK - (u.subs || 0)),
    submissions_total: CONFIG.SUBS_PER_WEEK,
  };
}

export async function quota(member, week = weekOf()) {
  return quotaView(member, await get(K.usage(week, member.sk), true), week);
}

/** The member's own holdings this week. Earlier weeks are not attributable. */
export async function me(member) {
  const week = weekOf();
  const [votes, usage] = await Promise.all([
    queryAll('VOTE#' + week, { prefix: member.sk + '#', consistent: true }),
    get(K.usage(week, member.sk), true),
  ]);
  const my_weights = {};
  for (const v of votes) if (v.weight) my_weights[v.paperId] = v.weight;
  return { ok: true, member: member.name, admin: !!member.admin, my_weights, me: quotaView(member, usage, week) };
}

// ---------------------------------------------------------------- voting
/**
 * Move the member's holding on a paper one step up or down.
 *
 * Everything this touches is keyed by the current week: the holding and the
 * budget. Last week's holdings live under a different partition key and cannot be
 * read or rewritten from here, so adding and removing votes this week has no path
 * to last week's numbers. What last week contributed is already in the paper's
 * running tally, which only ever receives deltas.
 *
 * The four writes (holding, budget, tally, paper still votable) commit together or
 * not at all. Each is conditioned on the values read, so a concurrent change from
 * another tab fails the condition and the step is recomputed.
 */
export async function vote(member, { paper_id, direction }) {
  const pid = String(paper_id || '').trim();
  const dir = String(direction || '').toLowerCase();
  if (!pid) throw new HttpError(400, 'Missing paper.');
  if (dir !== 'up' && dir !== 'down') throw new HttpError(400, 'Vote must be up or down.');

  for (let attempt = 0; attempt < 5; attempt++) {
    const week = weekOf();
    const [paper, holding, usage] = await Promise.all([
      get(K.paper(pid), true),
      get(K.vote(week, member.sk, pid), true),
      get(K.usage(week, member.sk), true),
    ]);
    if (!paper || paper.hidden) throw new HttpError(404, 'That paper is no longer on the list.');

    const held = (holding && holding.weight) || 0;
    const next = held + (dir === 'up' ? 1 : -1);
    const growing = Math.abs(next) > Math.abs(held);

    if (growing && (paper.state || 'active') !== 'active') {
      throw new HttpError(409, 'Voting is closed on read and archived papers. You can still take back votes you placed.');
    }

    const was = { up: (usage && usage.up) || 0, down: (usage && usage.down) || 0 };
    const now = { up: was.up - pos(held) + pos(next), down: was.down - neg(held) + neg(next) };
    if (now.up > CONFIG.UP_PER_WEEK) {
      throw new HttpError(409, 'You have used all ' + CONFIG.UP_PER_WEEK + ' upvotes for this week.',
        { me: quotaView(member, usage, week) });
    }
    if (now.down > CONFIG.DOWN_PER_WEEK) {
      throw new HttpError(409, 'You have used all ' + CONFIG.DOWN_PER_WEEK + ' downvotes for this week.',
        { me: quotaView(member, usage, week) });
    }

    const voteKey = K.vote(week, member.sk, pid);
    const holdingOp = next === 0
      ? { Delete: { Key: voteKey, ConditionExpression: 'weight = :held', ExpressionAttributeValues: { ':held': held } } }
      : {
          Put: {
            Item: { ...voteKey, weight: next, paperId: pid, ttl: weekTtl(week) },
            ConditionExpression: held === 0 ? 'attribute_not_exists(pk)' : 'weight = :held',
            ExpressionAttributeValues: held === 0 ? undefined : { ':held': held },
          },
        };

    const usageOp = {
      Update: {
        Key: K.usage(week, member.sk),
        UpdateExpression: 'SET #up = :nu, #down = :nd, subs = if_not_exists(subs, :zero), #ttl = :ttl',
        ConditionExpression: usage ? '#up = :ou AND #down = :od' : 'attribute_not_exists(pk)',
        ExpressionAttributeNames: { '#up': 'up', '#down': 'down', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':nu': now.up, ':nd': now.down, ':zero': 0, ':ttl': weekTtl(week),
          ...(usage ? { ':ou': was.up, ':od': was.down } : {}),
        },
      },
    };

    const tallyOp = {
      Update: {
        Key: K.tally(pid),
        UpdateExpression: 'ADD #up :du, #down :dd',
        ExpressionAttributeNames: { '#up': 'up', '#down': 'down' },
        ExpressionAttributeValues: { ':du': pos(next) - pos(held), ':dd': neg(next) - neg(held) },
      },
    };

    // The paper must still exist, be visible, and (if the holding is growing) be active.
    const paperCheck = {
      ConditionCheck: {
        Key: K.paper(pid),
        ConditionExpression: growing
          ? 'attribute_exists(pk) AND (attribute_not_exists(#hid) OR #hid = :f) AND (attribute_not_exists(#st) OR #st = :active)'
          : 'attribute_exists(pk)',
        // `hidden` and `state` are DynamoDB reserved words, so they must be aliased.
        ExpressionAttributeNames: growing ? { '#st': 'state', '#hid': 'hidden' } : undefined,
        ExpressionAttributeValues: growing ? { ':f': false, ':active': 'active' } : undefined,
      },
    };

    try {
      await transact([holdingOp, usageOp, tallyOp, paperCheck]);
    } catch (err) {
      if (conditionFailures(err)) continue;      // something moved underneath us; recompute
      throw err;
    }

    const t = await get(K.tally(pid), true);
    const up = (t && t.up) || 0;
    const down = (t && t.down) || 0;
    return {
      ok: true,
      paper_id: pid,
      action: next === 0 ? 'removed' : held === 0 ? 'added' : 'changed',
      up, down, score: up - down,
      my_weight: next,
      me: quotaView(member, { up: now.up, down: now.down, subs: (usage && usage.subs) || 0 }, week),
    };
  }
  throw new HttpError(409, 'That paper is busy. Try again.');
}

// ---------------------------------------------------------------- submitting
export async function submit(member, body) {
  const title = clip(tidy(body.title), 500);
  if (!title) throw new HttpError(400, 'A title is required.');
  const link = clip(normalizeLink(body.link), 2000);
  const lk = link ? linkKey(link) : '';

  if (lk) {
    const dup = await get(K.link(lk), true);
    if (dup) {
      const other = await get(K.paper(dup.paperId));
      throw new HttpError(409, 'That paper is already on the list' +
        (other && other.title ? ': "' + other.title + '".' : '.'));
    }
  }

  const week = weekOf();
  const id = newPaperId();
  const now = clock.now();
  const paper = {
    ...K.paper(id),
    title,
    link,
    linkKey: lk || undefined,
    venue: clip(tidy(body.venue), 200),
    year: clip(tidy(body.year), 10),
    summary: clip(String(body.summary || '').trim(), 10000),
    tags: clip(tidy(body.technical_focus), 300),
    submittedBy: member.name,
    submittedKey: member.sk,
    submittedAt: now,
    state: 'active',
  };

  const ops = [
    { Put: { Item: paper, ConditionExpression: 'attribute_not_exists(pk)' } },
    {
      Update: {
        Key: K.usage(week, member.sk),
        UpdateExpression: 'SET subs = if_not_exists(subs, :zero) + :one, #up = if_not_exists(#up, :zero), ' +
                          '#down = if_not_exists(#down, :zero), #ttl = :ttl',
        ConditionExpression: 'attribute_not_exists(pk) OR subs < :cap',
        ExpressionAttributeNames: { '#up': 'up', '#down': 'down', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':ttl': weekTtl(week), ':cap': CONFIG.SUBS_PER_WEEK },
      },
    },
    lk ? { Put: { Item: { ...K.link(lk), paperId: id }, ConditionExpression: 'attribute_not_exists(pk)' } } : null,
  ];

  try {
    await transact(ops);
  } catch (err) {
    const failed = conditionFailures(err);
    if (!failed) throw err;
    if (failed.includes(1)) {
      throw new HttpError(409, 'You have already submitted ' + CONFIG.SUBS_PER_WEEK + ' papers this week.',
        { me: await quota(member, week) });
    }
    if (failed.includes(2)) throw new HttpError(409, 'That paper is already on the list.');
    throw new HttpError(409, 'Could not save that paper. Try again.');
  }
  return { ok: true, id, me: await quota(member, week) };
}

// ---------------------------------------------------------------- read / archive
/**
 * Lab-wide. A paper is in exactly one of: active (the ranked list), read
 * (discussed at reading group), archived (shelved without reading).
 */
export async function setState(member, { paper_id, state }) {
  const pid = String(paper_id || '').trim();
  const s = String(state || '').toLowerCase();
  if (!pid) throw new HttpError(400, 'Missing paper.');
  if (!STATES.includes(s)) throw new HttpError(400, 'State must be active, read, or archived.');
  const now = clock.now();
  try {
    const p = await update({
      Key: K.paper(pid),
      UpdateExpression: s === 'active'
        ? 'SET #st = :s REMOVE stateAt, stateBy'
        : 'SET #st = :s, stateAt = :at, stateBy = :by',
      ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(#hid) OR #hid = :f)',
      ExpressionAttributeNames: { '#st': 'state', '#hid': 'hidden' },
      ExpressionAttributeValues: s === 'active' ? { ':s': s, ':f': false } : { ':s': s, ':at': now, ':by': member.name, ':f': false },
    });
    return {
      ok: true, paper_id: pid, state: p.state,
      state_at: p.stateAt ? new Date(p.stateAt).toISOString() : '',
      state_by: p.stateBy || '',
    };
  } catch (err) {
    if (conditionFailures(err)) throw new HttpError(404, 'That paper is no longer on the list.');
    throw err;
  }
}
