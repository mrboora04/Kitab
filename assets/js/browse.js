'use strict';
/* Browse tab: free public-domain catalogs and your own OPDS catalogs (Calibre, Calibre-Web, Kavita, ...). */

const Browse = {
  builtin: [
    {
      id: 'gutenberg', name: 'Project Gutenberg', blurb: 'Over 70,000 free classics, public domain', icon: '📚',
      url: 'https://www.gutenberg.org/ebooks.opds/',
      search: 'https://www.gutenberg.org/ebooks/search.opds/?query={searchTerms}',
    },
    {
      id: 'standardebooks', name: 'Standard Ebooks', blurb: 'Carefully formatted free editions of classics', icon: '✒️',
      url: 'https://standardebooks.org/feeds/opds',
      search: 'https://standardebooks.org/feeds/opds/all?query={searchTerms}',
    },
  ],
  custom: store.get('er.sources', []),
  stack: [],          // opened feeds, newest last: { source, url, feed, title, scroll }
  downloads: {},      // id -> { entry, pct }
  saved: store.get('er.dl', {}),   // entry id -> file name of a book downloaded from a catalog
  sheetEntry: null,

  init() {
    $('#addSource').onclick = () => this.addSource();
    $('#feedBack').onclick = () => this.back();
    $('#feedSearch').onsubmit = (e) => { e.preventDefault(); this.search($('#feedQuery').value.trim()); };
    $('#sheetClose').onclick = () => this.closeSheet();
    $('#sheetScrim').onclick = () => this.closeSheet();
    this.renderSources();
  },

  /* ---------------- source list ---------------- */
  renderSources() {
    $('#sourceView').classList.toggle('hidden', this.stack.length > 0);
    $('#feedView').classList.toggle('hidden', this.stack.length === 0);
    if (this.stack.length) return;
    const card = (s, custom) => `
      <button class="source" data-src="${esc(s.id)}">
        <span class="src-icon">${s.icon || '🌐'}</span>
        <span class="src-text"><b>${esc(s.name)}</b><small>${esc(s.blurb || s.url)}</small></span>
        ${custom ? `<span class="src-del" data-del="${esc(s.id)}" aria-label="Remove catalog">✕</span>` : '<span class="chev">›</span>'}
      </button>`;
    $('#sourceList').innerHTML = this.builtin.map((s) => card(s)).join('')
      + (this.custom.length ? '<h3 class="subhead">Your catalogs</h3>' + this.custom.map((s) => card(s, true)).join('') : '');
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

  all() { return this.builtin.concat(this.custom); },

  async addSource() {
    const url = await App.dialog({
      title: 'Add a catalog', message: 'Paste the OPDS address of a Calibre, Calibre-Web or Kavita library, or any other OPDS catalog.',
      input: 'https://', ok: 'Add',
    });
    if (!url || !/^https?:\/\/\S+$/i.test(url.trim())) { if (url) App.toast('That does not look like a web address'); return; }
    busy(true, 'Checking the catalog…');
    try {
      const feed = await Opds.load(url.trim());
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

  /* ---------------- feeds ---------------- */
  openSource(src) { return this.open(src, src.url, src.name); },

  async open(src, url, title) {
    this.status('loading');
    try {
      const feed = await Opds.load(url);
      this.stack.push({ source: src, url, feed, title: title || feed.title, scroll: 0 });
      this.renderFeed();
    } catch (e) {
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
    $('#sourceView').classList.add('hidden');
    $('#feedView').classList.remove('hidden');
    $('#feedTitle').textContent = view.title || 'Catalog';
    const canSearch = !!(view.source.search || view.feed.search);
    $('#feedSearch').classList.toggle('hidden', !canSearch);
    $('#feedQuery').value = '';
    $('#feedQuery').placeholder = 'Search ' + (view.source.name || 'catalog');
    this.drawEntries(view, view.feed.entries, false);
    $('#feedList').parentElement.scrollTop = view.scroll || 0;
  },

  drawEntries(view, entries, append) {
    const list = $('#feedList');
    if (!append) list.innerHTML = '';
    const frag = entries.map((e, i) => {
      const idx = (append ? view.drawn : 0) + i;
      if (e.nav) {
        return `<button class="li nav" data-nav="${idx}"><span class="folder">📁</span><span class="row-text"><b>${esc(e.title)}</b>${e.summary ? `<small>${esc(e.summary.slice(0, 90))}</small>` : ''}</span><span class="chev">›</span></button>`;
      }
      const fmt = (e.formats || []).map((f) => f.format).filter((f, k, a) => a.indexOf(f) === k).join(' · ');
      const have = this.have(e);
      return `<button class="li item" data-book="${idx}">
        <span class="thumb">${e.cover ? `<img loading="lazy" src="${esc(e.cover)}" alt="" onerror="this.remove()">` : ''}<i>${esc(e.title.slice(0, 1))}</i></span>
        <span class="row-text"><b>${esc(e.title)}</b><small>${esc((e.authors || []).join(', '))}</small>${fmt ? `<em>${fmt}</em>` : ''}${have ? '<em class="have">In library</em>' : ''}</span></button>`;
    }).join('');
    list.insertAdjacentHTML('beforeend', frag);
    view.drawn = (append ? view.drawn : 0) + entries.length;
    view.all = (append ? view.all : []).concat(entries);
    $$('#feedList [data-nav]').forEach((b) => { b.onclick = () => this.leave(view, () => this.open(view.source, view.all[b.dataset.nav].nav, view.all[b.dataset.nav].title)); });
    $$('#feedList [data-book]').forEach((b) => { b.onclick = () => this.showBook(view.all[b.dataset.book]); });
    $('#feedMore').classList.toggle('hidden', !view.feed.next);
    $('#feedMore').textContent = 'Load more';
    $('#feedMore').onclick = () => this.more(view);
    if (!entries.length && !append) list.innerHTML = '<p class="none">Nothing found here.</p>';
  },

  leave(view, then) {
    view.scroll = $('#feedList').parentElement.scrollTop;
    then();
  },

  async more(view) {
    const btn = $('#feedMore');
    btn.textContent = 'Loading…';
    try {
      const next = await Opds.load(view.feed.next);
      view.feed.next = next.next;
      view.feed.entries = view.feed.entries.concat(next.entries);
      this.drawEntries(view, next.entries, true);
    } catch (e) {
      btn.textContent = 'Load more';
      App.toast(e.message, 3500);
    }
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
    if (!entry.formats.length && entry.detail && !entry._loading) {
      entry._loading = true;
      try {
        const doc = await Opds.load(entry.detail);
        const full = doc.entries.find((x) => x.formats && x.formats.length) || doc.entries[0];
        Object.assign(entry, { formats: full.formats, summary: full.summary || entry.summary, cover: entry.cover || full.cover, authors: entry.authors.length ? entry.authors : full.authors });
      } catch (e) {
        entry._error = e.message;
      }
      entry._loading = false;
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
    const id = 'd' + Date.now();
    this.downloads[id] = { entry, pct: 0 };
    this.drawSheet();
    if (window.Android && Android.downloadBook) Android.downloadBook(id, format.url, entry.title, entry.cover || '');
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
