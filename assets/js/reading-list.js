/* Lab paper reading list.
   Backend: AWS Lambda (Function URL) + DynamoDB. See reading-list-backend/.
   Public read is open; voting, submitting, and read/archive need a lab passcode. */
(function () {
  'use strict';

  // Must match API_VERSION in reading-list-backend/lambda/util.mjs. If the page and
  // the backend disagree, voting pauses instead of sending requests the backend
  // will interpret differently.
  var EXPECTED_API = 2;

  var cfg = window.READING_LIST_CONFIG || {};
  var API = (cfg.api || '').trim();
  var STORE = 'rl.session.v2';

  var state = {
    papers: [],
    contributors: [],
    contributorDays: 30,
    sort: 'top',
    query: '',
    open: { read: false, archived: false },
    session: null,        // { token, member, admin, me }
    busy: {},
    apiOk: true,
    admin: { tab: 'members', members: [], papers: [], editing: null, resetting: null }
  };

  var el = {};

  /* ------------------------------ boot ---------------------------------- */

  document.addEventListener('DOMContentLoaded', function () {
    var ids = ['list', 'notice', 'auth', 'search', 'tally',
      'login-modal', 'login-form', 'login-msg',
      'submit-modal', 'submit-form', 'submit-msg', 'submit-quota', 'details', 'lookup-btn', 'manual', 'submit-btn', 'f-link',
      'admin-modal', 'admin-msg', 'admin-members', 'admin-papers', 'admin-slack'];
    for (var i = 0; i < ids.length; i++) el[camel(ids[i])] = document.getElementById('rl-' + ids[i]);
    el.sorts = document.querySelectorAll('.rl-sort');
    el.tabs = document.querySelectorAll('.rl-tab');
    if (!el.list) return;

    try { localStorage.removeItem('rl.session.v1'); } catch (e) { /* ignore */ }
    state.session = readSession();

    for (var s = 0; s < el.sorts.length; s++) el.sorts[s].addEventListener('click', onSort);
    for (var t = 0; t < el.tabs.length; t++) el.tabs[t].addEventListener('click', onAdminTab);
    if (el.search) el.search.addEventListener('input', function (ev) { state.query = ev.target.value.trim(); render(); });
    if (el.loginForm) el.loginForm.addEventListener('submit', onLogin);
    if (el.submitForm) el.submitForm.addEventListener('submit', onSubmit);
    if (el.lookupBtn) el.lookupBtn.addEventListener('click', onLookup);
    if (el.manual) el.manual.addEventListener('click', function () { showDetails(true); });
    if (el.fLink) el.fLink.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); onLookup(); }   // Enter here means look up, not post
    });

    var closers = document.querySelectorAll('[data-rl-close]');
    for (var c = 0; c < closers.length; c++) {
      closers[c].addEventListener('click', function (ev) {
        closeModal(document.getElementById(ev.currentTarget.getAttribute('data-rl-close')));
      });
    }
    [el.loginModal, el.submitModal, el.adminModal].forEach(function (m) {
      if (m) m.addEventListener('mousedown', function (ev) { if (ev.target === m) closeModal(m); });
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { closeModal(el.loginModal); closeModal(el.submitModal); closeModal(el.adminModal); }
    });

    renderAuth();
    if (!API) {
      el.list.innerHTML = '';
      notice('The reading list backend is not connected yet. Set <code>reading_list_api</code> in <code>_config.yml</code>.', 'error');
      return;
    }
    load();
  });

  function camel(s) { return s.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); }); }

  /* ---------------------------- transport ------------------------------- */

  function request(method, payload, done) {
    var url = API;
    var opts = { method: method };
    if (method === 'GET') {
      url += (API.indexOf('?') === -1 ? '?' : '&') + 'action=' + encodeURIComponent(payload.action);
    } else {
      if (state.session && state.session.token && payload.token === undefined) payload.token = state.session.token;
      // text/plain keeps this a "simple" request, so the browser sends no preflight.
      opts.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
      opts.body = JSON.stringify(payload);
    }
    fetch(url, opts).then(function (res) {
      return res.text();
    }).then(function (text) {
      var data;
      try { data = JSON.parse(text); } catch (e) { data = { ok: false, error: 'Unexpected response from the backend.' }; }
      if (data && data.expired && state.session) {
        signOut();
        openLogin('Your session expired. Sign in again.');
      }
      done(data || { ok: false, error: 'Empty response.' });
    })['catch'](function () {
      done({ ok: false, error: 'Could not reach the backend. Check your connection.' });
    });
  }
  function apiPost(payload, done) { request('POST', payload, done); }

  /* ------------------------------ data ---------------------------------- */

  function load() {
    if (!state.papers.length) el.list.innerHTML = '<li class="rl-loading">Loading papers&hellip;</li>';
    request('GET', { action: 'list' }, function (data) {
      if (!data || !data.ok) {
        el.list.innerHTML = '';
        notice(esc((data && data.error) || 'Could not load the reading list.'), 'error');
        return;
      }
      state.apiOk = data.api_version === EXPECTED_API;
      if (!state.apiOk) {
        notice('This page and its backend are out of step (the page expects API version ' + EXPECTED_API +
               ', the backend reports ' + (data.api_version || 1) + '). The list is shown, but voting and ' +
               'changes are paused until both are updated together.', 'error');
      }
      var mine = {};
      for (var i = 0; i < state.papers.length; i++) mine[state.papers[i].id] = state.papers[i].my_weight;
      state.papers = data.papers || [];
      for (var j = 0; j < state.papers.length; j++) state.papers[j].my_weight = mine[state.papers[j].id] || 0;
      state.contributors = data.contributors || [];
      if (data.contributor_window_days) state.contributorDays = data.contributor_window_days;
      renderTally();
      render();
      refreshMe();
    });
  }

  function refreshMe() {
    if (!state.session || !state.session.token || !state.apiOk) return;
    apiPost({ action: 'me' }, function (data) {
      if (!data || !data.ok) return;
      applyMe(data);
      render();
    });
  }

  function applyMe(data) {
    var mine = data.my_weights || {};
    for (var i = 0; i < state.papers.length; i++) state.papers[i].my_weight = mine[state.papers[i].id] || 0;
    if (state.session) {
      state.session.me = data.me || state.session.me;
      if (typeof data.admin === 'boolean') state.session.admin = data.admin;
      writeSession(state.session);
    }
    renderAuth();
  }

  function guard() {
    if (state.apiOk) return true;
    notice('Voting and changes are paused: this page and its backend are out of step.', 'error');
    return false;
  }

  /* ----------------------------- rendering ------------------------------ */

  function stamp(iso) { var t = Date.parse(iso || ''); return isNaN(t) ? 0 : t; }

  function matches(p) {
    var q = state.query.toLowerCase();
    if (!q) return true;
    return (p.title + ' ' + p.venue + ' ' + p.summary + ' ' + p.technical_focus).toLowerCase().indexOf(q) !== -1;
  }

  function render() {
    var active = [], read = [], archived = [];
    for (var i = 0; i < state.papers.length; i++) {
      var p = state.papers[i];
      if (!matches(p)) continue;
      (p.state === 'read' ? read : p.state === 'archived' ? archived : active).push(p);
    }
    active.sort(function (a, b) {
      if (state.sort === 'new') return stamp(b.submitted_at) - stamp(a.submitted_at);
      return (b.score - a.score) || (b.up - a.up) || (stamp(b.submitted_at) - stamp(a.submitted_at));
    });
    var byStateTime = function (a, b) { return stamp(b.state_at) - stamp(a.state_at); };
    read.sort(byStateTime);
    archived.sort(byStateTime);

    if (!active.length && !read.length && !archived.length) {
      el.list.innerHTML = '<li class="rl-empty">' +
        (state.query ? 'No papers match &ldquo;' + esc(state.query) + '&rdquo;.'
                     : 'No papers on the list yet. Lab members can add the first one.') + '</li>';
      return;
    }

    var html = '';
    if (active.length) for (var a = 0; a < active.length; a++) html += itemHtml(active[a], a + 1);
    else html += '<li class="rl-empty">Nothing waiting to be read' + (state.query ? ' matches that search' : '') + '.</li>';
    html += sectionHtml('read', 'Read', read);
    html += sectionHtml('archived', 'Archived', archived);
    el.list.innerHTML = html;

    bindAll('.rl-arrow', onVote);
    bindAll('.rl-state-btn', onStateButton);
    bindAll('.rl-section-toggle', function (ev) {
      var which = ev.currentTarget.getAttribute('data-section');
      state.open[which] = !state.open[which];
      render();
    });

    // A four-line clamp only needs a toggle when the text overflows at this width.
    var mores = el.list.querySelectorAll('.rl-more');
    for (var m = 0; m < mores.length; m++) {
      var para = mores[m].previousElementSibling;
      if (para.scrollHeight > para.clientHeight + 2) {
        mores[m].hidden = false;
        mores[m].addEventListener('click', onToggleSummary);
      } else {
        para.classList.remove('is-clamped');
      }
    }
  }

  function bindAll(sel, fn) {
    var nodes = el.list.querySelectorAll(sel);
    for (var i = 0; i < nodes.length; i++) nodes[i].addEventListener('click', fn);
  }

  function sectionHtml(key, label, rows) {
    if (!rows.length) return '';
    var open = state.open[key];
    var html = '<li class="rl-section">' +
      '<button type="button" class="rl-section-toggle" data-section="' + key + '" aria-expanded="' + open + '">' +
      '<span class="rl-caret' + (open ? ' is-open' : '') + '">&#9656;</span> ' + label + ' (' + rows.length + ')' +
      '</button></li>';
    if (open) for (var i = 0; i < rows.length; i++) html += itemHtml(rows[i], null);
    return html;
  }

  var ICON = {
    up: 'M8 2.5 14.5 10H10.8v3.6H5.2V10H1.5z',
    down: 'M8 13.5 1.5 6h3.7V2.4h5.6V6h3.7z',
    read: 'M6.2 11.3 3 8.1l1.1-1.1 2.1 2.1 5.7-5.7L13 4.5z',
    archived: 'M2 3h12v3H2zm1 4h10v6.5H3zm3 1.5v1.3h4V8.5z'
  };
  function svg(path) { return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="' + path + '"/></svg>'; }

  function itemHtml(p, rank) {
    var mine = Number(p.my_weight) || 0;
    var signedIn = !!(state.session && state.session.token);
    var me = (state.session && state.session.me) || {};
    var isActive = (p.state || 'active') === 'active';

    // An arrow that moves the holding toward zero always refunds, so it stays live.
    // An arrow that moves it away from zero needs budget and an active paper.
    var upWhy = '', downWhy = '';
    if (signedIn) {
      if (mine >= 0) upWhy = !isActive ? 'Voting is closed on ' + p.state + ' papers' : (me.upvotes_left === 0 ? 'No upvotes left this week' : '');
      if (mine <= 0) downWhy = !isActive ? 'Voting is closed on ' + p.state + ' papers' : (me.downvotes_left === 0 ? 'No downvotes left this week' : '');
    }

    var focus = String(p.technical_focus || '').split(/[;,|]/);
    var tags = '';
    for (var i = 0; i < focus.length; i++) {
      var t = focus[i].trim();
      if (t) tags += '<span class="rl-tag">' + esc(t) + '</span>';
    }

    var meta = [];
    if (p.venue) meta.push('<span class="rl-venue">' + esc(p.venue) + '</span>');
    if (p.year) meta.push(esc(p.year));
    var ago = timeAgo(p.submitted_at);
    if (ago) meta.push(ago);
    if (!isActive) {
      meta.push('<span class="rl-state-flag is-' + p.state + '">' + (p.state === 'read' ? 'read' : 'archived') +
                (p.state_by ? ' by ' + esc(p.state_by) : '') + '</span>');
    }

    var titleHtml = p.link
      ? '<a href="' + esc(p.link) + '" target="_blank" rel="noopener">' + esc(p.title) + '</a>' +
        '<span class="rl-domain">' + esc(domainOf(p.link)) + '</span>'
      : esc(p.title);

    var scoreClass = mine > 0 ? ' is-up' : (mine < 0 ? ' is-down' : '');

    return '' +
      '<li class="rl-item is-' + (p.state || 'active') + '" data-id="' + esc(p.id) + '">' +
        '<div class="rl-rank">' + (rank == null ? '' : rank) + '</div>' +
        '<div class="rl-votes">' +
          arrowHtml('up', mine > 0, p.id, upWhy) +
          '<div class="rl-score' + scoreClass + '">' + p.score + '</div>' +
          arrowHtml('down', mine < 0, p.id, downWhy) +
          (mine ? '<div class="rl-mine' + (mine > 0 ? ' is-up' : ' is-down') + '" title="Your votes on this paper this week">' +
                    (mine > 0 ? '+' + mine : String(mine)) + '</div>' : '') +
        '</div>' +
        '<div class="rl-body">' +
          '<div class="rl-title">' + titleHtml + '</div>' +
          '<div class="rl-meta">' + meta.join(' &middot; ') + '</div>' +
          (p.summary ? '<p class="rl-summary is-clamped">' + esc(p.summary) + '</p>' +
                       '<button type="button" class="rl-more" hidden>show more</button>' : '') +
          (tags ? '<div class="rl-focus">' + tags + '</div>' : '') +
        '</div>' +
        '<div class="rl-actions">' +
          stateButton(p, 'read', p.state === 'read' ? 'Move back to the list' : 'Mark as read') +
          stateButton(p, 'archived', p.state === 'archived' ? 'Move back to the list' : 'Archive: not reading this') +
        '</div>' +
      '</li>';
  }

  function arrowHtml(dir, on, id, why) {
    return '<button type="button" class="rl-arrow rl-' + dir + (on ? ' is-on' : '') + '"' +
           ' data-dir="' + dir + '" data-id="' + esc(id) + '"' + (why ? ' disabled' : '') +
           ' aria-label="' + dir + 'vote" title="' + esc(why || ('Add ' + (dir === 'up' ? 'an upvote' : 'a downvote') + ' (they stack)')) + '">' +
           svg(ICON[dir]) + '</button>';
  }

  function stateButton(p, which, label) {
    var on = p.state === which;
    return '<button type="button" class="rl-state-btn rl-' + which + '-btn' + (on ? ' is-on' : '') + '"' +
           ' data-id="' + esc(p.id) + '" data-state="' + which + '" title="' + esc(label) + '" aria-label="' + esc(label) + '"' +
           ' aria-pressed="' + on + '">' + svg(ICON[which]) + '</button>';
  }

  function renderTally() {
    if (!el.tally) return;
    var rows = state.contributors || [];
    if (!rows.length) { el.tally.hidden = true; return; }
    var total = 0, parts = [];
    for (var i = 0; i < rows.length; i++) {
      total += rows[i].count;
      parts.push('<span class="rl-tally-item"><span class="rl-tally-name">' + esc(rows[i].name) +
                 '</span><span class="rl-tally-count">' + rows[i].count + '</span></span>');
    }
    var span = state.contributorDays === 30 ? 'the past month' : 'the past ' + state.contributorDays + ' days';
    el.tally.innerHTML = '<span class="rl-tally-label">' + total + (total === 1 ? ' paper' : ' papers') +
                         ' added in ' + span + '</span>' + parts.join('');
    el.tally.hidden = false;
  }

  function renderAuth() {
    if (!el.auth) return;
    var s = state.session;
    if (!s || !s.token) {
      el.auth.innerHTML = '<button type="button" class="rl-btn" id="rl-login-btn">Lab member sign in</button>';
      document.getElementById('rl-login-btn').addEventListener('click', function () { openLogin(); });
      return;
    }
    var me = s.me || {};
    el.auth.innerHTML =
      '<div class="rl-status"><strong>' + esc(s.member) + '</strong><br><span class="rl-quota">' +
        '<span title="Upvotes left this week">&#9650; ' + num(me.upvotes_left) + '/' + num(me.upvotes_total, 3) + '</span>' +
        '<span title="Downvotes left this week">&#9660; ' + num(me.downvotes_left) + '/' + num(me.downvotes_total, 3) + '</span>' +
        '<span>submissions ' + num(me.submissions_left) + '/' + num(me.submissions_total, 10) + '</span>' +
      '</span> &middot; <button type="button" class="rl-btn-link" id="rl-logout">sign out</button></div>' +
      (s.admin ? '<button type="button" class="rl-btn" id="rl-admin-open">Admin</button>' : '') +
      '<button type="button" class="rl-btn rl-btn-solid" id="rl-add">Add paper</button>';
    document.getElementById('rl-logout').addEventListener('click', signOut);
    document.getElementById('rl-add').addEventListener('click', openSubmit);
    if (s.admin) document.getElementById('rl-admin-open').addEventListener('click', openAdmin);
  }

  function num(v, fallback) {
    if (v === 0) return '0';
    return v == null ? (fallback == null ? '?' : String(fallback)) : String(v);
  }

  /* ------------------------------ actions -------------------------------- */

  function onSort(ev) {
    state.sort = ev.currentTarget.getAttribute('data-sort');
    for (var i = 0; i < el.sorts.length; i++) el.sorts[i].classList.remove('is-active');
    ev.currentTarget.classList.add('is-active');
    render();
  }

  function findPaper(id) {
    for (var i = 0; i < state.papers.length; i++) if (state.papers[i].id === id) return state.papers[i];
    return null;
  }

  function onVote(ev) {
    var btn = ev.currentTarget;
    var id = btn.getAttribute('data-id');
    if (!state.session || !state.session.token) { openLogin('Sign in with your lab passcode to vote.'); return; }
    if (!guard() || state.busy[id]) return;
    state.busy[id] = true;
    apiPost({ action: 'vote', paper_id: id, direction: btn.getAttribute('data-dir') }, function (data) {
      state.busy[id] = false;
      if (!data.ok) {
        if (!data.expired) notice(esc(data.error || 'Vote failed.'), 'error');
        if (data.me && state.session) { state.session.me = data.me; writeSession(state.session); renderAuth(); render(); }
        return;
      }
      clearNotice();
      var p = findPaper(data.paper_id);
      if (p) { p.up = data.up; p.down = data.down; p.score = data.score; p.my_weight = data.my_weight; }
      state.session.me = data.me;
      writeSession(state.session);
      renderAuth();
      render();
    });
  }

  function onStateButton(ev) {
    var btn = ev.currentTarget;
    var id = btn.getAttribute('data-id');
    if (!state.session || !state.session.token) { openLogin('Sign in with your lab passcode to mark papers.'); return; }
    if (!guard() || state.busy[id]) return;
    var p = findPaper(id);
    var which = btn.getAttribute('data-state');
    var target = p && p.state === which ? 'active' : which;
    state.busy[id] = true;
    btn.disabled = true;
    apiPost({ action: 'state', paper_id: id, state: target }, function (data) {
      state.busy[id] = false;
      btn.disabled = false;
      if (!data.ok) { if (!data.expired) notice(esc(data.error || 'Could not update that paper.'), 'error'); return; }
      clearNotice();
      if (p) { p.state = data.state; p.read = data.state === 'read'; p.state_at = data.state_at; p.state_by = data.state_by; }
      render();
    });
  }

  function onLogin(ev) {
    ev.preventDefault();
    var name = document.getElementById('rl-login-name').value.trim();
    var passcode = document.getElementById('rl-login-passcode').value;
    if (!name || !passcode) { msg(el.loginMsg, 'Enter your name and passcode.', 'error'); return; }
    var btn = document.getElementById('rl-login-submit');
    btn.disabled = true;
    msg(el.loginMsg, 'Checking…', '');
    apiPost({ action: 'login', name: name, passcode: passcode, token: null }, function (data) {
      btn.disabled = false;
      if (!data.ok) { msg(el.loginMsg, data.error || 'Sign in failed.', 'error'); return; }
      state.session = { token: data.token, member: data.member, admin: !!data.admin, me: data.me };
      writeSession(state.session);
      msg(el.loginMsg, '', '');
      el.loginForm.reset();
      closeModal(el.loginModal);
      applyMe(data);
      render();
    });
  }

  function signOut() {
    state.session = null;
    try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ }
    for (var i = 0; i < state.papers.length; i++) state.papers[i].my_weight = 0;
    closeModal(el.adminModal);
    renderAuth();
    render();
  }

  /* --------------------------- adding a paper ---------------------------- */

  function showDetails(focusTitle) {
    if (el.details) el.details.hidden = false;
    if (el.submitBtn) el.submitBtn.hidden = false;
    if (el.manual) el.manual.hidden = true;
    if (focusTitle) { var t = document.getElementById('rl-f-title'); if (t) t.focus(); }
  }

  function setValue(id, value) { var n = document.getElementById(id); if (n) n.value = value == null ? '' : value; }

  function onLookup() {
    var link = el.fLink ? el.fLink.value.trim() : '';
    if (!link) { msg(el.submitMsg, 'Paste a link first.', 'error'); if (el.fLink) el.fLink.focus(); return; }
    var label = el.lookupBtn.textContent;
    el.lookupBtn.disabled = true;
    el.lookupBtn.textContent = 'Looking…';
    msg(el.submitMsg, '', '');
    apiPost({ action: 'lookup', link: link }, function (data) {
      el.lookupBtn.disabled = false;
      el.lookupBtn.textContent = label;
      if (data.expired) { closeModal(el.submitModal); return; }
      if (!data.ok) {
        showDetails(true);   // a failed lookup opens the fields rather than blocking
        msg(el.submitMsg, data.error || 'Could not read that page. Fill the fields in by hand.', 'error');
        return;
      }
      if (data.link) el.fLink.value = data.link;
      setValue('rl-f-title', data.title);
      setValue('rl-f-venue', data.venue);
      setValue('rl-f-year', data.year);
      setValue('rl-f-summary', data.abstract);
      showDetails(!data.title);
      var missing = [];
      if (!data.title) missing.push('title');
      if (!data.venue) missing.push('venue');
      if (!data.year) missing.push('year');
      if (!data.abstract) missing.push('abstract');
      msg(el.submitMsg, missing.length
        ? 'Found what it could' + (data.source ? ' via ' + data.source : '') + '. Missing: ' + missing.join(', ') + '. Edit anything below before posting.'
        : 'Filled in from ' + (data.source || 'the page') + '. Check it over before posting.', missing.length ? '' : 'ok');
    });
  }

  function onSubmit(ev) {
    ev.preventDefault();
    if (!guard()) return;
    var payload = {
      action: 'submit',
      title: document.getElementById('rl-f-title').value.trim(),
      link: el.fLink.value.trim(),
      venue: document.getElementById('rl-f-venue').value.trim(),
      year: document.getElementById('rl-f-year').value.trim(),
      summary: document.getElementById('rl-f-summary').value.trim()
    };
    if (!payload.title) { msg(el.submitMsg, 'A title is required.', 'error'); return; }
    el.submitBtn.disabled = true;
    msg(el.submitMsg, 'Posting…', '');
    apiPost(payload, function (data) {
      el.submitBtn.disabled = false;
      if (data.expired) { closeModal(el.submitModal); return; }
      if (!data.ok) {
        msg(el.submitMsg, data.error || 'Could not post the paper.', 'error');
        if (data.me && state.session) { state.session.me = data.me; writeSession(state.session); renderAuth(); }
        return;
      }
      if (data.me) { state.session.me = data.me; writeSession(state.session); }
      el.submitForm.reset();
      msg(el.submitMsg, '', '');
      closeModal(el.submitModal);
      renderAuth();
      notice('Paper added to the list.', 'ok');
      load();
    });
  }

  /* ------------------------------- admin --------------------------------- */

  function openAdmin() {
    if (!el.adminModal) return;
    msg(el.adminMsg, '', '');
    el.adminModal.hidden = false;
    showAdminTab(state.admin.tab);
  }

  function onAdminTab(ev) { showAdminTab(ev.currentTarget.getAttribute('data-tab')); }

  function showAdminTab(tab) {
    state.admin.tab = tab;
    for (var i = 0; i < el.tabs.length; i++) {
      var on = el.tabs[i].getAttribute('data-tab') === tab;
      el.tabs[i].classList.toggle('is-active', on);
      el.tabs[i].setAttribute('aria-selected', on);
    }
    el.adminMembers.hidden = tab !== 'members';
    el.adminPapers.hidden = tab !== 'papers';
    el.adminSlack.hidden = tab !== 'slack';
    msg(el.adminMsg, '', '');
    if (tab === 'members') loadMembers();
    if (tab === 'papers') loadAdminPapers();
    if (tab === 'slack') loadSlack();
  }

  function admin(op, extra, done) {
    var payload = { action: 'admin', op: op };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
    apiPost(payload, function (data) {
      if (!data.ok && !data.expired) msg(el.adminMsg, data.error || 'That did not work.', 'error');
      done(data);
    });
  }

  // Members ---------------------------------------------------------------
  function loadMembers() {
    el.adminMembers.innerHTML = '<p class="rl-muted">Loading…</p>';
    admin('members', {}, function (data) {
      if (!data.ok) return;
      state.admin.members = data.members;
      renderMembers();
    });
  }

  function renderMembers() {
    var rows = state.admin.members, me = state.session && state.session.member;
    var html = '<table class="rl-admin-table"><thead><tr><th>Name</th><th>Status</th><th></th></tr></thead><tbody>';
    for (var i = 0; i < rows.length; i++) {
      var m = rows[i];
      var self = me && m.name.toLowerCase() === me.toLowerCase();
      var status = !m.active ? '<span class="rl-badge is-off">inactive</span>'
        : m.locked_until ? '<span class="rl-badge is-warn">locked until ' + esc(clock(m.locked_until)) + '</span>'
        : '<span class="rl-badge is-ok">active</span>';
      html += '<tr><td>' + esc(m.name) + (m.admin ? ' <span class="rl-badge">admin</span>' : '') + '</td><td>' + status + '</td><td class="rl-cell-actions">';
      if (state.admin.resetting === m.key) {
        html += '<form class="rl-inline" data-reset="' + esc(m.key) + '">' +
                '<input type="text" name="pass" placeholder="new passcode" minlength="6" autocomplete="off" required>' +
                '<button type="submit" class="rl-btn rl-btn-sm">Save</button>' +
                '<button type="button" class="rl-btn-link" data-act="reset-cancel">cancel</button></form>';
      } else {
        html += '<button type="button" class="rl-btn-link" data-act="reset" data-key="' + esc(m.key) + '">reset passcode</button>';
        if (m.locked_until) html += '<button type="button" class="rl-btn-link" data-act="unlock" data-key="' + esc(m.key) + '">unlock</button>';
        if (!self) html += '<button type="button" class="rl-btn-link" data-act="' + (m.active ? 'deactivate' : 'activate') + '" data-key="' + esc(m.key) + '">' + (m.active ? 'deactivate' : 'reactivate') + '</button>';
      }
      html += '</td></tr>';
    }
    html += '</tbody></table>' +
      '<h4 class="rl-admin-h">Add a member</h4>' +
      '<form class="rl-inline rl-add-member">' +
        '<input type="text" name="name" placeholder="First name" required>' +
        '<input type="text" name="pass" placeholder="Passcode (6+ characters)" minlength="6" autocomplete="off" required>' +
        '<label class="rl-check-label"><input type="checkbox" name="admin"> admin</label>' +
        '<button type="submit" class="rl-btn rl-btn-sm rl-btn-solid">Add</button>' +
      '</form>' +
      '<p class="rl-muted">Names sign in case-insensitively. Resetting a passcode or deactivating someone signs them out everywhere.</p>' +
      '<h4 class="rl-admin-h">Sign-in limits</h4>' +
      '<p class="rl-muted">Three wrong passcodes pause sign-in for 15 minutes, per member and per network address. ' +
      'If someone on a shared network (the lab, campus Wi-Fi) is stuck, clear the address locks.</p>' +
      '<button type="button" class="rl-btn rl-btn-sm" data-act="ip-unlock">Clear address locks</button>';
    el.adminMembers.innerHTML = html;

    var acts = el.adminMembers.querySelectorAll('[data-act]');
    for (var a = 0; a < acts.length; a++) acts[a].addEventListener('click', onMemberAction);
    var reset = el.adminMembers.querySelector('form[data-reset]');
    if (reset) {
      reset.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var key = ev.currentTarget.getAttribute('data-reset');
        var m = memberByKey(key);
        admin('member_save', { name: m.name, passcode: fv(ev.currentTarget, 'pass').value }, function (data) {
          if (!data.ok) return;
          state.admin.resetting = null;
          msg(el.adminMsg, 'Passcode for ' + m.name + ' changed. Tell them the new one.', 'ok');
          loadMembers();
        });
      });
      fv(reset, 'pass').focus();
    }
    el.adminMembers.querySelector('.rl-add-member').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var f = ev.currentTarget;
      var who = fv(f, 'name').value.trim();
      admin('member_save', { name: who, passcode: fv(f, 'pass').value, admin: fv(f, 'admin').checked }, function (data) {
        if (!data.ok) return;
        msg(el.adminMsg, data.created ? 'Added ' + who + '.' : 'Updated ' + who + '.', 'ok');
        loadMembers();
      });
    });
  }

  function fv(form, name) { var n = form.elements.namedItem(name); return n ? n : { value: '', checked: false, focus: function () {} }; }

  function memberByKey(key) {
    for (var i = 0; i < state.admin.members.length; i++) if (state.admin.members[i].key === key) return state.admin.members[i];
    return null;
  }

  function onMemberAction(ev) {
    var act = ev.currentTarget.getAttribute('data-act');
    var key = ev.currentTarget.getAttribute('data-key');
    var ok = function (text) { return function (data) { if (data.ok) { msg(el.adminMsg, text, 'ok'); loadMembers(); } }; };
    if (act === 'reset') { state.admin.resetting = key; renderMembers(); }
    else if (act === 'reset-cancel') { state.admin.resetting = null; renderMembers(); }
    else if (act === 'unlock') admin('member_unlock', { key: key }, ok('Unlocked.'));
    else if (act === 'deactivate') admin('member_active', { key: key, active: false }, ok('Deactivated. They are signed out.'));
    else if (act === 'activate') admin('member_active', { key: key, active: true }, ok('Reactivated.'));
    else if (act === 'ip-unlock') admin('ip_unlock_all', {}, function (data) {
      if (data.ok) msg(el.adminMsg, 'Cleared ' + data.cleared + ' address lock' + (data.cleared === 1 ? '' : 's') + '.', 'ok');
    });
  }

  // Papers ----------------------------------------------------------------
  function loadAdminPapers() {
    el.adminPapers.innerHTML = '<p class="rl-muted">Loading…</p>';
    admin('papers', {}, function (data) {
      if (!data.ok) return;
      state.admin.papers = data.papers;
      renderAdminPapers();
    });
  }

  function renderAdminPapers() {
    var rows = state.admin.papers;
    var html = '<p class="rl-muted">Hidden papers leave the public list and cannot be voted on. Hiding is reversible.</p><ul class="rl-admin-papers">';
    for (var i = 0; i < rows.length; i++) {
      var p = rows[i];
      html += '<li class="rl-admin-paper' + (p.hidden ? ' is-hidden' : '') + '">';
      if (state.admin.editing === p.id) {
        html += '<form class="rl-edit" data-id="' + esc(p.id) + '">' +
          field('Title', 'title', p.title) + field('Link', 'link', p.link) +
          '<div class="rl-row">' + field('Venue', 'venue', p.venue) + field('Year', 'year', p.year) + '</div>' +
          '<div class="rl-field"><label>Abstract</label><textarea name="summary" rows="5">' + esc(p.summary) + '</textarea></div>' +
          field('Tags (comma separated)', 'technical_focus', p.technical_focus) +
          '<div class="rl-modal-actions"><button type="submit" class="rl-btn rl-btn-sm rl-btn-solid">Save</button>' +
          '<button type="button" class="rl-btn-link" data-act="edit-cancel">cancel</button></div></form>';
      } else {
        html += '<div class="rl-admin-paper-title">' + esc(p.title) +
          (p.hidden ? ' <span class="rl-badge is-off">hidden</span>' : '') +
          (p.state !== 'active' ? ' <span class="rl-badge">' + esc(p.state) + '</span>' : '') + '</div>' +
          '<div class="rl-muted">' + esc([p.venue, p.year].filter(Boolean).join(' ')) +
          (p.submitted_by ? ' &middot; added by ' + esc(p.submitted_by) : '') + ' &middot; score ' + p.score + '</div>' +
          '<div class="rl-cell-actions"><button type="button" class="rl-btn-link" data-act="edit" data-id="' + esc(p.id) + '">edit</button>' +
          '<button type="button" class="rl-btn-link" data-act="' + (p.hidden ? 'unhide' : 'hide') + '" data-id="' + esc(p.id) + '">' + (p.hidden ? 'unhide' : 'hide') + '</button></div>';
      }
      html += '</li>';
    }
    el.adminPapers.innerHTML = html + '</ul>';

    var acts = el.adminPapers.querySelectorAll('[data-act]');
    for (var a = 0; a < acts.length; a++) acts[a].addEventListener('click', onPaperAction);
    var form = el.adminPapers.querySelector('form.rl-edit');
    if (form) form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var f = ev.currentTarget;
      admin('paper_save', {
        paper_id: f.getAttribute('data-id'), title: fv(f, 'title').value, link: fv(f, 'link').value,
        venue: fv(f, 'venue').value, year: fv(f, 'year').value, summary: fv(f, 'summary').value,
        technical_focus: fv(f, 'technical_focus').value
      }, function (data) {
        if (!data.ok) return;
        state.admin.editing = null;
        msg(el.adminMsg, 'Saved.', 'ok');
        loadAdminPapers();
        load();
      });
    });
  }

  function field(label, name, value) {
    return '<div class="rl-field"><label>' + label + '</label><input type="text" name="' + name + '" value="' + esc(value) + '"></div>';
  }

  function onPaperAction(ev) {
    var act = ev.currentTarget.getAttribute('data-act');
    var id = ev.currentTarget.getAttribute('data-id');
    if (act === 'edit') { state.admin.editing = id; renderAdminPapers(); }
    else if (act === 'edit-cancel') { state.admin.editing = null; renderAdminPapers(); }
    else if (act === 'hide' || act === 'unhide') {
      admin('paper_hidden', { paper_id: id, hidden: act === 'hide' }, function (data) {
        if (!data.ok) return;
        msg(el.adminMsg, act === 'hide' ? 'Hidden from the list.' : 'Back on the list.', 'ok');
        loadAdminPapers();
        load();
      });
    }
  }

  // Slack -----------------------------------------------------------------
  function loadSlack() {
    el.adminSlack.innerHTML = '<p class="rl-muted">Loading…</p>';
    admin('slack', {}, function (data) { if (data.ok) renderSlack(data.slack); });
  }

  function renderSlack(s) {
    el.adminSlack.innerHTML =
      '<p>' + (s.configured
        ? 'Posting to Slack through the saved webhook (ending <code>' + esc(s.webhook_hint) + '</code>).'
        : 'No webhook saved yet, so the Friday digest is not being posted.') + '</p>' +
      '<p class="rl-muted">The digest goes out every Friday at 9am Eastern' +
      (s.last_posted_at ? '. Last posted ' + esc(timeAgo(new Date(s.last_posted_at).toISOString())) : '') + '.</p>' +
      '<form class="rl-inline rl-slack-form">' +
        '<input type="url" name="webhook" placeholder="https://hooks.slack.com/services/…" autocomplete="off" required>' +
        '<button type="submit" class="rl-btn rl-btn-sm rl-btn-solid">' + (s.configured ? 'Replace' : 'Save') + '</button>' +
      '</form>' +
      '<p class="rl-muted">To get a URL: api.slack.com/apps &rarr; Create New App &rarr; From scratch &rarr; Incoming Webhooks &rarr; ' +
      'turn on &rarr; Add New Webhook &rarr; pick #papers. The URL is stored in the backend only and never shown in full again.</p>' +
      '<div class="rl-modal-actions"><button type="button" class="rl-btn rl-btn-sm" data-act="preview">Preview digest</button>' +
      '<button type="button" class="rl-btn rl-btn-sm"' + (s.configured ? '' : ' disabled') + ' data-act="send">Send now</button></div>' +
      '<pre class="rl-digest" hidden></pre>';

    el.adminSlack.querySelector('.rl-slack-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      admin('slack_save', { webhook: fv(ev.currentTarget, 'webhook').value.trim() }, function (data) {
        if (!data.ok) return;
        msg(el.adminMsg, 'Webhook saved.', 'ok');
        renderSlack(data.slack);
      });
    });
    var pre = el.adminSlack.querySelector('.rl-digest');
    el.adminSlack.querySelector('[data-act="preview"]').addEventListener('click', function () {
      admin('digest_preview', {}, function (data) { if (data.ok) { pre.textContent = data.text; pre.hidden = false; } });
    });
    el.adminSlack.querySelector('[data-act="send"]').addEventListener('click', function (ev) {
      ev.currentTarget.disabled = true;
      var b = ev.currentTarget;
      admin('digest_send', {}, function (data) {
        b.disabled = false;
        if (data.ok) { msg(el.adminMsg, 'Posted to Slack.', 'ok'); pre.textContent = data.text; pre.hidden = false; }
      });
    });
  }

  /* ------------------------------ modals --------------------------------- */

  function openLogin(message) {
    if (!el.loginModal) return;
    msg(el.loginMsg, message || '', message ? 'error' : '');
    el.loginModal.hidden = false;
    var f = document.getElementById('rl-login-name');
    if (f) f.focus();
  }

  function openSubmit() {
    if (!el.submitModal) return;
    var me = (state.session && state.session.me) || {};
    if (el.submitQuota) el.submitQuota.textContent = num(me.submissions_left) + ' of ' + num(me.submissions_total, 10) + ' submissions left this week.';
    msg(el.submitMsg, '', '');
    if (el.submitForm) el.submitForm.reset();
    if (el.details) el.details.hidden = true;
    if (el.submitBtn) el.submitBtn.hidden = true;
    if (el.manual) el.manual.hidden = false;
    el.submitModal.hidden = false;
    if (el.fLink) el.fLink.focus();
  }

  function closeModal(m) { if (m) m.hidden = true; }

  /* ------------------------------ helpers -------------------------------- */

  function onToggleSummary(ev) {
    var para = ev.currentTarget.previousElementSibling;
    var clamped = para.classList.toggle('is-clamped');
    ev.currentTarget.textContent = clamped ? 'show more' : 'show less';
  }

  function notice(html, kind) {
    if (!el.notice) return;
    el.notice.innerHTML = html;
    el.notice.className = 'rl-notice' + (kind ? ' is-' + kind : '');
    el.notice.hidden = false;
  }
  function clearNotice() { if (el.notice && state.apiOk) el.notice.hidden = true; }

  function msg(node, text, kind) {
    if (!node) return;
    node.textContent = text;
    node.className = 'rl-msg' + (kind ? ' is-' + kind : '');
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function domainOf(url) {
    try { var h = new URL(url).hostname.replace(/^www\./, ''); return h ? '(' + h + ')' : ''; }
    catch (e) { return ''; }
  }

  function clock(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function timeAgo(iso) {
    var t = Date.parse(iso || '');
    if (isNaN(t)) return '';
    var mins = Math.floor((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    var days = Math.floor(hours / 24);
    if (days < 7) return days + (days === 1 ? ' day ago' : ' days ago');
    var weeks = Math.floor(days / 7);
    if (weeks < 5) return weeks + (weeks === 1 ? ' week ago' : ' weeks ago');
    var months = Math.floor(days / 30);
    if (months < 12) return months + (months === 1 ? ' month ago' : ' months ago');
    return Math.floor(days / 365) + 'y ago';
  }

  function readSession() {
    try {
      var raw = localStorage.getItem(STORE);
      if (!raw) return null;
      var s = JSON.parse(raw);
      return s && s.token ? s : null;
    } catch (e) { return null; }
  }

  function writeSession(s) {
    try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }
})();
