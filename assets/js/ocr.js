'use strict';
/*
 * Offline text recognition for scanned books (Tesseract, English), loaded only when first used.
 *
 * Old printed pages carry things that are not text: ornamental drop caps, borders, rules, flourishes.
 * Tesseract turns those into junk ("aia Hr", "NSS ASSEN"), so a page is cleaned first:
 *   1. normalise the paper tone and binarise with a local threshold (copes with yellowed, uneven scans)
 *   2. erase connected shapes far bigger than a letter; big letter-like ones are kept aside (drop caps)
 *   3. read the clean image, drop low-confidence words, read each drop cap on its own and put it back
 * OCR.pageHtml(canvas) -> HTML paragraphs. Pages are queued so only one is processed at a time.
 */
const OCR = {
  worker: null,
  loading: null,
  jobs: [],          // pages waiting to be scanned: { key, label, high, run, promise }
  current: null,     // the page being scanned right now
  onChange: null,    // the app shows "scanning page N" in Aa

  init() {
    if (!this.loading) {
      this.loading = (async () => {
        if (!window.Tesseract) {
          await new Promise((ok, bad) => {
            const s = document.createElement('script');
            s.src = 'lib/ocr/tesseract.min.js';
            s.onload = ok;
            s.onerror = () => bad(new Error('OCR engine is missing from the app'));
            document.head.appendChild(s);
          });
        }
        const base = new URL('lib/ocr/', location.href).href;
        this.worker = await Tesseract.createWorker('eng', 1, {
          workerPath: base + 'worker.min.js',
          workerBlobURL: false,
          corePath: base,
          langPath: base,
          cacheMethod: 'none',
        });
        await this.worker.setParameters({ user_defined_dpi: '300' });
      })().catch((e) => { this.loading = null; throw e; });
    }
    return this.loading;
  },

  /**
   * Queues one page. Pages are scanned one at a time; the page you are looking at (high) jumps the line,
   * read-ahead pages wait at the back. A failing page is retried 3 times with a fresh scanner.
   */
  schedule(key, label, run, high) {
    if (this.current && this.current.key === key) return this.current.promise;
    const waiting = this.jobs.find((j) => j.key === key);
    if (waiting) { if (high) this.promote(key); return waiting.promise; }
    const job = { key, label, run, high };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    if (high) this.jobs.unshift(job); else this.jobs.push(job);
    this.pump();
    return job.promise;
  },

  /** Drops waiting pages of a book you closed, so they never hold up the next one. */
  cancel(prefix) {
    const cur = this.current;
    if (cur && cur.key.startsWith(prefix)) {        // the page in progress belongs to a closed book: let go of it now
      cur.cancelled = true;
      const e = new Error('cancelled'); e.reason = 'cancelled';
      cur.reject(e);
      this.current = null;
      setTimeout(() => this.pump());
    }
    this.jobs = this.jobs.filter((j) => {
      if (!j.key.startsWith(prefix)) return true;
      const e = new Error('cancelled'); e.reason = 'cancelled';
      j.reject(e);
      return false;
    });
    this.changed();
  },

  promote(key) {
    const i = this.jobs.findIndex((j) => j.key === key);
    if (i > 0) this.jobs.unshift(this.jobs.splice(i, 1)[0]);
    if (i >= 0) this.jobs[0].high = true;
  },

  async pump() {
    if (this.current || !this.jobs.length) { this.changed(); return; }
    const job = (this.current = this.jobs.shift());
    this.changed();
    let err = null;
    for (let attempt = 1; attempt <= 3 && !job.cancelled; attempt++) {
      try {
        const out = await this.timeout(job.run(), 120000);
        if (!job.cancelled) job.resolve(out);
        err = null;
        break;
      } catch (e) {
        err = e;
        if (!job.cancelled) await this.reset();  // a crashed scanner stays broken: start a fresh one
      }
    }
    if (job.cancelled) return;                   // already let go of; the next page is running
    if (err) job.reject(this.explain(err));
    this.current = null;
    this.pump();
  },

  changed() { if (this.onChange) this.onChange(this.current && this.current.label, this.jobs.length); },

  timeout(p, ms) {
    return Promise.race([p, new Promise((_, bad) => setTimeout(() => bad(new Error('timeout')), ms))]);
  },

  async reset() {
    try { if (this.worker) await this.worker.terminate(); } catch (e) { /* already gone */ }
    this.worker = null;
    this.loading = null;
  },

  /** A plain reason for a page that could not be scanned. */
  explain(e) {
    const m = String(e && (e.message || e));
    let reason = 'the scanner stopped unexpectedly';
    if (/timeout/i.test(m)) reason = 'it took too long (a very large or complex page)';
    else if (/memory|allocation|out of bounds/i.test(m)) reason = 'your phone ran low on memory';
    else if (/missing|load|fetch|network/i.test(m)) reason = 'the scanner could not start';
    const err = new Error(reason);
    err.reason = reason;
    err.detail = m.slice(0, 200);
    return err;
  },

  /** Reads one page image and returns HTML paragraphs (call through schedule). */
  async read(canvas) {
    await this.init();
    const pre = this.clean(canvas);
    const { data } = await this.worker.recognize(pre.canvas);
    const caps = await this.readDropCaps(pre.caps);
    await Words.load();
    return this.layout(data, caps, pre.medH);
  },

  /* ---------------- 1 + 2: clean the image ---------------- */
  clean(src) {
    const w = src.width, h = src.height, n = w * h;
    const img = src.getContext('2d').getImageData(0, 0, w, h).data;
    const g = new Uint8Array(n);
    const hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const v = (img[p] * 77 + img[p + 1] * 151 + img[p + 2] * 28) >> 8;
      g[i] = v; hist[v]++;
    }
    // stretch so the paper becomes white and the darkest ink black
    let acc = 0, lo = 0, hi = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.01) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.35) { hi = v; break; } }  // paper is the bright majority
    const span = Math.max(40, hi - lo);
    for (let i = 0; i < n; i++) g[i] = Math.max(0, Math.min(255, ((g[i] - lo) * 255) / span));

    // local mean through an integral image, then threshold against it
    const W1 = w + 1;
    const integ = new Uint32Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += g[y * w + x];
        integ[(y + 1) * W1 + x + 1] = integ[y * W1 + x + 1] + row;
      }
    }
    const r = Math.max(10, Math.round(w / 90));
    const ink = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const sum = integ[y1 * W1 + x1] - integ[y0 * W1 + x1] - integ[y1 * W1 + x0] + integ[y0 * W1 + x0];
        const mean = sum / ((x1 - x0) * (y1 - y0));
        const v = g[y * w + x];
        if ((v < mean * 0.84 && v < 200) || v < 70) ink[y * w + x] = 1;  // second test keeps solid black shapes (drop caps) solid
      }
    }

    // connected components (8-neighbour) with bounding boxes
    const seen = new Uint8Array(n);
    const stack = new Int32Array(n);
    const comps = [];
    for (let s = 0; s < n; s++) {
      if (!ink[s] || seen[s]) continue;
      let top = 0, cnt = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
      stack[top++] = s; seen[s] = 1;
      while (top) {
        const p = stack[--top], px = p % w, py = (p / w) | 0;
        cnt++;
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
        for (let dy = -1; dy <= 1; dy++) {
          const qy = py + dy;
          if (qy < 0 || qy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const qx = px + dx, q = qy * w + qx;
            if (qx < 0 || qx >= w || !ink[q] || seen[q]) continue;
            seen[q] = 1; stack[top++] = q;
          }
        }
      }
      comps.push({ s, cnt, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    }

    // typical letter height = median over plausible letter-sized shapes
    const hs = comps.filter((c) => c.h >= 8 && c.h <= 70 && c.w >= 3 && c.cnt >= 12).map((c) => c.h).sort((a, b) => a - b);
    const medH = hs.length ? hs[hs.length >> 1] : 20;
    const caps = [];
    const out = new Uint8ClampedArray(n * 4).fill(255);
    const erase = (c) => {  // clear one component from `ink` (returns its pixels)
      const px = [];
      let top = 0;
      stack[top++] = c.s; ink[c.s] = 0;
      while (top) {
        const p = stack[--top]; px.push(p);
        const x = p % w, y = (p / w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const qx = x + dx, qy = y + dy;
          if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
          const q = qy * w + qx;
          if (ink[q]) { ink[q] = 0; stack[top++] = q; }
        }
      }
      return px;
    };
    for (const c of comps) {
      const huge = c.h > medH * 3.8 || c.w > medH * 30 || (c.w > medH * 12 && c.h < medH * 0.25);  // blob, long rule, thin line
      if (!huge) continue;
      const px = erase(c);
      const fill = c.cnt / (c.w * c.h), aspect = c.w / c.h;
      if (c.h <= medH * 14 && c.w <= medH * 14 && aspect > 0.35 && aspect < 2.3 && fill > 0.04) {  // maybe a drop cap, maybe a flourish
        const variants = [0, 0.22].map((cut) => {   // the whole shape, then only its middle (cuts away a wreath around the letter)
          const cx0 = c.x0 + c.w * cut, cy0 = c.y0 + c.h * cut, cw = c.w * (1 - 2 * cut), ch = c.h * (1 - 2 * cut);
          const pad = 24, cv = document.createElement('canvas');
          cv.width = Math.ceil(cw) + pad * 2; cv.height = Math.ceil(ch) + pad * 2;
          const cx = cv.getContext('2d');
          cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
          const id = cx.getImageData(0, 0, cv.width, cv.height);
          for (const p of px) {
            const X = (p % w) - cx0 + pad, Y = ((p / w) | 0) - cy0 + pad;
            if (X < 0 || Y < 0 || X >= cv.width || Y >= cv.height) continue;
            const o = (Y | 0) * cv.width + (X | 0);
            id.data[o * 4] = id.data[o * 4 + 1] = id.data[o * 4 + 2] = 0;
          }
          cx.putImageData(id, 0, 0);
          return cv;
        });
        caps.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, variants });
      }
    }
    // A drop cap sits at the left, above the bottom of the page. More than two candidates means pictures, not a letter.
    // Shapes nested inside each other (a letter in a wreath of rings) count as one; keep the innermost.
    const inside = (a, b) => a !== b && a.x0 >= b.x0 && a.y0 >= b.y0 && a.x1 <= b.x1 && a.y1 <= b.y1;
    const groups = caps.filter((c) => c.x0 < w * 0.4 && c.y0 < h * 0.8)
      .filter((c, _, all) => !all.some((o) => inside(o, c)));        // innermost of each nest
    caps.length = 0;
    if (groups.length <= 2) caps.push(...groups.sort((a, b) => a.y0 - b.y0).slice(0, 1));
    for (let i = 0; i < n; i++) if (ink[i]) out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 0;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
    return { canvas, caps, medH };
  },

  /* ---------------- 3: read the drop caps ---------------- */
  async readDropCaps(caps) {
    const found = [];
    if (!caps.length) return found;
    await this.worker.setParameters({ tessedit_pageseg_mode: '10', tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' });
    try {
      for (const c of caps.slice(0, 4)) {
        let best = null;
        for (const cv of c.variants) {
          const { data } = await this.worker.recognize(cv);
          const t = (data.text || '').trim();
          if (/^[A-Z]$/.test(t) && data.confidence >= 78 && (!best || data.confidence > best.conf)) best = { letter: t, conf: data.confidence };
          if (best) break;                       // found it: skip the second try
        }
        if (best) found.push({ letter: best.letter, x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 });
      }
    } finally {
      await this.worker.setParameters({ tessedit_pageseg_mode: '3', tessedit_char_whitelist: '' });
    }
    return found;
  },

  /* ---------------- 3: build paragraphs ---------------- */
  layout(data, caps, medH) {
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const junk = /^[|\\/~_=<>^`´¨°•·.,;:]+$/;
    const lines = [];
    for (const ln of data.lines || []) {
      const words = (ln.words || []).map((w) => {
        // a real word with a speck glued to its edge (“lifted) scores low: keep the clean core
        const core = (w.text || '').trim().replace(/^[^A-Za-z0-9]+/, '');
        return w.confidence < 55 && w.confidence >= 30 && core.length >= 4 && /^[A-Za-z]+[.,;:!?'’”)]*$/.test(core) ? { ...w, text: core, confidence: 60 } : w;
      }).filter((w) => {
        const t = (w.text || '').trim();
        if (!t || junk.test(t)) return false;
        if (!/[A-Za-z0-9]/.test(t)) return t.length === 1 && /[—–-]/.test(t);       // keep a lone dash
        if (w.confidence < 55) return false;
        if (t.length <= 2 && w.confidence < 75 && !/^(a|an|am|as|at|be|by|do|go|he|if|in|is|it|me|my|no|of|on|or|so|to|up|us|we|I|A)$/i.test(t)) return false;
        return true;
      });
      while (words.length && /^[—–-]$/.test(words[0].text.trim())) words.shift();   // a lone dash at a line edge is a speck
      while (words.length && /^[—–-]$/.test(words[words.length - 1].text.trim())) words.pop();
      if (!words.length) continue;
      const letters = words.map((w) => w.text).join('').replace(/[^A-Za-z]/g, '').length;
      if (letters < 2 && words.length < 2) continue;
      // measure the line by its typical word, so one word with a speck on it cannot stretch the box
      const med = (arr) => arr.slice().sort((p, q) => p - q)[arr.length >> 1];
      const bb = {
        x0: words[0].bbox.x0, x1: words[words.length - 1].bbox.x1,
        y0: med(words.map((w) => w.bbox.y0)), y1: med(words.map((w) => w.bbox.y1)),
      };
      lines.push({ words: words.map((w) => w.text.trim()), x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1, capLine: false });
    }
    if (!lines.length) return '';

    // restore drop-cap letters: the first line to the right of the cap, near its top
    for (const cap of caps) {
      const cand = lines.filter((l) => l.x0 >= cap.x1 - medH * 2 && l.y0 >= cap.y0 - medH * 2.5 && l.y0 <= cap.y0 + medH * 3).sort((a, b) => a.y0 - b.y0)[0];
      if (!cand) continue;
      const first = cand.words[0];
      cand.words[0] = (first[0] && first[0].toUpperCase() === cap.letter && first.length > 3 ? '' : cap.letter) + first;
      lines.forEach((l) => { if (l.x0 >= cap.x1 - medH * 2 && l.y0 >= cap.y0 - medH && l.y1 <= cap.y1 + medH * 2) l.capLine = true; });
    }

    const lefts = lines.filter((l) => l.words.length >= 3 && !l.capLine).map((l) => l.x0).sort((a, b) => a - b);
    const left = lefts.length ? lefts[lefts.length >> 1] : lines[0].x0;
    const heights = lines.map((l) => l.y1 - l.y0).sort((a, b) => a - b);
    const lineH = heights[heights.length >> 1];

    const gaps = lines.slice(1).map((l, i) => l.y0 - lines[i].y1).filter((g) => g > -lineH && g < lineH * 3).sort((x, y) => x - y);
    const gapMed = gaps.length ? gaps[gaps.length >> 1] : 0;
    const paras = [];
    let cur = null, prev = null, prevIndented = false;
    for (const l of lines) {
      const text = l.words.join(' ');
      const heading = l.y1 - l.y0 > lineH * 1.45 && l.words.length <= 8;
      const indented = l.x0 > left + medH * 1.1;
      const indent = !l.capLine && indented && !(prevIndented && prev && Math.abs(prev.x0 - l.x0) < medH * 3);
      const gap = prev && l.y0 - prev.y1 > Math.max(gapMed, 0) * 2 + lineH * 0.5;  // clearly more than the page's normal line spacing
      if (heading || !cur || cur.heading || indent || gap) {
        cur = { heading, text };
        paras.push(cur);
      } else {
        cur.text += ' ' + text;
      }
      prev = l;
      prevIndented = indented;
    }
    return paras
      .map((p) => ({ heading: p.heading, text: Words.fix(p.text.replace(/\s+/g, ' ').trim()) }))
      .filter((p, i, a) => p.text.replace(/[^A-Za-z0-9]/g, '').length > 1
        && !((/^\d{1,4}$/.test(p.text) || /^[ivxlcdm]{1,7}$/i.test(p.text)) && (i === 0 || i === a.length - 1)))  // page numbers
      .map((p) => (p.heading ? `<h2>${esc(p.text)}</h2>` : `<p>${esc(p.text)}</p>`)).join('\n');
  },
};


/*
 * Word repair after OCR, using an English word list (SCOWL, ~80k words incl. British spellings).
 * It is careful by design: a word is changed only when exactly one sensible fix exists.
 *   - typical scanner confusions: rn→m, cl→d, li→h, vv→w, 1→l, 0→o ...
 *   - run-together words: "artitexpressed" → "art it expressed"
 *   - words split at a line end: "ra- tional" → "rational", but "burgher- life" stays "burgher-life"
 * Names and old spellings that appear several times in the book are learned and left alone,
 * and capitalised words (likely names) are never changed.
 */
const Words = {
  rank: null,
  loading: null,
  seen: new Map(),      // words met in this book so far -> count

  load() {
    if (!this.loading) {
      this.loading = fetch('lib/ocr/words.txt').then((r) => r.text()).then((t) => {
        const rank = new Map();
        let tier = 10;
        for (const line of t.split('\n')) {
          if (line[0] === '#') tier = Number(line.slice(1));
          else if (line) rank.set(line, tier);
        }
        this.rank = rank;
      }).catch(() => { this.rank = new Map(); });
    }
    return this.loading;
  },

  tier(w) { return this.rank.get(w.toLowerCase()); },
  known(w) {
    const l = w.toLowerCase();
    return this.rank.has(l) || (this.seen.get(l) || 0) >= 3 || /^[ivxlcdm]+$/.test(l) && l.length <= 6;
  },

  CONFUSIONS: [['rn', 'm'], ['m', 'rn'], ['cl', 'd'], ['d', 'cl'], ['li', 'h'], ['h', 'li'], ['vv', 'w'], ['ii', 'u'], ['ri', 'n'],
    ['1', 'l'], ['l', 'i'], ['i', 'l'], ['0', 'o'], ['5', 's'], ['c', 'e'], ['e', 'c'], ['u', 'n'], ['n', 'u'], ['tl', 'd'], ['fi', 'h'], ['f', 't'], ['t', 'f']],

  /** The single best repair of one lower-case word, or null. */
  repair(w) {
    const best = (cands, maxTier) => {
      const ok = [...new Set(cands)].filter((c) => this.rank.has(c)).map((c) => [c, this.rank.get(c)]).filter(([, t]) => t <= maxTier);
      if (!ok.length) return null;
      ok.sort((a, b) => a[1] - b[1]);
      return ok.length === 1 || ok[0][1] < ok[1][1] ? ok[0][0] : null;   // a clear winner only
    };
    // 1. scanner confusions
    const conf = [];
    for (const [a, b] of this.CONFUSIONS) {
      for (let i = w.indexOf(a); i >= 0; i = w.indexOf(a, i + 1)) conf.push(w.slice(0, i) + b + w.slice(i + a.length));
    }
    const c = best(conf, 50);
    if (c) return c;
    // 2. run-together words
    const seg = this.split(w);
    if (seg) return seg;
    // 3. one wrong, missing or swapped letter (longer words only). Never drop letters: old spellings
    //    such as "mediaeval" or "connexion" must survive, and scanners rarely add letters.
    if (w.length >= 5) {
      const edits = [];
      const abc = 'abcdefghijklmnopqrstuvwxyz';
      for (let i = 0; i <= w.length; i++) {
        if (i < w.length - 1) edits.push(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
        for (const ch of abc) {
          if (i < w.length) edits.push(w.slice(0, i) + ch + w.slice(i + 1));
          edits.push(w.slice(0, i) + ch + w.slice(i));
        }
      }
      return best(edits.filter((e) => e !== w), 40);
    }
    return null;
  },

  /** Split a run-together word into 2–3 common words, or null. */
  split(w) {
    if (w.length < 6) return null;
    const good = (p) => (p.length >= 2 || p === 'a' || p === 'i') && (this.rank.get(p) || 99) <= (p.length <= 2 ? 20 : 50);
    let found = null;
    for (let i = 1; i < w.length; i++) {
      const a = w.slice(0, i), rest = w.slice(i);
      if (!good(a)) continue;
      if (good(rest)) { if (!found || found.length > 2) found = [a, rest]; continue; }
      for (let j = 1; j < rest.length; j++) {
        const b = rest.slice(0, j), c = rest.slice(j);
        if (good(b) && good(c) && !found) found = [a, b, c];
      }
    }
    if (!found) return null;
    return found.map((p) => (p === 'i' ? 'I' : p)).join(' ');
  },

  /** Repairs a paragraph of OCR text. */
  fix(text) {
    if (!this.rank || !this.rank.size) return text.replace(/([a-z])- (?=[a-z])/g, '$1');
    // learn this book's vocabulary first (names, old spellings)
    for (const m of text.toLowerCase().matchAll(/[a-z]{3,}/g)) this.seen.set(m[0], (this.seen.get(m[0]) || 0) + 1);
    // words broken at a line end
    text = text.replace(/\b([A-Za-z]+)- ([a-z]+)\b/g, (all, a, b) => {
      const joined = a + b;
      if (this.known(joined) || !(this.known(a) && this.known(b))) return joined;
      return a + '-' + b;                       // a real compound word, like burgher-life
    });
    return text.replace(/[A-Za-z0-9]+(?:['’][a-z]+)?/g, (tok) => {
      if (tok.length < 3 || /\d/.test(tok) && /^\d+$/.test(tok)) return tok;
      if (/[A-Z]/.test(tok.slice(1)) || /^[A-Z]/.test(tok)) return tok;   // names, acronyms: leave alone
      const core = tok.replace(/['’][a-z]+$/, '');
      if (this.known(core)) return tok;
      const r = this.repair(core.toLowerCase());
      return r ? r + tok.slice(core.length) : tok;
    });
  },
};
