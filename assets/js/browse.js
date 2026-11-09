'use strict';
/* Browse tab: free public-domain catalogs and your own OPDS catalogs (Calibre, Calibre-Web, Kavita, ...). */

const Browse = {
  builtin: [
    {
      id: 'gutenberg', lang: 'en', name: 'Project Gutenberg', blurb: 'Over 70,000 free classics, public domain', icon: '📚',
      url: 'https://www.gutenberg.org/ebooks.opds/',
      search: 'https://www.gutenberg.org/ebooks/search.opds/?query={searchTerms}',
    },
    {
      id: 'standardebooks', lang: 'en', name: 'Standard Ebooks', blurb: 'Carefully formatted free editions of classics', icon: '✒️',
      url: 'https://standardebooks.org/feeds/opds',
      search: 'https://standardebooks.org/feeds/opds/all?query={searchTerms}',
      // Their full catalog feed may be for Patrons Circle members only; New releases is the free part.
      fallback: 'https://standardebooks.org/feeds/opds/new-releases', fallbackTitle: 'New releases',
    },
  ],
  custom: store.get('er.sources', []),
  stack: [],          // opened feeds, newest last: { source, url, feed, title, scroll }
  downloads: {},      // id -> { entry, pct }
  saved: store.get('er.dl', {}),   // entry id -> file name of a book downloaded from a catalog
  sheetEntry: null,
  queue: [],
  busyLoads: 0,
  io: null,
  lang: store.get('er.lang', ''),      // global search language ('' = all)
  LANGS: [['', 'All'], ['en', 'English'], ['hi', 'Hindi'], ['pa', 'Punjabi'], ['ur', 'Urdu'], ['bn', 'Bengali'], ['mr', 'Marathi'], ['gu', 'Gujarati'], ['ta', 'Tamil'], ['te', 'Telugu'], ['kn', 'Kannada'], ['ml', 'Malayalam'], ['sa', 'Sanskrit']],
  tab: 'home',          // home, ext (Add sources) or sites (Free book websites)

  init() {
    $('#goExt').onclick = () => this.go('ext');
    $('#goSites').onclick = () => this.go('sites');
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
    $('#sitesView').classList.toggle('hidden', inFeed || this.tab !== 'sites');
    $('#feedView').classList.toggle('hidden', !inFeed);
    if (inFeed) return;
    if (this.tab === 'ext') return ExtUI.render();
    if (this.tab === 'sites') return ExtUI.renderSites();
    if (typeof App !== 'undefined' && App.tab === 'browse') ExtUI.warm();     // only once Browse is really on screen
    const card = (s, custom) => `
      <button class="source" data-src="${esc(s.id)}">
        <span class="src-icon">${s.icon || '🌐'}</span>
        <span class="src-text"><b>${esc(s.name)}</b><small>${esc(s.blurb || s.url)}</small></span>
        ${custom ? `<span class="src-del" data-del="${esc(s.id)}" aria-label="Remove catalog">✕</span>` : '<span class="chev">›</span>'}
      </button>`;
    const exts = Sources.list().map((d) => Sources.asCatalog(d));
    $('#sourceList').innerHTML = this.builtin.map((s) => card(s)).join('') + exts.map((s) => card(s)).join('') + this.custom.map((s) => card(s, true)).join('');
    const n = Object.values(Sources.indexes).reduce((t, ix) => t + ((ix.directory || []).length), 0);
    if (n) $('#sitesCount').textContent = `${n} sites worth knowing, for every age`;
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

  /** Moves between the Browse home, Add sources and Free book websites. */
  go(tab) {
    this.tab = tab;
    this.renderSources();
    $('#pane-browse').scrollTop = 0;
  },

  all() { return this.builtin.concat(Sources.list().map((d) => Sources.asCatalog(d)), this.custom); },

  /** One place that reads a feed: built-in and your own catalogs (OPDS), or an installed source (ext: addresses). */
  async loadFeed(url, src) {
    if (/^ext:/.test(url)) return Object.assign(await Sources.load(url), { url });
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
        if (!e.needsLogin) throw e;
        busy(false);
        const login = await App.dialog({ title: 'Log in to ' + e.host, message: 'This catalog asks for your account. Kitab keeps the login on this phone and only sends it to ' + e.host + '.', login: true, ok: 'Log in' });
        if (!login || !login.user) return;
        Opds.saveLogin(url.trim(), login.user, login.pass);
        busy(true, 'Checking the catalog…');
        feed = await Opds.load(url.trim());
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
    this.status('loading');
    try {
      const feed = await this.loadFeed(url, src);
      this.stack.push({ source: src, url, feed, title: title || feed.title, scroll: 0 });
      this.renderFeed();
    } catch (e) {
      // a members-only catalog: try its free part first
      if ((e.status === 401 || e.status === 403) && src.fallback && url === src.url && !this._triedFallback) {
        this._triedFallback = true;
        try { return await this.open(src, src.fallback, src.fallbackTitle || title); } finally { this._triedFallback = false; }
      }
      if (e.needsLogin) {
        const login = await App.dialog({ title: 'Log in to ' + (src.name || e.host), message: 'This catalog asks for your account. Kitab keeps the login on this phone and only sends it to ' + e.host + '.', login: true, ok: 'Log in' });
        if (login && login.user) { Opds.saveLogin(url, login.user, login.pass); return this.open(src, url, title); }
      }
      if (!this.stack.length) {   // nothing loaded yet: show an empty page with a header so Back still works
        $('#feedTitle').textContent = title || src.name;
        $('#feedSearch').classList.add('hidden');
        $('#feedList').innerHTML = '';
        $('#feedMore').classList.add('hidden');
      }
      this.status('error', e.message, () => this.open(src, url, title));
    }
  },

  status(kind, msg, retry) {
    const box = $('#feedStatus');
    this.errorShown = kind === 'error';
    if (kind === 'loading') {
      $('#extView').classList.add('hidden');
      $('#sitesView').classList.add('hidden');
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
    $('#sitesView').classList.add('hidden');
    $('#sourceView').classList.add('hidden');
    $('#feedView').classList.remove('hidden');
    $('#feedTitle').textContent = view.title || 'Catalog';
    const canSearch = !!(view.source.search || view.feed.search);
    $('#feedSearch').classList.toggle('hidden', !canSearch);
    $('#feedQuery').value = '';
    $('#feedQuery').placeholder = 'Search ' + (view.source.name || 'catalog');
    $('#feedLangs').classList.toggle('hidden', view.source.id !== 'all');
    this.drawEntries(view, view.feed.entries, false);
    $('#feedList').parentElement.scrollTop = view.scroll || 0;
    if (/op=root/.test(view.url || '') && canSearch && !view.feed.entries.length) setTimeout(() => $('#feedQuery').focus(), 250);
  },

  /** A steady colour for a book without a cover picture, from its title. */
  tint(t) { let h = 0; for (const ch of String(t)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; },

  rowHtml(e, idx) {
    if (e.nav) {      // a section of the catalog: a plain row, not a folder
      return `<button class="li nav" data-nav="${idx}"><span class="sec-dot" style="--h:${this.tint(e.title)}">${esc((e.title || '?').trim().slice(0, 1).toUpperCase())}</span><span class="row-text"><b>${esc(e.title)}</b>${e.summary ? `<small>${esc(e.summary.slice(0, 90))}</small>` : ''}</span><span class="chev">›</span></button>`;
    }
    // a book: its cover (or a printed-looking one made from the title), then title, author and one small label
    const fmt = (e.formats || []).map((f) => f.format).filter((f, k, a) => a.indexOf(f) === k).join(' · ');
    const tag = this.have(e) ? '<em class="have">In library</em>' : (e._sourceName ? `<em>${esc(e._sourceName)}</em>` : (fmt ? `<em>${fmt}</em>` : ''));
    const by = (e.authors || []).join(', ') || e.note || '';
    return `<button class="li gbook" data-book="${idx}">
        <span class="cover" style="--c1:hsl(${this.tint(e.title)} 38% 42%);--c2:hsl(${this.tint(e.title)} 45% 24%)">
          <span class="gen"><span class="type">${esc(fmt || 'BOOK')}</span><span>${esc(e.title.slice(0, 60))}</span><span></span></span>
          ${e.cover ? `<img loading="lazy" src="${esc(e.cover)}" alt="" onerror="this.remove()">` : ''}</span>
        <b>${esc(e.title)}</b>${by ? `<small>${esc(by)}</small>` : ''}<span class="tags">${tag}</span></button>`;
  },

  drawEntries(view, entries, append) {
    const list = $('#feedList');
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
          Object.assign(e, { formats: full.formats, summary: full.summary || e.summary, cover: e.cover || full.cover });
          if (!e.authors.length) e.authors = full.authors;
          e._done = true;
        } else if (doc.entries.length > 1 && e.maybeFolder) {
          e.nav = e.detail;                      // not a single book: it is a folder of entries
        } else {
          const one = doc.entries[0];
          if (one) { e.summary = one.summary || e.summary; if (!e.authors.length) e.authors = one.authors; }
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

  drawSheet() {
    const e = this.sheetEntry;
    if (!e) return;
    const dl = Object.values(this.downloads).find((d) => d.entry === e);
    const have = this.have(e);
    const buttons = dl
      ? `<button class="btn primary wide" disabled>Downloading… ${dl.pct}%</button><div class="dlbar"><i style="width:${dl.pct}%"></i></div>`
      : have
        ? `<button class="btn primary wide" id="readNow">Read now</button>`
        : e.formats.length
          ? e.formats.slice(0, 3).map((f, i) => `<button class="btn ${i ? '' : 'primary'} wide" data-dl="${i}">Download ${f.format}${f.size ? ` · ${Math.max(1, Math.round(f.size / 1024 / 102.4) / 10)} MB` : ''}</button>`).join('')
          : `<p class="muted">${e._loading ? 'Loading details…' : esc(e._error || 'No EPUB or PDF download is offered for this book.')}</p>`;
    $('#sheetBody').innerHTML = `
      <div class="sheet-book">
        <span class="thumb big">${e.cover ? `<img src="${esc(e.cover)}" alt="" onerror="this.remove()">` : ''}<i>${esc(e.title.slice(0, 1))}</i></span>
        <div><h3>${esc(e.title)}</h3><p class="muted">${esc((e.authors || []).join(', '))}</p></div>
      </div>
      ${e.summary ? `<p class="summary">${esc(e.summary.slice(0, 600))}${e.summary.length > 600 ? '…' : ''}</p>` : ''}
      <div class="actions">${buttons}</div>`;
    $$('#sheetBody [data-dl]').forEach((b) => { b.onclick = () => this.download(e, e.formats[b.dataset.dl]); });
    const rn = $('#readNow');
    if (rn) rn.onclick = () => { const f = this.saved[e.id || e.title]; this.closeSheet(); App.openBook(f); };
  },

  closeSheet() {
    this.sheetEntry = null;
    $('#bookSheet').classList.remove('open');
    $('#sheetScrim').classList.remove('on');
  },

  download(entry, format) {
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
