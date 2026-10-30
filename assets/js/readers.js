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
/** Load a PDF in pieces (the app serves byte ranges) instead of reading the whole file first. */
const PDF_RANGE = { disableAutoFetch: true };
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
    if ((hasSelection() && !app.hlMode) || e.target.closest('a, button, input')) return;
    app.onTap(e.clientX / window.innerWidth, e);
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
    this.tv.addEventListener('click', (e) => {   // "Try again" on a page that could not be scanned
      const b = e.target.closest('[data-retry]');
      if (!b) return;
      e.stopPropagation();
      if (this.src.forget) this.src.forget(this.s);
      this.show(this.s, { c: 0 });
    });
    this.wrap.addEventListener('scroll', () => {
      if (this.paged) return;
      this.fill();                                   // keep the parts above and below loaded: one long scroll
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

  /* A book is split into parts ("sections"). Paged mode shows one part; scroll mode strings several together. */
  secHtml(s, html) {
    return `<div class="sec" data-s="${s}">${html || '<p class="notice">This part has no text.</p>'}\n<div class="sec-end"></div></div>`;
  }

  async show(s, at) {
    s = clamp(s, 0, this.src.count - 1);
    const token = (this._token = {});
    const loading = this.src.load(s);
    const SLOW = {};
    // A page that still has to be scanned shows its picture at once; the text replaces it when ready.
    const wait = !this.src.ready || this.src.ready(s) ? 5000 : 300;
    let html = await Promise.race([loading, new Promise((r) => setTimeout(() => r(SLOW), wait))]);
    if (token !== this._token) return;
    if (html === SLOW) {
      // Taking long: show the page picture now, swap in the text when it is ready. Nothing is blocked.
      const preview = this.src.preview ? await this.src.preview(s) : '';
      if (token !== this._token) return;
      this.s = s;
      this.tv.innerHTML = this.secHtml(s, `<div class="scan-wait"><p class="notice">📝 Turning this page into text… read the page meanwhile.</p>${preview}</div>`);
      this.secEl = this.tv.firstElementChild;
      this.layout();
      this.paged ? this.setPage(0) : (this.wrap.scrollTop = 0);
      this.app.onScanSlow && this.app.onScanSlow();
      this.app.onRelocated();
      loading.then(() => { if (token === this._token) this.show(s, at); });
      return;
    }
    this.s = s;
    this.tv.innerHTML = this.secHtml(s, html);
    this.secEl = this.tv.firstElementChild;
    this.paint(this.secEl);
    this.layout();
    if (at.end) this.toEnd();
    else if (at.anchor) this.toAnchor(at.anchor);
    else this.toOffset(at.c || 0);
    if (!this.paged) await this.fill();
    this.app.onRelocated();
  }

  /** Scroll mode: load the next part before you reach the bottom, the previous one near the top, drop far ones. */
  async fill() {
    if (this.paged || this._filling || !this.tv.firstElementChild) return;
    this._filling = true;
    const token = this._token;
    try {
      const w = this.wrap;
      let last = this.tv.lastElementChild;
      while (Number(last.dataset.s) < this.src.count - 1 && w.scrollTop + w.clientHeight > w.scrollHeight - w.clientHeight * 1.5) {
        const n = Number(last.dataset.s) + 1;
        this.tv.insertAdjacentHTML('beforeend', '<p class="pmark loading-more">Loading…</p>');
        const html = await (this.src.quiet || this.src.load)(n);
        this.tv.querySelectorAll('.loading-more').forEach((e) => e.remove());
        if (token !== this._token || this.paged) return;
        this.tv.insertAdjacentHTML('beforeend', this.secHtml(n, html));
        last = this.tv.lastElementChild;
        this.paint(last);
      }
      const first = this.tv.firstElementChild;
      if (Number(first.dataset.s) > 0 && w.scrollTop < w.clientHeight * 0.75) {
        const n = Number(first.dataset.s) - 1;
        const html = await (this.src.quiet || this.src.load)(n);
        if (token !== this._token || this.paged) return;
        const before = w.scrollHeight;
        this.tv.insertAdjacentHTML('afterbegin', this.secHtml(n, html));
        this.paint(this.tv.firstElementChild);
        w.scrollTop += w.scrollHeight - before;     // keep the same words under your eyes
      }
      while (this.tv.children.length > 4) {
        const wr = w.getBoundingClientRect(), top = this.tv.firstElementChild, bottom = this.tv.lastElementChild;
        if (top.getBoundingClientRect().bottom < wr.top - w.clientHeight * 2) { const h = top.offsetHeight; top.remove(); w.scrollTop -= h; }
        else if (bottom.getBoundingClientRect().top > wr.bottom + w.clientHeight * 2) bottom.remove();
        else break;
      }
      if (!this.secEl || !this.secEl.isConnected) { this.secEl = this.tv.firstElementChild; this.s = Number(this.secEl.dataset.s); }
    } finally {
      this._filling = false;
      this.tv.querySelectorAll('.loading-more').forEach((e) => e.remove());
    }
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

  /* --- character offsets within the current part <-> DOM positions --- */
  textNodes(root) {
    const out = textNodesOf(root || this.secEl || this.tv);
    if (!root) this._len = out.length ? out[out.length - 1][1] + out[out.length - 1][0].length : 0;
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

  /** Makes the part that contains `node` the current one (scroll mode has several on screen). */
  pick(node) {
    const el = node.nodeType === 3 ? node.parentElement : node;
    const sec = el && el.closest('.sec');
    if (sec && sec !== this.secEl) { this.secEl = sec; this.s = Number(sec.dataset.s); }
  }

  topRange() {
    const b = this.wrap.getBoundingClientRect();
    const top = this.paged ? b.top : Math.max(b.top, 0) + 28;
    for (let y = top + 4; y < b.bottom; y += 8) {
      for (const x of [b.left + 4, b.left + b.width / 3, b.left + b.width / 2]) {
        const r = this.caretAt(x, y);
        if (r) return r;
      }
    }
    return null;
  }

  bottomRange() {
    const b = this.wrap.getBoundingClientRect();
    for (let y = b.bottom - 4; y > b.top; y -= 8) {
      for (const x of [b.right - 4, b.right - b.width / 3, b.left + 4]) {
        const r = this.caretAt(x, y);
        if (r) return r;
      }
    }
    return null;
  }

  /** Character offset of the first word on screen. */
  topOffset() {
    const r = this.topRange();
    if (r) { this.pick(r.startContainer); return this.offsetOf(r.startContainer, r.startOffset); }
    if (this.paged) return this.page === 0 ? 0 : null;
    return null;
  }

  toOffset(c) {
    const r = this.rangeAt(c);
    if (!r) { this.paged ? this.setPage(0) : this.toRect(this.secEl.getBoundingClientRect()); return; }
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
    else this.wrap.scrollTop += this.secEl.getBoundingClientRect().bottom - this.wrap.getBoundingClientRect().bottom;
  }

  /* --- navigation --- */
  async next() {
    if (this.paged) {
      if (this.page < this.pages - 1) { this.setPage(this.page + 1); this.app.onRelocated(); return true; }
      if (this.s < this.src.count - 1) { await this.show(this.s + 1, {}); return true; }
      return false;
    }
    const w = this.wrap;
    await this.fill();
    if (w.scrollTop + w.clientHeight < w.scrollHeight - 4) { w.scrollBy({ top: w.clientHeight - 60 }); return true; }
    return false;
  }

  async prev() {
    if (this.paged) {
      if (this.page > 0) { this.setPage(this.page - 1); this.app.onRelocated(); return true; }
      if (this.s > 0) { await this.show(this.s - 1, { end: true }); return true; }
      return false;
    }
    await this.fill();
    if (this.wrap.scrollTop > 0) { this.wrap.scrollBy({ top: -(this.wrap.clientHeight - 60) }); return true; }
    return false;
  }

  goTo(loc) { return this.show(loc.s || 0, loc); }

  goToProgress(f) {
    let s = 0;
    while (s < this.src.count - 1 && this.before[s + 1] <= f) s++;
    const inside = this.share[s] ? (f - this.before[s]) / this.share[s] : 0;
    return this.show(s, {}).then(async () => {
      if (this.paged) this.setPage(Math.round(inside * (this.pages - 1)));
      else { this.wrap.scrollTop += inside * this.secEl.offsetHeight; await this.fill(); }
      this.app.onRelocated();
    });
  }

  location() {
    if (!this.secEl) {                            // the first part is still loading
      return this._last || { loc: { s: this.s, c: 0 }, progress: this.before[this.s] || 0, label: 'Loading…', chapter: '' };
    }
    let c = this.topOffset();
    if (c == null) c = 0;
    if (this._len == null) this.textNodes();
    let inSection;
    if (this.paged) inSection = this.pages > 1 ? this.page / (this.pages - 1) : 0;
    else {
      const sr = this.secEl.getBoundingClientRect(), wr = this.wrap.getBoundingClientRect();
      inSection = clamp((wr.top + 28 - sr.top) / Math.max(1, sr.height), 0, 1);
    }
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
    for (const m of this.secEl.querySelectorAll('.pmark[id]')) {
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
        const el = this.secEl.querySelector('#' + CSS.escape(t.loc.anchor));
        if (el && el.firstChild && this.offsetOf(el.firstChild, 0) > c + 1) break;
      }
      label = t.label;
    }
    return label;
  }

  toc() { return this.src.toc; }

  async visibleText() {
    const a = this.topRange(), b = this.bottomRange();
    if (a && b && a.compareBoundaryPoints(Range.START_TO_START, b) <= 0) {
      const r = document.createRange();
      r.setStart(a.startContainer, a.startOffset);
      r.setEnd(b.startContainer, b.startOffset);
      const t = rangeText(r);
      if (t.trim()) return t;
    }
    return (this.secEl.textContent || '').slice(0, 1500).replace(/\s+/g, ' ').trim();
  }

  /* --- highlights: { id, s, a, b } character ranges inside part s --- */
  paint(sec) {
    const s = Number(sec.dataset.s);
    for (const h of this.app.highlights()) if (h.s === s && h.a != null) markRange(sec, h.a, h.b, h.id, h.c);
  }

  addMark(h) {
    const sec = this.tv.querySelector(`.sec[data-s="${h.s}"]`);
    if (sec) markRange(sec, h.a, h.b, h.id, h.c);
  }

  removeMark(id) { unmark(this.tv, id); }

  /** A tap that lands on an existing highlight: its id and where it is on screen. */
  markAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    const mk = hit && hit.closest && hit.closest('mark.hl');
    if (!mk) return null;
    const r = mk.getBoundingClientRect();
    return { id: mk.dataset.h, rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } };
  }

  /** Selects the sentence under the finger (the reader can then drag the handles to change it). */
  selectAt(x, y) {
    const r = this.caretAt(x, y);
    if (!r) return false;
    this.pick(r.startContainer);
    const block = r.startContainer.parentElement.closest('p, h2, li, blockquote');
    if (!block || !this.secEl.contains(block)) return false;
    const nodes = textNodesOf(block);
    const at = nodes.reduce((acc, [n, pos]) => (n === r.startContainer ? pos + r.startOffset : acc), 0);
    const [a, b] = sentenceAround(block.textContent, at);
    if (b <= a) return false;
    const range = document.createRange();
    for (const [n, pos] of nodes) if (a >= pos && a <= pos + n.length) { range.setStart(n, a - pos); break; }
    for (const [n, pos] of nodes) if (b >= pos && b <= pos + n.length) { range.setEnd(n, b - pos); break; }
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  /** The current selection, with where it is on screen (null when nothing is selected). */
  selectionInfo() {
    const h = this.selectionHighlight();
    if (!h) return null;
    const rg = window.getSelection().getRangeAt(0).getBoundingClientRect();
    return { h, rect: { top: rg.top, bottom: rg.bottom, left: rg.left, right: rg.right } };
  }

  clearSelection() { window.getSelection().removeAllRanges(); }

  /** The current text selection as a highlight (then the selection is cleared). */
  selectionHighlight() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    if (!this.tv.contains(r.startContainer) || r.startContainer.nodeType !== 3) return null;
    this.pick(r.startContainer);
    const a = this.offsetOf(r.startContainer, r.startOffset);
    const text = r.toString();
    let b = r.endContainer.nodeType === 3 && this.secEl.contains(r.endContainer) ? this.offsetOf(r.endContainer, r.endOffset) : (this.textNodes(), this._len);
    if (b <= a) return null;
    return { s: this.s, a, b, text: this.secEl.textContent.slice(a, b).replace(/\s+/g, ' ').trim() };
  }

  relayout() {
    const loc = this._last ? this._last.loc : { s: this.s };
    this.setMode();
    this.show(loc.s != null ? loc.s : this.s, loc);
  }

  apply() { this.relayout(); }

  destroy() {
    window.removeEventListener('resize', this._resize);
    this._token = null;
    this.frame.remove();
  }
}

/* ---------- small text helpers shared by the readers ---------- */
function textNodesOf(root) {
  const out = [];
  const w = (root.ownerDocument || document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n, pos = 0;
  while ((n = w.nextNode())) { out.push([n, pos]); pos += n.length; }
  return out;
}

/** [start, end) of the sentence around character `at` of `text`. */
function sentenceAround(text, at) {
  let a = 0, b = text.length;
  const re = /[.!?…]["”’)\]]*\s+/g;
  let m;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    if (end <= at) a = end;
    else { b = m.index + m[0].trimEnd().length; break; }
  }
  while (a < b && /\s/.test(text[a])) a++;
  return [a, b];
}

/** Wraps characters [a, b) of `root`'s text in <mark class="hl" data-h="id">. */
function markRange(root, a, b, id, c) {
  for (const [n, pos] of textNodesOf(root)) {
    const start = Math.max(a, pos), end = Math.min(b, pos + n.length);
    if (start >= end || !n.data.slice(start - pos, end - pos).trim()) continue;
    let target = n;
    if (end < pos + n.length) target.splitText(end - pos);
    if (start > pos) target = target.splitText(start - pos);
    const m = (root.ownerDocument || document).createElement('mark');
    m.className = 'hl';
    m.dataset.h = id;
    if (c) m.dataset.c = c;
    target.parentNode.insertBefore(m, target);
    m.appendChild(target);
  }
}

function unmark(root, id) {
  root.querySelectorAll(`mark.hl[data-h="${id}"]`).forEach((m) => {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    m.remove();
    parent.normalize();
  });
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
/**
 * Scanned text, saved for good: one small file per page inside the app (on Android), so a page is
 * scanned once and never again. In a desktop browser it falls back to localStorage.
 */
const ScanStore = {
  native() { return !!(window.Android && Android.getScan); },
  oldKey(book, n) { return `er.ocr3.${book}.${n}`; },
  get(book, n) {
    if (this.native()) {
      const v = Android.getScan(book, n);
      if (v != null) return v;
    }
    let old = null;
    try { old = localStorage.getItem(this.oldKey(book, n)); } catch (e) { /* none */ }
    if (old != null && this.native()) this.put(book, n, old);      // move older saves into the app's files
    return old;
  },
  put(book, n, html) {
    if (this.native()) {
      Android.saveScan(book, n, html);
      try { localStorage.removeItem(this.oldKey(book, n)); } catch (e) { /* fine */ }
    } else {
      try { localStorage.setItem(this.oldKey(book, n), html); } catch (e) { /* full */ }
    }
  },
  count(book) {
    if (this.native()) return Android.scanCount(book);
    try { return Object.keys(localStorage).filter((k) => k.startsWith(`er.ocr3.${book}.`)).length; } catch (e) { return 0; }
  },
  clear(book) {
    if (this.native() && Android.deleteScans) Android.deleteScans(book);
    try { Object.keys(localStorage).filter((k) => k.startsWith(`er.ocr3.${book}.`)).forEach((k) => localStorage.removeItem(k)); } catch (e) { /* fine */ }
  },
};

async function ocrPageHtml(pdf, n, key, onStatus, quiet, owner) {
  const hit = ScanStore.get(key, n);
  if (hit != null) return hit;
  if (!quiet) onStatus(`Scanning page ${n} of ${pdf.numPages}…`);
  try {
    const html = await OCR.schedule(`${key}:${n}`, `page ${n}`, async (worker) => {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const render = async (width) => {
        const scale = Math.min(width / base.width, (width * 1.45) / base.height, 5);
        const vp = page.getViewport({ scale });
        const raw = document.createElement('canvas');
        raw.width = Math.floor(vp.width); raw.height = Math.floor(vp.height);
        const rctx = raw.getContext('2d');
        rctx.fillStyle = '#fff'; rctx.fillRect(0, 0, raw.width, raw.height);
        await page.render({ canvasContext: rctx, viewport: vp }).promise;
        return raw;
      };
      // 1600 px wide is quick and enough for normal print. A page the scanner is unsure about (but not hopeless) gets one more
      // read from a sharper render (good scans carry detail that small print needs); the surer reading wins.
      let best = await OCR.read(await render(1600), worker);
      if (best.confidence < 72 && best.confidence >= 40) {   // below 40 it is a picture or a blank: a sharper look will not help
        const sharp = await OCR.read(await render(2600), worker);
        if (sharp.confidence > best.confidence) best = sharp;
      }
      // where the words are rides along as an invisible comment, so the original page can be selected too
      return best.html + (best.words && best.words.length ? `<!--W:${JSON.stringify(best.words)}-->` : '');
    }, !quiet, owner);
    ScanStore.put(key, n, html);
    if (App.reader && App.reader.refreshText && App.name === key) App.reader.refreshText(n);
    return html;
  } catch (e) {
    return scanFailedHtml(n, e);                  // not saved, so it is tried again next time
  }
}

/** What a page that could not be scanned shows: the reason, Try again, and a way to tell us. */
function scanFailedHtml(n, e) {
  const reason = (e && e.reason) || 'the scanner stopped unexpectedly';
  const body = `Kitab 1.8 could not scan a page.\n\nReason: ${reason}\nDetail: ${(e && e.detail) || ''}\nPhone: ${navigator.userAgent}\n\n(No book title or text is included.)`;
  const report = 'https://github.com/mrboora04/Kitab/issues/new?title=' + encodeURIComponent('Scan failed: ' + reason) + '&body=' + encodeURIComponent(body);
  return `<div class="scan-fail"><p><b>Couldn't scan page ${n} this time.</b><br>Reason: ${esc(reason)}. Kitab tried 3 times.</p>
    <p><button class="chip" data-retry="${n}">Try again</button> <a class="chip" href="${report}">Report this</a></p></div>`;
}

/**
 * Text source for a PDF. With opts.ocr every page is read by OCR (scanned books);
 * otherwise the PDF's own text is used. opts.onStatus(msg|null) reports slow work.
 */
async function pdfTextSource(pdf, opts) {
  opts = opts || {};
  const onStatus = opts.onStatus || (() => {});
  const per = opts.scanned ? 1 : 6;   // scanned books: one page per part, each read by OCR as you go
  const count = Math.ceil(pdf.numPages / per);
  const cache = new Map();
  const pending = new Map();
  const toLoc = (page) => ({ s: Math.floor((page - 1) / per), anchor: 'pg-' + page, page });
  // Use the PDF's own text; a page without real text (a scan or a picture) is read with OCR instead.
  const pageHtml = async (n, status, quiet) => {
    if (!opts.scanned) {
      const html = await pdfPageHtml(await pdf.getPage(n), n);
      if (html.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length >= 40) return html;
    }
    return ocrPageHtml(pdf, n, opts.key, status, quiet, 'reader');
  };
  const load = (i, silent) => {
    if (cache.has(i)) return Promise.resolve(cache.get(i));
    if (!pending.has(i)) pending.set(i, build(i, silent).finally(() => pending.delete(i)));
    else if (!silent) {                          // already being read ahead: move it to the front of the line
      for (let n = i * per + 1; n <= Math.min(pdf.numPages, (i + 1) * per); n++) OCR.promote(`${opts.key}:${n}`);
      onStatus('Scanning page…');
      return pending.get(i).finally(() => onStatus(null));
    }
    return pending.get(i);
  };
  // Read ahead only the next two parts of a scanned book, never the whole book.
  const ahead = (i) => { if (opts.scanned) for (const j of [i + 1, i + 2]) if (j < count && !cache.has(j)) load(j, true).catch(() => {}); };
  // While a page is being scanned you can already read its picture.
  const previewHtml = async (i) => {
    const out = [];
    for (let n = i * per + 1; n <= Math.min(pdf.numPages, (i + 1) * per, i * per + 2); n++) {
      try {
        const page = await pdf.getPage(n);
        const vp = page.getViewport({ scale: 720 / page.getViewport({ scale: 1 }).width });   // quick to draw
        const c = document.createElement('canvas');
        c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        out.push(`<img class="scan-preview" src="${c.toDataURL('image/jpeg', 0.7)}" alt="Page ${n}">`);
      } catch (e) { /* no preview */ }
    }
    return out.join('');
  };
  const build = async (i, silent) => {
    const status = silent ? () => {} : onStatus;
    const parts = [];
    let words = 0;
    try {
      for (let n = i * per + 1; n <= Math.min(pdf.numPages, (i + 1) * per); n++) {
        const html = await pageHtml(n, status, silent);
        words += html.length;
        parts.push(`<div class="pmark" id="pg-${n}">— ${n} —</div>`, html);
      }
    } finally { status(null); }
    const hint = 'No readable text was found here. It may be a blank page or a picture — switch PDF view to Original to see it.';
    const html = words < 20 ? parts.join('\n') + `<p class="notice">${hint}</p>` : parts.join('\n');
    cache.set(i, html);
    if (cache.size > 8) cache.delete(cache.keys().next().value);
    return html;
  };
  return { count, weights: Array.from({ length: count }, (_, i) => Math.min(per, pdf.numPages - i * per)), load: (i) => load(i, false).then((h) => { if (!/scan-fail/.test(h)) ahead(i); return h; }), quiet: (i) => load(i, true),
    forget: (i) => cache.delete(i), preview: (i) => previewHtml(i),
    // true when part i can be shown at once (already saved, or a PDF with its own text)
    ready: (i) => cache.has(i) || !opts.scanned || ScanStore.get(opts.key, i * per + 1) != null,
    toc: await pdfToc(pdf, toLoc), pdf, perSection: per, toLoc };
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
    box._n = n;
    box._crop = crop;
    const hl = document.createElement('div');
    hl.className = 'hl-layer';
    box.appendChild(hl);
    for (const h of this.app.highlights()) if (h.page === n && h.rects) this.paintMark(box, h);
    this.textLayer(page, box, scale, crop, base);   // selectable text on top, filled in when ready
  }

  /** An invisible copy of the page's text over the picture, so words can be selected (born-digital PDFs). */
  async textLayer(page, box, scale, crop, base) {
    try {
      const tc = await page.getTextContent();
      if (!box.isConnected) return;
      if (!tc.items.some((i) => i.str && i.str.trim())) return this.scannedLayer(page, box, scale, crop, base);   // a scan: use the words the scanner found
      const layer = document.createElement('div');
      layer.className = 'textLayer';
      const vp = page.getViewport({ scale });
      layer.style.setProperty('--scale-factor', vp.scale);
      // the layer covers the whole page; shift it so the trimmed part lines up with the picture
      layer.style.left = (-crop.x0 * base.width * scale) + 'px';
      layer.style.top = (-crop.y0 * base.height * scale) + 'px';
      box.appendChild(layer);
      await pdfjsLib.renderTextLayer({ textContentSource: tc, container: layer, viewport: vp, textDivs: [] }).promise;
    } catch (e) { /* the page is still readable without it */ }
  }

  /** For a scanned page: invisible words placed where the scanner found them. */
  scannedLayer(page, box, scale, crop, base) {
    const html = ScanStore.get(this.app.name, page.pageNumber);
    const m = html && /<!--W:(\[.*?\])-->/s.exec(html);
    if (!m || !box.isConnected) return;
    let words;
    try { words = JSON.parse(m[1]); } catch (e) { return; }
    box.querySelector('.textLayer')?.remove();
    const W = base.width * scale, H = base.height * scale;
    const layer = document.createElement('div');
    layer.className = 'textLayer scanned';
    layer.style.cssText = `width:${W}px;height:${H}px;left:${-crop.x0 * W}px;top:${-crop.y0 * H}px`;
    const spans = words.map(([t, a, b, c, d]) => {
      const sp = document.createElement('span');
      sp.textContent = t;
      sp.style.cssText = `left:${a / 10}%;top:${b / 10}%;font-size:${Math.max(4, (d - b) / 1000 * H * 0.85)}px;line-height:${(d - b) / 1000 * H}px`;
      sp._w = (c - a) / 1000 * W;
      return sp;
    });
    spans.forEach((sp) => { layer.appendChild(sp); layer.appendChild(document.createTextNode(' ')); });
    box.appendChild(layer);
    const nat = spans.map((sp) => sp.getBoundingClientRect().width);     // read all sizes first, then write
    spans.forEach((sp, i) => { if (nat[i] > 0) sp.style.transform = `scaleX(${sp._w / nat[i]})`; });
  }

  /** A page finished scanning while it is on screen: make its words selectable. */
  refreshText(n) {
    for (const b of this.boxes()) {
      if (b._n === n && !b.querySelector('.textLayer span')) this.pdf.getPage(n).then((pg) => {
        const base = pg.getViewport({ scale: 1 });
        const c = b._crop, cw = base.width * (c.x1 - c.x0);
        this.scannedLayer(pg, b, b.offsetWidth / cw, c, base);
      });
    }
  }

  /** Whether the page on screen has words that can be selected. */
  canSelect() { return !!this.wrap.querySelector('.textLayer span'); }

  boxes() { return [...this.wrap.querySelectorAll('.pdf-page')].filter((b) => b._n); }

  /* --- highlights on a PDF page: { id, page, rects: [{ x, y, w, h }] as fractions of the whole page } --- */
  paintMark(box, h) {
    const layer = box.querySelector('.hl-layer');
    const c = box._crop, cw = c.x1 - c.x0, ch = c.y1 - c.y0;
    if (!layer) return;
    for (const r of h.rects) {
      const d = document.createElement('i');
      d.className = 'hl-r';
      d.dataset.h = h.id;
      if (h.c) d.dataset.c = h.c;
      d.style.left = ((r.x - c.x0) / cw * 100) + '%'; d.style.top = ((r.y - c.y0) / ch * 100) + '%';
      d.style.width = (r.w / cw * 100) + '%'; d.style.height = (r.h / ch * 100) + '%';
      layer.appendChild(d);
    }
  }

  addMark(h) { for (const b of this.boxes()) if (b._n === h.page) this.paintMark(b, h); }

  removeMark(id) { this.wrap.querySelectorAll(`.hl-r[data-h="${id}"]`).forEach((d) => d.remove()); }

  /** A tap that lands on an existing highlight: its id and where it is on screen. */
  markAt(x, y) {
    for (const d of this.wrap.querySelectorAll('.hl-r')) {
      const r = d.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { id: d.dataset.h, rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } };
    }
    return null;
  }

  /** Selects the word under the finger (the reader can then drag the handles). */
  selectAt(x, y) {
    const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    if (!r || r.startContainer.nodeType !== 3 || !r.startContainer.parentElement.closest('.textLayer')) return false;
    const t = r.startContainer.data;
    let a = r.startOffset, b = r.startOffset;
    while (a > 0 && /[\w'’-]/.test(t[a - 1])) a--;
    while (b < t.length && /[\w'’-]/.test(t[b])) b++;
    if (b <= a) return false;
    const range = document.createRange();
    range.setStart(r.startContainer, a); range.setEnd(r.startContainer, b);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    return true;
  }

  /** The current selection as a highlight, with where it is on screen. */
  selectionInfo() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const el = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
    const layer = el && el.closest && el.closest('.textLayer');
    if (!layer) return null;
    const box = layer.parentElement, bb = box.getBoundingClientRect(), c = box._crop;
    const cw = c.x1 - c.x0, ch = c.y1 - c.y0;
    const rects = [];
    for (const r of range.getClientRects()) {
      if (r.width < 2 || r.height < 2) continue;
      rects.push({ x: c.x0 + (r.left - bb.left) / bb.width * cw, y: c.y0 + (r.top - bb.top) / bb.height * ch, w: r.width / bb.width * cw, h: r.height / bb.height * ch });
    }
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!rects.length || !text) return null;
    const rr = range.getBoundingClientRect();
    return { h: { page: box._n, rects, text }, rect: { top: rr.top, bottom: rr.bottom, left: rr.left, right: rr.right } };
  }

  clearSelection() { window.getSelection().removeAllRanges(); }

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
    if (this.zoom > 1) {   // start at the top-left of the page; the padding lets you push it anywhere
      this.wrap.scrollTop = box.offsetTop - 16;
      this.wrap.scrollLeft = box.offsetLeft - 16;
    } else { this.wrap.scrollTop = 0; this.wrap.scrollLeft = 0; }
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
    // Highlighter: select text, or tap a sentence; tap a highlight to remove it.
    r.on('selected', (cfiRange, contents) => {
      const sel = contents.window.getSelection();
      const text = String(sel || '').replace(/\s+/g, ' ').trim();
      if (!text || !sel.rangeCount) return;
      const rg = sel.getRangeAt(0).getBoundingClientRect();
      const fr = contents.window.frameElement.getBoundingClientRect();
      this._sel = sel;
      this.app.showHlBar({ top: rg.top + fr.top, bottom: rg.bottom + fr.top, left: rg.left + fr.left, right: rg.right + fr.left }, { h: { cfi: cfiRange, text } });
    });
    r.on('click', (e) => {
      if (Date.now() - (this._swiped || 0) < 400) return;
      if (this.app.hlBarOpen()) { this.app.hideHlBar(true); return; }
      const sel = e.view.getSelection();
      if (this.app.hlMode) { setTimeout(() => { if (Date.now() - (this._hlHit || 0) > 400) this.highlightTap(e); }, 0); return; }
      if (Date.now() - (this._hlHit || 0) < 400) return;
      if ((sel && String(sel).trim()) || e.target.closest('a')) return;
      const fr = e.view.frameElement.getBoundingClientRect();
      this.app.onTap((e.clientX + fr.left) / window.innerWidth);
    });
    await r.display(cfi || undefined);
    for (const h of this.app.highlights()) if (h.cfi) this.addMark(h);
  }

  addMark(h) {
    const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#c45c34';
    try {
      const tap = (ev) => {
        this._hlHit = Date.now();
        const x = ev && ev.clientX, y = ev && ev.clientY;
        this.app.editHighlight(h.id, x != null ? { top: y - 6, bottom: y + 6, left: x, right: x } : null);
      };
      const colour = { y: '#f4d03f', g: '#6fcf75', b: '#5aaeea', p: '#ef82ad' }[h.c];
      if (h.c === 'u') this.rendition.annotations.underline(h.cfi, { id: h.id }, tap, 'hl', { stroke: accent, 'stroke-opacity': '0.9', 'stroke-width': '2px' });
      else this.rendition.annotations.highlight(h.cfi, { id: h.id }, tap, 'hl', { fill: colour || '#f4d03f', 'fill-opacity': '0.4', 'mix-blend-mode': 'multiply' });
    } catch (e) { /* a highlight from an older layout */ }
  }

  removeMark(id) {
    const h = this.app.highlights().find((x) => x.id === id);
    if (h && h.cfi) this.rendition.annotations.remove(h.cfi, h.c === 'u' ? 'underline' : 'highlight');
  }

  clearSelection() { if (this._sel) { try { this._sel.removeAllRanges(); } catch (e) { /* frame gone */ } } }

  /** Tap in highlight mode: the sentence under the finger. */
  highlightTap(e) {
    const doc = e.view.document;
    const r = doc.caretRangeFromPoint && doc.caretRangeFromPoint(e.clientX, e.clientY);
    if (!r || r.startContainer.nodeType !== 3) return;
    const block = r.startContainer.parentElement.closest('p, li, blockquote, h1, h2, h3, h4, h5, h6, div');
    if (!block) return;
    const nodes = textNodesOf(block);
    let at = 0;
    for (const [n, pos] of nodes) if (n === r.startContainer) at = pos + r.startOffset;
    const [a, b] = sentenceAround(block.textContent, at);
    if (b <= a) return;
    const range = doc.createRange();
    for (const [n, pos] of nodes) {
      if (a >= pos && a <= pos + n.length) { range.setStart(n, a - pos); break; }
    }
    for (const [n, pos] of nodes) {
      if (b >= pos && b <= pos + n.length) { range.setEnd(n, b - pos); break; }
    }
    const contents = this.rendition.getContents().find((c) => c.document === doc);
    if (!contents) return;
    const sel = doc.defaultView.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);   // the 'selected' event then shows the colour bar
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
