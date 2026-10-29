'use strict';
/*
 * Three readers share one small interface used by app.js:
 *   open(loc)            show the book at a saved location (or the start)
 *   next() / prev()      turn a page (or scroll a screen)
 *   goTo(loc)            jump to a location from location(), toc() or a bookmark
 *   goToProgress(f)      jump to a fraction 0..1 of the book
 *   location()           { loc, progress, label, chapter } for the current position
 *   toc()                [{ label, level, loc }]
 *   visibleText()        text on screen, for read-aloud
 *   apply(settings)      re-layout after a settings change
 *   destroy()
 * They call app.onRelocated() whenever the position changes and app.onTap(xFraction)
 * on a tap that is not a text selection.
 */

const FONTS = {
  serif: '"Noto Serif", Georgia, "Times New Roman", serif',
  sans: 'Roboto, "Noto Sans", system-ui, sans-serif',
  mono: '"Roboto Mono", "Droid Sans Mono", "Courier New", monospace',
};
FONTS.casual = '"Coming Soon", casual, "Comic Neue", "Comic Sans MS", cursive';
FONTS.book = FONTS.serif;

pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
// useWorkerFetch: false keeps all loading on the page, where the app's request handler sees it.
const PDF_OPTS = { cMapUrl: 'lib/cmaps/', cMapPacked: true, standardFontDataUrl: 'lib/standard_fonts/', useWorkerFetch: false };

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** Text of a DOM range with a pause after headings and paragraphs, for text-to-speech. */
function rangeText(range) {
  const frag = range.cloneContents();
  frag.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, blockquote, tr, br').forEach((el) => el.after('\n'));
  return frag.textContent.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '.\n').replace(/([.!?:;,])\./g, '$1').replace(/^\.\n/, '').trim();
}
const hasSelection = () => { const s = window.getSelection(); return s && String(s).trim().length > 0; };

/** Wraps a reader's content in the bordered "page" whose look comes from CSS (settings: page frame, line length). */
function makeFrame(stage, inner) {
  const frame = document.createElement('div');
  frame.className = 'page-frame';
  frame.appendChild(inner);
  stage.appendChild(frame);
  return frame;
}

/** Horizontal swipes turn pages; taps go to app.onTap. */
function attachGestures(el, app, canSwipe) {
  let sx = 0, sy = 0, st = 0;
  el.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY; st = Date.now();
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (canSwipe() && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - st < 800) {
      app.onSwipe(dx < 0 ? 1 : -1);
    }
  }, { passive: true });
  el.addEventListener('click', (e) => {
    if (hasSelection() || e.target.closest('a, button, input')) return;
    app.onTap(e.clientX / window.innerWidth);
  });
}

/* ======================================================================
 * TextReader: TXT files and the "Text only" view of PDFs.
 * The book is split into sections (chunks of HTML) so long books stay fast.
 * A location is { s: section, c: character offset in that section }.
 * ==================================================================== */
class TextReader {
  constructor(stage, app, source) {
    this.app = app;
    this.src = source;            // { count, weights[], load(i) -> html, toc[], pdf? }
    this.s = 0;
    this.page = 0;
    this.pages = 1;
    this.GAP = 48;
    this.wrap = document.createElement('div');
    this.tv = document.createElement('div');
    this.tv.className = 'tv';
    this.wrap.appendChild(this.tv);
    this.frame = makeFrame(stage, this.wrap);
    attachGestures(this.frame, app, () => this.paged);
    this.wrap.addEventListener('scroll', () => {
      if (this.paged) return;
      clearTimeout(this._st);
      this._st = setTimeout(() => app.onRelocated(), 120);
    });
    this._resize = () => this.relayout();
    window.addEventListener('resize', this._resize);
    const total = source.weights.reduce((a, b) => a + b, 0) || 1;
    this.before = source.weights.map((_, i) => source.weights.slice(0, i).reduce((a, b) => a + b, 0) / total);
    this.share = source.weights.map((w) => w / total);
  }

  get paged() { return this.app.settings.flow === 'paged'; }

  async open(loc) {
    this.setMode();
    await this.show(loc && loc.s || 0, loc || {});
  }

  setMode() {
    this.wrap.className = 'tv-wrap ' + (this.paged ? 'paged' : 'scroll');
    this.frame.className = 'page-frame ' + (this.paged ? 'paged' : 'scroll');
  }

  async show(s, at) {
    s = clamp(s, 0, this.src.count - 1);
    const token = (this._token = {});
    const html = await this.src.load(s);
    if (token !== this._token) return;
    this.s = s;
    const prevPart = !this.paged && s > 0 ? '<p class="pmark"><button class="chip" data-go="-1">‹ Previous part</button></p>' : '';
    const nextPart = !this.paged && s < this.src.count - 1 ? '<p class="pmark"><button class="chip" data-go="1">Next part ›</button></p>' : '';
    this.tv.innerHTML = prevPart + (html || '<p class="notice">This part has no text.</p>') + '\n<div class="sec-end"></div>' + nextPart;
    this.tv.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => this.show(this.s + Number(b.dataset.go), b.dataset.go < 0 ? { end: true } : {})));
    this._text = null;
    this.layout();
    if (at.end) this.toEnd();
    else if (at.anchor) this.toAnchor(at.anchor);
    else this.toOffset(at.c || 0);
    this.app.onRelocated();
  }

  layout() {
    if (this.paged) {
      const W = this.wrap.clientWidth, H = this.wrap.clientHeight;
      Object.assign(this.tv.style, { width: W + 'px', height: H + 'px', columnWidth: W + 'px', columnGap: this.GAP + 'px', transform: '' });
      this.pageW = W + this.GAP;
      const tvLeft = this.tv.getBoundingClientRect().left;
      const end = this.tv.querySelector('.sec-end').getBoundingClientRect().left;
      this.pages = Math.max(1, Math.floor((end - tvLeft + 1) / this.pageW) + 1);
    } else {
      Object.assign(this.tv.style, { width: '', height: '', columnWidth: '', columnGap: '', transform: '' });
    }
  }

  setPage(n) {
    this.page = clamp(n, 0, this.pages - 1);
    this.tv.style.transform = `translateX(${-this.page * this.pageW}px)`;
  }

  /* --- character offsets <-> DOM positions --- */
  textNodes() {
    const out = [];
    const w = document.createTreeWalker(this.tv, NodeFilter.SHOW_TEXT);
    let n, pos = 0;
    while ((n = w.nextNode())) { out.push([n, pos]); pos += n.length; }
    this._len = pos;
    return out;
  }

  offsetOf(node, off) {
    for (const [n, pos] of this.textNodes()) if (n === node) return pos + off;
    return 0;
  }

  rangeAt(c) {
    const nodes = this.textNodes();
    for (let i = nodes.length - 1; i >= 0; i--) {
      const [n, pos] = nodes[i];
      if (pos <= c && n.data.trim()) {
        const r = document.createRange();
        const o = clamp(c - pos, 0, Math.max(0, n.length - 1));
        r.setStart(n, o); r.setEnd(n, Math.min(n.length, o + 1));
        return r;
      }
    }
    return null;
  }

  caretAt(x, y) {
    const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    if (r && this.tv.contains(r.startContainer) && r.startContainer.nodeType === 3) return r;
    return null;
  }

  /** Character offset of the first word on screen. */
  topOffset() {
    const b = this.wrap.getBoundingClientRect();
    const top = this.paged ? b.top : Math.max(b.top, 0) + 28;
    for (let y = top + 4; y < b.bottom; y += 8) {
      for (const x of [b.left + 4, b.left + b.width / 3, b.left + b.width / 2]) {
        const r = this.caretAt(x, y);
        if (r) return this.offsetOf(r.startContainer, r.startOffset);
      }
    }
    if (this.paged) return this.page === 0 ? 0 : null;
    return null;
  }

  bottomOffset() {
    const b = this.wrap.getBoundingClientRect();
    for (let y = b.bottom - 4; y > b.top; y -= 8) {
      for (const x of [b.right - 4, b.right - b.width / 3, b.left + 4]) {
        const r = this.caretAt(x, y);
        if (r) return this.offsetOf(r.startContainer, r.startOffset);
      }
    }
    return null;
  }

  toOffset(c) {
    const r = this.rangeAt(c);
    if (!r) { this.paged ? this.setPage(0) : (this.wrap.scrollTop = 0); return; }
    this.toRect(r.getBoundingClientRect());
  }

  toRect(rect) {
    if (this.paged) {
      this.tv.style.transform = '';
      const left = this.tv.getBoundingClientRect().left;
      this.setPage(Math.floor((rect.left - left + 2) / this.pageW));
    } else {
      this.wrap.scrollTop += rect.top - this.wrap.getBoundingClientRect().top - 30;
    }
  }

  toAnchor(id) {
    const el = this.tv.querySelector('#' + CSS.escape(id));
    if (!el) return this.toOffset(0);
    if (this.paged) this.tv.style.transform = '';
    this.toRect(el.getBoundingClientRect());
  }

  toEnd() {
    if (this.paged) this.setPage(this.pages - 1);
    else this.wrap.scrollTop = this.wrap.scrollHeight;
  }

  /* --- navigation --- */
  async next() {
    if (this.paged) {
      if (this.page < this.pages - 1) { this.setPage(this.page + 1); this.app.onRelocated(); return true; }
    } else {
      const w = this.wrap;
      if (w.scrollTop + w.clientHeight < w.scrollHeight - 4) { w.scrollBy({ top: w.clientHeight - 60 }); return true; }
    }
    if (this.s < this.src.count - 1) { await this.show(this.s + 1, {}); return true; }
    return false;
  }

  async prev() {
    if (this.paged) {
      if (this.page > 0) { this.setPage(this.page - 1); this.app.onRelocated(); return true; }
    } else if (this.wrap.scrollTop > 0) {
      this.wrap.scrollBy({ top: -(this.wrap.clientHeight - 60) }); return true;
    }
    if (this.s > 0) { await this.show(this.s - 1, { end: true }); return true; }
    return false;
  }

  goTo(loc) { return this.show(loc.s || 0, loc); }

  goToProgress(f) {
    let s = 0;
    while (s < this.src.count - 1 && this.before[s + 1] <= f) s++;
    const inside = this.share[s] ? (f - this.before[s]) / this.share[s] : 0;
    return this.show(s, { frac: inside }).then(() => {
      if (this.paged) this.setPage(Math.round(inside * (this.pages - 1)));
      else this.wrap.scrollTop = inside * (this.wrap.scrollHeight - this.wrap.clientHeight);
      this.app.onRelocated();
    });
  }

  location() {
    let c = this.topOffset();
    if (c == null) c = 0;
    if (this._len == null) this.textNodes();
    const inSection = this.paged
      ? (this.pages > 1 ? this.page / (this.pages - 1) : 0)
      : clamp(this.wrap.scrollTop / Math.max(1, this.wrap.scrollHeight - this.wrap.clientHeight), 0, 1);
    const progress = this.before[this.s] + this.share[this.s] * inSection;
    const loc = { s: this.s, c };
    let label;
    if (this.src.pdf) {
      loc.page = this.pdfPageAt(c);
      label = `Page ${loc.page} of ${this.src.pdf.numPages}`;
    } else {
      label = this.paged ? `Part ${this.s + 1}/${this.src.count} · page ${this.page + 1} of ${this.pages}` : `Part ${this.s + 1} of ${this.src.count}`;
    }
    return (this._last = { loc, progress, label, chapter: this.chapterAt(this.s, c, loc.page) });
  }

  pdfPageAt(c) {
    let page = this.s * this.src.perSection + 1;
    for (const m of this.tv.querySelectorAll('.pmark[id]')) {
      const off = this.offsetOf(m.firstChild, 0);
      if (off <= c + 1) page = Number(m.id.slice(3));
    }
    return page;
  }

  chapterAt(s, c, page) {
    let label = '';
    for (const t of this.src.toc) {
      if (page != null ? t.loc.page > page : t.loc.s > s) break;
      if (page == null && t.loc.s === s && t.loc.anchor) {
        const el = this.tv.querySelector('#' + CSS.escape(t.loc.anchor));
        if (el && el.firstChild && this.offsetOf(el.firstChild, 0) > c + 1) break;
      }
      label = t.label;
    }
    return label;
  }

  toc() { return this.src.toc; }

  async visibleText() {
    if (this._len == null) this.textNodes();
    const a = this.topOffset() || 0;
    let b = this.bottomOffset();
    if (b == null || b <= a) b = a + 1500;
    let text = '';
    for (const [n, pos] of this.textNodes()) {
      const end = pos + n.length;
      if (end <= a || pos >= b + 1) continue;
      text += n.data.slice(Math.max(0, a - pos), Math.min(n.length, b + 1 - pos)) + (n.parentNode.tagName === 'P' ? ' ' : '\n');
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  relayout() {
    const loc = this._last ? this._last.loc : { s: this.s };
    this.setMode();
    this.show(this.s, loc);
  }

  apply() { this.relayout(); }

  destroy() {
    window.removeEventListener('resize', this._resize);
    this._token = null;
    this.frame.remove();
  }
}

/* ---------- TXT source ---------- */
async function textSource(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  if ((text.match(/�/g) || []).length > text.length / 1000) text = new TextDecoder('windows-1252').decode(buf);
  text = text.replace(/\r\n?/g, '\n');

  // Paragraphs: blank-line separated, or one per line when the file has no blank lines.
  let paras = /\n\s*\n/.test(text) ? text.split(/\n\s*\n+/) : text.split('\n');
  paras = paras.map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  const heading = /^(chapter|part|book|prologue|epilogue|introduction|preface|contents)\b.{0,60}$|^[IVXLC]{1,7}\.?$|^\d{1,3}\.?$/i;

  const sections = [], toc = [];
  let cur = [], size = 0;
  const flush = () => { if (cur.length) { sections.push(cur.join('\n')); cur = []; size = 0; } };
  for (const p of paras) {
    const isHead = p.length < 70 && heading.test(p);
    if (isHead && size > 4000) flush();
    if (isHead) {
      const id = 'h' + toc.length;
      toc.push({ label: p, level: 0, loc: { s: sections.length, anchor: id } });
      cur.push(`<h2 id="${id}">${esc(p)}</h2>`);
    } else {
      cur.push(`<p>${esc(p)}</p>`);
    }
    size += p.length;
    if (size > 40000) flush();
  }
  flush();
  if (!sections.length) sections.push('<p class="notice">This file is empty.</p>');
  return { count: sections.length, weights: sections.map((s) => s.length), load: async (i) => sections[i], toc };
}

/* ---------- PDF → reflowable text ---------- */
async function pdfPageHtml(page, n) {
  const tc = await page.getTextContent();
  const lines = [];
  let line = null;
  for (const it of tc.items) {
    if (!('str' in it)) continue;
    const x = it.transform[4], y = it.transform[5], h = Math.abs(it.transform[3]) || it.height || 10;
    if (!line || Math.abs(y - line.y) > h * 0.5) {
      line = { y, x, h, text: '', right: x };
      lines.push(line);
    }
    if (line.text && !line.text.endsWith(' ') && !it.str.startsWith(' ') && x - line.right > h * 0.15) line.text += ' ';
    line.text += it.str;
    line.right = x + (it.width || 0);
    line.h = Math.max(line.h, h);
    if (it.hasEOL) line = null;
  }
  const real = lines.filter((l) => l.text.trim());
  if (!real.length) return '';
  // drop a lone page number at the top or bottom
  const isNum = (l) => /^\s*(page\s*)?\d{1,4}\s*$/i.test(l.text);
  if (isNum(real[real.length - 1])) real.pop();
  if (real.length && isNum(real[0])) real.shift();
  if (!real.length) return '';

  const hs = real.map((l) => l.h).sort((a, b) => a - b);
  const bodyH = hs[Math.floor(hs.length / 2)];
  const gaps = [];
  for (let i = 1; i < real.length; i++) { const g = real[i - 1].y - real[i].y; if (g > 0) gaps.push(g); }
  gaps.sort((a, b) => a - b);
  const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : bodyH * 1.2;
  const minX = Math.min(...real.map((l) => l.x));
  const maxR = Math.max(...real.map((l) => l.right));

  const out = [];
  let para = '';
  const flush = () => { if (para.trim()) out.push(`<p>${esc(para.trim())}</p>`); para = ''; };
  real.forEach((l, i) => {
    const t = l.text.replace(/\s+/g, ' ').trim();
    const prev = real[i - 1];
    if (l.h > bodyH * 1.3 && t.length < 90) { flush(); out.push(`<h2>${esc(t)}</h2>`); return; }
    const bigGap = prev && prev.y - l.y > gap * 1.45;
    const indent = l.x - minX > bodyH * 1.2;
    const prevShort = prev && prev.right < maxR - bodyH * 4 && /[.!?:"”’)]$/.test(prev.text.trim());
    if (bigGap || indent || prevShort) flush();
    if (para.endsWith('-') && /^[a-z]/.test(t)) para = para.slice(0, -1) + t;
    else para += (para ? ' ' : '') + t;
  });
  flush();
  return out.join('\n');
}

async function pdfToc(pdf, toLoc) {
  const toc = [];
  let outline = null;
  try { outline = await pdf.getOutline(); } catch (e) { /* no outline */ }
  async function walk(items, level) {
    for (const it of items || []) {
      try {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (dest && dest[0] != null) {
          const idx = typeof dest[0] === 'object' ? await pdf.getPageIndex(dest[0]) : dest[0];
          toc.push({ label: it.title, level, loc: toLoc(idx + 1) });
        }
      } catch (e) { /* broken link */ }
      if (level < 2) await walk(it.items, level + 1);
    }
  }
  await walk(outline, 0);
  return toc;
}

/** True when the first pages of a PDF carry no real text, i.e. it is a scan. */
async function pdfLooksScanned(pdf) {
  const n = Math.min(pdf.numPages, 4);
  let chars = 0;
  for (let i = 1; i <= n; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    chars += tc.items.reduce((a, it) => a + (it.str || '').trim().length, 0);
  }
  return chars < 30 * n;
}

/** Renders a page as a high-contrast greyscale image and reads it with OCR (results are cached on the phone). */
async function ocrPageHtml(pdf, n, key, onStatus) {
  const ck = `er.ocr3.${key}.${n}`;
  try { const hit = localStorage.getItem(ck); if (hit != null) return hit; } catch (e) { /* no cache */ }
  onStatus(`Scanning page ${n} of ${pdf.numPages}…`);
  const page = await pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(1800 / base.width, 2600 / base.height, 4);  // enough detail for print, light on phone memory
  const vp = page.getViewport({ scale });
  const raw = document.createElement('canvas');
  raw.width = Math.floor(vp.width); raw.height = Math.floor(vp.height);
  const rctx = raw.getContext('2d');
  rctx.fillStyle = '#fff'; rctx.fillRect(0, 0, raw.width, raw.height);
  await page.render({ canvasContext: rctx, viewport: vp }).promise;
  const html = await OCR.pageHtml(raw);  // cleans the page, reads it, rebuilds paragraphs
  try { localStorage.setItem(ck, html); } catch (e) { /* storage full: it will just be scanned again */ }
  return html;
}

/**
 * Text source for a PDF. With opts.ocr every page is read by OCR (scanned books);
 * otherwise the PDF's own text is used. opts.onStatus(msg|null) reports slow work.
 */
async function pdfTextSource(pdf, opts) {
  opts = opts || {};
  const onStatus = opts.onStatus || (() => {});
  const per = opts.ocr ? 1 : 6;
  const count = Math.ceil(pdf.numPages / per);
  const cache = new Map();
  const pending = new Map();
  const toLoc = (page) => ({ s: Math.floor((page - 1) / per), anchor: 'pg-' + page, page });
  const pageHtml = async (n, status) => (opts.ocr ? ocrPageHtml(pdf, n, opts.key, status) : pdfPageHtml(await pdf.getPage(n), n));
  const load = (i, silent) => {
    if (cache.has(i)) return Promise.resolve(cache.get(i));
    if (!pending.has(i)) pending.set(i, build(i, silent).finally(() => pending.delete(i)));
    else if (!silent) { onStatus('Scanning page…'); return pending.get(i).finally(() => onStatus(null)); }
    return pending.get(i);
  };
  const build = async (i, silent) => {
    const status = silent ? () => {} : onStatus;
    const parts = [];
    let words = 0;
    try {
      for (let n = i * per + 1; n <= Math.min(pdf.numPages, (i + 1) * per); n++) {
        const html = await pageHtml(n, status);
        words += html.length;
        parts.push(`<div class="pmark" id="pg-${n}">— ${n} —</div>`, html);
      }
    } finally { status(null); }
    const hint = opts.ocr
      ? 'No readable text was found on this page. It may be blank or a picture.'
      : 'No text found on these pages — this PDF is probably a scan. Tap <b>📝 Scan text</b> at the bottom to read it with OCR.';
    const html = words < 20 ? parts.join('\n') + `<p class="notice">${hint}</p>` : parts.join('\n');
    cache.set(i, html);
    if (cache.size > 8) cache.delete(cache.keys().next().value);
    if (opts.ocr && i + 1 < count) setTimeout(() => load(i + 1, true).catch(() => {}), 50);  // read ahead quietly while you read
    return html;
  };
  return { count, weights: Array.from({ length: count }, (_, i) => Math.min(per, pdf.numPages - i * per)), load: (i) => load(i, false), toc: await pdfToc(pdf, toLoc), pdf, perSection: per, toLoc };
}

/* ======================================================================
 * PdfPageReader: the PDF's original pages, rendered with PDF.js.
 * A location is { page }.
 * ==================================================================== */
class PdfPageReader {
  constructor(stage, app, pdf, outline) {
    this.app = app;
    this.pdf = pdf;
    this.outline = outline;
    this.page = 1;
    this.zoom = 1;
    this.crops = new Map();
    this.wrap = document.createElement('div');
    stage.appendChild(this.wrap);
    attachGestures(this.wrap, app, () => this.paged && this.zoom <= 1);
    this.wrap.addEventListener('scroll', () => {
      if (this.paged) return;
      clearTimeout(this._st);
      this._st = setTimeout(() => this.trackScroll(), 100);
    });
    this._resize = () => this.relayout();
    window.addEventListener('resize', this._resize);
  }

  get paged() { return this.app.settings.flow === 'paged'; }
  get trim() { return this.app.settings.pdfTrim; }

  async open(loc) {
    this.page = clamp(loc && loc.page || 1, 1, this.pdf.numPages);
    this.zoom = loc && loc.zoom || 1;
    this.first = await this.pdf.getPage(1);
    await this.build();
  }

  async build() {
    if (this.io) this.io.disconnect();
    this.wrap.innerHTML = '';
    this.wrap.className = 'pdf-wrap ' + (this.paged ? 'paged' : 'scroll') + (this.zoom > 1 ? ' zoomed' : '');
    if (this.paged) {
      await this.showPage(this.page);
    } else {
      this.wrap.insertAdjacentHTML('beforeend', '<div class="pdf-scroll-pad"></div>');
      const vp = this.first.getViewport({ scale: 1 });
      const w = (this.wrap.clientWidth - 8) * this.zoom;
      this.slots = [];
      for (let n = 1; n <= this.pdf.numPages; n++) {
        const d = document.createElement('div');
        d.className = 'pdf-page';
        d.dataset.n = n;
        d.style.width = w + 'px';
        d.style.height = (w * vp.height / vp.width) + 'px';
        this.wrap.appendChild(d);
        this.slots.push(d);
      }
      this.io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          const n = Number(e.target.dataset.n);
          if (e.isIntersecting) this.renderSlot(n);
          else if (e.target.firstChild) e.target.innerHTML = '';  // free memory for far pages
        }
      }, { root: this.wrap, rootMargin: '150% 0px' });
      this.slots.forEach((s) => this.io.observe(s));
      this.slots[this.page - 1].scrollIntoView();
      this.app.onRelocated();
    }
  }

  /** Bounding box of the non-white area, as fractions of the page. */
  async cropOf(page) {
    if (!this.trim) return { x0: 0, y0: 0, x1: 1, y1: 1 };
    if (this.crops.has(page.pageNumber)) return this.crops.get(page.pageNumber);
    const vp = page.getViewport({ scale: 200 / page.getViewport({ scale: 1 }).width });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i] + d[i + 1] + d[i + 2] < 690) {
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    let crop = { x0: 0, y0: 0, x1: 1, y1: 1 };
    if (x1 - x0 > c.width * 0.2 && y1 - y0 > c.height * 0.2) {
      const px = 6 / c.width, py = 6 / c.height;
      crop = { x0: Math.max(0, x0 / c.width - px), y0: Math.max(0, y0 / c.height - py), x1: Math.min(1, x1 / c.width + px), y1: Math.min(1, y1 / c.height + py) };
    }
    this.crops.set(page.pageNumber, crop);
    return crop;
  }

  /** Renders a page into box, `fit` = 'width' or 'page'. */
  async draw(n, box, fit) {
    const page = await this.pdf.getPage(n);
    const crop = await this.cropOf(page);
    const base = page.getViewport({ scale: 1 });
    const cw = base.width * (crop.x1 - crop.x0), ch = base.height * (crop.y1 - crop.y0);
    const W = this.wrap.clientWidth - (this.paged ? 0 : 8), H = this.wrap.clientHeight;
    let scale = fit === 'page' ? Math.min(W / cw, H / ch) : W / cw;
    scale *= this.zoom;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    let rs = scale * dpr;
    const maxSide = 4096;
    if (cw * rs > maxSide || ch * rs > maxSide) rs = Math.min(maxSide / cw, maxSide / ch);
    const vp = page.getViewport({ scale: rs, offsetX: -crop.x0 * base.width * rs, offsetY: -crop.y0 * base.height * rs });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(cw * rs); canvas.height = Math.floor(ch * rs);
    box.style.width = (cw * scale) + 'px';
    box.style.height = (ch * scale) + 'px';
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const task = page.render({ canvasContext: ctx, viewport: vp });
    box._task = task;
    try { await task.promise; } catch (e) { return; }  // cancelled
    box.innerHTML = '';
    box.appendChild(canvas);
  }

  async showPage(n) {
    this.page = clamp(n, 1, this.pdf.numPages);
    if (this.cur && this.cur._task) this.cur._task.cancel();
    const box = document.createElement('div');
    box.className = 'pdf-page';
    const token = (this._token = {});
    await this.draw(this.page, box, 'page');
    if (token !== this._token) return;
    this.wrap.innerHTML = '';
    this.wrap.appendChild(box);
    this.wrap.scrollTop = 0; this.wrap.scrollLeft = 0;
    this.cur = box;
    this.app.onRelocated();
  }

  async renderSlot(n) {
    const slot = this.slots[n - 1];
    if (slot.firstChild || slot._busy) return;
    slot._busy = true;
    await this.draw(n, slot, 'width');
    slot._busy = false;
  }

  trackScroll() {
    const top = this.wrap.getBoundingClientRect().top + this.wrap.clientHeight / 3;
    for (const s of this.slots) {
      const r = s.getBoundingClientRect();
      if (r.bottom >= top) { this.page = Number(s.dataset.n); break; }
    }
    this.app.onRelocated();
  }

  async next() {
    if (this.paged) {
      if (this.page >= this.pdf.numPages) return false;
      await this.showPage(this.page + 1); return true;
    }
    const w = this.wrap;
    if (w.scrollTop + w.clientHeight >= w.scrollHeight - 4) return false;
    w.scrollBy({ top: w.clientHeight - 60 }); return true;
  }

  async prev() {
    if (this.paged) {
      if (this.page <= 1) return false;
      await this.showPage(this.page - 1); return true;
    }
    if (this.wrap.scrollTop <= 0) return false;
    this.wrap.scrollBy({ top: -(this.wrap.clientHeight - 60) }); return true;
  }

  async goTo(loc) {
    const n = clamp(loc.page || 1, 1, this.pdf.numPages);
    if (this.paged) await this.showPage(n);
    else { this.page = n; this.slots[n - 1].scrollIntoView(); this.app.onRelocated(); }
  }

  goToProgress(f) { return this.goTo({ page: Math.round(f * (this.pdf.numPages - 1)) + 1 }); }

  location() {
    const n = this.pdf.numPages;
    return { loc: { page: this.page, zoom: this.zoom }, progress: n > 1 ? (this.page - 1) / (n - 1) : 0, label: `Page ${this.page} of ${n}`, chapter: this.chapterAt(this.page) };
  }

  chapterAt(page) {
    let label = '';
    for (const t of this.outline) if (t.loc.page <= page) label = t.label;
    return label;
  }

  toc() { return this.outline.map((t) => ({ label: t.label, level: t.level, loc: { page: t.loc.page } })); }

  async visibleText() {
    const page = await this.pdf.getPage(this.page);
    const html = await pdfPageHtml(page, this.page);
    const d = document.createElement('div');
    d.innerHTML = html;
    return Array.from(d.children).map((e) => e.textContent).join('\n');
  }

  setZoom(z) {
    this.zoom = clamp(Math.round(z * 4) / 4, 1, 4);
    this.build();
  }

  relayout() { this.crops.clear(); this.build(); }
  apply() { this.relayout(); }

  destroy() {
    window.removeEventListener('resize', this._resize);
    if (this.io) this.io.disconnect();
    this._token = null;
    this.wrap.remove();
  }
}

/* ======================================================================
 * EpubReader: EPUB books through epub.js. A location is { cfi }.
 * ==================================================================== */
class EpubReader {
  constructor(stage, app, url, name) {
    this.app = app;
    this.url = url;
    this.name = name;
    this.wrap = document.createElement('div');
    this.frame = makeFrame(stage, this.wrap);
    this._resize = () => { clearTimeout(this._rt); this._rt = setTimeout(() => this.relayout(), 250); };
    window.addEventListener('resize', this._resize);
  }

  get paged() { return this.app.settings.flow === 'paged'; }

  async open(loc) {
    const buf = await (await fetch(this.url)).arrayBuffer();
    this.book = ePub(buf);
    await this.book.ready;
    const meta = this.book.packaging.metadata || {};
    this.title = meta.title;
    this.author = meta.creator;
    const flat = [];
    const walk = (items, level) => (items || []).forEach((t) => {
      flat.push({ label: (t.label || '').trim(), level, loc: { href: t.href } });
      if (level < 2) walk(t.subitems, level + 1);
    });
    walk(this.book.navigation.toc, 0);
    this.tocItems = flat;
    await this.render(loc && loc.cfi);
    this.prepareLocations();
  }

  /** Page-accurate percentages need a scan of the whole book; done once in the background and cached. */
  async prepareLocations() {
    const key = 'er.locs.' + this.name;
    let saved = null;
    try { saved = localStorage.getItem(key); } catch (e) { /* ignore */ }
    if (saved) this.book.locations.load(saved);
    else {
      await this.book.locations.generate(1200);
      try { localStorage.setItem(key, this.book.locations.save()); } catch (e) { /* storage full */ }
    }
    this.locsReady = true;
    if (this.rendition) this.app.onRelocated();
  }

  css() {
    const s = this.app.settings, t = getComputedStyle(document.body);
    const fg = t.getPropertyValue('--fg').trim(), accent = t.getPropertyValue('--accent').trim();
    const dark = ['dusk', 'night'].includes(s.theme);
    const font = s.font === 'book' ? '' : `font-family: ${FONTS[s.font]} !important;`;
    return `
      html, body { background: transparent !important; }
      body { color: ${fg} !important; font-size: ${s.fontSize}px !important; line-height: ${s.lineHeight} !important;
             -webkit-hyphens: none; hyphens: none; ${font}
             ${this.paged ? '' : `padding: 28px ${s.margin}px !important; margin: 0 !important;`} }
      ${s.font === 'book' ? '' : `body *:not(pre):not(code):not(kbd) { ${font} }`}
      * { color: inherit !important; background-color: transparent !important; }
      p, li, blockquote, dd, div, span, td { line-height: inherit !important; }
      p, li, blockquote, dd { font-size: 1em !important; text-align: left !important; }
      a, a * { color: ${accent} !important; }
      img, svg, video { max-width: 100% !important; height: auto; ${dark ? 'filter: brightness(.82);' : ''} }
      ::selection { background: ${accent}55; }`;
  }

  style(contents) {
    const doc = contents.document;
    let st = doc.getElementById('er-style');
    if (!st) { st = doc.createElement('style'); st.id = 'er-style'; doc.head.appendChild(st); }
    st.textContent = this.css();
  }

  async render(cfi) {
    if (this.rendition) this.rendition.destroy();
    this.wrap.innerHTML = '';
    this.wrap.className = 'epub-wrap ' + (this.paged ? 'paged' : 'scroll');
    this.frame.className = 'page-frame ' + (this.paged ? 'paged' : 'scroll');
    const opts = this.paged
      ? { width: '100%', height: '100%', flow: 'paginated', spread: 'none', allowScriptedContent: false }
      : { width: '100%', height: '100%', flow: 'scrolled', manager: 'continuous', allowScriptedContent: false };
    const r = (this.rendition = this.book.renderTo(this.wrap, opts));
    r.hooks.content.register((c) => this.style(c));
    r.on('relocated', (l) => { this.loc = l; this.app.onRelocated(); });
    let sx = 0, sy = 0, st = 0;
    r.on('touchstart', (e) => { const t = e.changedTouches[0]; sx = t.screenX; sy = t.screenY; st = Date.now(); });
    r.on('touchend', (e) => {
      const t = e.changedTouches[0], dx = t.screenX - sx, dy = t.screenY - sy;
      if (this.paged && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - st < 800) {
        this._swiped = Date.now();
        this.app.onSwipe(dx < 0 ? 1 : -1);
      }
    });
    r.on('click', (e) => {
      if (Date.now() - (this._swiped || 0) < 400) return;
      const sel = e.view.getSelection();
      if ((sel && String(sel).trim()) || e.target.closest('a')) return;
      const fr = e.view.frameElement.getBoundingClientRect();
      this.app.onTap((e.clientX + fr.left) / window.innerWidth);
    });
    await r.display(cfi || undefined);
  }

  next() { return this.rendition.next().then(() => true); }
  prev() { return this.rendition.prev().then(() => true); }

  goTo(loc) { return this.rendition.display(loc.cfi || loc.href); }

  goToProgress(f) {
    if (this.locsReady && this.book.locations.length()) return this.rendition.display(this.book.locations.cfiFromPercentage(f));
    const items = this.book.spine.spineItems;
    return this.rendition.display(items[Math.round(f * (items.length - 1))].href);
  }

  location() {
    const l = this.loc;
    if (!l) return { loc: {}, progress: 0, label: '', chapter: '' };
    let progress, label;
    const d = l.start.displayed;
    const inChapter = d && d.total ? ` · ${d.page}/${d.total} in chapter` : '';
    if (this.locsReady) {
      progress = this.book.locations.percentageFromCfi(l.start.cfi) || 0;
      const total = this.book.locations.length();
      label = `Page ${Math.min(total, Math.floor(progress * total) + 1)} of ${total}${inChapter}`;
    } else {
      const items = this.book.spine.spineItems.length;
      progress = l.start.index / Math.max(1, items);
      label = (d && d.total ? `Page ${d.page} of ${d.total} in chapter` : '') + ' · counting pages…';
    }
    return { loc: { cfi: l.start.cfi }, progress, label, chapter: this.chapterAt(l.start.href) };
  }

  chapterAt(href) {
    const base = (h) => (h || '').split('#')[0].split('/').pop();
    let best = '';
    for (const t of this.tocItems) if (base(t.loc.href) === base(href)) { best = t.label; break; }
    return best;
  }

  toc() { return this.tocItems; }

  async visibleText() {
    const l = this.loc;
    if (!l) return '';
    try {
      const a = this.rendition.getRange(l.start.cfi), b = this.rendition.getRange(l.end.cfi);
      if (a && b && a.startContainer.ownerDocument === b.startContainer.ownerDocument) {
        const r = a.startContainer.ownerDocument.createRange();
        r.setStart(a.startContainer, a.startOffset);
        r.setEnd(b.endContainer, b.endOffset);
        return rangeText(r);
      }
      if (a) {
        const doc = a.startContainer.ownerDocument, r = doc.createRange();
        r.setStart(a.startContainer, a.startOffset);
        r.setEndAfter(doc.body.lastChild || doc.body);
        return rangeText(r).slice(0, 2500);
      }
    } catch (e) { /* fall through */ }
    return '';
  }

  async cover() {
    try {
      const url = await this.book.coverUrl();
      return url || null;
    } catch (e) { return null; }
  }

  relayout() {
    if (!this.rendition) return;
    const cfi = this.loc && this.loc.start.cfi;
    return this.render(cfi);
  }

  apply() { return this.relayout(); }

  destroy() {
    window.removeEventListener('resize', this._resize);
    if (this.rendition) this.rendition.destroy();
    if (this.book) this.book.destroy();
    this.frame.remove();
  }
}
