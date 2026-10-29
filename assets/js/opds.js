'use strict';
/*
 * OPDS catalog support (the open standard used by Project Gutenberg, Standard Ebooks, Calibre, Calibre-Web, Kavita, ...).
 *   Opds.parse(xmlText, baseUrl) -> { title, entries[], next, search }
 * An entry is either a folder ({ nav: url }) or a book ({ title, authors, summary, cover, formats[], detail }).
 * All requests go through the native bridge (window.Android.httpGet) because a web page may not read other sites.
 */
const Opds = (() => {
  const REL_ACQ = 'http://opds-spec.org/acquisition';
  const REL_IMG = 'http://opds-spec.org/image';
  const REL_THUMB = 'http://opds-spec.org/image/thumbnail';

  /** A plain-language reason for a failed request. */
  function describeFailure(r) {
    const s = r.status;
    if (s === 401 || s === 403) return `The catalog refused the request (${s}). It may need a login, or it may block apps.`;
    if (s === 404) return 'That catalog page was not found (404). The address may have changed.';
    if (s === 429) return 'The catalog says too many requests (429). Wait a minute and try again.';
    if (s >= 500) return `The catalog is having problems (${s}). Try again later.`;
    if (s) return `The catalog answered ${s}.`;
    const e = r.error || '';
    if (/resolve host|UnknownHost|connect|timed out|timeout|reset|Network/i.test(e) || !e) return 'Could not reach the catalog. Check your internet connection and try again.';
    return e;
  }

  const pending = {};
  let counter = 0;

  /** Called by the app when the native side answers. */
  function answer(r) {
    const cb = pending[r.id];
    delete pending[r.id];
    if (cb) cb(r);
  }

  function fetchText(url) {
    return new Promise((resolve, reject) => {
      const id = 'h' + (++counter);
      const timer = setTimeout(() => { delete pending[id]; reject(new Error('The catalog took too long to answer')); }, 45000);
      pending[id] = (r) => {
        clearTimeout(timer);
        if (r.status >= 200 && r.status < 300) resolve(r);
        else reject(new Error(describeFailure(r)));
      };
      if (window.Android && Android.httpGet) Android.httpGet(id, url);
      else answer({ id, status: 0, error: 'Needs the Android app' });
    });
  }

  const abs = (href, base) => { try { return new URL(href, base).toString(); } catch (e) { return ''; } };
  const text = (el, tag) => { const n = el.getElementsByTagName(tag)[0]; return n ? n.textContent.trim() : ''; };
  const clean = (html) => {
    const spaced = (html || '').replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|tr|td)\b[^>]*>/gi, ' ');
    const d = new DOMParser().parseFromString(spaced, 'text/html');
    return (d.body.textContent || '').replace(/\bLanguage:\s*[A-Za-z]+\.?/g, '').replace(/\s+/g, ' ').trim();
  };

  /** A book's description from <content> or <summary>, whether it is plain text, escaped HTML or inline XHTML. */
  function describe(e) {
    const kids = Array.from(e.children);
    const el = kids.find((c) => c.localName === 'content') || kids.find((c) => c.localName === 'summary');
    if (!el) return '';
    if ((el.getAttribute('type') || 'text').toLowerCase() === 'xhtml') return clean(new XMLSerializer().serializeToString(el));
    return clean(el.textContent);
  }

  function links(el, base) {
    return Array.from(el.children).filter((c) => c.localName === 'link').map((l) => ({
      rel: l.getAttribute('rel') || '', type: l.getAttribute('type') || '', href: abs(l.getAttribute('href') || '', base),
      title: l.getAttribute('title') || '', length: l.getAttribute('length') || '',
    })).filter((l) => l.href);
  }

  const isAcq = (l) => l.rel.indexOf(REL_ACQ) === 0;
  const isImage = (l) => l.rel === REL_IMG || l.rel === REL_THUMB || l.rel === 'x-stanza-cover-image' || l.rel === 'x-stanza-cover-image-thumbnail';

  function formatOf(l) {
    const t = l.type.toLowerCase();
    if (t.includes('epub')) return 'EPUB';
    if (t.includes('pdf')) return 'PDF';
    return null;
  }

  /** Readable formats first; EPUB with images before plain EPUB. */
  function rankFormats(list) {
    return list.sort((a, b) => (a.format === b.format ? (b.score - a.score) : (a.format === 'EPUB' ? -1 : 1)));
  }

  function parseEntry(e, base) {
    const ls = links(e, base);
    const authors = Array.from(e.getElementsByTagName('author')).map((a) => text(a, 'name')).filter(Boolean);
    const formats = [];
    for (const l of ls.filter(isAcq)) {
      const f = formatOf(l);
      if (!f) continue;
      let score = 0;
      if (/images/.test(l.href) || /\.images/.test(l.title)) score += 2;
      if (/epub3|epub\.noimages/.test(l.href) === false && f === 'EPUB') score += 1;
      if (/noimages/.test(l.href)) score -= 1;
      formats.push({ format: f, url: l.href, size: l.length, score });
    }
    const thumb = ls.find((l) => l.rel === REL_THUMB) || ls.find(isImage);
    const title = text(e, 'title') || 'Untitled';
    let summary = describe(e);
    const entry = {
      id: text(e, 'id'), title, authors, summary, note: '',
      cover: thumb ? thumb.href : '',
      formats: rankFormats(formats),
    };
    // Some feeds (Project Gutenberg) put only the author, or a download count, in a book's short description
    const splitShort = () => {
      if (!entry.authors.length && entry.summary && entry.summary.length <= 90 && !/[.!?]\s/.test(entry.summary)) {
        if (/^\d[\d,.]*\s+downloads?$/i.test(entry.summary)) entry.note = entry.summary; else entry.authors.push(entry.summary);
        entry.summary = '';
      }
    };
    if (!entry.formats.length) {
      const detail = ls.find((l) => /application\/atom\+xml/.test(l.type) && /entry/.test(l.type))
        || ls.find((l) => l.rel === 'alternate' && /atom|opds/.test(l.type));
      const nav = ls.find((l) => l.rel === 'subsection' || l.rel === 'http://opds-spec.org/sort/new' || l.rel === 'http://opds-spec.org/sort/popular'
        || l.rel === 'http://opds-spec.org/featured' || (/atom\+xml/.test(l.type) && /kind=(navigation|acquisition)/.test(l.type)) || l.rel === 'start');
      // A listing without download links is a book only when it points at a single-book page
      // (Gutenberg lists books as plain "subsection" links); anything else is a folder.
      const single = [detail, nav].filter(Boolean).find((l) => /\/ebooks\/\d+\.opds|\/entry\b|\/book\//.test(l.href) || (l === detail));
      const bookLike = !!single;   // cover art alone does not make a book: folders often carry an icon
      const target = (detail || nav || {}).href;
      if (bookLike && target) { entry.detail = target; entry.maybeFolder = !detail; }
      else if (nav) return { title, summary, nav: nav.href, authors };
      else if (detail) entry.detail = detail.href;
    }
    splitShort();
    return entry;
  }

  function parse(xml, base) {
    if (/^\s*(<!doctype html|<html)/i.test(xml)) throw new Error('The site sent a web page instead of a catalog. It may block apps or need a login.');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('This address is not an OPDS catalog');
    const root = doc.documentElement;
    if (root.localName === 'entry') return { title: text(root, 'title'), entries: [parseEntry(root, base)], single: true };
    if (root.localName !== 'feed') throw new Error('This address is not an OPDS catalog');
    const ls = links(root, base);
    const next = ls.find((l) => l.rel === 'next');
    const search = ls.find((l) => l.rel === 'search');
    const entries = Array.from(root.children).filter((c) => c.localName === 'entry').map((e) => parseEntry(e, base));
    return { title: text(root, 'title'), entries, next: next && next.href, search: search && { href: search.href, type: search.type } };
  }

  /** Fills in a search URL from an OpenSearch template. */
  const fillTemplate = (tpl, q) => tpl.replace(/(\{|%7B)searchTerms\??(\}|%7D)/gi, encodeURIComponent(q)).replace(/(\{|%7B)[^}%]+(\}|%7D)/gi, '');

  async function searchUrl(source, feed, q) {
    if (source && source.search) return fillTemplate(source.search, q);
    const s = feed && feed.search;
    if (!s) return null;
    if (/opensearchdescription/.test(s.type)) {
      const r = await fetchText(s.href);
      const d = new DOMParser().parseFromString(r.body, 'application/xml');
      const urls = Array.from(d.getElementsByTagName('Url'));
      const u = urls.find((x) => /atom|opds/.test(x.getAttribute('type') || '')) || urls[0];
      return u ? fillTemplate(abs(u.getAttribute('template'), r.url), q) : null;
    }
    return fillTemplate(s.href, q);
  }

  async function load(url) {
    const r = await fetchText(url);
    return Object.assign(parse(r.body, r.url), { url: r.url });
  }

  return { load, parse, answer, searchUrl, fetchText };
})();
