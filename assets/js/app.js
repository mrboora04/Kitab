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
    try { Object.keys(localStorage).filter((k) => k.startsWith('er.ocr.')).forEach((k) => localStorage.removeItem(k)); } catch (e) { /* older, lower-quality scans are re-read */ }
    this.applySettings(true);
    this.bindLibrary();
    this.bindReader();
    this.bindSettings();
    this.renderLibrary();
  },

  bookKey(name) { return 'er.book.' + name; },
  bookMeta(name) { return store.get(this.bookKey(name), { title: prettyName(name), bookmarks: [] }); },
  saveMeta() { if (this.name && this.meta) store.set(this.bookKey(this.name), this.meta); },

  /* ---------------- library ---------------- */
  bindLibrary() {
    $('#addBtn').onclick = () => Native.pickBook();
  },

  books() {
    let list = [];
    try { list = JSON.parse(Native.listBooks()); } catch (e) { /* none */ }
    return list.map((b) => Object.assign(b, { meta: this.bookMeta(b.name) }))
      .sort((a, b) => (b.meta.lastRead || b.added || 0) - (a.meta.lastRead || a.added || 0));
  },

  coverHtml(b) {
    const m = b.meta;
    const [c1, c2] = hashColor(b.name);
    const pct = Math.round((m.progress || 0) * 100);
    const inner = m.cover
      ? `<img src="${m.cover}" alt="">`
      : `<div class="gen"><span class="type">${extOf(b.name).toUpperCase()}</span><span>${esc(m.title || prettyName(b.name))}</span><span class="type">${esc(m.author || '')}</span></div>`;
    return `<div class="cover" style="--c1:${c1};--c2:${c2}">${inner}${pct ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}</div>`;
  },

  renderLibrary() {
    const books = this.books();
    $('#emptyState').classList.toggle('hidden', books.length > 0);
    $('#libCount').textContent = books.length ? `${books.length} book${books.length > 1 ? 's' : ''}` : 'Your books';
    const last = books.find((b) => b.meta.lastRead);
    $('#continueWrap').innerHTML = last ? `
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
    $$('[data-open]').forEach((el) => { el.onclick = () => this.openBook(el.dataset.open); });
    $$('[data-menu]').forEach((el) => { el.onclick = (e) => { e.stopPropagation(); this.bookMenu(el.dataset.menu, el); }; });
  },

  bookMenu(name, anchor) {
    document.querySelectorAll('.menu').forEach((m) => m.remove());
    const m = document.createElement('div');
    m.className = 'menu';
    m.innerHTML = '<button data-a="open">Open</button><button data-a="reset">Mark as unread</button><button data-a="del" class="danger">Remove from library</button>';
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 10) + 'px';
    m.style.left = Math.max(10, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 10)) + 'px';
    const close = () => { m.remove(); document.removeEventListener('click', close, true); };
    setTimeout(() => document.addEventListener('click', close, true));
    m.onclick = (e) => {
      const a = e.target.dataset.a;
      if (a === 'open') this.openBook(name);
      if (a === 'reset') { const meta = this.bookMeta(name); delete meta.loc; meta.progress = 0; delete meta.lastRead; store.set(this.bookKey(name), meta); this.renderLibrary(); }
      if (a === 'del' && confirm(`Remove “${prettyName(name)}” from Easy Reader? The original file on your phone is not touched.`)) {
        Native.deleteBook(name);
        store.del(this.bookKey(name));
        store.del('er.locs.' + name);
        this.renderLibrary();
      }
    };
  },

  /* Called from Java */
  onImportStarted() { busy(true, 'Adding book…'); },
  onImported(name) {
    busy(false);
    if (name) this.openBook(name);
    else this.renderLibrary();
  },

  /* ---------------- reader ---------------- */
  async openBook(name) {
    if (this.reader) await this.closeBook(true);
    busy(true, 'Opening…');
    this.name = name;
    this.meta = this.bookMeta(name);
    const type = extOf(name);
    const url = 'books/' + encodeURIComponent(name);
    document.body.classList.toggle('is-pdf', type === 'pdf');
    document.body.classList.toggle('is-epub', type === 'epub');
    $('#library').classList.add('hidden');
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
        if (this.reader.title) this.meta.title = this.reader.title;
        if (this.reader.author) this.meta.author = this.reader.author;
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
    $('#zoomBox').classList.toggle('hidden', reflow);
    $('#ocrBtn').classList.toggle('on', ocr);
    $('#ocrBtn').textContent = ocr ? '📄 Original' : '📝 Scan text';
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
      $('#library').classList.remove('hidden');
      this.renderLibrary();
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
    $('#ttsBtn').onclick = () => (this.tts ? this.stopTts() : this.startTts());
    $('#ocrBtn').onclick = () => this.toggleOcr();
    $('#ocrBtn2').onclick = () => { this.closePanels(); this.toggleOcr(true); };
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
    $('#ttsBtn').textContent = '⏸ Stop';
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
    $('#ttsBtn').textContent = '🔊 Listen';
    $('#ttsBtn').classList.remove('on');
  },

  /* ---------------- settings ---------------- */
  bindSettings() {
    $$('#themeSwatches button').forEach((b) => { b.onclick = () => this.set('theme', b.dataset.theme); });
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
    document.body.classList.toggle('flow-scroll', s.flow === 'scroll');
    document.body.classList.toggle('frame-on', !!s.frame);
    root.setProperty('--rd-maxw', Number(s.measure) ? `calc(${s.measure}ch + ${s.frame ? 34 : 0}px)` : 'none');
    root.setProperty('--rd-size', s.fontSize + 'px');
    root.setProperty('--rd-lh', s.lineHeight);
    root.setProperty('--rd-margin', s.margin + 'px');
    root.setProperty('--rd-font', FONTS[s.font] || FONTS.serif);
    $('#warmth').style.opacity = s.warmth;
    $('#fontSizeVal').textContent = s.fontSize;
    $$('#themeSwatches button').forEach((b) => b.classList.toggle('on', b.dataset.theme === s.theme));
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
App.init();
