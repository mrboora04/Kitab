'use strict';
/* Browse tab: free public-domain catalogs and your own OPDS catalogs (Calibre, Calibre-Web, Kavita, ...). */

const Browse = {
  custom: store.get('er.sources', []),
  stack: [],          // opened feeds, newest last: { source, url, feed, title, scroll }
  downloads: {},      // id -> { entry, pct }
  saved: store.get('er.dl', {}),   // entry id -> file name of a book downloaded from a catalog
  sheetEntry: null,
  queue: [],
  busyLoads: 0,
  io: null,
  lang: store.get('er.lang', ''),      // global search language ('' = all)
  LANGS: [['', 'All'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['ru', 'Russian'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['la', 'Latin']],
  tab: 'home',          // home or ext (Add sources)
  // shelves on the Browse home when the source list has none of its own (kitab-sources/shelves.json overrides these)
  SHELVES: [{"id": "lang", "title": "In {language}", "byLang": {"en": {"title": "Popular in English", "mix": [{"source": "gutenberg", "list": "popular"}, {"source": "open-library", "list": "popular"}]}, "es": {"mix": [{"source": "wikisource-es", "list": "novelas"}, {"source": "openstax", "list": "es"}]}, "fr": {"mix": [{"source": "wikisource-fr", "list": "romans"}, {"source": "wikisource-fr", "list": "contes"}]}, "de": {"mix": [{"source": "wikisource-de", "list": "romane"}, {"source": "wikisource-de", "list": "maerchen"}]}, "it": {"mix": [{"source": "wikisource-it", "list": "romanzi"}, {"source": "wikisource-it", "list": "racconti"}]}, "pt": {"mix": [{"source": "wikisource-pt", "list": "romances"}, {"source": "wikisource-pt", "list": "contos"}]}, "ru": {"mix": [{"source": "wikisource-ru", "list": "romany"}, {"source": "wikisource-ru", "list": "rasskazy"}]}, "ar": {"mix": [{"source": "african-storybook", "list": "ar"}]}}}, {"id": "popular", "title": "Popular classics", "mix": [{"source": "gutenberg", "list": "popular"}, {"source": "open-library", "list": "popular"}, {"source": "internet-archive", "list": "popular"}]}, {"id": "fiction", "title": "Novels and stories", "mix": [{"source": "open-library", "list": "fiction"}, {"source": "gutenberg", "list": "fiction"}, {"source": "wikisource", "list": "novels"}]}, {"id": "scans", "title": "From the world's libraries", "about": "Scanned by public and university libraries", "mix": [{"source": "internet-archive", "list": "popular"}, {"source": "internet-archive", "list": "classics"}]}, {"id": "children", "title": "For children", "mix": [{"source": "gutenberg", "list": "children"}, {"source": "open-library", "list": "children"}, {"source": "african-storybook", "list": "en"}]}, {"id": "textbooks", "title": "Free textbooks", "mix": [{"source": "openstax", "list": "all"}]}, {"id": "poetry", "title": "Poetry", "mix": [{"source": "open-library", "list": "poetry"}, {"source": "gutenberg", "list": "poetry"}, {"source": "wikisource", "list": "poems"}]}, {"id": "history", "title": "History", "mix": [{"source": "open-library", "list": "history"}, {"source": "gutenberg", "list": "history"}]}, {"id": "science", "title": "Science", "mix": [{"source": "open-library", "list": "science"}, {"source": "gutenberg", "list": "science"}]}, {"id": "philosophy", "title": "Philosophy", "mix": [{"source": "open-library", "list": "philosophy"}]}, {"id": "plays", "title": "Plays", "mix": [{"source": "wikisource", "list": "plays"}]}],
  shelfCache: {},      // shelf key -> { entries, src, at }

  init() {
    $('#goExt').onclick = () => this.go('ext');
    $$('#pane-browse [data-go]').forEach((b) => { b.onclick = () => this.go(b.dataset.go); });
    ExtUI.init();
    this.drawLangs();
    $('#addSource').onclick = () => this.addSource();
    const gs = $('#globalSearch');
    if (gs) gs.onsubmit = (e) => { e.preventDefault(); this.globalSearch($('#globalQuery').value.trim()); };
    $('#feedBack').onclick = () => this.back();
    $('#feedSearch').onsubmit = (e) => { e.preventDefault(); this.search($('#feedQuery').value.trim()); };
    $('#sheetClose').onclick = () => this.closeSheet();
    $('#sheetScrim').onclick = () => this.closeSheet();
    this.renderSources();
  },

  /* ---------------- source list ---------------- */
  renderSources() {
    const inFeed = this.stack.length > 0;
    $('#sourceView').classList.toggle('hidden', inFeed || this.tab !== 'home');
    $('#extView').classList.toggle('hidden', inFeed || this.tab !== 'ext');
    $('#feedView').classList.toggle('hidden', !inFeed);
    if (inFeed) return;
    if (this.tab === 'ext') return ExtUI.render();
    if (typeof App !== 'undefined' && App.tab === 'browse') ExtUI.warm();     // only once Browse is really on screen
    const card = (s, custom) => `
      <button class="source" data-src="${esc(s.id)}">
        <span class="src-icon">${s.icon || '🌐'}</span>
        <span class="src-text"><b>${esc(s.name)}</b><small>${esc(s.blurb || s.url)}</small>${this.downNote(s)}</span>
        ${custom ? `<span class="src-del" data-del="${esc(s.id)}" aria-label="Remove catalog">✕</span>` : '<span class="chev">›</span>'}
      </button>`;
    this.drawShelves();
    $('#sourceList').innerHTML = Sources.catalogs().map((s) => card(s)).join('') + this.custom.map((s) => card(s, true)).join('');
    $$('#sourceList [data-src]').forEach((b) => {
      b.onclick = (e) => {
        if (e.target.dataset.del) return;
        this.openSource(this.all().find((s) => s.id === b.dataset.src));
      };
    });
    $$('#sourceList [data-del]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        if (!(await App.dialog({ title: 'Remove catalog?', message: 'Books you already downloaded stay in your library.', ok: 'Remove', danger: true }))) return;
        this.custom = this.custom.filter((s) => s.id !== b.dataset.del);
        store.set('er.sources', this.custom);
        this.renderSources();
      };
    });
  },

  /** The language chips under the search boxes. Choosing one re-runs a global search that is on screen. */
  drawLangs() {
    const html = this.LANGS.map(([c, n]) => `<button class="chip${c === this.lang ? ' on' : ''}" data-lang="${c}">${n}</button>`).join('');
    $$('.langbar').forEach((bar) => {
      bar.innerHTML = html;
      bar.querySelectorAll('[data-lang]').forEach((b) => {
        b.onclick = () => {
          this.lang = b.dataset.lang;
          store.set('er.lang', this.lang);
          if (!this.stack.length && this.tab === 'home') this.drawShelves();
          this.drawLangs();
          const view = this.stack[this.stack.length - 1];
          if (view && view.source.id === 'all' && view.q) this.globalSearch(view.q);
        };
      });
    });
  },

  /** Whether a catalog can answer in the chosen language: it filters by language itself, or it is in that language. */
  speaks(src, lang) {
    if (!lang) return true;
    if (src.ext) return !!((src.def.langFilter && src.def.langFilter.values && src.def.langFilter.values[lang]) || src.def.lang === lang);
    return src.lang === lang;
  },

  /** Moves between the Browse home and Add sources. */
  go(tab) {
    this.tab = tab;
    this.renderSources();
    $('#pane-browse').scrollTop = 0;
  },

  all() { return Sources.catalogs().concat(this.custom); },

  /* ---------------- shelves: rows of covers on the Browse home ---------------- */
  shelfList() {
    let list = this.SHELVES;
    for (const r of Sources.repos) { const ix = Sources.indexes[r.url]; if (ix && ix.shelves && ix.shelves.length) { list = ix.shelves; break; } }
    const out = [];
    for (const sh of list) {
      if (sh.byLang) {                      // the shelf for the language chosen under the search box, first
        const pick = this.lang && sh.byLang[this.lang];
        if (!pick) continue;
        const name = (this.LANGS.find(([c]) => c === this.lang) || [])[1] || this.lang;
        out.unshift(Object.assign({ id: sh.id + '-' + this.lang, title: String(sh.title || '').replace('{language}', name) }, pick));
      } else if (sh.mix || (sh.source && sh.list)) out.push(sh);
    }
    // a shelf mixes lists from several sources; a source that is down today drops out of it
    return out.map((sh) => Object.assign({}, sh, { mix: (sh.mix || [{ source: sh.source, list: sh.list }]).filter((p) => { const h = Sources.health(p.source); return !h || h.working !== false; }) }))
      .filter((sh) => sh.mix.length);
  },

  drawShelves() {
    const box = $('#shelves');
    if (!box) return;
    this._shelvesBox = box;
    const list = this.shelfList();
    const key = list.map((sh) => sh.id).join('|') + '#' + this.lang;
    if (box._key === key) return;                 // the same shelves are already on screen
    box._key = key;
    if (this._shelfIo) this._shelfIo.disconnect();
    if (this._moreIo) this._moreIo.disconnect();
    box.innerHTML = '<div id="shelfEnd" class="shelf-end"></div>';
    this._shown = new Set();                      // source:list pairs already on a shelf
    this._pool = null; this._rr = 0;
    this._shelfIo = new IntersectionObserver((seen) => {
      for (const e of seen) {
        if (!e.isIntersecting) continue;
        this._shelfIo.unobserve(e.target);
        this.fillShelf(e.target._sh, e.target);
      }
    }, { rootMargin: '300px 0px' });
    list.forEach((sh) => this.addShelf(sh));
    // below the chosen shelves, more keep coming as you scroll: every list of every source, mixed
    this._moreIo = new IntersectionObserver((seen) => { if (seen.some((e) => e.isIntersecting)) this.moreShelves(); }, { rootMargin: '600px 0px' });
    this._moreIo.observe($('#shelfEnd'));
  },

  addShelf(sh) {
    const parts = sh.mix || [{ source: sh.source, list: sh.list }];
    const keys = parts.map((p) => p.source + ':' + p.list);
    if (!sh.mix && this._shown.has(keys[0])) return false;
    keys.forEach((k) => this._shown.add(k));
    const el = document.createElement('section');
    el.className = 'bshelf';
    el._sh = sh;
    el.innerHTML = `<div class="shelf-head"><div><h3>${esc(sh.title)}</h3>${sh.about ? `<small>${esc(sh.about)}</small>` : ''}</div><button class="see-all">See all ›</button></div>
      <div class="shelf-row">${'<span class="shelf-wait"></span>'.repeat(3)}</div>`;
    el.querySelector('.see-all').onclick = () => this.openShelf(sh);
    $('#shelves').insertBefore(el, $('#shelfEnd'));
    this._shelfIo.observe(el);
    return true;
  },

  /** Every source this phone can use (built in, installed, or in the store), with its lists not shown yet. */
  async shelfPool() {
    const ids = new Set(Object.keys(Sources.builtin).concat(Object.keys(Sources.installed)));
    for (const r of Sources.repos) { const ix = Sources.indexes[r.url]; if (ix) ix.sources.forEach((x) => ids.add(x.id)); }
    const pool = [];
    for (const id of ids) {
      const h = Sources.health(id);
      if (h && h.working === false) continue;
      let def = null;
      try { def = await Sources.previewDef(id); } catch (e) { def = null; }
      if (!def || !(def.browse || []).length) continue;
      if (this.lang && !this.speaks(Sources.asCatalog(def), this.lang)) continue;
      pool.push({ def, lists: def.browse.filter((b) => !this._shown.has(def.id + ':' + b.key)) });
    }
    return pool;
  },

  async moreShelves() {
    if (this._moreBusy) return;
    this._moreBusy = true;
    const box = this._shelvesBox;
    try {
      if (!this._pool) this._pool = await this.shelfPool();
      if (box !== this._shelvesBox) return;
      let added = 0, guard = 0;
      while (added < 3 && this._pool.some((p) => p.lists.length) && guard++ < 200) {
        const p = this._pool[this._rr++ % this._pool.length];
        const b = p.lists.shift();
        if (b && !this._shown.has(p.def.id + ':' + b.key) && this.addShelf({ id: `auto-${p.def.id}-${b.key}`, title: b.label, about: p.def.name, source: p.def.id, list: b.key })) added++;
      }
      if (!this._pool.some((p) => p.lists.length)) {           // every list of every source is on a shelf
        const end = $('#shelfEnd');
        if (end) end.innerHTML = '<p class="shelf-done">That’s every shelf. Search or add sources for more.</p>';
        this._moreIo.disconnect();
      }
    } catch (e) { /* try again on the next scroll */ }
    finally {
      this._moreBusy = false;
      // still short of the bottom of the screen: keep going
      const end = $('#shelfEnd');
      if (end && this._pool && this._pool.some((q) => q.lists.length) && end.getBoundingClientRect().top < window.innerHeight + 600) setTimeout(() => this.moreShelves(), 50);
    }
  },

  /** Books with a real cover go first; when a shelf has enough of them, the ones without a cover wait for "See all". */
  coversFirst(entries) {
    const withCover = entries.filter((e) => e.cover), without = entries.filter((e) => !e.cover);
    return withCover.length >= 6 ? withCover : withCover.concat(without);
  },

  /** One list of one source: its first page, ready for a shelf. */
  async shelfPart(p) {
    const def = await Sources.previewDef(p.source);
    if (!def) return null;
    const src = Sources.asCatalog(def);
    const feed = await Sources.load(`ext:${def.id}?op=browse&k=${encodeURIComponent(p.list)}&page=1`);
    const entries = (feed.entries || []).filter((e) => e.title && !e.nav);
    entries.forEach((e) => { e._src = src; });
    return { src, def, list: p.list, entries, next: feed.next || null };
  },

  /** Books from several lists, taken in turn (one from each), without the same title twice. */
  interleave(lists, seen) {
    const out = [], idx = lists.map(() => 0);
    for (let more = true; more;) {
      more = false;
      lists.forEach((l, i) => {
        while (idx[i] < l.length) {
          const e = l[idx[i]++];
          const t = String(e.title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
          if (seen.has(t)) continue;
          seen.add(t); out.push(e); more = true; break;
        }
      });
    }
    return out;
  },

  /* A shelf as it was last time, kept on the phone for a day, so Browse shows it at once while it refreshes. */
  shelfKey(id) { return 'er.shelf.' + id; },

  keepShelf(sh, hit) {
    const small = (v, d = 0) => (Array.isArray(v) ? v.slice(0, 10).map((x) => small(x, d + 1)) : v && typeof v === 'object' && d < 3
      ? Object.fromEntries(Object.entries(v).slice(0, 30).map(([k, x]) => [k, small(x, d + 1)])) : typeof v === 'string' ? v.slice(0, 300) : v);
    const items = hit.entries.slice(0, 12).map((e) => {
      const m = e.detail && /[?&]c=([^&]+)/.exec(e.detail);
      return {
        e: { id: e.id, title: e.title, authors: e.authors, summary: (e.summary || '').slice(0, 600), cover: e.cover, formats: e.formats, read: e.read, tags: (e.tags || []).slice(0, 16), note: e.note, detail: e.detail, src: e._src && e._src.def ? e._src.def.id : '' },
        ctx: m && Sources.ctx[m[1]] ? [m[1], small(Sources.ctx[m[1]])] : null,
      };
    });
    const text = JSON.stringify({ at: Date.now(), items });
    if (text.length < 80000) { try { localStorage.setItem(this.shelfKey(sh.id), text); } catch (e) { /* storage full: just not kept */ } }
  },

  async keptShelf(sh) {
    const k = store.get(this.shelfKey(sh.id), null);
    if (!k || !k.items || Date.now() - k.at > 86400e3) return null;
    const entries = [];
    for (const it of k.items) {
      const def = it.e.src && await Sources.previewDef(it.e.src).catch(() => null);
      if (!def) continue;
      if (it.ctx) Sources.ctx[it.ctx[0]] = it.ctx[1];
      entries.push(Object.assign({}, it.e, { authors: it.e.authors || [], formats: it.e.formats || [], _src: Sources.asCatalog(def) }));
    }
    return entries.length ? { parts: [], entries, seen: new Set(entries.map((e) => String(e.title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim())), at: 0, kept: true } : null;
  },

  async fillShelf(sh, el) {
    const row = el.querySelector('.shelf-row');
    // last time's books first, at once (they are replaced by fresh ones below)
    if (!this.shelfCache[sh.id]) {
      const kept = await this.keptShelf(sh).catch(() => null);
      if (kept && !row.querySelector('[data-book]')) { row.innerHTML = ''; this.appendToShelf(row, kept, kept.entries); }
    }
    try {
      let hit = this.shelfCache[sh.id];
      if (!hit || Date.now() - hit.at > 3600e3) {
        const parts = (await Promise.all((sh.mix || [{ source: sh.source, list: sh.list }]).map((p) => this.shelfPart(p).catch(() => null)))).filter(Boolean);
        if (!parts.length) throw new Error('no such source');
        const seen = new Set();
        // covers first within each source, then one from each source in turn
        const entries = this.coversFirst(this.interleave(parts.map((p) => this.coversFirst(p.entries)), seen));
        hit = this.shelfCache[sh.id] = { parts, entries, seen, at: Date.now() };
        this.keepShelf(sh, hit);
      }
      if (!hit.entries.length) throw new Error('empty');
      if (row.scrollLeft > 10) return;            // you are already looking along last time's books: leave them
      row.innerHTML = '';
      this.appendToShelf(row, hit, hit.entries);
      row.scrollLeft = 0;                         // a shelf starts at its first book
      // sideways, too: the next page of every list comes when you reach the end of the row
      row.onscroll = () => {
        const waiting = hit.parts.filter((p) => p.next);
        if (row._busy || !waiting.length || hit.entries.length >= 120) return;
        if (row.scrollLeft + row.clientWidth < row.scrollWidth - row.clientWidth * 0.8) return;
        row._busy = true;
        Promise.all(waiting.map((p) => Sources.load(p.next).then((f) => {
          const got = (f.entries || []).filter((e) => e.title && !e.nav);
          got.forEach((e) => { e._src = p.src; });
          p.next = got.length ? f.next || null : null;
          return got;
        }).catch(() => { p.next = null; return []; }))).then((lists) => {
          const more = this.interleave(lists, hit.seen);
          hit.entries = hit.entries.concat(more);
          this.appendToShelf(row, hit, more);
        }).finally(() => { row._busy = false; });
      };
    } catch (e) {
      if (!row.querySelector('[data-book]')) el.remove();   // a shelf that cannot be filled (and was not kept) is not shown
    }
  },

  appendToShelf(row, hit, entries) {
    const from = row.querySelectorAll('[data-book]').length;
    row.insertAdjacentHTML('beforeend', entries.map((e, i) => this.rowHtml(e, from + i)).join(''));
    row.querySelectorAll('[data-book]').forEach((b) => { if (!b._bound) { b._bound = true; b.onclick = () => this.showBook(hit.entries[b.dataset.book]); } });
  },

  /** "See all": the source, opened on that list. */
  async openShelf(sh) {
    if (sh.mix) sh = Object.assign({}, sh, sh.mix[0]);            // a mixed shelf opens its first list
    const def = await Sources.previewDef(sh.source);
    if (!def) return App.toast('This shelf is not available right now');
    const src = Sources.asCatalog(def);
    await this.open(src, src.url, src.name);
    const view = this.stack[this.stack.length - 1];
    if (!view || !view.tabs) return;
    const i = view.tabs.findIndex((t) => t.url.includes('k=' + encodeURIComponent(sh.list) + '&'));
    if (i > 0) this.switchTab(i);
  },

  /** "Not working right now", when the store's daily check says so. */
  downNote(s) {
    const h = s.ext && s.def ? Sources.health(s.def.id) : null;
    if (!h || h.working) return '';
    const when = h.checkedAt ? new Date(h.checkedAt) : null;
    const ago = when && !isNaN(when) ? Math.max(0, Math.round((Date.now() - when) / 864e5)) : null;
    return `<small class="down">⚠️ Not working right now${ago == null ? '' : ago === 0 ? ' · checked today' : ` · checked ${ago} day${ago === 1 ? '' : 's'} ago`}</small>`;
  },

  /** One place that reads a feed: built-in and your own catalogs (OPDS), or an installed source (ext: addresses). */
  /** A private address (this phone, your home network): only the catalog that lives there may use it. */
  localTarget(url) {
    let h;
    try { h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch (e) { return false; }
    return h === 'localhost' || !h.includes('.') && !h.includes(':') || /\.(local|lan|home|internal|localdomain)$/.test(h)
      || /^(10|127|0)\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)
      || /^(::1?|f[cd][0-9a-f]{2}:.*|fe80:.*)$/.test(h);
  },

  guardLocal(url, src) {
    if (!this.localTarget(url)) return;
    let own = '', to = '';
    try { own = new URL(src.url).host; to = new URL(url).host; } catch (e) { /* refused below */ }
    if (!own || own !== to) throw new Error('This catalog tried to reach a device on your own network, so Kitab stopped it');
  },

  async loadFeed(url, src) {
    if (/^ext:/.test(url)) return Object.assign(await Sources.load(url), { url });
    if (src && !src.ext) this.guardLocal(url, src);
    if (src && src.ext && !Sources.hostOk(src.def, url)) throw new Error('This source tried to reach a website it did not declare, so Kitab stopped it');
    return Opds.load(url);
  },

  async addSource() {
    const url = await App.dialog({
      title: 'Add a catalog', message: 'Paste the OPDS address of a Calibre, Calibre-Web or Kavita library, or any other OPDS catalog.',
      input: 'https://', ok: 'Add',
    });
    if (!url || !/^https?:\/\/\S+$/i.test(url.trim())) { if (url) App.toast('That does not look like a web address'); return; }
    busy(true, 'Checking the catalog…');
    try {
      let feed;
      try { feed = await Opds.load(url.trim()); } catch (e) {
        if (e.needsLogin || e.status === 401 || e.status === 403) throw new Error('This library needs a login. Kitab only uses libraries that anyone can read without one.');
        throw e;
      }
      const host = new URL(url.trim()).host;
      const src = { id: 'c' + Date.now(), name: feed.title || host, blurb: host, url: url.trim(), icon: '🌐' };
      this.custom.push(src);
      store.set('er.sources', this.custom);
      busy(false);
      this.renderSources();
      App.toast('Catalog added');
    } catch (e) {
      busy(false);
      App.toast(e.message || 'Could not read that catalog', 4000);
    }
  },

  /** Opens a search straight away (used by the floating book ideas in the library). */
  async searchIn(id, q) {
    const src = this.all().find((x) => x.id === id);
    if (!src) return;
    this.stack = [];
    const url = await Opds.searchUrl(src, null, q);
    if (url) this.open(src, url, `“${q}”`);
  },

  /* ---------------- feeds ---------------- */
  openSource(src) { return this.open(src, src.url, src.name); },

  async open(src, url, title) {
    if (!this.stack.length) {          // a fresh source: no leftovers from the last one under the spinner
      $('#feedList').innerHTML = '';
      $('#feedTitle').textContent = title || src.name;
      $('#feedSearch').classList.add('hidden');
      $('#feedLangs').classList.add('hidden');
      $('#feedMore').classList.add('hidden');
      $('#feedTabs').classList.add('hidden');
    }
    this.status('loading');
    try {
      const feed = await this.loadFeed(url, src);
      const view = { source: src, url, feed, title: title || feed.title, scroll: 0 };
      const tabs = this.stack.length ? null : this.tabsOf(feed);
      if (tabs) {          // like a manga reader: the source's lists along the top, the first list's books straight away
        const first = await this.loadFeed(tabs[0].url, src);
        if (!first.search || !first.search.href) first.search = feed.search;
        Object.assign(view, { url: tabs[0].url, feed: first, title: title || src.name, tabs, tab: 0 });
      }
      this.stack.push(view);
      this.renderFeed();
    } catch (e) {
      if (e.needsLogin || e.status === 401 || e.status === 403) e = new Error('This library needs a login. Kitab only uses libraries that anyone can read without one.');
      if (!this.stack.length) {   // nothing loaded yet: show an empty page with a header so Back still works
        $('#feedTitle').textContent = title || src.name;
        $('#feedSearch').classList.add('hidden');
        $('#feedList').innerHTML = '';
        $('#feedMore').classList.add('hidden');
      }
      this.status('error', e.message, () => this.open(src, url, title));
    }
  },

  /** The lists a source opens on: a recipe's own lists, or a catalog whose first page is only a few sections. */
  tabsOf(feed) {
    if (feed.tabs && feed.tabs.length) return feed.tabs;
    const e = feed.entries || [];
    if (e.length < 2 || e.length > 12 || !e.every((x) => x.nav)) return null;
    this.shortenSections(e);
    return e.map((x) => ({ label: x._short || x.title, url: x.nav }));
  },

  drawTabs(view) {
    const bar = $('#feedTabs');
    bar.classList.toggle('hidden', !view.tabs);
    if (!view.tabs) return;
    bar.innerHTML = view.tabs.map((t, i) => `<button class="chip${i === view.tab ? ' on' : ''}" data-tab="${i}">${esc(t.label)}</button>`).join('');
    $$('#feedTabs [data-tab]').forEach((b) => { b.onclick = () => this.switchTab(Number(b.dataset.tab)); });
    const on = bar.querySelector('.on');
    if (on) bar.scrollLeft = Math.max(0, on.offsetLeft - 16);
  },

  async switchTab(i, again) {
    const view = this.stack[this.stack.length - 1];
    if (!view || !view.tabs || (i === view.tab && !again)) return;
    view.tab = i;
    this.drawTabs(view);
    $('#feedList').innerHTML = '';
    $('#feedMore').classList.add('hidden');
    this.status('loading');
    try {
      const feed = await this.loadFeed(view.tabs[i].url, view.source);
      if (this.stack[this.stack.length - 1] !== view || view.tab !== i) return;     // another chip was tapped meanwhile
      if (!feed.search || !feed.search.href) feed.search = view.feed.search;
      Object.assign(view, { feed, url: view.tabs[i].url, scroll: 0 });
      this.renderFeed();
    } catch (e) {
      if (view.tab === i) this.status('error', e.message, () => this.switchTab(i, true));
    }
  },

  status(kind, msg, retry) {
    const box = $('#feedStatus');
    this.errorShown = kind === 'error';
    if (kind === 'loading') {
      $('#extView').classList.add('hidden');
      $('#sourceView').classList.add('hidden');
      $('#feedView').classList.remove('hidden');
      box.innerHTML = '<div class="spinner"></div>';
      box.classList.remove('hidden');
    } else if (kind === 'error') {
      box.innerHTML = `<p>⚠️ ${esc(msg || 'Something went wrong')}</p><button class="btn primary" id="retry">Try again</button> <button class="btn" id="giveUp">Back</button>`;
      box.classList.remove('hidden');
      $('#retry').onclick = retry;
      $('#giveUp').onclick = () => this.back();
    } else box.classList.add('hidden');
  },

  renderFeed() {
    this.status('done');
    const view = this.stack[this.stack.length - 1];
    if (!view) return this.renderSources();
    $('#extView').classList.add('hidden');
    $('#sourceView').classList.add('hidden');
    $('#feedView').classList.remove('hidden');
    $('#feedTitle').textContent = view.title || 'Catalog';
    const canSearch = !!(view.source.search || view.feed.search);
    $('#feedSearch').classList.toggle('hidden', !canSearch);
    $('#feedQuery').value = '';
    $('#feedQuery').placeholder = 'Search ' + (view.source.name || 'catalog');
    $('#feedLangs').classList.toggle('hidden', view.source.id !== 'all');
    this.drawTabs(view);
    this.drawEntries(view, view.feed.entries, false);
    $('#feedList').parentElement.scrollTop = view.scroll || 0;
    if (/op=root/.test(view.url || '') && canSearch && !view.feed.entries.length) setTimeout(() => $('#feedQuery').focus(), 250);
  },

  /** A steady colour for a book without a cover picture, from its title. */
  tint(t) { let h = 0; for (const ch of String(t)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; },

  rowHtml(e, idx) {
    if (e.nav) {      // a section of the catalog: a coloured tile (its own picture when it has one)
      return `<button class="li nav tile" data-nav="${idx}" style="--h:${this.tint(e.title)}">${e.cover ? `<img loading="lazy" src="${esc(e.cover)}" alt="" onerror="this.remove()">` : ''}<span class="tile-text"><b>${esc(e._short || e.title)}</b>${e.summary ? `<small>${esc(e.summary.slice(0, 90))}</small>` : ''}</span></button>`;
    }
    // a book: its cover picture with the title over the bottom; without a picture, a printed-looking cover with the title and author
    const badge = this.have(e) ? '<em class="badge have">In library</em>' : (e._sourceName ? `<em class="badge">${esc(e._sourceName)}</em>` : '');
    const by = (e.authors || []).join(', ') || e.note || '';
    return `<button class="li gbook" data-book="${idx}" aria-label="${esc(e.title + (by ? ', ' + by : ''))}">
        <span class="cover${e.cover ? '' : ' noimg'}" style="--c1:hsl(${this.tint(e.title)} 38% 42%);--c2:hsl(${this.tint(e.title)} 45% 24%)">
          <span class="gen"><span class="gt">${esc(e.title.slice(0, 90))}</span><span class="ga">${esc(by.slice(0, 60))}</span></span>
          ${e.cover ? `<img loading="lazy" src="${esc(e.cover)}" alt="" onerror="this.parentNode.classList.add('noimg');this.remove()">` : ''}
          <span class="cap"><b>${esc(e.title)}</b></span>${badge}</span></button>`;
  },

  /** Sections that all start with the same words ("Unglue.it Free eBooks", "Unglue.it Fiction"...) show without them. */
  shortenSections(entries) {
    const navs = entries.filter((e) => e.nav && e.title);
    if (navs.length < 3) return;
    const words = navs.map((e) => e.title.split(/\s+/));
    let n = 0;
    while (words.every((w) => w.length > n + 1 && w[n] === words[0][n])) n++;
    if (!n) return;
    navs.forEach((e, i) => {
      const rest = words[i].slice(n).join(' ').replace(/^[:\-–—·|]+\s*/, '');
      e._short = rest ? rest[0].toUpperCase() + rest.slice(1) : e.title;
    });
  },

  drawEntries(view, entries, append) {
    const list = $('#feedList');
    if (!append) this.shortenSections(entries);
    if (!append) { list.innerHTML = ''; view.all = []; view.drawn = 0; }
    const start = view.drawn;
    entries.forEach((e) => { if (!e._src) e._src = view.source; });
    view.all = view.all.concat(entries);
    view.drawn += entries.length;
    list.insertAdjacentHTML('beforeend', entries.map((e, i) => this.rowHtml(e, start + i)).join(''));
    this.bindRows(view, start);
    $('#feedMore').classList.toggle('hidden', !view.feed.next);
    $('#feedMore').textContent = 'Load more';
    $('#feedMore').onclick = () => this.more(view);
    if (!entries.length && !append) {
      const fresh = /op=root/.test(view.url || '');                          // a source with no lists: it opens on its search box
      const q = (view.title || '').replace(/^[“"]|[”"]$/g, '');
      list.innerHTML = fresh
        ? `<div class="search-prompt"><b>Search ${esc(view.source.name)}</b><p>Type a title or an author in the box above.</p></div>`
        : (view.source.id === 'all' ? '' : `<p class="none">No books found${q ? ` for “${esc(q)}”` : ''}.</p>`);
    }
  },

  bindRows(view, from) {
    $$('#feedList .li').forEach((el) => {
      const nav = el.dataset.nav, book = el.dataset.book;
      const idx = Number(nav != null ? nav : book);
      if (idx < from || el._bound) return;
      el._bound = true;
      if (nav != null) el.onclick = () => this.leave(view, () => this.open(view.source, view.all[idx].nav, view.all[idx].title));
      else {
        el.onclick = () => this.showBook(view.all[idx]);
        const e = view.all[idx];
        if (e.detail && !e.summary && !e._tried) this.watch(el, view, idx);
      }
    });
  },

  /** Fetch a book's description and formats when its row scrolls into view (two at a time, quietly). */
  watch(el, view, idx) {
    if (!this.io) {
      this.io = new IntersectionObserver((hits) => hits.forEach((h) => {
        if (!h.isIntersecting) return;
        this.io.unobserve(h.target);
        this.queue.push(h.target);
        this.pump();
      }), { root: $('#feedList').parentElement, rootMargin: '200px 0px' });
      this.queue = [];
      this.busyLoads = 0;
    }
    el._view = view; el._idx = idx;
    this.io.observe(el);
  },

  pump() {
    while (this.busyLoads < 2 && this.queue.length) {
      const el = this.queue.shift();
      const view = el._view, e = view.all[el._idx];
      if (!el.isConnected || !e || e._tried || e._loading) continue;
      this.busyLoads++;
      this.hydrate(e).finally(() => {
        this.busyLoads--;
        this.refreshRow(view, el._idx);
        if (this.sheetEntry === e) this.drawSheet();
        this.pump();
      });
    }
  },

  /** Loads a book's own page: description, formats, and whether it is really a folder of other entries. */
  hydrate(e) {
    if (e._p) return e._p;                      // a row and the book sheet can ask at the same time
    if (e._done) return Promise.resolve();
    e._loading = true;
    e._p = (async () => {
      try {
        const doc = await this.loadFeed(e.detail, e._src);
        const full = doc.entries.find((x) => x.formats && x.formats.length);
        if (full) {
          Object.assign(e, { formats: full.formats, summary: full.summary || e.summary, cover: e.cover || full.cover, read: e.read || full.read });
          if (!e.authors.length) e.authors = full.authors;
          e._done = true;
        } else if (doc.entries.length > 1 && e.maybeFolder) {
          e.nav = e.detail;                      // not a single book: it is a folder of entries
        } else {
          const one = doc.entries[0];
          if (one) { e.summary = one.summary || e.summary; if (!e.authors.length) e.authors = one.authors; if (one.read) e.read = one.read; }
          e._done = true;
        }
        e._error = '';
      } catch (err) {
        e._error = err.message;
      }
      e._tried = true;
      e._loading = false;
      e._p = null;
    })();
    return e._p;
  },

  refreshRow(view, idx) {
    const el = $(`#feedList [data-book="${idx}"], #feedList [data-nav="${idx}"]`);
    if (!el || this.stack[this.stack.length - 1] !== view) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = this.rowHtml(view.all[idx], idx);
    const fresh = tmp.firstElementChild;
    el.replaceWith(fresh);
    this.bindRows(view, idx);
  },

  leave(view, then) {
    view.scroll = $('#feedList').parentElement.scrollTop;
    then();
  },

  async more(view) {
    const btn = $('#feedMore');
    btn.textContent = 'Loading…';
    try {
      const next = await this.loadFeed(view.feed.next, view.source);
      view.feed.next = next.next;
      view.feed.entries = view.feed.entries.concat(next.entries);
      this.drawEntries(view, next.entries, true);
    } catch (e) {
      btn.textContent = 'Load more';
      App.toast(e.message, 3500);
    }
  },


  /* ---------------- global search (all catalogs at once) ---------------- */
  /**
   * One catalog's answer to a search. It never opens a login box: a catalog that needs a login is skipped without a word,
   * because global search is for what you can read right now. A slow or dead catalog gives up after 15 seconds.
   */
  async searchCatalog(src, q) {
    const work = (async () => {
      try {
        let url;
        if (src.search) url = await Opds.searchUrl(src, null, q);
        else url = await Opds.searchUrl(src, await this.loadFeed(src.url, src), q);
        if (!url) return { src, entries: [], skipped: true };
        if (this.lang && /^ext:/.test(url)) url += '&lang=' + encodeURIComponent(this.lang);
        const result = await this.loadFeed(url, src);
        return { src, entries: (result.entries || []).slice(0, 50) };
      } catch (e) {
        if (e.needsLogin || e.status === 401 || e.status === 403) return { src, entries: [], skipped: true };   // needs a login: not searched
        return { src, entries: [], error: e.message || 'Could not search' };
      }
    })();
    const limit = new Promise((ok) => setTimeout(() => ok({ src, entries: [], error: 'took too long' }), 15000));
    return Promise.race([work, limit]);
  },

  /** How well a book matches what was typed: exact title, title starts with it, title has all the words, anywhere. */
  matchScore(e, q) {
    const t = (e.title || '').toLowerCase(), words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = t + ' ' + (e.authors || []).join(' ').toLowerCase();
    if (t === q.toLowerCase()) return 4;
    if (t.startsWith(q.toLowerCase())) return 3;
    if (words.length && words.every((w) => t.includes(w))) return 2;
    if (words.length && words.every((w) => hay.includes(w))) return 1;
    return 0;
  },

  /** Search every catalog at once. Results appear as each catalog answers, merged and de-duplicated, best matches first. */
  async globalSearch(q) {
    if (!q) return;
    this.stack = [];
    const sources = this.all().filter((src) => this.speaks(src, this.lang));
    const langName = (this.LANGS.find((l) => l[0] === this.lang) || [])[1];
    const view = { source: { name: 'All catalogs', id: 'all' }, feed: { entries: [], next: null, search: null }, title: `“${q}”`, q, scroll: 0 };
    this.stack.push(view);
    this.renderFeed();
    const seen = new Map();
    let done = 0, got = 0, failed = 0, timer = null;
    const box = $('#feedStatus');
    const progress = () => {
      if (this.stack[this.stack.length - 1] !== view) return;
      if (done >= sources.length) { this.status('done'); return; }
      box.innerHTML = `<div class="spinner"></div><p>Searching ${done} of ${sources.length} sources${this.lang ? ' in ' + langName : ''}…</p>`;
      box.classList.remove('hidden');
    };
    const redraw = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (this.stack[this.stack.length - 1] !== view) return;
        const keep = $('#feedList').parentElement.scrollTop;
        view.feed.entries.sort((x, y) => (y._score - x._score) || (x._order - y._order));
        this.drawEntries(view, view.feed.entries, false);
        $('#feedList').parentElement.scrollTop = keep;
        if (done >= sources.length && !view.feed.entries.length) $('#feedList').innerHTML = `<p class="none">No books found for “${esc(q)}”${this.lang ? ' in ' + langName + '. Try All, or add the Free Scanned Books source' : ''}.</p>`;
      }, 120);
    };
    if (!sources.length) { this.status('done'); $('#feedList').innerHTML = `<p class="none">None of your sources has ${esc(langName)} books yet. Add “Free Scanned Books” under Add sources.</p>`; return; }
    progress();
    await Promise.all(sources.map((src) => this.searchCatalog(src, q).then((r) => {
      done++;
      if (r.error) failed++;
      for (const e of r.entries) {
        if (!e || e.nav || view.feed.entries.length >= 150) continue;      // a folder needs its own catalog to open
        const entry = Object.assign({}, e, { _sourceName: src.name, _src: src, _score: this.matchScore(e, q), _order: got++ });
        const key = (entry.title || '').toLowerCase() + '|' + (entry.authors || []).join(', ').toLowerCase();
        const prev = seen.get(key);
        if (prev) {                                                          // the same book from another catalog: keep the one that can be downloaded
          if (!(prev.formats || []).length && (entry.formats || []).length) { view.feed.entries[view.feed.entries.indexOf(prev)] = entry; seen.set(key, entry); }
          continue;
        }
        seen.set(key, entry);
        view.feed.entries.push(entry);
      }
      progress();
      redraw();
    })));
    if (this.stack[this.stack.length - 1] === view && failed && view.feed.entries.length) App.toast(`${failed} catalog${failed === 1 ? '' : 's'} could not be reached`, 3500);
  },

  async search(q) {
    if (!q) return;
    const view = this.stack[this.stack.length - 1];
    try {
      const url = await Opds.searchUrl(view.source, view.feed, q);
      if (!url) return App.toast('This catalog cannot be searched');
      view.scroll = $('#feedList').parentElement.scrollTop;
      this.open(view.source, url, `“${q}”`);
    } catch (e) {
      App.toast(e.message, 3500);
    }
  },

  /** Back one level; false when already at the list of catalogs. */
  back() {
    if (this.sheetEntry) { this.closeSheet(); return true; }
    if (this.errorShown) {            // dismiss an error and return to what was on screen before
      this.status('done');
      this.stack.length ? this.renderFeed() : this.renderSources();
      return true;
    }
    if (!this.stack.length && this.tab !== 'home') { this.go('home'); return true; }
    if ($('#feedView').classList.contains('hidden')) return false;
    this.stack.pop();
    this.status('done');
    this.renderFeed();
    return true;
  },

  /* ---------------- book sheet and downloads ---------------- */
  have(entry) {
    const f = this.saved[entry.id || entry.title];
    return !!(f && App.hasBook(f));
  },

  async showBook(entry) {
    this.sheetEntry = entry;
    this.drawSheet();
    $('#bookSheet').classList.add('open');
    $('#sheetScrim').classList.add('on');
    if (!entry.formats.length && entry.detail && !entry._loading && !entry._done) {
      await this.hydrate(entry);
      if (entry.nav) {                            // it turned out to be a folder, not a book
        this.closeSheet();
        const view = this.stack[this.stack.length - 1];
        return this.open(view.source, entry.nav, entry.title);
      }
      if (entry._error) entry._tried = false;
      if (this.sheetEntry === entry) this.drawSheet();
    }
  },

  /** The book page: cover, title, author, where it comes from; Read now and Download; tags; description. */
  drawSheet() {
    const e = this.sheetEntry;
    if (!e) return;
    const dl = Object.values(this.downloads).find((d) => d.entry === e);
    const have = this.have(e);
    const size = (f) => (f.size ? ` · ${Math.max(1, Math.round(f.size / 1024 / 102.4) / 10)} MB` : '');
    const buttons = dl
      ? `<button class="btn primary wide" disabled>Downloading… ${dl.pct}%</button><div class="dlbar"><i style="width:${dl.pct}%"></i></div>`
      : have
        ? `<button class="btn primary wide" id="readNow">Read now</button>`
        : (e.read ? `<button class="btn primary wide" id="readOnline">Read now</button>` : '') + (e.formats.length
          ? e.formats.slice(0, 3).map((f, i) => `<button class="btn ${i || e.read ? '' : 'primary'} wide" data-dl="${i}">${e.read ? 'Keep' : 'Download'} ${f.format}${size(f)}</button>`).join('')
          : e.read ? '' : `<p class="muted">${e._loading ? 'Loading details…' : esc(e._error || 'No EPUB or PDF download is offered for this book.')}</p>`);
    const src = e._src || (this.stack[this.stack.length - 1] || {}).source || {};
    const facts = [src.name, e.note && !/·/.test(e.note) ? '' : e.note].filter(Boolean).join(' · ');
    const tags = e.tags || [];
    const summary = e.summary || '';
    const long = summary.length > 280;
    $('#sheetBody').innerHTML = `
      <div class="bp-head">
        <span class="bp-cover cover${e.cover ? '' : ' noimg'}" style="--c1:hsl(${this.tint(e.title)} 38% 42%);--c2:hsl(${this.tint(e.title)} 45% 24%)">
          <span class="gen"><span class="gt">${esc(e.title.slice(0, 90))}</span><span class="ga">${esc((e.authors || []).join(', ').slice(0, 60))}</span></span>
          ${e.cover ? `<img src="${esc(e.cover)}" alt="" onerror="this.parentNode.classList.add('noimg');this.remove()">` : ''}</span>
        <div class="bp-title"><h3>${esc(e.title)}</h3>${(e.authors || []).length ? `<p class="bp-author">${esc(e.authors.join(', '))}</p>` : ''}${facts ? `<p class="muted bp-facts">${esc(facts)}</p>` : ''}</div>
      </div>
      <div class="actions">${buttons}</div>
      ${tags.length ? `<div class="bp-tags">${tags.slice(0, 12).map((t, i) => `<button class="chip" data-tag="${i}">${esc(t)}</button>`).join('')}${tags.length > 12 ? `<button class="chip more" data-moretags>+${tags.length - 12}</button>` : ''}</div>` : ''}
      ${summary ? `<p class="summary bp-sum${long ? ' folded' : ''}">${esc(summary.slice(0, 2400))}</p>${long ? '<button class="bp-more" id="bpMore">More</button>' : ''}` : ''}`;
    $$('#sheetBody [data-dl]').forEach((b) => { b.onclick = () => this.download(e, e.formats[b.dataset.dl]); });
    $$('#sheetBody [data-tag]').forEach((b) => { b.onclick = () => this.openTag(src, tags[b.dataset.tag]); });
    const mt = $('#sheetBody [data-moretags]');
    if (mt) mt.onclick = () => { mt.remove(); $('#sheetBody .bp-tags').insertAdjacentHTML('beforeend', tags.slice(12).map((t, i) => `<button class="chip" data-tag="${i + 12}">${esc(t)}</button>`).join('')); $$('#sheetBody [data-tag]').forEach((b) => { b.onclick = () => this.openTag(src, tags[b.dataset.tag]); }); };
    const more = $('#bpMore');
    if (more) more.onclick = () => { $('#sheetBody .bp-sum').classList.toggle('folded'); more.textContent = more.textContent === 'More' ? 'Less' : 'More'; };
    const ro = $('#readOnline');
    if (ro) ro.onclick = () => { this.closeSheet(); App.openOnline(e); };
    const rn = $('#readNow');
    if (rn) rn.onclick = () => { const f = this.saved[e.id || e.title]; this.closeSheet(); App.openBook(f); };
  },

  /** A tag on a book page: more books with that tag from the same source (or a search for it). */
  async openTag(src, tag) {
    if (!src || !tag) return;
    this.closeSheet();
    if (App.tab !== 'browse') App.showTab('browse');
    const def = src.ext && src.def;
    if (def && def.tagSearch && def.tagSearch.url) return this.open(src, `ext:${def.id}?op=tag&t=${encodeURIComponent(tag)}&page=1`, tag);
    const url = await Opds.searchUrl(src, null, tag).catch(() => null);
    if (url) return this.open(src, url, tag);
    App.toast('This source cannot look up books by subject');
  },

  closeSheet() {
    this.sheetEntry = null;
    $('#bookSheet').classList.remove('open');
    $('#sheetScrim').classList.remove('on');
  },

  download(entry, format) {
    try { if (entry._src && !entry._src.ext) this.guardLocal(format.url, entry._src); } catch (e) { return App.toast(e.message, 4000); }
    if (entry._src && entry._src.ext && !Sources.hostOk(entry._src.def, format.url)) { App.toast('This source may only download from the sites it declared', 4000); return; }
    const id = 'd' + Date.now();
    this.downloads[id] = { entry, pct: 0 };
    this.drawSheet();
    if (window.Android && Android.downloadBook) Android.downloadBook(id, format.url, entry.title, entry.cover || '', Opds.authFor(format.url));
    else this.onDownloaded(id, null, 'Needs the Android app');
  },

  onDownload(id, pct) {
    const d = this.downloads[id];
    if (!d) return;
    d.pct = pct;
    if (this.sheetEntry === d.entry) this.drawSheet();
  },

  onDownloaded(id, name, error) {
    const d = this.downloads[id];
    delete this.downloads[id];
    if (!d) return;
    if (error) App.toast('Download failed: ' + error, 4500);
    else {
      this.saved[d.entry.id || d.entry.title] = name;
      store.set('er.dl', this.saved);
      const meta = App.bookMeta(name);
      meta.title = d.entry.title;
      if (d.entry.authors && d.entry.authors.length) meta.author = d.entry.authors.join(', ');
      meta.titleSet = true;
      meta.coverUrl = d.entry.cover ? 'covers/' + encodeURIComponent(name) + '.jpg' : '';
      if (meta.coverUrl) meta.cover = meta.coverUrl;
      meta.addedAt = Date.now();
      store.set(App.bookKey(name), meta);
      App.toast('Added to your library');
    }
    if (this.sheetEntry === d.entry) this.drawSheet();
    if (this.stack.length) {
      const view = this.stack[this.stack.length - 1];
      this.drawEntries(view, view.feed.entries, false);
    }
  },
};
