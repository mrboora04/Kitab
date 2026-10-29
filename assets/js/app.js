'use strict';
/* Library, reader chrome and settings. Native features come from window.Android (MainActivity.Bridge). */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const Native = window.Android || {
  // Lets the UI run in a desktop browser for development.
  pickBook() { toast('File picking needs the Android app'); },
  listBooks() { return '[]'; }, deleteBook() { return true; }, canSpeak() { return false; },
  speak() {}, stopSpeaking() {}, setKeepScreenOn() {}, setBrightness() {}, setVolumeKeys() {},
  setFullscreen() {}, setBarColor() {}, toast(m) { toast(m); },
};

const DEFAULTS = {
  theme: 'paper', fontSize: 19, font: 'serif', lineHeight: 1.6, margin: 20, measure: 48, frame: true,
  flow: 'paged', pdfMode: 'page', pdfTrim: true, brightness: null, warmth: 0, ttsRate: 1,
  tapZones: true, volumeKeys: true, keepAwake: true, fullscreen: false,
  ui: 'funky', accent: 'ember', eyeEvery: '30', eyeInsist: true, eyeRest: '2', protect: true,
};
const BAR_COLORS = { paper: '#fbf8f2', sepia: '#f1e6cf', mint: '#e2eddd', dusk: '#2a2b2f', night: '#000000' };
const COVER_COLORS = [['#c45c34', '#7d3420'], ['#3c6e8f', '#1f3b52'], ['#4f7d4a', '#2b4a28'], ['#8a5a9e', '#4c2d5c'], ['#b0893a', '#6b511c'], ['#5d6470', '#2f343b']];

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full or blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};

function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('on'), ms || 2200);
}

function busy(on, text, note) {
  $('#busy').classList.toggle('hidden', !on);
  if (text) $('#busyText').textContent = text;
  $('#busyNote').textContent = note || '';
}

const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
const prettyName = (name) => name.replace(/\.(pdf|epub|txt)$/i, '').replace(/[_]+/g, ' ').trim();
function ago(t) {
  if (!t) return 'New';
  const m = (Date.now() - t) / 60000;
  if (m < 2) return 'Just now';
  if (m < 60) return Math.round(m) + ' min ago';
  if (m < 60 * 24) return Math.round(m / 60) + ' h ago';
  const d = Math.round(m / 1440);
  return d === 1 ? 'Yesterday' : d + ' days ago';
}
function hashColor(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return COVER_COLORS[Math.abs(h) % COVER_COLORS.length];
}

const App = {
  settings: Object.assign({}, DEFAULTS, store.get('er.settings', {})),
  reader: null,
  name: null,
  meta: null,
  tts: false,

  /* ---------------- startup ---------------- */
  init() {
    try { Object.keys(localStorage).filter((k) => k.startsWith('er.ocr.') || k.startsWith('er.ocr2.')).forEach((k) => localStorage.removeItem(k)); } catch (e) { /* older, lower-quality scans are re-read */ }
    this.applySettings(true);
    this.bindLibrary();
    this.bindReader();
    this.bindSettings();
    Browse.init();
    this.renderLibrary();
  },

  bookKey(name) { return 'er.book.' + name; },
  bookMeta(name) { return store.get(this.bookKey(name), { title: prettyName(name), bookmarks: [] }); },
  saveMeta() { if (this.name && this.meta) store.set(this.bookKey(this.name), this.meta); },

  /* ---------------- library ---------------- */
  lib: Object.assign({ sort: 'recent', filter: 'all', query: '' }, store.get('er.lib', {})),
  tab: 'library',

  bindLibrary() {
    $('#addBtn').onclick = () => Native.pickBook();
    $('#searchBtn').onclick = () => {
      const on = $('#libSearch').classList.toggle('hidden') === false;
      if (on) $('#libQuery').focus(); else { this.lib.query = ''; $('#libQuery').value = ''; this.renderLibrary(); }
    };
    $('#libQuery').oninput = () => { this.lib.query = $('#libQuery').value.trim().toLowerCase(); this.renderLibrary(); };
    $('#sortBtn').onclick = (e) => this.sortMenu(e.currentTarget);
    $$('#filters [data-f]').forEach((b) => { b.onclick = () => { this.lib.filter = b.dataset.f; this.saveLib(); this.renderLibrary(); }; });
    $$('#navbar [data-tab]').forEach((b) => { b.onclick = () => this.showTab(b.dataset.tab); });
    $('#browseAddBtn').onclick = () => this.showTab('browse');
  },

  saveLib() { store.set('er.lib', { sort: this.lib.sort, filter: this.lib.filter }); },

  showTab(tab) {
    this.tab = tab;
    $$('#navbar [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    ['library', 'browse', 'history', 'more'].forEach((t) => $('#pane-' + t).classList.toggle('hidden', t !== tab));
    if (tab === 'library') this.renderLibrary();
    if (tab === 'history') this.renderHistory();
    if (tab === 'browse') Browse.renderSources();
  },

  hasBook(name) { return this.books().some((b) => b.name === name); },

  books() {
    let list = [];
    try { list = JSON.parse(Native.listBooks()); } catch (e) { /* none */ }
    return list.map((b) => Object.assign(b, { meta: this.bookMeta(b.name) }));
  },

  state(b) {
    const p = b.meta.progress || 0;
    return b.meta.finished || p >= 0.97 ? 'finished' : p > 0 ? 'reading' : 'unread';
  },

  coverHtml(b) {
    const m = b.meta;
    const [c1, c2] = hashColor(b.name);
    const pct = Math.round((m.progress || 0) * 100);
    const gen = `<div class="gen"><span class="type">${extOf(b.name).toUpperCase()}</span><span>${esc(m.title || prettyName(b.name))}</span><span class="type">${esc(m.author || '')}</span></div>`;
    const inner = m.cover ? `<img src="${esc(m.cover)}" alt="" onerror="this.closest('.cover').classList.remove('has-img');this.remove()">${gen}` : gen;
    const badge = this.state(b) === 'finished' ? '<span class="badge">✓</span>' : m.favorite ? '<span class="badge fav">★</span>' : '';
    return `<div class="cover ${m.cover ? 'has-img' : ''} ${badge ? 'badged' : ''}" style="--c1:${c1};--c2:${c2}">${inner}${badge}${pct && pct < 97 ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}</div>`;
  },

  sortMenu(anchor) {
    const opts = [['recent', 'Recently read'], ['added', 'Recently added'], ['title', 'Title A–Z'], ['progress', 'Progress']];
    this.menu(anchor, opts.map(([v, t]) => `<button data-v="${v}">${this.lib.sort === v ? '✓ ' : ''}${t}</button>`).join(''), (el) => {
      this.lib.sort = el.dataset.v; this.saveLib(); this.renderLibrary();
    });
  },

  renderLibrary() {
    const all = this.books();
    const q = this.lib.query;
    const sorters = {
      recent: (a, b) => (b.meta.lastRead || b.added || 0) - (a.meta.lastRead || a.added || 0),
      added: (a, b) => (b.meta.addedAt || b.added || 0) - (a.meta.addedAt || a.added || 0),
      title: (a, b) => (a.meta.title || a.name).localeCompare(b.meta.title || b.name),
      progress: (a, b) => (b.meta.progress || 0) - (a.meta.progress || 0),
    };
    const f = this.lib.filter;
    const books = all.filter((b) => {
      if (q && !((b.meta.title || b.name) + ' ' + (b.meta.author || '')).toLowerCase().includes(q)) return false;
      if (f === 'favorite') return !!b.meta.favorite;
      return f === 'all' || this.state(b) === f;
    }).sort(sorters[this.lib.sort] || sorters.recent);

    $$('#filters [data-f]').forEach((b) => {
      const n = all.filter((x) => (b.dataset.f === 'all' ? true : b.dataset.f === 'favorite' ? x.meta.favorite : this.state(x) === b.dataset.f)).length;
      b.classList.toggle('on', b.dataset.f === f);
      b.querySelector('i').textContent = n || '';
    });
    $('#emptyState').classList.toggle('hidden', all.length > 0);
    $('#noMatch').classList.toggle('hidden', !all.length || books.length > 0);
    $('#libCount').textContent = all.length ? `${all.length} book${all.length > 1 ? 's' : ''}` : 'Your books';
    $('#filters').classList.toggle('hidden', !all.length);
    const last = all.filter((b) => b.meta.lastRead && this.state(b) !== 'finished').sort(sorters.recent)[0];
    $('#continueWrap').innerHTML = last && !q && f === 'all' ? `
      <button class="continue" data-open="${esc(last.name)}">
        ${this.coverHtml(last)}
        <div><div class="label">Continue reading</div><h3>${esc(last.meta.title || prettyName(last.name))}</h3>
        <div class="muted">${Math.round((last.meta.progress || 0) * 100)}% · ${ago(last.meta.lastRead)}</div></div>
      </button>` : '';
    $('#shelf').innerHTML = books.map((b) => `
      <div class="book">
        <button data-open="${esc(b.name)}" style="text-align:left">${this.coverHtml(b)}</button>
        <button class="more" data-menu="${esc(b.name)}" aria-label="Options">⋮</button>
        <div class="title">${esc(b.meta.title || prettyName(b.name))}</div>
        <div class="meta">${b.meta.progress ? Math.round(b.meta.progress * 100) + '% · ' : ''}${ago(b.meta.lastRead)}</div>
      </div>`).join('');
    $$('#pane-library [data-open]').forEach((el) => { el.onclick = () => this.openBook(el.dataset.open); });
    $$('#pane-library [data-menu]').forEach((el) => { el.onclick = (e) => { e.stopPropagation(); this.bookMenu(el.dataset.menu, el); }; });
  },

  renderHistory() {
    const books = this.books().filter((b) => b.meta.lastRead).sort((a, b) => b.meta.lastRead - a.meta.lastRead);
    $('#historyEmpty').classList.toggle('hidden', books.length > 0);
    $('#historyList').innerHTML = books.map((b) => `
      <button class="li item" data-open="${esc(b.name)}">
        <span class="thumb">${b.meta.cover ? `<img src="${esc(b.meta.cover)}" alt="" onerror="this.remove()">` : ''}<i>${esc((b.meta.title || b.name).slice(0, 1))}</i></span>
        <span class="row-text"><b>${esc(b.meta.title || prettyName(b.name))}</b>
          <small>${Math.round((b.meta.progress || 0) * 100)}% · ${ago(b.meta.lastRead)}</small>
          <span class="mini"><i style="width:${Math.round((b.meta.progress || 0) * 100)}%"></i></span></span>
      </button>`).join('');
    $$('#historyList [data-open]').forEach((el) => { el.onclick = () => this.openBook(el.dataset.open); });
    $('#clearHistory').classList.toggle('hidden', !books.length);
    $('#clearHistory').onclick = async () => {
      if (!(await this.dialog({ title: 'Clear history?', message: 'Your books and bookmarks stay. Reading positions are forgotten.', ok: 'Clear', danger: true }))) return;
      this.books().forEach((b) => { const m = b.meta; delete m.lastRead; delete m.loc; m.progress = 0; store.set(this.bookKey(b.name), m); });
      this.renderHistory();
    };
  },

  /** Small popup list anchored to a button; onPick gets the chosen button. */
  menu(anchor, html, onPick) {
    document.querySelectorAll('.menu').forEach((m) => m.remove());
    const m = document.createElement('div');
    m.className = 'menu';
    m.innerHTML = html;
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = Math.max(10, Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 10)) + 'px';
    m.style.left = Math.max(10, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 10)) + 'px';
    const close = () => { m.remove(); document.removeEventListener('click', close, true); };
    setTimeout(() => document.addEventListener('click', close, true));
    m.onclick = (e) => { const b = e.target.closest('button'); if (b) onPick(b); };
  },

  bookMenu(name, anchor) {
    const meta = this.bookMeta(name);
    const fin = meta.finished || (meta.progress || 0) >= 0.97;
    this.menu(anchor,
      `<button data-a="open">Open</button><button data-a="fav">${meta.favorite ? 'Remove from favourites' : 'Add to favourites'}</button>`
      + `<button data-a="fin">${fin ? 'Mark as unread' : 'Mark as finished'}</button><button data-a="del" class="danger">Remove from library</button>`,
      async (el) => {
        const a = el.dataset.a;
        if (a === 'open') this.openBook(name);
        if (a === 'fav') { meta.favorite = !meta.favorite; store.set(this.bookKey(name), meta); this.renderLibrary(); }
        if (a === 'fin') {
          if (fin) { meta.finished = false; meta.progress = 0; delete meta.loc; delete meta.lastRead; } else { meta.finished = true; meta.progress = 1; }
          store.set(this.bookKey(name), meta);
          this.renderLibrary();
        }
        if (a === 'del' && await this.dialog({ title: `Remove “${meta.title || prettyName(name)}”?`, message: 'It is removed from Kitab only. Your original file is not touched.', ok: 'Remove', danger: true })) {
          Native.deleteBook(name);
          store.del(this.bookKey(name));
          store.del('er.locs.' + name);
          this.renderLibrary();
        }
      });
  },

  /** In-app dialog. Resolves to true / the typed text / null when cancelled. */
  dialog({ title, message, input, ok, danger }) {
    return new Promise((resolve) => {
      const d = $('#dialog');
      $('#dlgTitle').textContent = title || '';
      $('#dlgMsg').textContent = message || '';
      const field = $('#dlgInput');
      field.classList.toggle('hidden', input == null);
      field.value = input || '';
      const okBtn = $('#dlgOk');
      okBtn.textContent = ok || 'OK';
      okBtn.classList.toggle('danger', !!danger);
      d.classList.remove('hidden');
      if (input != null) setTimeout(() => { field.focus(); field.select(); }, 50);
      const done = (v) => { d.classList.add('hidden'); okBtn.onclick = $('#dlgCancel').onclick = null; this._dialogOpen = false; resolve(v); };
      this._dialogOpen = () => done(null);
      okBtn.onclick = () => done(input != null ? field.value : true);
      $('#dlgCancel').onclick = () => done(null);
    });
  },

  toast(m, ms) { toast(m, ms); },

  /* Called from Java */
  onHttp(r) { Opds.answer(r); },
  onDownload(id, pct) { Browse.onDownload(id, pct); },
  onDownloaded(id, name, err) { Browse.onDownloaded(id, name, err); },

  /* Called from Java */
  onImportStarted() { busy(true, 'Adding book…'); },
  onImported(name) {
    busy(false);
    if (name) this.openBook(name);
    else this.renderLibrary();
  },

  /* ---------------- reader ---------------- */
  async openBook(name) {
    if (EyeCare.resting()) return EyeCare.showRest();
    if (this.reader) await this.closeBook(true);
    busy(true, 'Opening…');
    Native.setSecure && Native.setSecure(!!this.settings.protect);   // book pages are protected from screenshots
    this.name = name;
    this.meta = this.bookMeta(name);
    const type = extOf(name);
    const url = 'books/' + encodeURIComponent(name);
    document.body.classList.toggle('is-pdf', type === 'pdf');
    document.body.classList.toggle('is-epub', type === 'epub');
    $('#home').classList.add('hidden');
    $('#reader').classList.remove('hidden', 'ui');
    $('#bookTitle').textContent = this.meta.title || prettyName(name);
    this.applySettings(true);
    try {
      if (type === 'pdf') {
        const data = new Uint8Array(await (await fetch(url)).arrayBuffer());
        this.pdf = await pdfjsLib.getDocument(Object.assign({ data }, PDF_OPTS)).promise;
        const info = await this.pdf.getMetadata().catch(() => null);
        const t = info && info.info && info.info.Title;
        if (t && t.trim().length > 2 && !/^(untitled|microsoft word|scan)/i.test(t.trim()) && !this.meta.titleSet) this.meta.title = t.trim();
        await this.makePdfReader(this.meta.loc);
        if (!this.meta.cover) this.pdfCover();
        if (!this.meta.ocr && !this.meta.ocrHinted && await pdfLooksScanned(this.pdf)) {
          this.meta.ocrHinted = true;
          this.saveMeta();
          setTimeout(() => toast('This looks like a scanned book. Tap 📝 Scan text to turn it into readable text.', 6000), 1200);
        }
      } else if (type === 'epub') {
        this.reader = new EpubReader($('#stage'), this, url, name);
        await this.reader.open(this.meta.loc);
        if (this.reader.title && !this.meta.titleSet) this.meta.title = this.reader.title;
        if (this.reader.author && !this.meta.titleSet) this.meta.author = this.reader.author;
        if (!this.meta.cover) this.epubCover();
      } else {
        this.reader = new TextReader($('#stage'), this, await textSource(url));
        await this.reader.open(this.meta.loc);
      }
    } catch (e) {
      console.error(e);
      busy(false);
      toast('Could not open this book: ' + (e.message || e));
      this.closeBook();
      return;
    }
    $('#bookTitle').textContent = this.meta.title || prettyName(name);
    this.meta.lastRead = Date.now();
    this.saveMeta();
    busy(false);
    this.onRelocated();
    if (!store.get('er.seenHelp')) {
      store.set('er.seenHelp', true);
      toast('Tap the middle for menus · tap or swipe the edges to turn pages');
    }
  },

  /** PDFs have two readers: original pages and reflowed text. Both report a page number. */
  async makePdfReader(loc) {
    const page = loc && loc.page || 1;
    if (this.reader) { this.reader.destroy(); this.reader = null; }
    const ocr = !!this.meta.ocr;
    const reflow = ocr || this.settings.pdfMode === 'reflow';
    document.body.classList.toggle('pdf-reflow', reflow);
    $('#ocrBtn').classList.toggle('on', ocr);
    $('#ocrBtn').innerHTML = ocr ? '<span>📄</span>Original pages' : '<span>📝</span>Scan text';
    if (reflow) {
      const src = await pdfTextSource(this.pdf, {
        ocr, key: this.name,
        onStatus: (msg) => {
          if (msg) busy(true, msg, OCR.worker ? '' : 'Starting the text reader (first time only)…');
          else if (this._opening !== true) busy(false);
        },
      });
      this.reader = new TextReader($('#stage'), this, src);
      await this.reader.open(loc && loc.s != null ? loc : src.toLoc(page));
    } else {
      if (!this.outline) this.outline = await pdfToc(this.pdf, (p) => ({ page: p }));
      this.reader = new PdfPageReader($('#stage'), this, this.pdf, this.outline);
      await this.reader.open({ page, zoom: loc && loc.zoom });
      $('#zoomLabel').textContent = Math.round(this.reader.zoom * 100) + '%';
    }
  },

  async epubCover() {
    const url = await this.reader.cover();
    if (url) this.thumb(url).then((d) => { if (d && this.meta) { this.meta.cover = d; this.saveMeta(); } });
  },

  async pdfCover() {
    try {
      const page = await this.pdf.getPage(1);
      const vp = page.getViewport({ scale: 1 });
      const s = 240 / vp.width;
      const c = document.createElement('canvas');
      c.width = 240; c.height = Math.round(vp.height * s);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: s }) }).promise;
      this.meta.cover = c.toDataURL('image/jpeg', 0.72);
      this.saveMeta();
    } catch (e) { /* no cover */ }
  },

  thumb(src) {
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = 240; c.height = Math.round(240 * img.height / img.width);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL('image/jpeg', 0.72));
      };
      img.onerror = () => res(null);
      img.src = src;
    });
  },

  async closeBook(keepView) {
    this.stopTts();
    Native.setSecure && Native.setSecure(false);
    this.saveNow();
    this.closePanels();
    if (this.reader) { try { this.reader.destroy(); } catch (e) { /* ignore */ } }
    this.reader = null;
    if (this.pdf) { this.pdf.destroy(); this.pdf = null; this.outline = null; }
    this.name = null;
    this.meta = null;
    document.body.classList.remove('is-pdf', 'is-epub', 'pdf-reflow');
    Native.setKeepScreenOn(false);
    Native.setFullscreen(false);
    Native.setBrightness(-1);
    if (!keepView) {
      $('#reader').classList.add('hidden');
      $('#home').classList.remove('hidden');
      this.showTab(this.tab);
    }
  },

  saveNow() {
    if (!this.reader || !this.meta) return;
    try {
      const l = this.reader.location();
      if (l.loc && Object.keys(l.loc).length) {
        this.meta.loc = l.loc;
        this.meta.progress = l.progress;
        this.meta.lastRead = Date.now();
        this.saveMeta();
      }
    } catch (e) { /* reader still loading */ }
  },

  onRelocated() {
    if (!this.reader) return;
    let l;
    try { l = this.reader.location(); } catch (e) { return; }
    const pct = Math.round(l.progress * 1000) / 10;
    if (!this._dragging) $('#progress').value = Math.round(l.progress * 1000);
    $('#progressLabel').textContent = `${pct}% · ${l.label}`;
    $('#chapterTitle').textContent = l.chapter || '';
    $('#infoLeft').textContent = l.chapter || (this.meta && this.meta.title) || '';
    $('#infoRight').textContent = pct + '%';
    this.updateBookmarkBtn(l.loc);
    clearTimeout(this._save);
    this._save = setTimeout(() => this.saveNow(), 800);
  },

  /* ---------------- navigation & gestures ---------------- */
  onTap(x) {
    if (this.panelOpen()) return this.closePanels();
    if (this.tts) { this.stopTts(); toast('Stopped listening'); return; }   // tap anywhere to stop
    const ui = $('#reader').classList.contains('ui');
    if (this.settings.tapZones && !ui) {
      if (x < 0.28) return this.turn(-1);
      if (x > 0.72) return this.turn(1);
    }
    this.toggleUi();
  },
  onSwipe(dir) { if (!this.panelOpen()) this.turn(dir); },
  onVolumeKey(dir) {
    if (this.reader && this.settings.volumeKeys && !$('#reader').classList.contains('hidden')) this.turn(dir);
    return true;
  },
  async turn(dir) {
    if (!this.reader) return;
    EyeCare.touch();
    if (this.tts) this.stopTts();
    const ok = await (dir > 0 ? this.reader.next() : this.reader.prev());
    if (!ok) toast(dir > 0 ? 'End of book' : 'Start of book');
  },
  toggleUi(force) {
    const r = $('#reader');
    const on = force != null ? force : !r.classList.contains('ui');
    r.classList.toggle('ui', on);
  },

  onBack() {
    if (EyeCare.showing) {
      if (!$('#ebActions').classList.contains('hidden')) EyeCare.skip();   // back = "later"
      else if (!this.reader) EyeCare.close();                             // rest screen: dismiss, the lock stays
      return true;                                                        // a closing countdown cannot be skipped
    }
    if (this._dialogOpen) { this._dialogOpen(); return true; }
    if ($('#reader').classList.contains('hidden')) {
      if (document.querySelector('.menu')) { document.querySelector('.menu').remove(); return true; }
      if (this.tab === 'browse' && Browse.back()) return true;
      if (this.tab !== 'library') { this.showTab('library'); return true; }
      return false;
    }
    if (this.panelOpen()) { this.closePanels(); return true; }
    if (!$('#reader').classList.contains('hidden')) { this.closeBook(); return true; }
    if (document.querySelector('.menu')) { document.querySelector('.menu').remove(); return true; }
    return false;
  },

  bindReader() {
    $('#backBtn').onclick = () => this.closeBook();
    $('#prevBtn').onclick = () => this.turn(-1);
    $('#nextBtn').onclick = () => this.turn(1);
    $('#settingsBtn').onclick = () => this.openPanel('#settingsPanel');
    $('#tocBtn').onclick = () => { this.renderToc(); this.openPanel('#tocPanel'); };
    $('#scrim').onclick = () => this.closePanels();
    $$('[data-close]').forEach((b) => { b.onclick = () => this.closePanels(); });
    $$('.tab').forEach((t) => {
      t.onclick = () => {
        $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
        $('#tocList').classList.toggle('hidden', t.dataset.tab !== 'toc');
        $('#markList').classList.toggle('hidden', t.dataset.tab !== 'marks');
      };
    });
    const p = $('#progress');
    p.oninput = () => { this._dragging = true; $('#progressLabel').textContent = (p.value / 10).toFixed(1) + '%'; };
    p.onchange = async () => {
      this._dragging = false;
      if (this.reader) await this.reader.goToProgress(p.value / 1000);
      this.onRelocated();
    };
    $('#bookmarkBtn').onclick = () => this.toggleBookmark();
    // reading tools live in the settings sheet; they close it so you land back on the page
    $('#ttsBtn').onclick = () => { if (this.tts) this.stopTts(); else { this.closePanels(); this.startTts(); } };
    $('#ocrBtn').onclick = () => { this.closePanels(); this.toggleOcr(); };
    $('#zoomIn').onclick = () => this.zoom(0.25);
    $('#zoomOut').onclick = () => this.zoom(-0.25);
    document.addEventListener('keydown', (e) => {
      if ($('#reader').classList.contains('hidden')) return;
      if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); this.turn(1); }
      if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); this.turn(-1); }
    });
  },

  /** Switches a scanned PDF between its original pictures and OCR text. */
  async toggleOcr(forceOn) {
    if (!this.pdf || !this.reader) return;
    const on = forceOn ? true : !this.meta.ocr;
    if (on === !!this.meta.ocr) return;
    const loc = this.reader.location().loc;
    this.meta.ocr = on;
    this.saveMeta();
    busy(true, on ? 'Preparing text scan…' : 'Showing original pages…');
    this._opening = true;
    try {
      await this.makePdfReader({ page: loc.page });
    } catch (e) {
      this.meta.ocr = false;
      this.saveMeta();
      toast('Text scan failed: ' + (e.message || e));
      await this.makePdfReader({ page: loc.page });
    }
    this._opening = false;
    busy(false);
    this.toggleUi(false);
    this.onRelocated();
  },

  zoom(d) {
    if (!(this.reader instanceof PdfPageReader)) return;
    this.reader.setZoom(this.reader.zoom + d);
    $('#zoomLabel').textContent = Math.round(this.reader.zoom * 100) + '%';
  },

  panelOpen() { return !!document.querySelector('.drawer.open, .sheet.open'); },
  openPanel(sel) {
    this.closePanels();
    $(sel).classList.add('open');
    $('#scrim').classList.add('on');
  },
  closePanels() {
    $$('.drawer.open, .sheet.open').forEach((p) => p.classList.remove('open'));
    $('#scrim').classList.remove('on');
  },

  renderToc() {
    const items = this.reader ? this.reader.toc() : [];
    const cur = this.reader ? this.reader.location().chapter : '';
    $('#tocList').innerHTML = items.length
      ? items.map((t, i) => `<button class="${t.level ? 'sub' + (t.level > 1 ? '2' : '') : ''} ${t.label === cur ? 'current' : ''}" data-i="${i}">${esc(t.label || 'Untitled')}</button>`).join('')
      : '<div class="none">This book has no table of contents. Use the slider at the bottom to jump around.</div>';
    $$('#tocList [data-i]').forEach((b) => {
      b.onclick = async () => { this.closePanels(); this.toggleUi(false); await this.reader.goTo(items[b.dataset.i].loc); this.onRelocated(); };
    });
    this.renderMarks();
    const curBtn = $('#tocList .current');
    if (curBtn) setTimeout(() => curBtn.scrollIntoView({ block: 'center' }), 50);
  },

  /* ---------------- bookmarks ---------------- */
  sameLoc(a, b) {
    if (!a || !b) return false;
    if (a.cfi || b.cfi) return a.cfi === b.cfi;
    if (a.s != null && b.s != null) return a.s === b.s && Math.abs((a.c || 0) - (b.c || 0)) < 40;
    return a.page === b.page && a.s == null && b.s == null;
  },
  updateBookmarkBtn(loc) {
    const on = !!(this.meta && (this.meta.bookmarks || []).some((m) => this.sameLoc(m.loc, loc)));
    const b = $('#bookmarkBtn');
    b.classList.toggle('on', on);
    b.textContent = on ? '★' : '☆';
  },
  async toggleBookmark() {
    const l = this.reader.location();
    const marks = (this.meta.bookmarks = this.meta.bookmarks || []);
    const i = marks.findIndex((m) => this.sameLoc(m.loc, l.loc));
    if (i >= 0) { marks.splice(i, 1); toast('Bookmark removed'); } else {
      let snippet = '';
      try { snippet = (await this.reader.visibleText()).slice(0, 90); } catch (e) { /* none */ }
      marks.push({ loc: l.loc, progress: l.progress, chapter: l.chapter, label: l.label, snippet, at: Date.now() });
      marks.sort((a, b) => a.progress - b.progress);
      toast('Bookmarked');
    }
    this.saveMeta();
    this.updateBookmarkBtn(l.loc);
  },
  renderMarks() {
    const marks = (this.meta && this.meta.bookmarks) || [];
    $('#markList').innerHTML = marks.length ? marks.map((m, i) => `
      <div class="mark"><button data-go="${i}">${esc(m.snippet || m.chapter || 'Bookmark')}…<small>${Math.round(m.progress * 100)}% · ${esc(m.chapter || m.label || '')}</small></button>
      <button class="del" data-del="${i}" aria-label="Delete bookmark">✕</button></div>`).join('')
      : '<div class="none">No bookmarks yet. Tap ☆ at the top while reading to add one.</div>';
    $$('#markList [data-go]').forEach((b) => {
      b.onclick = async () => {
        const m = marks[b.dataset.go];
        this.closePanels(); this.toggleUi(false);
        // A PDF bookmark made in the other view mode still works through its page number.
        const loc = this.reader instanceof PdfPageReader && m.loc.s != null ? { page: m.loc.page }
          : this.reader instanceof TextReader && this.reader.src.pdf && m.loc.s == null ? this.reader.src.toLoc(m.loc.page) : m.loc;
        await this.reader.goTo(loc);
        this.onRelocated();
      };
    });
    $$('#markList [data-del]').forEach((b) => {
      b.onclick = () => { marks.splice(Number(b.dataset.del), 1); this.saveMeta(); this.renderMarks(); this.onRelocated(); };
    });
  },

  /* ---------------- read aloud ---------------- */
  async startTts() {
    if (!Native.canSpeak()) { toast('Text-to-speech is not available. Install or enable a voice in Android settings.'); return; }
    this.tts = true;
    $('#ttsBtn').innerHTML = '<span>⏸</span>Stop listening';
    $('#ttsBtn').classList.add('on');
    this.toggleUi(false);
    this.speakPage();
  },
  async speakPage() {
    if (!this.tts || !this.reader) return;
    const text = await this.reader.visibleText();
    if (!this.tts) return;
    Native.speak(text || ' ', this.settings.ttsRate);
  },
  async onSpeechDone() {
    if (!this.tts || !this.reader) return;
    const more = await this.reader.next();
    if (!more) { this.stopTts(); toast('Finished reading'); return; }
    setTimeout(() => this.speakPage(), 250);
  },
  stopTts() {
    if (!this.tts) return;
    this.tts = false;
    Native.stopSpeaking();
    $('#ttsBtn').innerHTML = '<span>🔊</span>Listen';
    $('#ttsBtn').classList.remove('on');
  },

  /* ---------------- settings ---------------- */
  bindSettings() {
    $$('#themeSwatches button, #themeSwatches2 button').forEach((b) => { b.onclick = () => this.set('theme', b.dataset.theme); });
    $$('#accentPicker button').forEach((b) => { b.onclick = () => this.set('accent', b.dataset.accent); });
    $$('[data-step]').forEach((b) => {
      b.onclick = () => this.set(b.dataset.step, clamp(this.settings[b.dataset.step] + Number(b.dataset.d), 12, 40));
    });
    $$('.seg[data-setting]').forEach((seg) => {
      seg.querySelectorAll('button').forEach((b) => { b.onclick = () => this.set(seg.dataset.setting, b.dataset.v); });
    });
    $$('input[type=range][data-setting]').forEach((r) => {
      r.oninput = () => this.set(r.dataset.setting, Number(r.value), true);
      r.onchange = () => this.set(r.dataset.setting, Number(r.value));
    });
    $$('input[type=checkbox][data-setting]').forEach((c) => { c.onchange = () => this.set(c.dataset.setting, c.checked); });
    $('#autoBright').onclick = () => this.set('brightness', null);
  },

  /** live = still dragging a slider: update the cheap things now, re-layout when it is let go. */
  set(key, value, live) {
    const old = this.settings[key];
    this.settings[key] = value;
    store.set('er.settings', this.settings);
    this.applySettings();
    if (live || old === value || !this.reader) return;
    const layoutKeys = ['fontSize', 'font', 'lineHeight', 'margin', 'flow', 'pdfTrim', 'measure', 'frame'];
    if (key === 'pdfMode') {
      if (this.meta) this.meta.ocr = false;
      const l = this.reader.location().loc;
      busy(true, value === 'reflow' ? 'Extracting text…' : 'Rendering pages…');
      this.makePdfReader({ page: l.page }).then(() => { busy(false); this.onRelocated(); });
    } else if (layoutKeys.includes(key) || (key === 'theme' && this.reader instanceof EpubReader)) {
      clearTimeout(this._relayout);
      this._relayout = setTimeout(() => Promise.resolve(this.reader && this.reader.apply(this.settings)).then(() => this.onRelocated()), 150);
    }
  },

  applySettings() {
    const s = this.settings;
    const root = document.documentElement.style;
    document.body.dataset.theme = s.theme;
    document.body.dataset.accent = s.accent;
    document.body.classList.toggle('funky', s.ui === 'funky');
    document.body.classList.toggle('flow-scroll', s.flow === 'scroll');
    if (this.reader) Native.setSecure && Native.setSecure(!!s.protect);
    document.body.classList.toggle('frame-on', !!s.frame);
    root.setProperty('--rd-maxw', Number(s.measure) ? `calc(${s.measure}ch + ${s.frame ? 34 : 0}px)` : 'none');
    root.setProperty('--rd-size', s.fontSize + 'px');
    root.setProperty('--rd-lh', s.lineHeight);
    root.setProperty('--rd-margin', s.margin + 'px');
    root.setProperty('--rd-font', FONTS[s.font] || FONTS.serif);
    $('#warmth').style.opacity = s.warmth;
    $('#fontSizeVal').textContent = s.fontSize;
    $$('#themeSwatches button, #themeSwatches2 button').forEach((b) => b.classList.toggle('on', b.dataset.theme === s.theme));
    $$('#accentPicker button').forEach((b) => b.classList.toggle('on', b.dataset.accent === s.accent));
    $$('.seg[data-setting]').forEach((seg) => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(s[seg.dataset.setting]))));
    $$('input[type=range][data-setting]').forEach((r) => {
      const v = s[r.dataset.setting];
      r.value = v == null ? r.max : v;
    });
    $$('input[type=checkbox][data-setting]').forEach((c) => { c.checked = !!s[c.dataset.setting]; });
    $('#autoBright').classList.toggle('on', s.brightness == null);
    Native.setBarColor(BAR_COLORS[s.theme], !['dusk', 'night'].includes(s.theme));
    Native.setVolumeKeys(!!s.volumeKeys);
    const reading = !!this.reader || !$('#reader').classList.contains('hidden');
    Native.setKeepScreenOn(reading && !!s.keepAwake);
    Native.setFullscreen(reading && !!s.fullscreen);
    Native.setBrightness(reading && s.brightness != null ? s.brightness : -1);
  },
};

window.App = App;
/*
 * Eye care. Counts only real reading time (the book is open, the screen is on, you touched it in the
 * last 3 minutes, and Kitab is not reading aloud). Every few minutes it suggests a 20-second break.
 * Skip it twice and, if "Insist" is on, the next reminder closes the book for a short rest.
 */
const EyeCare = {
  LINES: [
    'Your eyes read every word for you. Give them twenty seconds.',
    'Look at something far away. The story will wait.',
    'Good stories wait. Good eyes last a lifetime.',
    'Blink, breathe, look far. The book will be right here.',
    'You only get one pair of eyes. Rest them a moment.',
    'Every chapter feels better with rested eyes.',
    'Find the farthest thing you can see and look at it.',
  ],
  state: Object.assign({ active: 0, skips: 0, at: 0, restUntil: 0 }, store.get('er.eye', {})),
  lastInput: Date.now(),
  showing: false,

  save() { this.state.at = Date.now(); store.set('er.eye', this.state); },
  touch() { this.lastInput = Date.now(); },
  resting() { return Date.now() < (this.state.restUntil || 0); },

  start() {
    if (Date.now() - (this.state.at || 0) > 5 * 60000) { this.state.active = 0; this.state.skips = 0; }  // a real break happened
    document.addEventListener('touchstart', () => this.touch(), { passive: true });
    document.addEventListener('keydown', () => this.touch());
    setInterval(() => this.tick(), 5000);
    $('#ebStart').onclick = () => this.rest(20, false);
    $('#ebSkip').onclick = () => this.skip();
  },

  tick() {
    const every = Number(App.settings.eyeEvery) * 60000;
    if (!App.reader || document.hidden || this.showing || App.tts) return;
    const idle = Date.now() - this.lastInput;
    if (idle > 5 * 60000) { this.state.active = 0; this.state.skips = 0; this.save(); return; }  // looked away long enough
    if (idle < 3 * 60000) this.state.active += 5000;
    this.save();
    if (every && this.state.active >= every) this.prompt();
  },

  line() { return this.LINES[Math.floor(Math.random() * this.LINES.length)]; },

  open(title, actions) {
    this.showing = true;
    $('#ebTitle').textContent = title;
    $('#ebLine').textContent = this.line();
    $('#ebActions').classList.toggle('hidden', !actions);
    $('#ebCount').classList.add('hidden');
    $('#eyeBreak').classList.remove('hidden');
  },

  close() {
    this.showing = false;
    clearInterval(this.countTimer);
    $('#eyeBreak').classList.add('hidden');
  },

  prompt() {
    if (App.settings.eyeInsist && this.state.skips >= 2) return this.insist();
    const mins = Math.round(this.state.active / 60000);
    this.open(`You've been reading for ${mins} minutes`, true);
    $('#ebSkip').textContent = this.state.skips === 1 && App.settings.eyeInsist ? 'Last 5 minutes' : '5 more minutes';
  },

  skip() {
    this.state.skips++;
    this.state.active = Math.max(0, Number(App.settings.eyeEvery) * 60000 - 5 * 60000);   // ask again in 5 minutes
    this.save();
    this.close();
  },

  /** A countdown ring; when it ends the break counts as taken. */
  countdown(secs, label, done) {
    $('#ebActions').classList.add('hidden');
    $('#ebCount').classList.remove('hidden');
    const ring = $('#ebRing'), len = 2 * Math.PI * 44;
    ring.style.strokeDasharray = len;
    let left = secs;
    const draw = () => { $('#ebNum').textContent = left; ring.style.strokeDashoffset = len * (1 - left / secs); $('#ebTitle').textContent = label(left); };
    draw();
    clearInterval(this.countTimer);
    this.countTimer = setInterval(() => { left--; draw(); if (left <= 0) { clearInterval(this.countTimer); done(); } }, 1000);
  },

  rest(secs) {
    this.countdown(secs, () => 'Look far away…', () => {
      this.state.active = 0; this.state.skips = 0; this.save();
      this.close();
      toast('Welcome back 👀');
    });
  },

  insist() {
    this.open('Your eyes need a real rest', false);
    this.countdown(15, (n) => `Closing the book in ${n}`, () => {
      this.state.active = 0; this.state.skips = 0;
      this.state.restUntil = Date.now() + Number(App.settings.eyeRest) * 60000;
      this.save();
      this.close();
      App.closeBook();
      this.showRest();
    });
  },

  /** While resting, books stay closed; the rest of the app works. */
  showRest() {
    this.open('Resting your eyes', false);
    $('#ebCount').classList.remove('hidden');
    const tick = () => {
      const left = Math.max(0, Math.ceil(((this.state.restUntil || 0) - Date.now()) / 1000));
      $('#ebNum').textContent = left >= 60 ? Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') : left;
      $('#ebTitle').textContent = left ? 'Books open again in a moment' : 'Ready when you are';
      if (!left) { clearInterval(this.countTimer); setTimeout(() => this.close(), 1200); }
    };
    tick();
    clearInterval(this.countTimer);
    this.countTimer = setInterval(tick, 1000);
    $('#eyeBreak').onclick = (e) => { if (e.target.id === 'eyeBreak') this.close(); };   // tap outside to dismiss the reminder, the lock stays
  },
};

document.addEventListener('DOMContentLoaded', () => { App.init(); EyeCare.start(); });
