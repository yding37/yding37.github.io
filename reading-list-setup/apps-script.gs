/*******************************************************************************
 * Lab Paper Reading List — Google Apps Script backend
 *
 * Backing store: the Google Sheet whose ID is in CONFIG.SPREADSHEET_ID.
 * Front end: /reading-list/ on yding37.github.io
 *
 * FIRST-TIME SETUP
 *   1. Run setup() once from the Apps Script editor. It builds the tabs and
 *      generates the signing secret.
 *   2. Deploy > New deployment > Web app
 *        Execute as:     Me
 *        Who has access: Anyone
 *   3. Copy the /exec URL into _config.yml as reading_list_api.
 ******************************************************************************/

var CONFIG = {
  SPREADSHEET_ID: '1kS_6cFw4avyNIOd0ldB1d8QcOxI2KH5R87cbAZa-Ayw',
  UPVOTES_PER_WEEK: 3,
  DOWNVOTES_PER_WEEK: 3,
  SUBMISSIONS_PER_WEEK: 10,
  TOKEN_TTL_DAYS: 30,
  LOGIN_MAX_ATTEMPTS: 3,        // wrong passcodes before the account locks
  LOGIN_LOCKOUT_MINUTES: 15,
  TIMEZONE: 'America/New_York'   // week boundaries are Monday 00:00 in this zone
};

var TAB = { PAPERS: 'Papers', MEMBERS: 'Members', VOTES: 'Votes' };

var PAPER_COLS = ['id', 'title', 'link', 'venue', 'year', 'summary',
                  'technical_focus', 'submitted_by', 'submitted_at', 'status',
                  'read_at', 'read_by', 'carried_up', 'carried_down'];
var MEMBER_COLS = ['name', 'email', 'passcode', 'active',
                   'failed_attempts', 'locked_until'];
var VOTE_COLS = ['paper_id', 'member', 'direction', 'week', 'updated_at', 'count'];

// How far back the "papers added" tally on the page reaches.
var CONTRIBUTOR_WINDOW_DAYS = 30;

// Weekly Slack digest. The reading group meets Wednesday, so the digest goes out
// Friday covering that vote week (Monday 00:00 through the moment it runs).
var DIGEST = {
  DAY: ScriptApp.WeekDay.FRIDAY,
  HOUR: 9,                                  // 9am in CONFIG.TIMEZONE
  TOP_N: 5,
  PAGE_URL: 'https://yding37.github.io/reading-list/'
};

/* ============================== SETUP ==================================== */

function setup() {
  var ss = book();
  ensureTab(ss, TAB.PAPERS, PAPER_COLS);
  ensureTab(ss, TAB.MEMBERS, MEMBER_COLS);
  ensureTab(ss, TAB.VOTES, VOTE_COLS);

  // Keep the week column as plain text so Sheets does not coerce it into a Date.
  var votes = ss.getSheetByName(TAB.VOTES);
  votes.getRange(1, 4, votes.getMaxRows(), 1).setNumberFormat('@');

  // Same for passcodes, so an all-digit one is not stored as a number.
  var mem = ss.getSheetByName(TAB.MEMBERS);
  mem.getRange(1, 3, mem.getMaxRows(), 1).setNumberFormat('@');

  // Remove the default empty "Sheet1" if it is still there and unused.
  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);

  // Seed one member row so the login can be tested immediately.
  var members = ss.getSheetByName(TAB.MEMBERS);
  if (members.getLastRow() < 2) {
    members.appendRow(['Yi Ding', 'yding37@gmail.com', 'change-me', 'yes', '', '']);
  }

  // Signing secret for login tokens.
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('AUTH_SECRET')) {
    props.setProperty('AUTH_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }

  ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);
  return 'Setup complete. Tabs ready: Papers, Members, Votes.';
}

function ensureTab(ss, name, cols) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  var head = sh.getRange(1, 1, 1, cols.length);
  head.setValues([cols]).setFontWeight('bold').setBackground('#f1f3f4');
  sh.setFrozenRows(1);
  if (sh.getMaxColumns() > cols.length) {
    sh.deleteColumns(cols.length + 1, sh.getMaxColumns() - cols.length);
  }
  sh.autoResizeColumns(1, cols.length);
  return sh;
}

function book() {
  try {
    var active = SpreadsheetApp.getActive();
    if (active) return active;
  } catch (err) { /* not container-bound; fall through */ }
  return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
}

/* ============================== ROUTING ================================== */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;
  try {
    out = route(p.action || 'list', p, p.token);
  } catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return reply(out, p.callback);
}

function doPost(e) {
  var body = {};
  try {
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
  } catch (err) { /* fall through to bad-request below */ }
  var out;
  try {
    out = route(body.action || '', body, body.token);
  } catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return reply(out, null);
}

function route(action, params, token) {
  switch (action) {
    case 'list':   return handleList(token);
    case 'login':  return handleLogin(params);
    case 'vote':   return handleVote(params, token);
    case 'submit': return handleSubmit(params, token);
    case 'lookup': return handleLookup(params, token);
    case 'mark':   return handleMark(params, token);
    case 'me':     return handleMe(token);
    case 'ping':   return { ok: true, pong: true, week: currentWeek() };
    default:       return { ok: false, error: 'Unknown action: ' + action };
  }
}

function reply(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================== HANDLERS ================================= */

function handleList(token) {
  var ss = book();
  var papers = readTab(ss, TAB.PAPERS, PAPER_COLS);
  var votes = readTab(ss, TAB.VOTES, VOTE_COLS);

  var tally = {};
  var mine = {};
  var member = token ? verifyToken(token) : null;
  var week = currentWeek();

  for (var i = 0; i < votes.length; i++) {
    var v = votes[i];
    var w = voteWeight(v);
    if (!w) continue;
    var pid = String(v.paper_id);
    if (!tally[pid]) tally[pid] = { up: 0, down: 0 };
    if (w > 0) tally[pid].up += w;
    else tally[pid].down += -w;
    // Only the current week is attributable; earlier weeks are anonymous by design.
    if (member && sameName(v.member, member) && asWeekKey(v.week) === week) mine[pid] = w;
  }

  // Who added what is kept in the Papers tab but is not published per paper.
  // The page shows only an aggregate of the last 30 days.
  var since = Date.now() - CONTRIBUTOR_WINDOW_DAYS * 86400000;
  var counts = {};

  var out = [];
  for (var j = 0; j < papers.length; j++) {
    var p = papers[j];
    if (!p.id || !p.title) continue;
    if (String(p.status || '').toLowerCase() === 'hidden') continue;
    var t = tally[String(p.id)] || { up: 0, down: 0 };
    var carried = carriedOf(p);
    t = { up: t.up + carried.up, down: t.down + carried.down };

    var who = String(p.submitted_by || '').trim();
    var at = p.submitted_at instanceof Date ? p.submitted_at.getTime() : Date.parse(p.submitted_at);
    if (who && !isNaN(at) && at >= since) {
      counts[who] = (counts[who] || 0) + 1;
    }

    out.push({
      id: String(p.id),
      title: String(p.title),
      link: String(p.link || ''),
      venue: String(p.venue || ''),
      year: p.year === '' || p.year === null ? '' : String(p.year),
      summary: String(p.summary || ''),
      technical_focus: String(p.technical_focus || ''),
      submitted_at: isoDate(p.submitted_at),
      read: !!p.read_at,
      read_at: isoDate(p.read_at),
      read_by: String(p.read_by || ''),
      up: t.up,
      down: t.down,
      score: t.up - t.down,
      my_weight: mine[String(p.id)] || 0
    });
  }

  var contributors = [];
  for (var who2 in counts) {
    if (Object.prototype.hasOwnProperty.call(counts, who2)) {
      contributors.push({ name: who2, count: counts[who2] });
    }
  }
  contributors.sort(function (a, b) {
    if (b.count !== a.count) return b.count - a.count;
    return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
  });

  var res = {
    ok: true,
    papers: out,
    contributors: contributors,
    contributor_window_days: CONTRIBUTOR_WINDOW_DAYS,
    week: currentWeek()
  };
  if (member) res.me = quotaFor(ss, member, papers, votes);
  return res;
}

/*
 * Apps Script never sees the caller's IP, and anything the browser reports about its
 * own address is attacker-controlled, so the limit is enforced per account instead:
 * CONFIG.LOGIN_MAX_ATTEMPTS wrong passcodes lock that member out for
 * CONFIG.LOGIN_LOCKOUT_MINUTES. An attacker rotating IPs gains nothing. The counter
 * and the unlock time are written to the Members tab so they can be seen and cleared
 * by hand.
 */
function handleLogin(params) {
  var name = String(params.name || '').trim();
  var passcode = String(params.passcode || '').trim();
  if (!name || !passcode) return { ok: false, error: 'Enter your name and passcode.' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = book();
    var sh = ss.getSheetByName(TAB.MEMBERS);
    var members = readTab(ss, TAB.MEMBERS, MEMBER_COLS);

    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      var nameMatch = sameName(m.name, name) ||
                      (m.email && String(m.email).trim().toLowerCase() === name.toLowerCase());
      if (!nameMatch) continue;

      if (String(m.active || 'yes').trim().toLowerCase() === 'no') {
        return { ok: false, error: 'That account is not active. Ask Yi to reactivate it.' };
      }

      var now = Date.now();
      var lockedUntil = asTime(m.locked_until);
      if (lockedUntil && lockedUntil > now) {
        return {
          ok: false,
          locked: true,
          error: 'Too many wrong passcodes. This account is locked for another ' +
                 minutesUntil(lockedUntil) + '. Ask Yi if you need it cleared sooner.'
        };
      }

      // An expired lock is a clean slate.
      var fails = lockedUntil && lockedUntil <= now ? 0 : toCount(m.failed_attempts);

      if (String(m.passcode).trim() !== passcode) {
        fails++;
        if (fails >= CONFIG.LOGIN_MAX_ATTEMPTS) {
          var until = new Date(now + CONFIG.LOGIN_LOCKOUT_MINUTES * 60000);
          setLoginState(sh, m._row, 0, until);
          return {
            ok: false,
            locked: true,
            error: 'Too many wrong passcodes. This account is locked for ' +
                   CONFIG.LOGIN_LOCKOUT_MINUTES + ' minutes.'
          };
        }
        setLoginState(sh, m._row, fails, '');
        var left = CONFIG.LOGIN_MAX_ATTEMPTS - fails;
        return {
          ok: false,
          attempts_left: left,
          error: 'Wrong passcode. ' + left + (left === 1 ? ' attempt' : ' attempts') +
                 ' left before this account locks for ' + CONFIG.LOGIN_LOCKOUT_MINUTES + ' minutes.'
        };
      }

      if (fails || lockedUntil) setLoginState(sh, m._row, 0, '');
      var canonical = String(m.name).trim();
      return {
        ok: true,
        token: makeToken(canonical),
        member: canonical,
        me: quotaFor(ss, canonical, null, null)
      };
    }
    return { ok: false, error: 'No lab member found with that name.' };
  } finally {
    lock.releaseLock();
  }
}

function setLoginState(sheet, row, fails, until) {
  sheet.getRange(row, 5, 1, 2).setValues([[fails || '', until || '']]);
}

function toCount(value) {
  var n = Number(value);
  return isNaN(n) || n < 0 ? 0 : Math.floor(n);
}

function asTime(value) {
  if (!value) return 0;
  if (value && typeof value.getTime === 'function') return value.getTime();
  var t = Date.parse(String(value));
  return isNaN(t) ? 0 : t;
}

function minutesUntil(ms) {
  var mins = Math.ceil((ms - Date.now()) / 60000);
  if (mins < 1) return 'less than a minute';
  return mins + (mins === 1 ? ' minute' : ' minutes');
}

/** Clear every lockout. Run from the editor if someone is stuck. */
function unlockAllMembers() {
  var ss = book();
  var sh = ss.getSheetByName(TAB.MEMBERS);
  var members = readTab(ss, TAB.MEMBERS, MEMBER_COLS);
  for (var i = 0; i < members.length; i++) setLoginState(sh, members[i]._row, 0, '');
  return 'Cleared lockouts for ' + members.length + ' member(s).';
}

function handleMe(token) {
  var member = verifyToken(token);
  if (!member) return { ok: false, error: 'Session expired. Sign in again.', expired: true };
  var ss = book();
  var votes = readTab(ss, TAB.VOTES, VOTE_COLS);
  var mine = {};
  var thisWeek = currentWeek();
  for (var i = 0; i < votes.length; i++) {
    var v = votes[i];
    if (!sameName(v.member, member)) continue;
    if (asWeekKey(v.week) !== thisWeek) continue;   // past weeks are no longer yours
    var w = voteWeight(v);
    if (w) mine[String(v.paper_id)] = w;
  }
  return {
    ok: true,
    member: member,
    my_weights: mine,
    me: quotaFor(ss, member, null, votes)
  };
}

/**
 * The arrows adjust the member's allocation on a paper by one step, so several
 * votes can be stacked on the same paper. The ceiling is whatever remains of that
 * week's budget, checked against the member's other papers plus the new holding.
 *
 * Because an allocation is stamped with the week it was last touched, adjusting a
 * holding from an earlier week re-books the whole of it against the current week.
 * That errs toward spending, never toward exceeding a budget.
 */
function handleVote(params, token) {
  var member = verifyToken(token);
  if (!member) return { ok: false, error: 'Session expired. Sign in again.', expired: true };

  var paperId = String(params.paper_id || '').trim();
  var dir = String(params.direction || '').toLowerCase();
  if (!paperId) return { ok: false, error: 'Missing paper.' };
  if (dir !== 'up' && dir !== 'down') return { ok: false, error: 'Vote must be up or down.' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = book();
    archiveOldVotes(ss);            // finished weeks become anonymous before we touch anything

    var papers = readTab(ss, TAB.PAPERS, PAPER_COLS);
    var exists = false;
    var paperRow = null;
    for (var i = 0; i < papers.length; i++) {
      if (String(papers[i].id) === paperId) { exists = true; paperRow = papers[i]; break; }
    }
    if (!exists) return { ok: false, error: 'That paper is no longer on the list.' };

    var sh = ss.getSheetByName(TAB.VOTES);
    var votes = readTab(ss, TAB.VOTES, VOTE_COLS);
    var week = currentWeek();

    var rowIndex = -1;
    var held = 0;
    for (var j = 0; j < votes.length; j++) {
      if (String(votes[j].paper_id) === paperId && sameName(votes[j].member, member)) {
        rowIndex = votes[j]._row;
        held = voteWeight(votes[j]);
        break;
      }
    }

    var next = held + (dir === 'up' ? 1 : -1);
    var elsewhere = countVotes(votes, member, week, paperId);
    var wouldUseUp = elsewhere.up + Math.max(next, 0);
    var wouldUseDown = elsewhere.down + Math.max(-next, 0);

    if (wouldUseUp > CONFIG.UPVOTES_PER_WEEK) {
      return {
        ok: false,
        error: 'You have used all ' + CONFIG.UPVOTES_PER_WEEK + ' upvotes for this week.',
        me: quotaFor(ss, member, papers, votes)
      };
    }
    if (wouldUseDown > CONFIG.DOWNVOTES_PER_WEEK) {
      return {
        ok: false,
        error: 'You have used all ' + CONFIG.DOWNVOTES_PER_WEEK + ' downvotes for this week.',
        me: quotaFor(ss, member, papers, votes)
      };
    }

    var newDir = next > 0 ? 'up' : (next < 0 ? 'down' : 'none');
    var newCount = Math.abs(next);
    var stampWeek = next === 0 ? '' : week;
    var rowValues = [paperId, member, newDir, stampWeek, new Date(), newCount || ''];

    if (rowIndex > 0) {
      sh.getRange(rowIndex, 1, 1, VOTE_COLS.length).setValues([rowValues]);
    } else {
      sh.appendRow(rowValues);
    }

    var fresh = readTab(ss, TAB.VOTES, VOTE_COLS);
    var carried = carriedOf(paperRow);
    var t = { up: carried.up, down: carried.down };
    for (var k = 0; k < fresh.length; k++) {
      if (String(fresh[k].paper_id) !== paperId) continue;
      var w = voteWeight(fresh[k]);
      if (w > 0) t.up += w;
      else if (w < 0) t.down += -w;
    }

    return {
      ok: true,
      action: next === 0 ? 'removed' : (held === 0 ? 'added' : 'changed'),
      paper_id: paperId,
      up: t.up,
      down: t.down,
      score: t.up - t.down,
      my_weight: next,
      me: quotaFor(ss, member, papers, fresh)
    };
  } finally {
    lock.releaseLock();
  }
}

function handleSubmit(params, token) {
  var member = verifyToken(token);
  if (!member) return { ok: false, error: 'Session expired. Sign in again.', expired: true };

  var title = String(params.title || '').trim();
  var link = String(params.link || '').trim();
  if (!title) return { ok: false, error: 'A title is required.' };
  if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = book();
    var papers = readTab(ss, TAB.PAPERS, PAPER_COLS);
    var week = currentWeek();

    var usedSubs = 0;
    for (var i = 0; i < papers.length; i++) {
      var p = papers[i];
      if (!sameName(p.submitted_by, member)) continue;
      if (weekOf(p.submitted_at) === week) usedSubs++;
      // Reject an exact duplicate link that is already on the list.
      if (link && String(p.link || '').trim().toLowerCase() === link.toLowerCase()) {
        return { ok: false, error: 'That link is already on the reading list.' };
      }
    }
    if (usedSubs >= CONFIG.SUBMISSIONS_PER_WEEK) {
      return {
        ok: false,
        error: 'You have already submitted ' + CONFIG.SUBMISSIONS_PER_WEEK + ' papers this week.',
        me: quotaFor(ss, member, papers, null)
      };
    }

    var id = 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    ss.getSheetByName(TAB.PAPERS).appendRow([
      id,
      title,
      link,
      String(params.venue || '').trim(),
      String(params.year || '').trim(),
      String(params.summary || '').trim(),
      String(params.technical_focus || '').trim(),
      member,
      new Date(),
      'published'
    ]);

    var after = readTab(ss, TAB.PAPERS, PAPER_COLS);
    return { ok: true, id: id, me: quotaFor(ss, member, after, null) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Marking a paper read is a lab-wide action, not a personal one: the reading group
 * covers papers together, so a paper leaves the queue for everyone. Any member can
 * mark or unmark, and the Sheet records who did it and when.
 */
function handleMark(params, token) {
  var member = verifyToken(token);
  if (!member) return { ok: false, error: 'Session expired. Sign in again.', expired: true };

  var paperId = String(params.paper_id || '').trim();
  if (!paperId) return { ok: false, error: 'Missing paper.' };
  var wantRead = String(params.read) !== 'false';

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = book();
    var sh = ss.getSheetByName(TAB.PAPERS);
    var papers = readTab(ss, TAB.PAPERS, PAPER_COLS);

    for (var i = 0; i < papers.length; i++) {
      if (String(papers[i].id) !== paperId) continue;
      var row = papers[i]._row;
      var readAt = wantRead ? new Date() : '';
      var readBy = wantRead ? member : '';
      sh.getRange(row, 11, 1, 2).setValues([[readAt, readBy]]);
      return {
        ok: true,
        paper_id: paperId,
        read: wantRead,
        read_at: wantRead ? isoDate(readAt) : '',
        read_by: readBy
      };
    }
    return { ok: false, error: 'That paper is no longer on the list.' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Collapse finished weeks into anonymous per-paper totals.
 *
 * Once a week is over, who voted for what is nobody's business and nothing needs it:
 * budgets only ever look at the current week, and a member cannot adjust a holding
 * from a past week anyway. So the rows are folded into the paper's carried_up /
 * carried_down and deleted, which keeps the Votes tab from becoming a permanent
 * record of everyone's opinions.
 *
 * A paper's score is unaffected by whether this has run yet: scores add carried
 * totals to whatever rows are still present. That makes the timing of this a
 * housekeeping detail rather than something scores depend on.
 */
function archiveOldVotes(ss) {
  var week = currentWeek();
  var votes = readTab(ss, TAB.VOTES, VOTE_COLS);
  var stale = [];
  var add = {};

  for (var i = 0; i < votes.length; i++) {
    var v = votes[i];
    if (asWeekKey(v.week) === week) continue;      // this week stays attributed
    stale.push(v._row);
    var w = voteWeight(v);
    if (!w) continue;                              // spent-out rows just go
    var pid = String(v.paper_id);
    if (!add[pid]) add[pid] = { up: 0, down: 0 };
    if (w > 0) add[pid].up += w;
    else add[pid].down += -w;
  }
  if (!stale.length) return 0;

  var papersSheet = ss.getSheetByName(TAB.PAPERS);
  var papers = readTab(ss, TAB.PAPERS, PAPER_COLS);
  for (var j = 0; j < papers.length; j++) {
    var p = papers[j];
    var extra = add[String(p.id)];
    if (!extra) continue;
    var up = toCount(p.carried_up) + extra.up;
    var down = toCount(p.carried_down) + extra.down;
    papersSheet.getRange(p._row, 13, 1, 2).setValues([[up || '', down || '']]);
  }

  // Delete from the bottom so earlier row numbers stay valid.
  var votesSheet = ss.getSheetByName(TAB.VOTES);
  stale.sort(function (a, b) { return b - a; });
  for (var k = 0; k < stale.length; k++) votesSheet.deleteRow(stale[k]);

  return stale.length;
}

/** Run by hand from the editor if you want to compact the Votes tab now. */
function archiveOldVotesNow() {
  return 'Archived ' + archiveOldVotes(book()) + ' row(s) from finished weeks.';
}

/** Votes still attributed to a member, plus the anonymous carried totals. */
function carriedOf(p) {
  return { up: toCount(p.carried_up), down: toCount(p.carried_down) };
}

/* ============================== QUOTAS =================================== */

function quotaFor(ss, member, papers, votes) {
  if (!papers) papers = readTab(ss, TAB.PAPERS, PAPER_COLS);
  if (!votes) votes = readTab(ss, TAB.VOTES, VOTE_COLS);
  var week = currentWeek();
  var used = countVotes(votes, member, week);

  var subs = 0;
  for (var i = 0; i < papers.length; i++) {
    if (sameName(papers[i].submitted_by, member) && weekOf(papers[i].submitted_at) === week) subs++;
  }

  return {
    member: member,
    week: week,
    week_ends: weekEnds(week),
    upvotes_left: Math.max(0, CONFIG.UPVOTES_PER_WEEK - used.up),
    downvotes_left: Math.max(0, CONFIG.DOWNVOTES_PER_WEEK - used.down),
    upvotes_total: CONFIG.UPVOTES_PER_WEEK,
    downvotes_total: CONFIG.DOWNVOTES_PER_WEEK,
    submissions_left: Math.max(0, CONFIG.SUBMISSIONS_PER_WEEK - subs),
    submissions_total: CONFIG.SUBMISSIONS_PER_WEEK
  };
}

/**
 * A member's holding on one paper, as a signed integer. Members may stack several
 * votes on the same paper, so a row carries a count as well as a direction. Rows
 * written before stacking existed have no count and are worth one.
 */
function voteWeight(v) {
  var d = String(v.direction || '').toLowerCase();
  if (d !== 'up' && d !== 'down') return 0;
  var n = Number(v.count);
  if (isNaN(n) || n < 1) n = 1;
  n = Math.floor(n);
  return d === 'up' ? n : -n;
}

/** Votes a member has committed in the given week, summed rather than counted. */
function countVotes(votes, member, week, skipPaperId) {
  var used = { up: 0, down: 0 };
  for (var i = 0; i < votes.length; i++) {
    var v = votes[i];
    if (!sameName(v.member, member)) continue;
    if (asWeekKey(v.week) !== week) continue;
    if (skipPaperId != null && String(v.paper_id) === String(skipPaperId)) continue;
    var w = voteWeight(v);
    if (w > 0) used.up += w;
    else if (w < 0) used.down += -w;
  }
  return used;
}

/* ============================== SHEET I/O ================================ */

function readTab(ss, name, cols) {
  var sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '". Run setup() once.');
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var row = { _row: i + 2 };
    var blank = true;
    for (var c = 0; c < cols.length; c++) {
      row[cols[c]] = values[i][c];
      if (values[i][c] !== '' && values[i][c] !== null) blank = false;
    }
    if (!blank) rows.push(row);
  }
  return rows;
}

/* ============================== AUTH ===================================== */

function secret() {
  var s = PropertiesService.getScriptProperties().getProperty('AUTH_SECRET');
  if (!s) throw new Error('AUTH_SECRET is not set. Run setup() once.');
  return s;
}

function signPayload(payload) {
  var raw = Utilities.computeHmacSha256Signature(payload, secret());
  return Utilities.base64EncodeWebSafe(raw).replace(/=+$/, '');
}

function makeToken(name) {
  var expires = Date.now() + CONFIG.TOKEN_TTL_DAYS * 86400000;
  var payload = Utilities.base64EncodeWebSafe(name).replace(/=+$/, '') + '.' + expires;
  return payload + '.' + signPayload(payload);
}

function verifyToken(token) {
  if (!token) return null;
  var parts = String(token).split('.');
  if (parts.length !== 3) return null;
  var payload = parts[0] + '.' + parts[1];
  if (signPayload(payload) !== parts[2]) return null;
  if (Number(parts[1]) < Date.now()) return null;
  try {
    return Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
  } catch (err) {
    return null;
  }
}

/* ============================== LOOKUP =================================== */
/*
 * Given a paper link, try to recover title, venue, year and abstract.
 * Tried in order: arXiv API, Crossref by DOI, OpenAlex by DOI (mainly for the
 * abstract Crossref often lacks), then the page's own citation meta tags.
 * Every step is best effort; whatever is missing is left for the member to type.
 */

function handleLookup(params, token) {
  var member = verifyToken(token);
  if (!member) return { ok: false, error: 'Session expired. Sign in again.', expired: true };

  var url = String(params.link || '').trim();
  if (!url) return { ok: false, error: 'Paste a link first.' };
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  var meta = null;
  var source = '';

  var arx = arxivIdFrom(url);
  if (arx) {
    meta = fromArxiv(arx);
    if (meta) source = 'arXiv';
  }

  var orId = openReviewIdFrom(url);
  if (orId && (!meta || !meta.title)) {
    var or_ = fromOpenReview(orId);
    if (or_) { meta = mergeMeta(meta, or_); source = source || 'OpenReview'; }
  }

  if (!meta || !meta.abstract || !meta.title) {
    var doi = doiFrom(url);
    if (doi) {
      var cr = fromCrossref(doi);
      if (cr) { meta = mergeMeta(meta, cr); source = source || 'Crossref'; }
      if (!meta || !meta.abstract) {
        var oa = fromOpenAlex('doi:' + doi);
        if (oa) { meta = mergeMeta(meta, oa); source = source || 'OpenAlex'; }
      }
    }
  }

  if (!meta || !meta.title) {
    var pm = fromPageMeta(url);
    if (pm) { meta = mergeMeta(meta, pm); source = source || 'page metadata'; }
  }

  if (!meta || (!meta.title && !meta.abstract)) {
    return {
      ok: false,
      link: url,
      error: 'Could not read that page. Fill the fields in by hand.'
    };
  }

  return {
    ok: true,
    link: url,
    source: source,
    title: meta.title || '',
    venue: meta.venue || '',
    year: meta.year || '',
    abstract: meta.abstract || ''
  };
}

/** Later sources fill gaps only; they never overwrite something already found. */
function mergeMeta(base, extra) {
  if (!base) return extra;
  if (!extra) return base;
  var keys = ['title', 'venue', 'year', 'abstract'];
  for (var i = 0; i < keys.length; i++) {
    if (!base[keys[i]] && extra[keys[i]]) base[keys[i]] = extra[keys[i]];
  }
  return base;
}

function arxivIdFrom(url) {
  var m = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i.exec(url);
  if (m) return m[1];
  m = /arxiv\.org\/(?:abs|pdf)\/([a-z\-]+(?:\.[A-Za-z]{2})?\/\d{7})/i.exec(url);
  if (m) return m[1];
  m = /^\s*(?:arxiv:)?(\d{4}\.\d{4,5})\s*$/i.exec(url);
  return m ? m[1] : null;
}

function fromArxiv(id) {
  var xml = fetchText('https://export.arxiv.org/api/query?max_results=1&id_list=' +
                      encodeURIComponent(id));
  if (!xml) return null;
  try {
    var atom = XmlService.getNamespace('http://www.w3.org/2005/Atom');
    var arxiv = XmlService.getNamespace('http://arxiv.org/schemas/atom');
    var entry = XmlService.parse(xml).getRootElement().getChild('entry', atom);
    if (!entry) return null;

    var published = entry.getChildText('published', atom) || '';
    var journal = entry.getChildText('journal_ref', arxiv) || '';
    var comment = entry.getChildText('comment', arxiv) || '';

    return {
      title: tidy(entry.getChildText('title', atom)),
      venue: tidy(journal) || venueFromComment(comment) || 'arXiv',
      year: published.slice(0, 4),
      abstract: tidy(entry.getChildText('summary', atom))
    };
  } catch (err) {
    return null;
  }
}

/** arXiv comments often read "Accepted at NeurIPS 2026" and that is the real venue. */
function venueFromComment(comment) {
  if (!comment) return '';
  var m = /(?:accepted|to appear|published|camera[- ]ready)[^.;]*?\b(?:at|in|to|by)\b\s*([^.;,]{2,60})/i.exec(comment);
  return m ? tidy(m[1]) : '';
}

function openReviewIdFrom(url) {
  var m = /openreview\.net\/(?:forum|pdf|references)\?[^#]*\bid=([A-Za-z0-9_\-]+)/i.exec(url);
  return m ? m[1] : null;
}

/**
 * OpenReview has two API generations and a paper may live on either. api2 wraps
 * every field as {value: ...}; api1 stores the value directly.
 */
function fromOpenReview(id) {
  var endpoints = [
    'https://api2.openreview.net/notes?forum=' + encodeURIComponent(id),
    'https://api.openreview.net/notes?forum=' + encodeURIComponent(id),
    'https://api2.openreview.net/notes?id=' + encodeURIComponent(id),
    'https://api.openreview.net/notes?id=' + encodeURIComponent(id)
  ];
  for (var i = 0; i < endpoints.length; i++) {
    var data = fetchJson(endpoints[i]);
    if (!data || !data.notes || !data.notes.length) continue;
    var content = data.notes[0].content || {};
    var title = orField(content.title);
    if (!title) continue;
    var venue = orField(content.venue) || orField(content.venueid) || 'OpenReview';
    var year = /(19|20)\d{2}/.exec(venue || '');
    return {
      title: tidy(title),
      venue: tidy(venue),
      year: year ? year[0] : '',
      abstract: tidy(orField(content.abstract))
    };
  }
  return null;
}

function orField(field) {
  if (field == null) return '';
  if (typeof field === 'object' && 'value' in field) return String(field.value || '');
  return String(field);
}

function doiFrom(url) {
  var text = url;
  try { text = decodeURIComponent(url); } catch (err) { /* keep the raw string */ }
  var m = /(10\.\d{4,9}\/[^\s"'<>&?#]+)/i.exec(text);
  return m ? m[1].replace(/[).,;:]+$/, '') : null;
}

function fromCrossref(doi) {
  var data = fetchJson('https://api.crossref.org/works/' + encodeURIComponent(doi));
  if (!data || !data.message) return null;
  var m = data.message;

  var venue = pickFirst(m['container-title']) || pickFirst(m['short-container-title']) || '';
  if (!venue && m.event && m.event.name) venue = m.event.name;

  var year = '';
  var issued = m.issued && m.issued['date-parts'] && m.issued['date-parts'][0];
  if (issued && issued[0]) year = String(issued[0]);

  return {
    title: tidy(pickFirst(m.title)),
    venue: tidy(venue),
    year: year,
    abstract: stripJats(m.abstract || '')
  };
}

function fromOpenAlex(id) {
  var data = fetchJson('https://api.openalex.org/works/' + encodeURIComponent(id));
  if (!data || !data.id) return null;
  var venue = '';
  if (data.primary_location && data.primary_location.source) {
    venue = data.primary_location.source.display_name || '';
  }
  return {
    title: tidy(data.display_name),
    venue: tidy(venue),
    year: data.publication_year ? String(data.publication_year) : '',
    abstract: fromInvertedIndex(data.abstract_inverted_index)
  };
}

/** OpenAlex stores abstracts as {word: [positions]}. Put the words back in order. */
function fromInvertedIndex(index) {
  if (!index) return '';
  var words = [];
  for (var word in index) {
    if (!Object.prototype.hasOwnProperty.call(index, word)) continue;
    var at = index[word];
    for (var i = 0; i < at.length; i++) words[at[i]] = word;
  }
  return tidy(words.join(' '));
}

function fromPageMeta(url) {
  var html = fetchText(url);
  if (!html) return null;

  var title = metaContent(html, 'citation_title') ||
              metaContent(html, 'dc.title') ||
              metaContent(html, 'og:title') ||
              tagText(html, 'title');
  var venue = metaContent(html, 'citation_journal_title') ||
              metaContent(html, 'citation_conference_title') ||
              metaContent(html, 'citation_inbook_title') ||
              metaContent(html, 'dc.source') ||
              metaContent(html, 'og:site_name');
  var date  = metaContent(html, 'citation_publication_date') ||
              metaContent(html, 'citation_date') ||
              metaContent(html, 'citation_online_date') ||
              metaContent(html, 'dc.date') ||
              metaContent(html, 'article:published_time');
  var abs   = metaContent(html, 'citation_abstract') ||
              metaContent(html, 'dc.description') ||
              metaContent(html, 'og:description') ||
              metaContent(html, 'description');

  var year = '';
  var ym = /(19|20)\d{2}/.exec(date || '');
  if (ym) year = ym[0];

  if (!title && !abs) return null;
  return { title: tidy(title), venue: tidy(venue), year: year, abstract: tidy(abs) };
}

/* ---------- fetch and parsing helpers ---------- */

function fetchText(url) {
  try {
    var res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LabReadingList/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8'
      }
    });
    if (res.getResponseCode() >= 400) return null;
    return res.getContentText();
  } catch (err) {
    return null;
  }
}

function fetchJson(url) {
  var text = fetchText(url);
  if (!text) return null;
  try { return JSON.parse(text); } catch (err) { return null; }
}

function metaContent(html, name) {
  var tags = html.match(/<meta\b[^>]*>/gi);
  if (!tags) return '';
  var wanted = String(name).toLowerCase();
  for (var i = 0; i < tags.length; i++) {
    var key = attrValue(tags[i], 'name') || attrValue(tags[i], 'property');
    if (key && key.toLowerCase() === wanted) {
      var content = attrValue(tags[i], 'content');
      if (content) return decodeEntities(content);
    }
  }
  return '';
}

function attrValue(tag, attr) {
  var re = new RegExp(attr + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
  var m = re.exec(tag);
  if (!m) return '';
  return m[1] != null ? m[1] : (m[2] != null ? m[2] : (m[3] || ''));
}

function tagText(html, tag) {
  var re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  var m = re.exec(html);
  return m ? decodeEntities(m[1]) : '';
}

/** Crossref returns abstracts as JATS XML. Keep the prose. */
function stripJats(text) {
  if (!text) return '';
  return tidy(decodeEntities(String(text)
    .replace(/<jats:title[^>]*>[\s\S]*?<\/jats:title>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')));
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(Number(d)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function tidy(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

function pickFirst(value) {
  if (!value) return '';
  return Object.prototype.toString.call(value) === '[object Array]' ? (value[0] || '') : value;
}

/* ============================== SLACK DIGEST ============================= */
/*
 * Run installWeeklyDigest() once to schedule this. It needs a Slack incoming
 * webhook URL in Script Properties under SLACK_WEBHOOK_URL — the webhook is a
 * credential, so it is deliberately not stored in this file or the repo.
 */

function installWeeklyDigest() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'postWeeklyDigest') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  ScriptApp.newTrigger('postWeeklyDigest')
    .timeBased()
    .onWeekDay(DIGEST.DAY)
    .atHour(DIGEST.HOUR)
    .inTimezone(CONFIG.TIMEZONE)
    .create();
  return 'Weekly digest scheduled for Friday around ' + DIGEST.HOUR + ':00 ' + CONFIG.TIMEZONE + '.';
}

function removeWeeklyDigest() {
  var triggers = ScriptApp.getProjectTriggers();
  var n = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'postWeeklyDigest') {
      ScriptApp.deleteTrigger(triggers[i]);
      n++;
    }
  }
  return 'Removed ' + n + ' digest trigger(s).';
}

function postWeeklyDigest() {
  archiveOldVotes(book());
  var hook = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
  if (!hook) throw new Error('SLACK_WEBHOOK_URL is not set in Script Properties.');
  var res = UrlFetchApp.fetch(hook, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({ text: buildDigest() })
  });
  var code = res.getResponseCode();
  if (code >= 300) throw new Error('Slack returned ' + code + ': ' + res.getContentText());
  return 'Posted.';
}

/** Print the digest in the editor log without posting, to check the wording. */
function previewWeeklyDigest() {
  var text = buildDigest();
  Logger.log(text);
  return text;
}

function buildDigest() {
  var ss = book();
  var papers = readTab(ss, TAB.PAPERS, PAPER_COLS);
  var votes = readTab(ss, TAB.VOTES, VOTE_COLS);

  var tally = {};
  for (var v = 0; v < votes.length; v++) {
    var w = voteWeight(votes[v]);
    if (!w) continue;
    var key = String(votes[v].paper_id);
    if (!tally[key]) tally[key] = { up: 0, down: 0 };
    if (w > 0) tally[key].up += w;
    else tally[key].down += -w;
  }

  var week = currentWeek();
  var live = [], unread = [], addedThisWeek = 0, readThisWeek = 0;

  for (var i = 0; i < papers.length; i++) {
    var p = papers[i];
    if (!p.id || !p.title) continue;
    if (String(p.status || '').toLowerCase() === 'hidden') continue;
    var t = tally[String(p.id)] || { up: 0, down: 0 };
    var carriedTotals = carriedOf(p);
    t = { up: t.up + carriedTotals.up, down: t.down + carriedTotals.down };
    var row = {
      title: String(p.title),
      link: String(p.link || ''),
      venue: String(p.venue || ''),
      year: p.year === '' || p.year === null ? '' : String(p.year),
      score: t.up - t.down,
      up: t.up,
      read: !!p.read_at
    };
    live.push(row);
    if (!row.read) unread.push(row);
    if (weekOf(p.submitted_at) === week) addedThisWeek++;
    if (p.read_at && weekOf(p.read_at) === week) readThisWeek++;
  }

  unread.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return b.up - a.up;
  });

  var lines = [];
  lines.push('*Reading list — week of ' + prettyDate(week) + '*');

  var counts = [
    plural(addedThisWeek, 'new paper', 'new papers') + ' added this week',
    plural(live.length, 'paper', 'papers') + ' on the list',
    plural(unread.length, 'still unread', 'still unread')
  ];
  if (readThisWeek) counts.push(readThisWeek + ' marked read this week');
  lines.push(counts.join('  ·  '));

  if (unread.length) {
    lines.push('');
    lines.push('*Top ' + Math.min(DIGEST.TOP_N, unread.length) + ' right now*');
    for (var r = 0; r < Math.min(DIGEST.TOP_N, unread.length); r++) {
      var u = unread[r];
      var where = [u.venue, u.year].filter(String).join(' ');
      var name = u.link ? '<' + u.link + '|' + slackEscape(u.title) + '>' : slackEscape(u.title);
      lines.push((r + 1) + '. ' + name +
                 (where ? '  _' + slackEscape(where) + '_' : '') +
                 '  — ' + u.score + (Math.abs(u.score) === 1 ? ' point' : ' points'));
    }
  } else {
    lines.push('');
    lines.push('Nothing unread. Someone add a paper before Wednesday.');
  }

  lines.push('');
  lines.push('<' + DIGEST.PAGE_URL + '|Open the reading list>');
  return lines.join('\n');
}

function plural(n, one, many) {
  return n + ' ' + (Math.abs(n) === 1 ? one : many);
}

/** Slack mrkdwn only needs these three escaped. */
function slackEscape(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function prettyDate(ymd) {
  if (!ymd) return '';
  var parts = String(ymd).split('-');
  var d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  return Utilities.formatDate(d, 'Etc/UTC', 'MMM d');
}

/* ============================== DATES ==================================== */

/** Week key = the Monday that starts the week, as yyyy-MM-dd. */
function currentWeek() { return weekOf(new Date()); }

function weekOf(value) {
  if (!value) return '';
  var d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '';
  var local = Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd').split('-');
  var utc = new Date(Date.UTC(Number(local[0]), Number(local[1]) - 1, Number(local[2])));
  var dow = utc.getUTCDay() || 7;            // Monday = 1 ... Sunday = 7
  utc.setUTCDate(utc.getUTCDate() - dow + 1);
  return Utilities.formatDate(utc, 'Etc/UTC', 'yyyy-MM-dd');
}

/** Sunday that ends the given week key, as yyyy-MM-dd. */
function weekEnds(weekKey) {
  if (!weekKey) return '';
  var parts = weekKey.split('-');
  var d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  d.setUTCDate(d.getUTCDate() + 6);
  return Utilities.formatDate(d, 'Etc/UTC', 'yyyy-MM-dd');
}

/**
 * Reads a stored week value back as a yyyy-MM-dd key. Sheets turns a date-shaped
 * string into a Date on write, so the cell can come back as either type.
 */
function asWeekKey(value) {
  if (!value) return '';
  if (value && typeof value.getTime === 'function') {
    return Utilities.formatDate(value, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }
  var s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  return s;
}

function isoDate(value) {
  if (!value) return '';
  var d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return Utilities.formatDate(d, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}
