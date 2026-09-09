---
layout: page
permalink: /reading-list/
title: Reading List
description: Papers the lab is reading, ranked by lab votes. Anyone can browse; lab members sign in to vote and to add papers.
nav: true
nav_order: 2
---

<link rel="stylesheet" href="{{ '/assets/css/reading-list.css' | relative_url }}">

<div class="rl-wrap">

  <div class="rl-toolbar">
    <div class="rl-sorts">
      <button type="button" class="rl-sort is-active" data-sort="top">Top</button>
      <button type="button" class="rl-sort" data-sort="new">New</button>
    </div>
    <input type="search" id="rl-search" class="rl-search" placeholder="Search title, venue, topic&hellip;" aria-label="Search papers">
    <div class="rl-auth" id="rl-auth"></div>
  </div>

  <div class="rl-tally" id="rl-tally" hidden></div>

  <div class="rl-notice" id="rl-notice" hidden></div>

  <ul class="rl-list" id="rl-list">
    <li class="rl-loading">Loading papers&hellip;</li>
  </ul>

</div>

<!-- Sign in -->
<div class="rl-modal" id="rl-login-modal" role="dialog" aria-modal="true" aria-labelledby="rl-login-title" hidden>
  <div class="rl-modal-card">
    <div class="rl-modal-head">
      <h3 id="rl-login-title">Lab member sign in</h3>
      <button type="button" class="rl-close" data-rl-close="rl-login-modal" aria-label="Close">&times;</button>
    </div>
    <p class="rl-modal-sub">Your first name and the passcode Yi gave you. Browsing the list needs no sign in.</p>
    <form id="rl-login-form">
      <div class="rl-field">
        <label for="rl-login-name">Name</label>
        <input type="text" id="rl-login-name" autocomplete="username" placeholder="First name" required>
      </div>
      <div class="rl-field">
        <label for="rl-login-passcode">Passcode</label>
        <input type="password" id="rl-login-passcode" autocomplete="current-password" required>
      </div>
      <div class="rl-modal-actions">
        <button type="submit" class="rl-btn rl-btn-solid" id="rl-login-submit">Sign in</button>
        <button type="button" class="rl-btn-link rl-spacer" data-rl-close="rl-login-modal">Cancel</button>
      </div>
      <div class="rl-msg" id="rl-login-msg"></div>
    </form>
  </div>
</div>

<!-- Add a paper -->
<div class="rl-modal" id="rl-submit-modal" role="dialog" aria-modal="true" aria-labelledby="rl-submit-title" hidden>
  <div class="rl-modal-card">
    <div class="rl-modal-head">
      <h3 id="rl-submit-title">Add a paper</h3>
      <button type="button" class="rl-close" data-rl-close="rl-submit-modal" aria-label="Close">&times;</button>
    </div>
    <p class="rl-modal-sub" id="rl-submit-quota"></p>
    <form id="rl-submit-form">
      <div class="rl-field">
        <label for="rl-f-link">Link</label>
        <div class="rl-lookup">
          <input type="url" id="rl-f-link" placeholder="https://arxiv.org/abs/2601.00042" autocomplete="off">
          <button type="button" class="rl-btn" id="rl-lookup-btn">Look up</button>
        </div>
        <div class="rl-hint">An arXiv, DOI or publisher link. The rest is filled in for you where possible.</div>
      </div>

      <div id="rl-details" hidden>
        <div class="rl-field">
          <label for="rl-f-title">Title</label>
          <input type="text" id="rl-f-title" required>
        </div>
        <div class="rl-row">
          <div class="rl-field">
            <label for="rl-f-venue">Venue</label>
            <input type="text" id="rl-f-venue" placeholder="NeurIPS, arXiv, TPAMI&hellip;">
          </div>
          <div class="rl-field">
            <label for="rl-f-year">Year</label>
            <input type="text" id="rl-f-year" inputmode="numeric" placeholder="2026">
          </div>
        </div>
        <div class="rl-field">
          <label for="rl-f-summary">Abstract</label>
          <textarea id="rl-f-summary" rows="7" placeholder="Pasted automatically when it can be found."></textarea>
        </div>
      </div>

      <div class="rl-modal-actions">
        <button type="submit" class="rl-btn rl-btn-solid" id="rl-submit-btn" hidden>Post to list</button>
        <button type="button" class="rl-btn-link" id="rl-manual">Skip lookup and type it in</button>
        <button type="button" class="rl-btn-link rl-spacer" data-rl-close="rl-submit-modal">Cancel</button>
      </div>
      <div class="rl-msg" id="rl-submit-msg"></div>
    </form>
  </div>
</div>

<script>
  window.READING_LIST_CONFIG = { api: "{{ site.reading_list_api }}" };
</script>
<script src="{{ '/assets/js/reading-list.js' | relative_url }}"></script>
