'use strict';
/*
 * Kitab sources: a store of book sources for public, free-to-read books, like Mihon's extensions, but safer.
 *
 * A repository is ONE link to an index.json. Each source in it is a small JSON recipe, not code: it says which web
 * addresses to ask, and where in the answer the titles, covers and download links are. Kitab runs the recipe itself.
 * So a source cannot run anything on the phone, cannot read other apps, and can only talk to the sites it declares.
 *
 *   index.json  { schema:1, name, sources:[{ id, name, lang, version, file, sha256, site, icon, license, kind }] }
 *   source file { schema:1, id, name, version, lang, license, site, hosts:[...], type:'json'|'html'|'opds', ... }
 *
 * See store/SOURCE_FORMAT.md for the full format.
 */
const OFFICIAL_REPO = 'https://raw.githubusercontent.com/mrboora04/kitab-sources/main/index.json';
// where the store lived until Kitab 1.17: still read when the new address cannot be reached
const LEGACY_REPO = 'https://raw.githubusercontent.com/mrboora04/Kitab/main/store/index.json';

const Sources = {
  repos: store.get('er.repos', null) || [{ url: OFFICIAL_REPO, name: 'Kitab Official' }],
  installed: store.get('er.ext', {}),      // id -> { def, repo, at }
  // Sources that come with Kitab itself (not from the store, cannot be removed)
  builtin: { gutenberg: {"schema": 1, "id": "gutenberg", "name": "Project Gutenberg", "version": 5, "lang": "multi", "builtin": true, "license": "Public domain", "site": "https://www.gutenberg.org", "icon": "📚", "blurb": "Over 75,000 free classics, public domain", "hosts": ["gutendex.com", "www.gutenberg.org"], "coverHosts": ["gutenberg.pglaf.org"], "type": "json", "langFilter": {"param": "&languages={v}", "values": {"en": "en", "es": "es", "fr": "fr", "de": "de", "it": "it", "pt": "pt", "ru": "ru", "zh": "zh", "ja": "ja", "ar": "ar", "hi": "hi", "la": "la"}}, "tagSearch": {"url": "https://gutendex.com/books/?topic={tag}"}, "search": {"url": "https://gutendex.com/books/?search={q}{lang}", "list": "results", "next": "next", "map": {"id": "id", "title": "title", "authors": "authors[].name", "summary": "summaries.0", "cover": {"tpl": "https://gutenberg.pglaf.org/cache/epub/{id}/pg{id}.cover.medium.jpg#{formats.image/jpeg|enc}"}, "tags": ["subjects", "bookshelves"], "formats": [{"format": "EPUB", "url": {"tpl": "https://www.gutenberg.org/ebooks/{id}.epub.noimages#{formats.application/epub+zip|enc}"}}, {"format": "EPUB", "label": "EPUB with pictures", "url": "formats.application/epub+zip"}]}}, "browse": [{"key": "popular", "label": "Popular", "url": "https://gutendex.com/books/?sort=popular{lang}"}, {"key": "latest", "label": "Latest", "url": "https://gutendex.com/books/?sort=descending{lang}"}, {"key": "fiction", "label": "Fiction", "url": "https://gutendex.com/books/?topic=fiction{lang}"}, {"key": "children", "label": "Children", "url": "https://gutendex.com/books/?topic=children{lang}"}, {"key": "poetry", "label": "Poetry", "url": "https://gutendex.com/books/?topic=poetry{lang}"}, {"key": "history", "label": "History", "url": "https://gutendex.com/books/?topic=history{lang}"}, {"key": "science", "label": "Science", "url": "https://gutendex.com/books/?topic=science{lang}"}]} },
  indexes: {},                             // repo url -> { name, sources[], at }
  ctx: {},                                 // detail key -> what is needed to open one book's page
  catalogCache: {},                        // source id -> { data, at }: a catalog source's whole list, kept for a while
  preview: {},                             // source id -> def: a store source used by a shelf, checked but not installed

  saveRepos() { store.set('er.repos', this.repos); },

  /** Settings saved by Kitab 1.17 and older point at the old store address. */
  migrate() {
    let changed = false;
    for (const r of this.repos) if (r.url === LEGACY_REPO) { r.url = OFFICIAL_REPO; changed = true; }
    this.repos = this.repos.filter((r, i, a) => a.findIndex((x) => x.url === r.url) === i);
    if (changed) this.saveRepos();
    let moved = false;
    for (const x of Object.values(this.installed)) if (x.repo === LEGACY_REPO) { x.repo = OFFICIAL_REPO; moved = true; }
    if (moved) this.saveInstalled();
  },

  /** What the store's daily check found for a source: { working, checkedAt } or null when it has not been checked. */
  health(id) {
    for (const r of this.repos) {
      const ix = this.indexes[r.url], st = ix && ix.status && ix.status.sources && ix.status.sources[id];
      if (st) return { working: st.working !== false, checkedAt: ix.status.checkedAt || '' };
    }
    return null;
  },
  saveInstalled() { store.set('er.ext', this.installed); },

  /* ---------------- safety ---------------- */
  hostOk(def, url) {
    let u;
    try { u = new URL(url); } catch (e) { return false; }
    if (u.protocol !== 'https:') return false;
    return def.hosts.some((h) => (h.startsWith('*.') ? (u.hostname === h.slice(2) || u.hostname.endsWith(h.slice(1))) : u.hostname === h));
  },

  /** Why a source recipe is not acceptable, or '' when it is fine. */
  validate(d) {
    const str = (v, max = 200) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return 'it is not a source';
    if (d.schema !== 1) return 'it uses a newer format than this Kitab understands';
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(d.id || '')) return 'its id is not valid';
    if (!str(d.name, 60)) return 'it has no name';
    if (!Number.isInteger(d.version) || d.version < 1) return 'its version is not valid';
    if (!str(d.license, 200)) return 'it does not say what kind of books it offers (license)';
    if (d.adult) return 'sources with adult content are not allowed';
    if (!Array.isArray(d.hosts) || !d.hosts.length || d.hosts.length > 6 || d.hosts.some((h) => !/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(h))) return 'its list of websites is not valid';
    if (!['json', 'html', 'opds', 'catalog'].includes(d.type)) return 'its type is unknown';
    if (d.type === 'catalog' && !/^https:\/\/\S+$/.test(d.catalog || '')) return 'its list of books (catalog) is missing';
    if (JSON.stringify(d).length > 20000) return 'it is too large';
    if (d.coverHosts && (!Array.isArray(d.coverHosts) || d.coverHosts.length > 4 || d.coverHosts.some((h) => !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(h)))) return 'its list of picture websites is not valid';
    let bad = '';
    const walk = (v) => {
      if (bad) return;
      if (typeof v === 'string') {
        if (/^https?:\/\//i.test(v) && !this.hostOk(d, v.replace(/\{[^}]*\}/g, 'x')) && !this.coverOk(d, v.replace(/\{[^}]*\}/g, 'x'))) bad = 'it points at a website it did not declare: ' + v.slice(0, 60);
      } else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(d);
    return bad;
  },

  async sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  },

  /* ---------------- repositories and installing ---------------- */
  async fetchIndex(repo, force) {
    const hit = this.indexes[repo.url];
    if (hit && !force && Date.now() - hit.at < 3600e3) return hit;
    let r;
    try { r = await Opds.fetchText(repo.url); } catch (e) {
      if (repo.url !== OFFICIAL_REPO) throw e;
      r = await Opds.fetchText(LEGACY_REPO);        // the official store's older home
    }
    let idx;
    try { idx = JSON.parse(r.body); } catch (e) { throw new Error('That address is not a Kitab source list'); }
    if (!idx || idx.schema !== 1 || !Array.isArray(idx.sources)) throw new Error('That address is not a Kitab source list');
    const sources = idx.sources.filter((s) => s && /^[a-z0-9][a-z0-9-]{1,39}$/.test(s.id || '') && typeof s.file === 'string').slice(0, 300);
    const text = (v, n) => String(v == null ? '' : v).slice(0, n);
    const directory = (Array.isArray(idx.directory) ? idx.directory : [])
      .filter((d) => d && typeof d.name === 'string' && /^https:\/\/\S+$/.test(d.url || '') && d.category).slice(0, 200)
      .map((d) => ({ id: text(d.id || d.name, 40), name: text(d.name, 60), icon: text(d.icon || '🌐', 4), category: text(d.category, 50), url: d.url, about: text(d.about, 140), license: text(d.license, 50), source: /^[a-z0-9-]{2,40}$/.test(d.source || '') ? d.source : '' }));
    const packs = (Array.isArray(idx.packs) ? idx.packs : [])
      .filter((k) => k && /^[a-z0-9-]{2,40}$/.test(k.id || '') && typeof k.name === 'string' && Array.isArray(k.sources)).slice(0, 10)
      .map((k) => ({ id: k.id, name: text(k.name, 60), icon: text(k.icon || '🎁', 4), about: text(k.about, 140), sources: k.sources.filter((i) => /^[a-z0-9-]{2,40}$/.test(i)).slice(0, 12) }));
    const out = { name: String(idx.name || repo.name || 'Repository').slice(0, 60), sources, directory, packs, base: r.url || repo.url, at: Date.now(), status: null };
    // the shelves for the Browse home (optional)
    try {
      const sh = JSON.parse((await Opds.fetchText(new URL('shelves.json', out.base).toString())).body);
      if (sh && sh.schema === 1 && Array.isArray(sh.shelves)) out.shelves = sh.shelves.slice(0, 30);
    } catch (e) { /* no shelves here */ }
    // the daily check's results, next to the list (optional: a list without one is fine)
    try {
      const st = JSON.parse((await Opds.fetchText(new URL('status.json', out.base).toString())).body);
      if (st && typeof st.sources === 'object') out.status = { checkedAt: String(st.checkedAt || '').slice(0, 30), sources: st.sources };
    } catch (e) { /* no status yet */ }
    this.indexes[repo.url] = out;
    return out;
  },

  /** Downloads one source, checks it is the exact file the repository listed, then keeps it. */
  async install(repo, entry) {
    const idx = await this.fetchIndex(repo);
    const url = new URL(entry.file, idx.base).toString();
    const r = await Opds.fetchText(url);
    if (!entry.sha256) throw new Error('This source has no checksum, so Kitab will not install it');
    if ((await this.sha256(r.body)) !== String(entry.sha256).toLowerCase()) throw new Error('The file does not match its checksum. It may have been changed. Not installed');
    let def;
    try { def = JSON.parse(r.body); } catch (e) { throw new Error('That source file is damaged'); }
    const why = this.validate(def);
    if (why) throw new Error('Not installed: ' + why);
    if (def.id !== entry.id) throw new Error('Not installed: the file is not the source it claims to be');
    this.installed[def.id] = { def, repo: repo.url, repoName: idx.name, at: Date.now() };
    this.saveInstalled();
    return def;
  },

  uninstall(id) { delete this.installed[id]; this.saveInstalled(); },

  list() { return Object.values(this.installed).map((x) => x.def).sort((a, b) => a.name.localeCompare(b.name)); },

  /** Every source Browse shows: the built-in ones first, then the installed ones. */
  catalogs() { return Object.values(this.builtin).concat(this.list()).map((d) => this.asCatalog(d)); },

  def(id) { return (this.installed[id] && this.installed[id].def) || this.builtin[id] || this.preview[id] || null; },

  /** A source from the store, for a shelf: checked exactly like installing it (checksum, rules), but not added to your list. */
  async previewDef(id) {
    if (this.def(id)) return this.def(id);
    if (this._previewing && this._previewing[id]) return this._previewing[id];
    this._previewing = this._previewing || {};
    const p = this._previewing[id] = this.fetchPreview(id);
    try { return await p; } finally { delete this._previewing[id]; }
  },

  async fetchPreview(id) {
    for (const repo of this.repos) {
      let idx;
      try { idx = await this.fetchIndex(repo); } catch (e) { continue; }
      const entry = idx.sources.find((x) => x.id === id);
      if (!entry || !entry.sha256) continue;
      try {
        const r = await Opds.fetchText(new URL(entry.file, idx.base).toString());
        if ((await this.sha256(r.body)) !== String(entry.sha256).toLowerCase()) continue;
        const def = JSON.parse(r.body);
        if (def.id !== id || this.validate(def)) continue;
        this.preview[id] = def;
        return def;
      } catch (e) { /* try the next list */ }
    }
    return null;
  },

  /** A source as a Browse "catalog": the root page is an ext: address that Sources.load answers. */
  asCatalog(def) {
    const cat = { id: 'ext:' + def.id, name: def.name, blurb: def.blurb || [def.lang === 'multi' ? 'Multi' : (def.lang || '').toUpperCase(), def.license].filter(Boolean).join(' · '), icon: def.icon || '🧩', def, ext: true };
    if (def.type === 'opds') {
      cat.url = def.start;
      if (def.search) cat.search = def.search;
    } else {
      cat.url = `ext:${def.id}?op=root`;
      if ((def.search && def.search.url) || def.type === 'html' || def.type === 'catalog') cat.search = `ext:${def.id}?op=search&q={searchTerms}`;
    }
    return cat;
  },

  /* ---------------- running a source ---------------- */
  async fetch(def, url) {
    if (!this.hostOk(def, url)) throw new Error('This source tried to reach a website it did not declare, so Kitab stopped it');
    const r = await Opds.fetchText(url);
    if (r.url && !this.hostOk(def, r.url)) throw new Error('The site sent Kitab somewhere this source did not declare, so Kitab stopped it');
    return r;
  },

  fill(tpl, vars) { return String(tpl).replace(/\{([a-zA-Z_]+)\}/g, (m, k) => (vars[k] == null ? '' : vars[k])); },

  /** Follows "a.b[].c" through JSON. A [] walks every item of a list. */
  pick(obj, path) {
    if (obj == null || !path) return undefined;
    let cur = [obj], many = false;
    for (const part of String(path).split('.')) {
      const list = part.endsWith('[]'), key = list ? part.slice(0, -2) : part;
      const next = [];
      for (const o of cur) {
        const v = key ? (o == null ? undefined : o[key]) : o;
        if (list) { if (Array.isArray(v)) next.push(...v); } else if (v !== undefined && v !== null) next.push(v);
      }
      cur = next;
      if (list) many = true;
    }
    return many ? cur : cur[0];
  },

  /** A value from a path ("title") or a template ({ tpl: "https://x/{id}.epub" }); '' when something it needs is missing. */
  val(spec, ctx) {
    if (spec == null) return '';
    if (typeof spec === 'object' && spec.tpl) {
      let missing = false;
      const s = spec.tpl.replace(/\{([^}]+)\}/g, (m, p) => {
        // filters after the path: {title|enc} is made safe for a web address; {ia|or} joins a list as "a OR b OR c"
        const [path, ...filters] = p.split('|');
        const v = this.pick(ctx, path);
        if (v == null || v === '' || (Array.isArray(v) && !v.length)) missing = true;
        let t = Array.isArray(v) ? (filters.includes('or') ? v.slice(0, 25).join(' OR ') : v.join(', ')) : String(v == null ? '' : v);
        if (filters.includes('enc')) t = encodeURIComponent(t);
        return t;
      });
      return missing ? '' : s;
    }
    const v = this.pick(ctx, spec);
    return v == null ? '' : v;
  },

  plain(v) {
    if (Array.isArray(v)) v = v.join(', ');
    const spaced = String(v == null ? '' : v).replace(/<\/?(p|div|br|li|ul|ol|h[1-6])\b[^>]*>/gi, ' ');
    return new DOMParser().parseFromString(spaced, 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
  },

  /** "css selector" or "css selector@attribute" on an HTML page. */
  dom(root, spec, base) {
    if (!spec) return '';
    const [css, attr] = String(spec).split('@');
    let el;
    try { el = css.trim() ? root.querySelector(css.trim()) : root; } catch (e) { return ''; }
    if (!el) return '';
    let v = attr ? el.getAttribute(attr.trim()) : el.textContent;
    v = (v || '').replace(/\s+/g, ' ').trim();
    if (v && attr && /^(href|src|data-src)$/.test(attr.trim())) { try { v = new URL(v, base).toString(); } catch (e) { v = ''; } }
    return v;
  },

  /** A cover picture may come from the source's own sites, or from sites it lists as picture hosts. */
  coverOk(def, url) {
    if (!url) return false;
    if (this.hostOk(def, url)) return true;
    try { const u = new URL(url); return u.protocol === 'https:' && (def.coverHosts || []).includes(u.hostname); } catch (e) { return false; }
  },

  entryId(def, key) { return def.id + ':' + key; },

  /** Keeps only download links on the sites the source declared. */
  formats(def, list) {
    const seen = new Set();
    return list.filter((f) => f && f.url && /^(EPUB|PDF)$/.test(f.format) && this.hostOk(def, f.url) && !seen.has(f.url) && seen.add(f.url));
  },

  async load(url) {
    const m = /^ext:([a-z0-9-]+)\?(.*)$/.exec(url);
    const def = m && this.def(m[1]);
    if (!def) throw new Error('That source is not installed');
    const p = new URLSearchParams(m[2]), op = p.get('op');
    if (def.type === 'json') return this.loadJson(def, op, p);
    if (def.type === 'html') return this.loadHtml(def, op, p);
    if (def.type === 'catalog') return this.loadCatalog(def, op, p);
    throw new Error('Open this source from its own page');
  },

  root(def) {
    const entries = (def.browse || []).map((b) => ({ title: b.label || 'Browse', summary: b.about || '', nav: `ext:${def.id}?op=browse&k=${encodeURIComponent(b.key)}&page=1`, authors: [] }));
    return { title: def.name, entries, tabs: entries.map((e) => ({ label: e.title, url: e.nav })), next: null, search: { href: '', type: '' } };
  },

  /** The source's own way of asking for one language ('' for all, or when it cannot). */
  langParam(def, code) {
    const lf = def.langFilter;
    return code && lf && lf.values && lf.values[code] ? String(lf.param || '{v}').replace('{v}', lf.values[code]) : '';
  },

  /** Which request a page needs: the address to fetch and which "map" reads it. */
  request(def, op, p) {
    const page = Math.max(1, Number(p.get('page')) || 1);
    if (op === 'search') {
      const s = def.search;
      if (!s) throw new Error('This source cannot be searched');
      // {lang} in the address becomes the source's own way of asking for one language, or nothing for all
      const lang = this.langParam(def, p.get('lang')), code = p.get('lang') || '';
      const per = (s.pager && Number(s.pager.per)) || 24;
      return { url: this.fill(s.url, { q: encodeURIComponent(p.get('q') || ''), page, offset: (page - 1) * per, lang }), m: s, op, page, q: p.get('q') || '', lang: code };
    }
    if (op === 'browse') {
      const b = (def.browse || []).find((x) => x.key === p.get('k'));
      if (!b) throw new Error('That list does not exist');
      const m = b.map ? b : Object.assign({}, def.search || {}, b), per = (m.pager && Number(m.pager.per)) || 24;
      const code = /\{lang\}/.test(b.url) ? p.get('lang') || '' : '';        // a list in one language, when the source can
      return { url: this.fill(b.url, { page, offset: (page - 1) * per, lang: this.langParam(def, code) }), m, op, page, k: b.key, lang: code };
    }
    if (op === 'tag') {
      const t = def.tagSearch;
      if (!t || !t.url) throw new Error('This source cannot list books by subject');
      const m = Object.assign({}, def.search || {}, t), per = (m.pager && Number(m.pager.per)) || 24;
      return { url: this.fill(t.url, { tag: encodeURIComponent(p.get('t') || ''), page, offset: (page - 1) * per, lang: '' }), m, op, page, t: p.get('t') || '' };
    }
    if (op === 'page') {
      const u = p.get('u');
      const base = p.get('k') ? (def.browse || []).find((x) => x.key === p.get('k')) : null;
      return { url: u, m: base ? (base.map ? base : Object.assign({}, def.search || {}, base)) : def.search, op, page: 1 };
    }
    throw new Error('Unknown request');
  },

  nextAddress(def, req, count, extra) {
    if (extra && /^https:/.test(extra)) return `ext:${def.id}?op=page&u=${encodeURIComponent(extra)}${req.k ? '&k=' + encodeURIComponent(req.k) : ''}`;
    if (!count) return null;
    if (req.op === 'search') return `ext:${def.id}?op=search&q=${encodeURIComponent(req.q)}&page=${req.page + 1}${req.lang ? '&lang=' + req.lang : ''}`;
    if (req.op === 'browse') return `ext:${def.id}?op=browse&k=${encodeURIComponent(req.k)}&page=${req.page + 1}${req.lang ? '&lang=' + req.lang : ''}`;
    if (req.op === 'tag') return `ext:${def.id}?op=tag&t=${encodeURIComponent(req.t)}&page=${req.page + 1}`;
    return null;
  },

  /* --- catalog sources: the whole list of books is one file (built every day by the source list);
         Kitab searches it and makes its lists on the phone --- */
  async catalogData(def) {
    const mem = this.catalogCache[def.id];
    if (mem && Date.now() - mem.at < 6 * 3600e3) return mem.data;
    let data;
    try {
      data = JSON.parse((await this.fetch(def, def.catalog)).body);
    } catch (e) {
      if (mem) return mem.data;                     // keep using the list we have
      throw e.status ? e : new Error('The list of books could not be read');
    }
    if (!data || !Array.isArray(data.books)) throw new Error('The list of books could not be read');
    this.catalogCache[def.id] = { data, at: Date.now() };
    return data;
  },

  async loadCatalog(def, op, p) {
    if (op === 'root') return this.root(def);
    const data = await this.catalogData(def);
    const page = Math.max(1, Number(p.get('page')) || 1), per = 24;
    const fold = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const is = (x, where) => Object.entries(where || {}).every(([k, v]) => (Array.isArray(v) ? v.includes(x[k]) : x[k] === v));
    let list = data.books, base;
    if (op === 'browse') {
      const b = (def.browse || []).find((x) => x.key === p.get('k'));
      if (!b) throw new Error('That list does not exist');
      const code = p.get('lang') || '', wantLang = code && def.langFilter && def.langFilter.values ? def.langFilter.values[code] : '';
      list = list.filter((x) => is(x, b.where) && (!wantLang || x.lang === wantLang));
      if (b.sort) list = list.slice().sort((x, y) => (b.sort === 'title' ? String(x.title).localeCompare(String(y.title)) : (y[b.sort] || 0) - (x[b.sort] || 0)));
      base = `ext:${def.id}?op=browse&k=${encodeURIComponent(b.key)}${p.get('lang') ? '&lang=' + encodeURIComponent(p.get('lang')) : ''}`;
    } else if (op === 'search') {
      const q = fold(p.get('q')).trim(), code = p.get('lang') || '';
      const want = code && def.langFilter && def.langFilter.values ? def.langFilter.values[code] : '';
      list = list.filter((x) => (!want || x.lang === want) && fold([x.title, (x.authors || []).join(' '), x.summary, x.language].join(' ')).includes(q));
      base = `ext:${def.id}?op=search&q=${encodeURIComponent(p.get('q') || '')}${code ? '&lang=' + encodeURIComponent(code) : ''}`;
    } else throw new Error('Unknown request');
    const entries = list.slice((page - 1) * per, page * per).map((x) => ({
      id: this.entryId(def, x.id), title: String(x.title || ''), authors: (x.authors || []).map(String),
      summary: String(x.summary || ''), note: [x.language, x.levelName].filter(Boolean).join(' · '),
      tags: this.tidyTags(x.tags || [x.language, x.levelName]),
      cover: this.coverOk(def, x.cover) ? x.cover : '',
      formats: this.formats(def, Array.isArray(x.formats) ? x.formats : []),
      read: x.read && this.hostOk(def, String(x.read)) ? String(x.read) : undefined,
    })).filter((e) => e.title);
    return { title: def.name, entries, next: page * per < list.length ? `${base}&page=${page + 1}` : null, search: { href: '', type: '' } };
  },

  /** Library subjects as short tags: "England -- Fiction" → England, Fiction; no repeats, no long ones, at most 16. */
  tidyTags(values) {
    const out = [], seen = new Set();
    const walk = (v) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v == null || v === '') return;
      for (let t of String(v).split(/\s+--\s+|\s*;\s*/)) {
        t = t.replace(/^(Browsing|Category):\s*/i, '').replace(/[.,:;]+$/, '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 40 || /^\d+$/.test(t)) continue;
        const k = t.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k); out.push(t);
      }
    };
    walk(values);
    return out.slice(0, 16);
  },

  /* --- JSON sources --- */
  async loadJson(def, op, p) {
    if (op === 'root') return this.root(def);
    if (op === 'detail') return this.detailJson(def, p);
    const req = this.request(def, op, p);
    const r = await this.fetch(def, req.url);
    let body;
    try { body = JSON.parse(r.body); } catch (e) { throw new Error('The site did not answer with data Kitab can read'); }
    const map = req.m.map || {};
    const items = this.pick(body, req.m.list) || [];
    const entries = (Array.isArray(items) ? items : []).slice(0, 60).map((it) => this.jsonEntry(def, map, it)).filter((e) => e.title);
    let nextAddr = null;
    const nextUrl = req.m.next ? this.pick(body, req.m.next) : '';
    if (nextUrl && this.hostOk(def, String(nextUrl))) nextAddr = this.nextAddress(def, req, entries.length, String(nextUrl));
    else if (req.m.pager) {
      const total = Number(this.pick(body, req.m.pager.total)) || 0, per = Number(req.m.pager.per) || entries.length;
      if (req.page * per < total) nextAddr = this.nextAddress(def, req, entries.length);
    }
    return { title: def.name, entries, next: nextAddr, search: { href: '', type: '' } };
  },

  jsonEntry(def, map, it) {
    const title = this.plain(this.val(map.title, it));
    const idv = this.val(map.id, it);
    const e = {
      id: this.entryId(def, idv || title), title, authors: [].concat(this.val(map.authors, it) || []).map((a) => this.plain(a)).filter(Boolean),
      summary: this.plain(this.val(map.summary, it)), note: '', cover: '', formats: [],
    };
    const cover = this.val(map.cover, it);
    if (this.coverOk(def, cover)) e.cover = cover;
    e.tags = this.tidyTags([].concat(map.tags || []).map((t) => this.val(t, it)));
    const read = this.val(map.read, it);                 // the book's pages, to read online before downloading
    if (read && this.hostOk(def, String(read))) e.read = String(read);
    e.formats = this.formats(def, (map.formats || []).map((f) => ({ format: f.format, label: typeof f.label === 'string' ? f.label.slice(0, 40) : '', url: this.val(f.url, it) })));
    if (!e.formats.length && def.detail && this.val({ tpl: def.detail.url }, it)) {
      const key = def.id + Math.random().toString(36).slice(2, 9);
      this.ctx[key] = { it, id: idv };
      e.detail = `ext:${def.id}?op=detail&c=${key}`;
    }
    return e;
  },

  async detailJson(def, p) {
    const c = this.ctx[p.get('c')];
    if (!c) throw new Error('Open the book again');
    const d = def.detail;
    const it = Object.assign({}, c.it);
    // "pick": one more question first, to choose which copy to open (e.g. the most read copy that is free to download)
    if (d.pick && d.pick.url && d.pick.value && d.pick.as) {
      const pr = await this.fetch(def, this.val({ tpl: d.pick.url }, it));
      let pb;
      try { pb = JSON.parse(pr.body); } catch (e) { throw new Error('The site did not answer with data Kitab can read'); }
      const v = this.pick(pb, d.pick.value);
      const first = Array.isArray(v) ? v[0] : v;
      if (first == null || first === '') throw new Error(String(d.pick.none || 'No free copy of this book can be downloaded').slice(0, 120));
      it[d.pick.as] = [first];
    }
    const r = await this.fetch(def, this.val({ tpl: d.url }, it));
    let body;
    try { body = JSON.parse(r.body); } catch (e) { throw new Error('The site did not answer with data Kitab can read'); }
    const out = { summary: this.plain(this.pick(body, d.summary)), formats: [], read: '' };
    const read = d.read ? this.val(d.read, Object.assign({}, it, body)) : '';
    if (read && this.hostOk(def, String(read))) out.read = String(read);
    if (d.formats) {
      const pick = d.formats, files = this.pick(body, pick.list) || [];
      for (const f of Array.isArray(files) ? files : []) {
        const kind = pick.as && pick.as[f[pick.field || 'format']];
        if (!kind) continue;
        const url = this.val(pick.url, Object.assign({}, it, f));
        out.formats.push({ format: kind, url, size: Number(f.size) || 0, score: kind === 'EPUB' ? 2 : 1 });
      }
      // EPUB first; of several PDFs keep the smallest (the text one, not the heavy picture-only one)
      const kinds = new Set();
      out.formats = this.formats(def, out.formats).sort((a, b) => (b.score - a.score) || ((a.size || 9e12) - (b.size || 9e12)))
        .filter((f) => !kinds.has(f.format) && kinds.add(f.format));
    }
    return { title: def.name, entries: [{ id: '', title: '', authors: [], summary: out.summary, formats: out.formats, read: out.read, cover: '' }], next: null };
  },

  /* --- HTML sources (the recipe names CSS selectors) --- */
  async loadHtml(def, op, p) {
    if (op === 'root') return this.root(def);
    if (op === 'detail') return this.detailHtml(def, p);
    const req = this.request(def, op, p);
    const r = await this.fetch(def, req.url);
    const doc = new DOMParser().parseFromString(r.body, 'text/html');   // inert: nothing in the page runs or loads
    const base = r.url || req.url, map = req.m.map || {};
    const entries = [];
    let rows = [];
    try { rows = Array.from(doc.querySelectorAll(req.m.list)).slice(0, 60); } catch (e) { throw new Error('This source is out of date: its page layout rule is not valid'); }
    for (const row of rows) {
      const title = this.dom(row, map.title, base);
      if (!title) continue;
      const link = this.dom(row, map.link, base);
      const e = { id: this.entryId(def, link || title), title, authors: [this.dom(row, map.authors, base)].filter(Boolean), summary: this.dom(row, map.summary, base), note: '', cover: '', formats: [] };
      const cover = this.dom(row, map.cover, base);
      if (this.coverOk(def, cover)) e.cover = cover;
      e.formats = this.formats(def, (map.formats || []).map((f) => ({ format: f.format, url: this.dom(row, f.sel, base) })));
      if (!e.formats.length && link && this.hostOk(def, link) && def.detail) {
        const key = def.id + Math.random().toString(36).slice(2, 9);
        this.ctx[key] = { link };
        e.detail = `ext:${def.id}?op=detail&c=${key}`;
      }
      entries.push(e);
    }
    let nextAddr = null;
    const nextUrl = req.m.next ? this.dom(doc, req.m.next, base) : '';
    if (nextUrl && this.hostOk(def, nextUrl)) nextAddr = this.nextAddress(def, req, entries.length, nextUrl);
    return { title: def.name, entries, next: nextAddr, search: { href: '', type: '' } };
  },

  async detailHtml(def, p) {
    const c = this.ctx[p.get('c')];
    if (!c) throw new Error('Open the book again');
    const r = await this.fetch(def, c.link);
    const doc = new DOMParser().parseFromString(r.body, 'text/html');
    const base = r.url || c.link, d = def.detail;
    const formats = this.formats(def, (d.formats || []).map((f) => ({ format: f.format, url: this.dom(doc, f.sel, base) })));
    return { title: def.name, entries: [{ id: '', title: '', authors: [], summary: this.dom(doc, d.summary, base), formats, cover: '' }], next: null };
  },
};

Sources.migrate();
