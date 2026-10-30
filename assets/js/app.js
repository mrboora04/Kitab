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

const SUGGESTIONS = [
  ['Pride and Prejudice', 'Jane Austen'], ['Frankenstein', 'Mary Shelley'], ['Moby Dick', 'Herman Melville'], ['Dracula', 'Bram Stoker'],
  ["Alice's Adventures in Wonderland", 'Lewis Carroll'], ['The Adventures of Sherlock Holmes', 'Arthur Conan Doyle'], ['Little Women', 'Louisa May Alcott'],
  ['The Great Gatsby', 'F. Scott Fitzgerald'], ['Jane Eyre', 'Charlotte Brontë'], ['Wuthering Heights', 'Emily Brontë'], ['A Tale of Two Cities', 'Charles Dickens'],
  ['The Picture of Dorian Gray', 'Oscar Wilde'], ['The Odyssey', 'Homer'], ['Meditations', 'Marcus Aurelius'], ['The Art of War', 'Sun Tzu'],
  ['The Count of Monte Cristo', 'Alexandre Dumas'], ['Crime and Punishment', 'Fyodor Dostoyevsky'], ['Les Misérables', 'Victor Hugo'],
  ['The Time Machine', 'H. G. Wells'], ['Treasure Island', 'Robert Louis Stevenson'], ['Peter Pan', 'J. M. Barrie'], ['The Jungle Book', 'Rudyard Kipling'],
  ['Siddhartha', 'Hermann Hesse'], ['Gitanjali', 'Rabindranath Tagore'], ['The Prophet', 'Kahlil Gibran'], ['Anne of Green Gables', 'L. M. Montgomery'],
  ['The Secret Garden', 'Frances Hodgson Burnett'], ['Emma', 'Jane Austen'], ['Great Expectations', 'Charles Dickens'], ['The Call of the Wild', 'Jack London'],
  ['Heart of Darkness', 'Joseph Conrad'], ['The Metamorphosis', 'Franz Kafka'], ['Don Quixote', 'Miguel de Cervantes'], ['Walden', 'Henry David Thoreau'],
];

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
    OCR.onChange = (label) => this.showScanState(label);
    // finish scanning a book that was not done when the app was last closed
    setTimeout(() => {
      const todo = this.books().find((b) => b.meta.scanAll && !b.meta.scanComplete);
      if (todo) BookScanner.start(todo.name, 1);
    }, 4000);
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
    this.renderSuggestions();
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
        ${b.meta.scanAll && !b.meta.scanComplete && b.meta.scanTotal ? `<div class="meta scan">📝 Text ${Math.round((b.meta.scanDone || 0) / b.meta.scanTotal * 100)}%</div>` : ''}
      </div>`).join('');
    $$('#pane-library [data-open]').forEach((el) => { el.onclick = () => this.openBook(el.dataset.open); });
    $$('#pane-library [data-menu]').forEach((el) => { el.onclick = (e) => { e.stopPropagation(); this.bookMenu(el.dataset.menu, el); }; });
  },

  /** Floating book ideas: free classics drifting by; tap one to find it in Project Gutenberg. */
  renderSuggestions() {
    const ideas = SUGGESTIONS.slice().sort(() => Math.random() - 0.5).slice(0, 14);
    const chip = ([t, a]) => `<button class="idea" data-q="${esc(t)}"><b>${esc(t)}</b><small>${esc(a)}</small></button>`;
    $('#suggestTrack').innerHTML = '<span class="idea-lead">Try a classic →</span>' + ideas.map(chip).join('') + ideas.map(chip).join('');   // twice, for a seamless loop
    $$('#suggestTrack .idea').forEach((b) => {
      b.onclick = () => { this.showTab('browse'); Browse.searchIn('gutenberg', b.dataset.q); };
    });
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
          if (BookScanner.book === name) BookScanner.stop();
          Native.deleteBook(name);
          ScanStore.clear(name);
          store.del(this.bookKey(name));
          store.del('er.locs.' + name);
          this.renderLibrary();
        }
      });
  },

  /** In-app dialog. Resolves to true / the typed text / null when cancelled. */
  dialog({ title, message, input, ok, danger, login, type }) {
    return new Promise((resolve) => {
      const d = $('#dialog');
      $('#dlgTitle').textContent = title || '';
      $('#dlgMsg').textContent = message || '';
      const field = $('#dlgInput'), pass = $('#dlgPass');
      field.classList.toggle('hidden', input == null && !login);
      field.value = input || '';
      field.type = login ? 'text' : (type || 'url');
      field.placeholder = login ? 'Email or username' : '';
      pass.classList.toggle('hidden', !login);
      pass.value = '';
      const okBtn = $('#dlgOk');
      okBtn.textContent = ok || 'OK';
      okBtn.classList.toggle('danger', !!danger);
      d.classList.remove('hidden');
      if (input != null || login) setTimeout(() => { field.focus(); field.select(); }, 50);
      const done = (v) => { d.classList.add('hidden'); okBtn.onclick = $('#dlgCancel').onclick = null; this._dialogOpen = false; resolve(v); };
      this._dialogOpen = () => done(null);
      okBtn.onclick = () => done(login ? { user: field.value.trim(), pass: pass.value } : input != null ? field.value : true);
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
        if (this.meta.ocr) { this.meta.pdfMode = 'reflow'; delete this.meta.ocr; }      // from older versions
        if (this.meta.scanned == null) this.meta.scanned = await pdfLooksScanned(this.pdf);
        // a scanned book stays on the original pages until its text is complete; the scan starts by itself
        if (this.meta.scanned && !this.meta.scanComplete) this.meta.pdfMode = 'page';
        this.settings.pdfMode = this.meta.pdfMode || 'page';                            // each PDF remembers its view
        this.applySettings();
        await this.makePdfReader(this.meta.loc);
        if (!this.meta.cover) this.pdfCover();
        if (this.meta.scanned && !this.meta.scanComplete) setTimeout(() => this.name === name && BookScanner.start(name, this.reader.location().loc.page || 1), 1500);
        this.showScanState(OCR.current && OCR.current.label);
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
    const reflow = this.settings.pdfMode === 'reflow';
    document.body.classList.toggle('pdf-reflow', reflow);
    if (reflow) {
      const src = await pdfTextSource(this.pdf, {
        scanned: !!this.meta.scanned, key: this.name,
        onStatus: () => {},           // scanning never blocks the screen; progress is shown in Aa
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
    if (this.name) OCR.cancel(this.name + ':', 'reader');   // the background scan of the whole book keeps going
    this.stopTts();
    if (this.hlMode) this.toggleHl(false);
    $('#lookup').classList.add('hidden');
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
    clearTimeout(this._save);
    this._save = setTimeout(() => this.saveNow(), 800);
  },

  /* ---------------- navigation & gestures ---------------- */
  onTap(x, e) {
    if (!$('#lookup').classList.contains('hidden')) { $('#lookup').classList.add('hidden'); return; }
    if (this.hlBarOpen()) return this.hideHlBar(true);
    if (this.panelOpen()) return this.closePanels();
    if (e && this.reader && this.reader.markAt) {                              // a tap on a highlight edits it
      const m = this.reader.markAt(e.clientX, e.clientY);
      if (m) return this.editHighlight(m.id, m.rect);
    }
    if (this.hlMode && e && this.reader && this.reader.selectAt) {             // select mode: a tap selects the sentence
      this.reader.selectAt(e.clientX, e.clientY);
      return;
    }
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
    $('#hlBtn').onclick = () => this.toggleHl();
    document.addEventListener('selectionchange', () => {      // a finished selection in the text view opens the colour bar
      if (!(this.reader instanceof TextReader)) return;
      clearTimeout(this._selT);
      this._selT = setTimeout(() => {
        const info = this.reader && this.reader.selectionInfo && this.reader.selectionInfo();
        if (info) this.showHlBar(info.rect, { h: info.h });
        else if (this.hlState && this.hlState.h) this.hideHlBar();
      }, 350);
    });
    this.bindHlBar();
    // reading tools live in the settings sheet; they close it so you land back on the page
    $('#ttsBtn').onclick = () => { if (this.tts) this.stopTts(); else { this.closePanels(); this.startTts(); } };
    $('#zoomIn').onclick = () => this.zoom(0.25);
    $('#zoomOut').onclick = () => this.zoom(-0.25);
    document.addEventListener('keydown', (e) => {
      if ($('#reader').classList.contains('hidden')) return;
      if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); this.turn(1); }
      if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); this.turn(-1); }
    });
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
    this.renderHighlights();
    const curBtn = $('#tocList .current');
    if (curBtn) setTimeout(() => curBtn.scrollIntoView({ block: 'center' }), 50);
  },

  /* ---------------- scanning in the background ---------------- */
  onScanSlow() {
    clearTimeout(this._scanT);
    if ($('#busy').classList.contains('hidden')) return;
    busy(false);
    toast('Still scanning in the background. You can keep reading; progress is in Aa.', 4000);
  },

  /** Aa shows what the scanner is doing: "Scanning page 12 · 2 waiting", or nothing when it is idle. */
  showScanState(label) {
    const el = $('#scanState');
    if (!el) return;
    const m = this.meta;
    const total = m && m.scanTotal, done = m && m.scanDone;
    const book = total ? (done >= total ? '✓ The whole book is saved as text' : `Text ready for ${done} of ${total} pages`) : '';
    // "Text only" stays greyed out until every page of a scanned book has its text
    const btn = $('.seg[data-setting="pdfMode"] button[data-v="reflow"]');
    if (btn) {
      const waiting = !!(m && m.scanned && !m.scanComplete);
      btn.classList.toggle('disabled', waiting);
      btn.setAttribute('aria-disabled', waiting);
      btn.textContent = waiting ? `Text ${total ? Math.round((done || 0) / total * 100) : 0}%` : 'Text only';
    }
    el.classList.toggle('hidden', !label && !book);
    el.innerHTML = (label && !(done >= total) ? '<span class="mini-spin"></span>' : '') +
      `<span>${label ? `Scanning ${esc(label)}${book ? ' · ' : ''}` : ''}${book}</span>` +
      (total && done < total ? `<i class="scanbar"><b style="width:${Math.round(done / total * 100)}%"></b></i>` : '');
  },

  /** Called by the background scanner after each page. */
  onBookScan(name, done, total, finished) {
    const meta = name === this.name ? this.meta : this.bookMeta(name);
    meta.scanDone = done;
    meta.scanTotal = total;
    if (finished) meta.scanComplete = done >= total;
    store.set(this.bookKey(name), meta);
    if (name === this.name) this.showScanState(OCR.current && OCR.current.label);
    if (finished && done >= total) toast(`“${meta.title || prettyName(name)}” is ready: Aa → Text only is now available.`, 4500);
    if (!this.reader && this.tab === 'library' && (finished || done % 5 === 0)) this.renderLibrary();
  },

  /* ---------------- highlights ---------------- */
  hlMode: false,
  highlights() { return (this.meta && this.meta.highlights) || []; },

  toggleHl(force) {
    const on = force != null ? force : !this.hlMode;
    if (on && !(this.reader instanceof TextReader || this.reader instanceof EpubReader)) {
      toast(this.meta && this.meta.scanned && !this.meta.scanComplete
        ? 'Select works in Text only, which lights up in Aa when your scan is done.'
        : 'To select text, open Aa and choose Text only.', 4000);
      return;
    }
    this.hlMode = on;
    $('#hlBtn').classList.toggle('on', on);
    document.body.classList.toggle('hl-mode', on);
    if (!on) this.hideHlBar(true);
    if (on) { this.toggleUi(false); toast('Tap a sentence to select it. Press and hold to pick your own words.', 3500); }
  },

  /* The colour bar: shown over a new selection, or over a highlight that was tapped. */
  hlState: null,
  hlBarOpen() { return !$('#hlBar').classList.contains('hidden'); },

  showHlBar(rect, state) {
    const bar = $('#hlBar');
    this.hlState = state;
    bar.classList.toggle('fresh', !state.id);
    const cur = state.id ? (this.highlights().find((x) => x.id === state.id) || {}).c || 'y' : '';
    bar.querySelectorAll('.c').forEach((b) => b.classList.toggle('on', b.dataset.c === cur));
    bar.classList.remove('hidden');
    const w = bar.offsetWidth, h = bar.offsetHeight;
    const r = rect || { top: innerHeight / 2, bottom: innerHeight / 2, left: innerWidth / 2, right: innerWidth / 2 };
    // select mode: above the words, like Apple Books. After a press-and-hold the phone's own menu is above them, so go below
    let top = this.hlMode && !state.id ? r.top - h - 12 : r.bottom + 34;
    if (top < 70) top = r.bottom + 34;
    if (top + h > innerHeight - 12) top = Math.max(70, r.top - h - 14);
    bar.style.top = top + 'px';
    bar.style.left = clamp((r.left + r.right) / 2 - w / 2, 8, innerWidth - w - 8) + 'px';
  },

  hideHlBar(clear) {
    $('#hlBar').classList.add('hidden');
    if (clear && this.reader && this.reader.clearSelection) this.reader.clearSelection();
    this.hlState = null;
  },

  editHighlight(id, rect) { this.showHlBar(rect, { id }); },

  bindHlBar() {
    const bar = $('#hlBar');
    bar.addEventListener('mousedown', (e) => e.preventDefault());       // keep the text selected while a button is pressed
    bar.querySelectorAll('.c').forEach((b) => {
      b.onclick = () => {
        const st = this.hlState;
        if (!st) return;
        this.lastColour = b.dataset.c;
        store.set('er.hlc', this.lastColour);
        if (st.id) this.recolorHighlight(st.id, b.dataset.c);
        else this.addHighlight(Object.assign({}, st.h, { c: b.dataset.c }));
        this.hideHlBar(true);
      };
    });
    bar.querySelector('[data-a=lookup]').onclick = () => {
      const st = this.hlState;
      const text = st && (st.id ? (this.highlights().find((x) => x.id === st.id) || {}).text : st.h.text);
      this.hideHlBar(true);
      if (text) this.lookUp(text);
    };
    bar.querySelector('[data-a=copy]').onclick = () => {
      const st = this.hlState;
      const text = st && (st.id ? (this.highlights().find((x) => x.id === st.id) || {}).text : st.h.text);
      this.hideHlBar(false);
      if (!text) return;
      const done = () => toast('Copied');
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => toast('Could not copy'));
      else { try { document.execCommand('copy'); done(); } catch (e) { toast('Could not copy'); } }
      this.reader && this.reader.clearSelection && this.reader.clearSelection();
    };
    bar.querySelector('[data-a=note]').onclick = async () => {
      const st = this.hlState;
      if (!st) return;
      const old = st.id ? this.highlights().find((x) => x.id === st.id) : null;
      this.hideHlBar(false);
      const note = await this.dialog({ title: 'Note', message: (old ? old.text : st.h.text).slice(0, 90), input: (old && old.note) || '', ok: 'Save', type: 'text' });
      if (note == null) return;
      if (old) { old.note = note.trim(); this.saveMeta(); }
      else this.addHighlight(Object.assign({}, st.h, { c: this.lastColour || 'y', note: note.trim() }));
      this.reader && this.reader.clearSelection && this.reader.clearSelection();
    };
    bar.querySelector('[data-a=del]').onclick = () => {
      const st = this.hlState;
      this.hideHlBar(true);
      if (st && st.id) this.removeHighlight(st.id);
    };
  },

  lastColour: store.get('er.hlc', 'y'),

  /* ---------------- look up: a word's meaning (Wiktionary) and what a name is (Wikipedia) ---------------- */
  lookUp(raw) {
    const term = raw.replace(/^[\s"'“”‘’(\[.,;:!?—–-]+|[\s"'“”‘’)\].,;:!?—–-]+$/g, '').replace(/\s+/g, ' ');
    const sheet = $('#lookup'), body = $('#lkBody');
    $('#lkTitle').textContent = term.length > 40 ? term.slice(0, 38) + '…' : term;
    sheet.classList.remove('hidden');
    $('#lkClose').onclick = () => sheet.classList.add('hidden');
    if (!term || term.split(' ').length > 6) { body.innerHTML = '<p class="note">Select a word or a name to look it up.</p>'; return; }
    body.innerHTML = '<p class="spin">Looking up…</p>';
    const token = (this._lk = {});
    const get = async (url) => { try { return JSON.parse((await Opds.fetchText(url)).body); } catch (e) { if (e.status === 404 || e.status === 400) return null; throw e; } };
    const plain = (html) => new DOMParser().parseFromString(html || '', 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
    const one = !term.includes(' ');
    const dictionary = one ? get('https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(term.toLowerCase())) : Promise.resolve(null);
    const wiki = (async () => {
      let sum = await get('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(term.replace(/ /g, '_')) + '?redirect=true');
      if (!sum || !sum.extract) {
        const f = await get('https://en.wikipedia.org/w/rest.php/v1/search/title?limit=1&q=' + encodeURIComponent(term));
        const hit = f && f.pages && f.pages[0];
        if (hit) sum = await get('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(hit.key) + '?redirect=true');
      }
      return sum && sum.extract ? sum : null;
    })();
    Promise.all([dictionary.catch((e) => ({ error: e })), wiki.catch((e) => ({ error: e }))]).then(([dict, sum]) => {
      if (this._lk !== token) return;
      const err = (dict && dict.error) || (sum && sum.error);
      if (err && !(dict && !dict.error) && !(sum && !sum.error)) { body.innerHTML = `<p>${esc(err.message || 'Could not look that up.')}</p><p class="note">Look up needs an internet connection. Only the word you selected is sent to Wikipedia.</p>`; return; }
      let html = '';
      const lower = one && term === term.toLowerCase();
      const meaning = () => {
        if (!dict || dict.error) return '';
        const parts = (dict.en || []).slice(0, 3);
        if (!parts.length) return '';
        return '<h4>Meaning</h4>' + parts.map((p) => `<div class="pos">${esc(p.partOfSpeech || '')}</div><ol>${(p.definitions || []).slice(0, 3).map((d) => plain(d.definition)).filter(Boolean).map((d) => `<li>${esc(d)}</li>`).join('')}</ol>`).join('');
      };
      const about = () => {
        if (!sum || sum.error) return '';
        const img = sum.thumbnail && sum.thumbnail.source ? `<img class="thumb" src="${esc(sum.thumbnail.source)}" alt="">` : '';
        const link = sum.content_urls && sum.content_urls.desktop && sum.content_urls.desktop.page;
        return `<h4>${lower ? 'On Wikipedia' : 'Wikipedia'}</h4>${img}<p><b>${esc(sum.title || term)}</b>${sum.description ? ' · ' + esc(sum.description) : ''}</p><p>${esc(sum.extract)}</p>${link ? `<a class="more" href="${esc(link)}">Read more on Wikipedia</a>` : ''}`;
      };
      html = lower ? meaning() + about() : about() + meaning();
      body.innerHTML = (html || `<p>Nothing found for “${esc(term)}”.</p>`) + '<p class="note">From Wikipedia and Wiktionary. Only the selected word is sent.</p>';
    });
  },

  recolorHighlight(id, c) {
    const h = this.highlights().find((x) => x.id === id);
    if (!h) return;
    if (this.reader.removeMark) this.reader.removeMark(id);
    h.c = c;
    this.saveMeta();
    this.reader.addMark(h);
  },

  async addHighlight(h) {
    if (!this.meta || !h.text) return;
    const l = this.reader.location();
    h.id = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    h.chapter = l.chapter;
    h.progress = l.progress;
    if (this.reader.src && this.reader.src.pdf) h.page = l.loc.page;
    h.c = h.c || this.lastColour || 'y';
    h.at = Date.now();
    (this.meta.highlights = this.meta.highlights || []).push(h);
    this.meta.highlights.sort((a, b) => a.progress - b.progress);
    this.saveMeta();
    this.reader.addMark(h);
  },

  removeHighlight(id) {
    if (!this.meta) return;
    if (this.reader && this.reader.removeMark) this.reader.removeMark(id);
    this.meta.highlights = this.highlights().filter((h) => h.id !== id);
    this.saveMeta();
    toast('Highlight removed');
  },

  renderHighlights() {
    const list = this.highlights();
    $('#markList').innerHTML = list.length ? list.map((h, i) => `
      <div class="mark"><button data-go="${i}"><q style="--hc:var(--hl-${h.c === 'u' ? 'y' : h.c || 'y'})">${esc(h.text.slice(0, 180))}${h.text.length > 180 ? '…' : ''}</q>${h.note ? `<em>${esc(h.note)}</em>` : ''}<small>${Math.round((h.progress || 0) * 100)}% · ${esc(h.chapter || '')}</small></button>
      <button class="del" data-del="${i}" aria-label="Delete highlight">✕</button></div>`).join('')
      : '<div class="none">No highlights yet. Press and hold a word, or tap the select button at the top.</div>';
    $$('#markList [data-go]').forEach((b) => {
      b.onclick = async () => {
        const h = list[b.dataset.go];
        this.closePanels(); this.toggleUi(false);
        if (h.cfi) await this.reader.goTo({ cfi: h.cfi });
        else if (this.reader instanceof TextReader) await this.reader.goTo({ s: h.s, c: h.a });
        else if (h.page) await this.reader.goTo({ page: h.page });
        this.onRelocated();
      };
    });
    $$('#markList [data-del]').forEach((b) => {
      b.onclick = () => { this.removeHighlight(list[b.dataset.del].id); this.renderHighlights(); };
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
      seg.querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          if (b.classList.contains('disabled')) { toast('Still preparing the text. Keep reading the original; this lights up when every page is ready.', 3500); return; }
          this.set(seg.dataset.setting, b.dataset.v);
        };
      });
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
    if (key === 'ttsRate' && this.tts && !live) { Native.stopSpeaking(); this.speakPage(); }
    if (live || old === value || !this.reader) return;
    const layoutKeys = ['fontSize', 'font', 'lineHeight', 'margin', 'flow', 'pdfTrim', 'measure', 'frame'];
    if (key === 'pdfMode') {
      if (this.meta) { this.meta.pdfMode = value; this.saveMeta(); }
      const l = this.reader.location().loc;
      this.closePanels();
      busy(true, value === 'reflow' ? 'Getting the text…' : 'Showing the pages…');
      this._opening = true;
      this.makePdfReader({ page: l.page })
        .catch((e) => toast('Could not show the text: ' + (e.message || e), 4000))
        .finally(() => { this._opening = false; busy(false); this.toggleUi(false); this.onRelocated(); });
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
    $('#ttsRateLbl').textContent = Number(s.ttsRate).toFixed(1) + '×';
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
/*
 * Scans a whole scanned book once, in the background, from the page you are on to the end and then
 * the start. Every page is saved (ScanStore), so nothing is ever scanned twice. It keeps going when you
 * close the book and picks up again the next time Kitab opens. Pages you are looking at always go first.
 */
const BookScanner = {
  book: null,
  run: null,

  async start(name, fromPage) {
    if (this.book === name && this.run) return;
    this.stop();
    const run = (this.run = {});
    this.book = name;
    // remember "scan this whole book" on the open book too, or saving its reading position would erase it
    const meta = App.name === name && App.meta ? App.meta : App.bookMeta(name);
    if (!meta.scanAll) { meta.scanAll = true; store.set(App.bookKey(name), meta); }
    let pdf;
    try {
      const data = new Uint8Array(await (await fetch('books/' + encodeURIComponent(name))).arrayBuffer());
      pdf = await pdfjsLib.getDocument(Object.assign({ data }, PDF_OPTS)).promise;
    } catch (e) { if (this.run === run) this.run = null; return; }
    const total = pdf.numPages;
    const start = Math.min(Math.max(1, fromPage || 1), total);
    const order = [];
    for (let n = start; n <= total; n++) order.push(n);
    for (let n = 1; n < start; n++) order.push(n);
    const done = () => { let d = 0; for (let n = 1; n <= total; n++) if (ScanStore.get(name, n) != null) d++; return d; };
    let count = done();
    App.onBookScan(name, count, total, false);
    const failed = [];
    for (const pass of [order, failed]) {
      const queue = pass.filter((n) => ScanStore.get(name, n) == null);
      // as many pages at once as the phone can comfortably read
      const lane = async () => {
        while (queue.length && this.run === run) {
          const n = queue.shift();
          const html = await ocrPageHtml(pdf, n, name, () => {}, true, 'bg');
          if (/scan-fail/.test(html)) { if (pass === order) failed.push(n); continue; }
          count++;
          App.onBookScan(name, count, total, false);
          await new Promise((r) => setTimeout(r, 40));        // let the reader breathe between pages
        }
      };
      await Promise.all(Array.from({ length: OCR.size() }, lane));
      if (this.run !== run) { pdf.destroy(); return; }
    }
    pdf.destroy();
    if (this.run !== run) return;
    this.run = null;
    App.onBookScan(name, done(), total, true);
  },

  stop() {
    this.run = null;
    if (this.book) OCR.cancel(this.book + ':', 'bg');
  },
};

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
