// Fill in title, venue, year and abstract from a paper link.
// Sources, in order: arXiv API, OpenReview API, Crossref by DOI, OpenAlex by DOI,
// then the page's own citation_* / OpenGraph meta tags. Each fills only gaps.

import { tidy, normalizeLink, arxivIdFrom, doiFrom, decodeEntities, HttpError } from './util.mjs';

const UA = 'Mozilla/5.0 (compatible; LabReadingList/2.0; +https://yding37.github.io/reading-list/)';

async function fetchText(url, ms = 6000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8' },
    });
    if (!r.ok) return null;
    const text = await r.text();
    return text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url) {
  const t = await fetchText(url);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function merge(base, extra) {
  if (!base) return extra;
  if (!extra) return base;
  for (const k of ['title', 'venue', 'year', 'abstract']) if (!base[k] && extra[k]) base[k] = extra[k];
  return base;
}

function tag(xml, name) {
  const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i').exec(xml);
  return m ? tidy(decodeEntities(m[1])) : '';
}

// ---------------------------------------------------------------- arXiv
export async function fromArxiv(id) {
  const xml = await fetchText('https://export.arxiv.org/api/query?max_results=1&id_list=' + encodeURIComponent(id));
  if (!xml) return null;
  const entry = /<entry>([\s\S]*?)<\/entry>/i.exec(xml);
  if (!entry) return null;
  const e = entry[1];
  const title = tag(e, 'title');
  if (!title || /^error$/i.test(title)) return null;
  const journal = tag(e, 'arxiv:journal_ref');
  return {
    title,
    venue: journal || venueFromComment(tag(e, 'arxiv:comment')) || 'arXiv',
    year: tag(e, 'published').slice(0, 4),
    abstract: tag(e, 'summary'),
  };
}

/** "Accepted at NeurIPS 2026" in an arXiv comment names the real venue. */
export function venueFromComment(comment) {
  if (!comment) return '';
  const m = /(?:accepted|to appear|published|camera[- ]ready)[^.;]*?\b(?:at|in|to|by)\b\s*([^.;,]{2,60})/i.exec(comment);
  return m ? tidy(m[1]) : '';
}

// ---------------------------------------------------------------- OpenReview
function openReviewIdFrom(url) {
  const m = /openreview\.net\/(?:forum|pdf|references)\?[^#]*\bid=([A-Za-z0-9_-]+)/i.exec(url);
  return m ? m[1] : null;
}

const orField = (f) => (f == null ? '' : typeof f === 'object' && 'value' in f ? String(f.value || '') : String(f));

async function fromOpenReview(id) {
  for (const base of ['https://api2.openreview.net', 'https://api.openreview.net']) {
    for (const q of ['forum=', 'id=']) {
      const data = await fetchJson(base + '/notes?' + q + encodeURIComponent(id));
      const note = data && data.notes && data.notes[0];
      const title = note && orField(note.content && note.content.title);
      if (!title) continue;
      const venue = orField(note.content.venue) || orField(note.content.venueid) || 'OpenReview';
      const year = /(19|20)\d{2}/.exec(venue);
      return { title: tidy(title), venue: tidy(venue), year: year ? year[0] : '', abstract: tidy(orField(note.content.abstract)) };
    }
  }
  return null;
}

// ---------------------------------------------------------------- DOI
function stripJats(text) {
  return tidy(decodeEntities(String(text || '')
    .replace(/<jats:title[^>]*>[\s\S]*?<\/jats:title>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')));
}

const first = (v) => (Array.isArray(v) ? v[0] || '' : v || '');

async function fromCrossref(doi) {
  const data = await fetchJson('https://api.crossref.org/works/' + encodeURIComponent(doi));
  const m = data && data.message;
  if (!m) return null;
  const issued = m.issued && m.issued['date-parts'] && m.issued['date-parts'][0];
  return {
    title: tidy(first(m.title)),
    venue: tidy(first(m['container-title']) || first(m['short-container-title']) || (m.event && m.event.name) || ''),
    year: issued && issued[0] ? String(issued[0]) : '',
    abstract: stripJats(m.abstract),
  };
}

// OpenAlex rejects an encoded "doi%3A" prefix; the prefix must stay literal and only
// the DOI itself is encoded.
async function fromOpenAlex(doi) {
  const d = await fetchJson('https://api.openalex.org/works/doi:' + encodeURIComponent(doi));
  if (!d || !d.id) return null;
  let abstract = '';
  if (d.abstract_inverted_index) {
    const words = [];
    for (const [w, at] of Object.entries(d.abstract_inverted_index)) for (const i of at) words[i] = w;
    abstract = tidy(words.join(' '));
  }
  return {
    title: tidy(d.display_name),
    venue: tidy(d.primary_location && d.primary_location.source && d.primary_location.source.display_name),
    year: d.publication_year ? String(d.publication_year) : '',
    abstract,
  };
}

// ---------------------------------------------------------------- page meta
function attr(tagText, name) {
  const m = new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tagText);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
}

function meta(html, name) {
  const want = name.toLowerCase();
  for (const t of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = attr(t, 'name') || attr(t, 'property');
    if (key && key.toLowerCase() === want) {
      const c = attr(t, 'content');
      if (c) return tidy(decodeEntities(c));
    }
  }
  return '';
}

async function fromPageMeta(url) {
  const html = await fetchText(url);
  if (!html) return null;
  const title = meta(html, 'citation_title') || meta(html, 'dc.title') || meta(html, 'og:title') || tag(html, 'title');
  const venue = meta(html, 'citation_journal_title') || meta(html, 'citation_conference_title') ||
                meta(html, 'citation_inbook_title') || meta(html, 'dc.source') || meta(html, 'og:site_name');
  const date = meta(html, 'citation_publication_date') || meta(html, 'citation_date') ||
               meta(html, 'citation_online_date') || meta(html, 'dc.date') || meta(html, 'article:published_time');
  const abstract = meta(html, 'citation_abstract') || meta(html, 'dc.description') ||
                   meta(html, 'og:description') || meta(html, 'description');
  const y = /(19|20)\d{2}/.exec(date || '');
  if (!title && !abstract) return null;
  return { title, venue, year: y ? y[0] : '', abstract };
}

// ---------------------------------------------------------------- entry point
export async function lookup({ link }) {
  const url = normalizeLink(link);
  if (!url) throw new HttpError(400, 'Paste a link first.');

  let meta_ = null;
  let source = '';
  const note = (m, s) => { if (m) { meta_ = merge(meta_, m); source = source || s; } };

  const ax = arxivIdFrom(url);
  if (ax) note(await fromArxiv(ax), 'arXiv');

  const orId = openReviewIdFrom(url);
  if (orId && !(meta_ && meta_.title)) note(await fromOpenReview(orId), 'OpenReview');

  if (!meta_ || !meta_.title || !meta_.abstract) {
    const doi = doiFrom(url);
    if (doi) {
      note(await fromCrossref(doi), 'Crossref');
      if (!meta_ || !meta_.abstract) note(await fromOpenAlex(doi), 'OpenAlex');
    }
  }

  if (!meta_ || !meta_.title) note(await fromPageMeta(url), 'page metadata');

  if (!meta_ || (!meta_.title && !meta_.abstract)) {
    return { ok: false, link: url, error: 'Could not read that page. Fill the fields in by hand.' };
  }
  return {
    ok: true, link: url, source,
    title: meta_.title || '', venue: meta_.venue || '', year: meta_.year || '', abstract: meta_.abstract || '',
  };
}
