/* Lab paper reading list.
   Backend: a Google Apps Script web app over a Google Sheet.
   Public read is open; voting and submitting need a lab passcode. */
(function () {
  'use strict';

  var cfg = window.READING_LIST_CONFIG || {};
  var API = (cfg.api || '').trim();
  var STORE = 'rl.session.v1';

  var state = {
    papers: [],
    contributors: [],
    contributorDays: 30,
    showRead: false,
    sort: 'top',
    query: '',
    session: null,   // { token: '', member: '', me: {...} }
    busy: {}
  };

  var el = {};

  /* ------------------------------ boot ---------------------------------- */

  document.addEventListener('DOMContentLoaded', function () {
    el.list = document.getElementById('rl-list');
    el.notice = document.getElementById('rl-notice');
    el.tally = document.getElementById('rl-tally');
    el.auth = document.getElementById('rl-auth');
    el.search = document.getElementById('rl-search');
    el.sorts = document.querySelectorAll('.rl-sort');
    el.loginModal = document.getElementById('rl-login-modal');
    el.submitModal = document.getElementById('rl-submit-modal');
    el.loginForm = document.getElementById('rl-login-form');
    el.submitForm = document.getElementById('rl-submit-form');
    el.loginMsg = document.getElementById('rl-login-msg');
    el.submitMsg = document.getElementById('rl-submit-msg');
    el.submitQuota = document.getElementById('rl-submit-quota');
    el.details = document.getElementById('rl-details');
    el.lookupBtn = document.getElementById('rl-lookup-btn');
    el.manualBtn = document.getElementById('rl-manual');
    el.submitBtn = document.getElementById('rl-submit-btn');
    el.link = document.getElementById('rl-f-link');
    if (!el.list) return;

    state.session = readSession();

    for (var i = 0; i < el.sorts.length; i++) {
      el.sorts[i].addEventListener('click', onSort);
    }
    if (el.search) el.search.addEventListener('input', onSearch);
    if (el.loginForm) el.loginForm.addEventListener('submit', onLogin);
    if (el.submitForm) el.submitForm.addEventListener('submit', onSubmit);
    if (el.lookupBtn) el.lookupBtn.addEventListener('click', onLookup);
    if (el.manualBtn) el.manualBtn.addEventListener('click', function () { showDetails(true); });
    if (el.link) el.link.addEventListener('keydown', function (ev) {
      // Enter in the link box means "look this up", not "post".
      if (ev.key === 'Enter') { ev.preventDefault(); onLookup(); }
    });

    var closers = document.querySelectorAll('[data-rl-close]');
    for (var c = 0; c < closers.length; c++) {
      closers[c].addEventListener('click', function (ev) {
        closeModal(document.getElementById(ev.currentTarget.getAttribute('data-rl-close')));
      });
    }
    [el.loginModal, el.submitModal].forEach(function (m) {
      if (!m) return;
      m.addEventListener('mousedown', function (ev) { if (ev.target === m) closeModal(m); });
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { closeModal(el.loginModal); closeModal(el.submitModal); }
    });

    renderAuth();

    if (!API) {
      el.list.innerHTML = '';
      notice('The reading list backend is not connected yet. Set <code>reading_list_api</code> in <code>_config.yml</code> to the Apps Script web app URL.', 'error');
      return;
    }
    load();
  });

  /* ---------------------------- transport ------------------------------- */

  // GET over JSONP: no CORS involved, so the public list always renders.
  function apiGet(params, done) {
    var name = 'rlcb' + Date.now() + Math.floor(Math.random() * 10000);
    var script = document.createElement('script');
    var timer = setTimeout(function () { cleanup(); done({ ok: false, error: 'The backend did not respond.' }); }, 20000);

    function cleanup() {
      clearTimeout(timer);
      try { delete window[name]; } catch (e) { window[name] = undefined; }
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window[name] = function (data) { cleanup(); done(data); };

    var qs = ['callback=' + encodeURIComponent(name)];
    for (var k in params) {
      if (Object.prototype.hasOwnProperty.call(params, k) && params[k] != null && params[k] !== '') {
        qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
      }
    }
    script.src = API + (API.indexOf('?') === -1 ? '?' : '&') + qs.join('&');
    script.onerror = function () { cleanup(); done({ ok: false, error: 'Could not reach the backend.' }); };
    document.body.appendChild(script);
  }

  // POST as text/plain so the browser sends no preflight request.
  function apiPost(payload, done) {
    if (state.session && state.session.token) payload.token = state.session.token;
    fetch(API, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.text();
    }).then(function (text) {
      var data;
      try { data = JSON.parse(text); }
      catch (e) { data = { ok: false, error: 'Unexpected response from the backend.' }; }
      done(data);
    })['catch'](function () {
      done({ ok: false, error: 'Could not reach the backend. Check your connection.' });
    });
  }

  /* ------------------------------ data ---------------------------------- */

  function load() {
    el.list.innerHTML = '<li class="rl-loading">Loading papers&hellip;</li>';
    apiGet({ action: 'list' }, function (data) {
      if (!data || !data.ok) {
        el.list.innerHTML = '';
        notice((data && data.error) || 'Could not load the reading list.', 'error');
        return;
      }
      state.papers = data.papers || [];
      state.contributors = data.contributors || [];
      if (data.contributor_window_days) state.contributorDays = data.contributor_window_days;
      renderTally();
      render();
      refreshMe();
    });
  }

  // The session token is only ever sent in a POST body, never in a URL.
  function refreshMe() {
    if (!state.session || !state.session.token) return;
    apiPost({ action: 'me' }, function (data) {
      if (!data || !data.ok) {
        if (data && data.expired) { signOut(); openLogin('Your session expired. Sign in again.'); }
        return;
      }
      var mine = data.my_weights || {};
      for (var i = 0; i < state.papers.length; i++) {
        state.papers[i].my_weight = mine[state.papers[i].id] || 0;
      }
      state.session.me = data.me;
      writeSession(state.session);
      renderAuth();
      render();
    });
  }

  /* ----------------------------- rendering ------------------------------ */

  function visiblePapers() {
    var q = state.query.toLowerCase();
    var rows = state.papers.filter(function (p) {
      if (!q) return true;
      return (p.title + ' ' + p.venue + ' ' + p.summary + ' ' +
              p.technical_focus).toLowerCase().indexOf(q) !== -1;
    });
    rows.sort(function (a, b) {
      if (state.sort === 'new') return stamp(b) - stamp(a);
      if (b.score !== a.score) return b.score - a.score;
      if (b.up !== a.up) return b.up - a.up;
      return stamp(b) - stamp(a);
    });
    return rows;
  }

  function stamp(p) {
    var t = Date.parse(p.submitted_at || '');
    return isNaN(t) ? 0 : t;
  }

  function render() {
    var rows = visiblePapers();
    var unread = [], read = [];
    for (var r = 0; r < rows.length; r++) (rows[r].read ? read : unread).push(rows[r]);
    read.sort(function (a, b) { return (Date.parse(b.read_at) || 0) - (Date.parse(a.read_at) || 0); });

    if (!rows.length) {
      el.list.innerHTML = '<li class="rl-empty">' +
        (state.query ? 'No papers match &ldquo;' + esc(state.query) + '&rdquo;.'
                     : 'No papers on the list yet. Lab members can add the first one.') +
        '</li>';
      return;
    }

    var html = '';
    if (unread.length) {
      for (var i = 0; i < unread.length; i++) html += itemHtml(unread[i], i + 1);
    } else {
      html += '<li class="rl-empty">Everything on the list has been read.</li>';
    }

    if (read.length) {
      html += '<li class="rl-section">' +
                '<button type="button" class="rl-section-toggle" id="rl-read-toggle">' +
                  '<span class="rl-caret' + (state.showRead ? ' is-open' : '') + '">&#9656;</span> ' +
                  'Read (' + read.length + ')' +
                '</button>' +
              '</li>';
      if (state.showRead) {
        for (var j = 0; j < read.length; j++) html += itemHtml(read[j], null);
      }
    }
    el.list.innerHTML = html;

    var readToggle = document.getElementById('rl-read-toggle');
    if (readToggle) readToggle.addEventListener('click', function () {
      state.showRead = !state.showRead;
      render();
    });

    var checks = el.list.querySelectorAll('.rl-check');
    for (var c = 0; c < checks.length; c++) checks[c].addEventListener('click', onMarkRead);

    var arrows = el.list.querySelectorAll('.rl-arrow');
    for (var a = 0; a < arrows.length; a++) arrows[a].addEventListener('click', onVote);

    // A four-line clamp only needs a toggle when the text actually exceeds it,
    // which depends on the rendered width, so measure rather than guess.
    var mores = el.list.querySelectorAll('.rl-more');
    for (var m = 0; m < mores.length; m++) {
      var btn = mores[m];
      var para = btn.previousElementSibling;
      if (para.scrollHeight > para.clientHeight + 2) {
        btn.hidden = false;
        btn.addEventListener('click', onToggleSummary);
      } else {
        para.classList.remove('is-clamped');
      }
    }
  }

  function onToggleSummary(ev) {
    var btn = ev.currentTarget;
    var para = btn.previousElementSibling;
    var clamped = para.classList.toggle('is-clamped');
    btn.textContent = clamped ? 'show more' : 'show less';
  }

  function itemHtml(p, rank) {
    var mine = Number(p.my_weight) || 0;
    var scoreClass = mine > 0 ? ' is-up' : (mine < 0 ? ' is-down' : '');
    var me = (state.session && state.session.me) || {};
    // Nudging toward zero always refunds, so it stays available at zero budget.
    var upBlocked = mine >= 0 && me.upvotes_left === 0;
    var downBlocked = mine <= 0 && me.downvotes_left === 0;
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

    var titleHtml = p.link
      ? '<a href="' + esc(p.link) + '" target="_blank" rel="noopener">' + esc(p.title) + '</a>' +
        '<span class="rl-domain">' + esc(domainOf(p.link)) + '</span>'
      : esc(p.title);

    var check = '';
    if (p.read) {
      var who = p.read_by ? ' by ' + esc(p.read_by) : '';
      meta.push('<span class="rl-read-flag">read' + who + '</span>');
      check = '<button type="button" class="rl-check is-on" data-id="' + esc(p.id) +
              '" data-read="false" title="Move back to the list">' + CHECK_SVG + '</button>';
    } else {
      check = '<button type="button" class="rl-check" data-id="' + esc(p.id) +
              '" data-read="true" title="Mark as read">' + CHECK_SVG + '</button>';
    }

    return '' +
      '<li class="rl-item' + (p.read ? ' is-read' : '') + '" data-id="' + esc(p.id) + '">' +
        '<div class="rl-rank">' + (rank == null ? '' : rank) + '</div>' +
        '<div class="rl-votes">' +
          arrowHtml('up', mine > 0, p.id, upBlocked) +
          '<div class="rl-score' + scoreClass + '" data-score>' + p.score + '</div>' +
          arrowHtml('down', mine < 0, p.id, downBlocked) +
          (mine ? '<div class="rl-mine' + (mine > 0 ? ' is-up' : ' is-down') + '">' +
                    (mine > 0 ? '+' + mine : String(mine)) + '</div>' : '') +
        '</div>' +
        '<div class="rl-body">' +
          '<div class="rl-title">' + titleHtml + '</div>' +
          '<div class="rl-meta">' + meta.join(' &middot; ') + '</div>' +
          (p.summary
            ? '<p class="rl-summary is-clamped">' + esc(p.summary) + '</p>' +
              '<button type="button" class="rl-more" hidden>show more</button>'
            : '') +
          (tags ? '<div class="rl-focus">' + tags + '</div>' : '') +
        '</div>' +
        check +
      '</li>';
  }

  var CHECK_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M6.2 11.3 3 8.1l1.1-1.1 2.1 2.1 5.7-5.7L13 4.5z"/></svg>';

  function arrowHtml(dir, on, id, blocked) {
    var path = dir === 'up'
      ? 'M8 2.5 14.5 10H10.8v3.6H5.2V10H1.5z'
      : 'M8 13.5 1.5 6h3.7V2.4h5.6V6h3.7z';
    var label = blocked
      ? 'No ' + dir + 'votes left this week'
      : 'Add ' + (dir === 'up' ? 'an upvote' : 'a downvote') + ' (you can stack several)';
    return '<button type="button" class="rl-arrow rl-' + dir + (on ? ' is-on' : '') + '"' +
           ' data-dir="' + dir + '" data-id="' + esc(id) + '"' +
           (blocked ? ' disabled' : '') +
           ' aria-label="' + dir + 'vote" title="' + label + '">' +
           '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="' + path + '"/></svg></button>';
  }

  // Who added what stays in the Sheet. The page shows only this aggregate.
  function renderTally() {
    if (!el.tally) return;
    var rows = state.contributors || [];
    if (!rows.length) { el.tally.hidden = true; return; }

    var total = 0;
    var parts = [];
    for (var i = 0; i < rows.length; i++) {
      total += rows[i].count;
      parts.push('<span class="rl-tally-item"><span class="rl-tally-name">' + esc(rows[i].name) +
                 '</span><span class="rl-tally-count">' + rows[i].count + '</span></span>');
    }
    var span = state.contributorDays === 30 ? 'the past month'
                                            : 'the past ' + state.contributorDays + ' days';
    el.tally.innerHTML =
      '<span class="rl-tally-label">' + total + (total === 1 ? ' paper' : ' papers') +
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
    var quota = '<span class="rl-quota">' +
      '<span>&#9650; ' + num(me.upvotes_left) + '/' + num(me.upvotes_total, 3) + '</span>' +
      '<span>&#9660; ' + num(me.downvotes_left) + '/' + num(me.downvotes_total, 3) + '</span>' +
      '<span>submissions ' + num(me.submissions_left) + '/' + num(me.submissions_total, 10) + '</span>' +
      '</span>';
    el.auth.innerHTML =
      '<div class="rl-status"><strong>' + esc(s.member) + '</strong><br>' + quota +
      ' &middot; <button type="button" class="rl-btn-link" id="rl-logout">sign out</button></div>' +
      '<button type="button" class="rl-btn rl-btn-solid" id="rl-add">Add paper</button>';
    document.getElementById('rl-logout').addEventListener('click', signOut);
    document.getElementById('rl-add').addEventListener('click', openSubmit);
  }

  function num(v, fallback) {
    if (v === 0) return '0';
    return v == null ? (fallback == null ? '?' : String(fallback)) : String(v);
  }

  /* ------------------------------ actions -------------------------------- */

  function onSort(ev) {
    var btn = ev.currentTarget;
    state.sort = btn.getAttribute('data-sort');
    for (var i = 0; i < el.sorts.length; i++) el.sorts[i].classList.remove('is-active');
    btn.classList.add('is-active');
    render();
  }

  function onSearch(ev) {
    state.query = ev.target.value.trim();
    render();
  }

  function onVote(ev) {
    var btn = ev.currentTarget;
    var id = btn.getAttribute('data-id');
    var dir = btn.getAttribute('data-dir');

    if (!state.session || !state.session.token) {
      openLogin('Sign in with your lab passcode to vote.');
      return;
    }
    if (state.busy[id]) return;
    state.busy[id] = true;

    apiPost({ action: 'vote', paper_id: id, direction: dir }, function (data) {
      state.busy[id] = false;
      if (!data || !data.ok) {
        if (data && data.expired) { signOut(); openLogin('Your session expired. Sign in again.'); }
        else notice((data && data.error) || 'Vote failed.', 'error');
        if (data && data.me && state.session) { state.session.me = data.me; writeSession(state.session); renderAuth(); }
        return;
      }
      clearNotice();
      for (var i = 0; i < state.papers.length; i++) {
        if (state.papers[i].id === data.paper_id) {
          state.papers[i].up = data.up;
          state.papers[i].down = data.down;
          state.papers[i].score = data.score;
          state.papers[i].my_weight = data.my_weight;
          break;
        }
      }
      if (data.me) { state.session.me = data.me; writeSession(state.session); }
      renderAuth();
      render();
    });
  }

  function onMarkRead(ev) {
    var btn = ev.currentTarget;
    var id = btn.getAttribute('data-id');
    var wantRead = btn.getAttribute('data-read') === 'true';

    if (!state.session || !state.session.token) {
      openLogin('Sign in with your lab passcode to mark papers read.');
      return;
    }
    if (state.busy[id]) return;
    state.busy[id] = true;
    btn.disabled = true;

    apiPost({ action: 'mark', paper_id: id, read: wantRead }, function (data) {
      state.busy[id] = false;
      if (!data || !data.ok) {
        if (data && data.expired) { signOut(); openLogin('Your session expired. Sign in again.'); }
        else notice((data && data.error) || 'Could not update that paper.', 'error');
        btn.disabled = false;
        return;
      }
      clearNotice();
      for (var i = 0; i < state.papers.length; i++) {
        if (state.papers[i].id === data.paper_id) {
          state.papers[i].read = data.read;
          state.papers[i].read_at = data.read_at;
          state.papers[i].read_by = data.read_by;
          break;
        }
      }
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

    apiPost({ action: 'login', name: name, passcode: passcode }, function (data) {
      btn.disabled = false;
      if (!data || !data.ok) { msg(el.loginMsg, (data && data.error) || 'Sign in failed.', 'error'); return; }
      state.session = { token: data.token, member: data.member, me: data.me };
      writeSession(state.session);
      msg(el.loginMsg, '', '');
      el.loginForm.reset();
      closeModal(el.loginModal);
      renderAuth();
      load();
    });
  }

  function showDetails(focusTitle) {
    if (el.details) el.details.hidden = false;
    if (el.submitBtn) el.submitBtn.hidden = false;
    if (el.manualBtn) el.manualBtn.hidden = true;
    if (focusTitle) {
      var t = document.getElementById('rl-f-title');
      if (t) t.focus();
    }
  }

  function onLookup() {
    var link = el.link ? el.link.value.trim() : '';
    if (!link) { msg(el.submitMsg, 'Paste a link first.', 'error'); el.link.focus(); return; }

    el.lookupBtn.disabled = true;
    var label = el.lookupBtn.textContent;
    el.lookupBtn.textContent = 'Looking\u2026';
    msg(el.submitMsg, '', '');

    apiPost({ action: 'lookup', link: link }, function (data) {
      el.lookupBtn.disabled = false;
      el.lookupBtn.textContent = label;

      if (!data || !data.ok) {
        if (data && data.expired) {
          signOut(); closeModal(el.submitModal); openLogin('Your session expired. Sign in again.');
          return;
        }
        // A failed lookup is not a dead end: open the fields so it can be typed.
        showDetails(true);
        msg(el.submitMsg, (data && data.error) || 'Could not read that page. Fill the fields in by hand.', 'error');
        return;
      }

      if (data.link) el.link.value = data.link;
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
      if (missing.length) {
        msg(el.submitMsg, 'Found what it could' + (data.source ? ' via ' + data.source : '') +
            '. Missing: ' + missing.join(', ') + '. Edit anything below before posting.', '');
      } else {
        msg(el.submitMsg, 'Filled in from ' + (data.source || 'the page') +
            '. Check it over before posting.', 'ok');
      }
    });
  }

  function setValue(id, value) {
    var node = document.getElementById(id);
    if (node) node.value = value == null ? '' : value;
  }

  function onSubmit(ev) {
    ev.preventDefault();
    var payload = {
      action: 'submit',
      title: document.getElementById('rl-f-title').value.trim(),
      link: document.getElementById('rl-f-link').value.trim(),
      venue: document.getElementById('rl-f-venue').value.trim(),
      year: document.getElementById('rl-f-year').value.trim(),
      summary: document.getElementById('rl-f-summary').value.trim()
    };
    if (!payload.title) { msg(el.submitMsg, 'A title is required.', 'error'); return; }

    var btn = document.getElementById('rl-submit-btn');
    btn.disabled = true;
    msg(el.submitMsg, 'Posting…', '');

    apiPost(payload, function (data) {
      btn.disabled = false;
      if (!data || !data.ok) {
        if (data && data.expired) { signOut(); closeModal(el.submitModal); openLogin('Your session expired. Sign in again.'); return; }
        msg(el.submitMsg, (data && data.error) || 'Could not post the paper.', 'error');
        if (data && data.me && state.session) { state.session.me = data.me; writeSession(state.session); renderAuth(); }
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

  function signOut() {
    state.session = null;
    try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ }
    for (var i = 0; i < state.papers.length; i++) state.papers[i].my_weight = 0;
    renderAuth();
    render();
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
    if (el.submitQuota) {
      el.submitQuota.textContent = num(me.submissions_left) + ' of ' +
        num(me.submissions_total, 10) + ' submissions left this week.';
    }
    msg(el.submitMsg, '', '');
    if (el.submitForm) el.submitForm.reset();
    if (el.details) el.details.hidden = true;
    if (el.submitBtn) el.submitBtn.hidden = true;
    if (el.manualBtn) el.manualBtn.hidden = false;
    el.submitModal.hidden = false;
    if (el.link) el.link.focus();
  }

  function closeModal(m) { if (m) m.hidden = true; }

  /* ------------------------------ helpers -------------------------------- */

  function notice(html, kind) {
    if (!el.notice) return;
    el.notice.innerHTML = html;
    el.notice.className = 'rl-notice' + (kind ? ' is-' + kind : '');
    el.notice.hidden = false;
  }
  function clearNotice() { if (el.notice) el.notice.hidden = true; }

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
    try {
      var h = new URL(url).hostname.replace(/^www\./, '');
      return h ? '(' + h + ')' : '';
    } catch (e) { return ''; }
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
