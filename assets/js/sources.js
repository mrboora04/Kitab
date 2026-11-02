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
const OFFICIAL_REPO = 'https://raw.githubusercontent.com/mrboora04/Kitab/main/store/index.json';

const Sources = {
  repos: store.get('er.repos', null) || [{ url: OFFICIAL_REPO, name: 'Kitab Official' }],
  installed: store.get('er.ext', {}),      // id -> { def, repo, at }
  indexes: {},                             // repo url -> { name, sources[], at }
  ctx: {},                                 // detail key -> what is needed to open one book's page

  saveRepos() { store.set('er.repos', this.repos); },
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
    if (!['json', 'html', 'opds'].includes(d.type)) return 'its type is unknown';
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
    const r = await Opds.fetchText(repo.url);
    let idx;
    try { idx = JSON.parse(r.body); } catch (e) { throw new Error('That address is not a Kitab source list'); }
    if (!idx || idx.schema !== 1 || !Array.isArray(idx.sources)) throw new Error('That address is not a Kitab source list');
    const sources = idx.sources.filter((s) => s && /^[a-z0-9][a-z0-9-]{1,39}$/.test(s.id || '') && typeof s.file === 'string').slice(0, 300);
    const out = { name: String(idx.name || repo.name || 'Repository').slice(0, 60), sources, base: r.url || repo.url, at: Date.now() };
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

  /** A source as a Browse "catalog": the root page is an ext: address that Sources.load answers. */
  asCatalog(def) {
    const cat = { id: 'ext:' + def.id, name: def.name, blurb: [def.lang === 'multi' ? 'Multi' : (def.lang || '').toUpperCase(), def.license].filter(Boolean).join(' · '), icon: def.icon || '🧩', def, ext: true };
    if (def.type === 'opds') {
      cat.url = def.start;
      if (def.search) cat.search = def.search;
    } else {
      cat.url = `ext:${def.id}?op=root`;
      if ((def.search && def.search.url) || def.type === 'html') cat.search = `ext:${def.id}?op=search&q={searchTerms}`;
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
        const enc = p.endsWith('|enc');                       // {title|enc}: made safe to put in a web address
        const v = this.pick(ctx, enc ? p.slice(0, -4) : p);
        if (v == null || v === '') missing = true;
        const t = Array.isArray(v) ? v.join(', ') : String(v == null ? '' : v);
        return enc ? encodeURIComponent(t) : t;
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
    const inst = m && this.installed[m[1]];
    if (!inst) throw new Error('That source is not installed');
    const def = inst.def, p = new URLSearchParams(m[2]), op = p.get('op');
    if (def.type === 'json') return this.loadJson(def, op, p);
    if (def.type === 'html') return this.loadHtml(def, op, p);
    throw new Error('Open this source from its own page');
  },

  root(def) {
    const entries = (def.browse || []).map((b) => ({ title: b.label || 'Browse', summary: b.about || '', nav: `ext:${def.id}?op=browse&k=${encodeURIComponent(b.key)}&page=1`, authors: [] }));
    return { title: def.name, entries, next: null, search: { href: '', type: '' } };
  },

  /** Which request a page needs: the address to fetch and which "map" reads it. */
  request(def, op, p) {
    const page = Math.max(1, Number(p.get('page')) || 1);
    if (op === 'search') {
      const s = def.search;
      if (!s) throw new Error('This source cannot be searched');
      return { url: this.fill(s.url, { q: encodeURIComponent(p.get('q') || ''), page }), m: s, op, page, q: p.get('q') || '' };
    }
    if (op === 'browse') {
      const b = (def.browse || []).find((x) => x.key === p.get('k'));
      if (!b) throw new Error('That list does not exist');
      return { url: this.fill(b.url, { page }), m: b.map ? b : Object.assign({}, def.search || {}, b), op, page, k: b.key };
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
    if (req.op === 'search') return `ext:${def.id}?op=search&q=${encodeURIComponent(req.q)}&page=${req.page + 1}`;
    if (req.op === 'browse') return `ext:${def.id}?op=browse&k=${encodeURIComponent(req.k)}&page=${req.page + 1}`;
    return null;
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
    e.formats = this.formats(def, (map.formats || []).map((f) => ({ format: f.format, url: this.val(f.url, it) })));
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
    const r = await this.fetch(def, this.val({ tpl: d.url }, Object.assign({}, c.it)));
    let body;
    try { body = JSON.parse(r.body); } catch (e) { throw new Error('The site did not answer with data Kitab can read'); }
    const out = { summary: this.plain(this.pick(body, d.summary)), formats: [] };
    if (d.formats) {
      const pick = d.formats, files = this.pick(body, pick.list) || [];
      for (const f of Array.isArray(files) ? files : []) {
        const kind = pick.as && pick.as[f[pick.field || 'format']];
        if (!kind) continue;
        const url = this.val(pick.url, Object.assign({}, c.it, f));
        out.formats.push({ format: kind, url, size: Number(f.size) || 0, score: kind === 'EPUB' ? 2 : 1 });
      }
      out.formats = this.formats(def, out.formats).sort((a, b) => (b.score - a.score) || (b.size - a.size)).slice(0, 3);
    }
    return { title: def.name, entries: [{ id: '', title: '', authors: [], summary: out.summary, formats: out.formats, cover: '' }], next: null };
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
