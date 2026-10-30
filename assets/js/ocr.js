'use strict';
/*
 * Offline text recognition for scanned books (Tesseract, English), loaded only when first used.
 *
 * Old printed pages carry things that are not text: ornamental drop caps, borders, rules, flourishes.
 * Tesseract turns those into junk ("aia Hr", "NSS ASSEN"), so a page is cleaned first:
 *   1. normalise the paper tone and binarise with a local threshold (copes with yellowed, uneven scans)
 *   2. erase connected shapes far bigger than a letter; big letter-like ones are kept aside (drop caps)
 *   3. read the clean image, drop low-confidence words, read each drop cap on its own and put it back
 * OCR.read(canvas) -> HTML paragraphs. Pages are queued; a few are read at once when the phone has the cores for it.
 */
const OCR = {
  worker: null,      // the first scanner (kept for tests and single reads)
  slots: [],         // scanners that run at the same time: { worker, ready, job }
  jobs: [],          // pages waiting to be scanned: { key, label, high, run, promise }
  onChange: null,    // the app shows "scanning page N" in Aa

  /** The page being scanned right now (if several run together, the first). */
  get current() { const s = this.slots.find((x) => x.job); return s ? s.job : null; },

  /** How many pages to read at once: about half the phone's cores, fewer on low memory (each scanner holds ~150 MB). */
  size() {
    const cores = navigator.hardwareConcurrency || 4, mem = navigator.deviceMemory || 4;
    return Math.max(1, Math.min(3, cores >> 1, mem >= 6 ? 3 : 2));
  },

  loadScript() {
    if (!this.script) {
      this.script = new Promise((ok, bad) => {
        if (window.Tesseract) return ok();
        const s = document.createElement('script');
        s.src = 'lib/ocr/tesseract.min.js';
        s.onload = ok;
        s.onerror = () => { this.script = null; bad(new Error('OCR engine is missing from the app')); };
        document.head.appendChild(s);
      });
    }
    return this.script;
  },

  /** Starts a scanner for a slot (once). */
  ready(slot) {
    if (!slot.ready) {
      slot.ready = (async () => {
        await this.loadScript();
        const base = new URL('lib/ocr/', location.href).href;
        slot.worker = await Tesseract.createWorker('eng', 1, {
          workerPath: base + 'worker.min.js',
          workerBlobURL: false,
          corePath: base,
          langPath: base,
          cacheMethod: 'none',
        });
        await slot.worker.setParameters({ user_defined_dpi: '300', tessedit_do_invert: '0' });
        if (!this.worker) this.worker = slot.worker;
        return slot.worker;
      })().catch((e) => { slot.ready = null; throw e; });
    }
    return slot.ready;
  },

  addSlot() { const slot = { worker: null, ready: null, job: null }; this.slots.push(slot); return slot; },

  /** The first scanner, started if needed. */
  async init() {
    if (!this.slots.length) this.addSlot();
    return this.ready(this.slots[0]);
  },

  /**
   * Queues one page. The page you are looking at (high) jumps the line, read-ahead pages wait at the back.
   * Several pages are read at the same time on a phone with spare cores. A failing page is retried 3 times
   * with a fresh scanner. run(worker) does the work.
   */
  schedule(key, label, run, high, owner) {
    const running = this.slots.find((s) => s.job && s.job.key === key);
    if (running) return running.job.promise;
    const waiting = this.jobs.find((j) => j.key === key);
    if (waiting) { if (high) this.promote(key); return waiting.promise; }
    const job = { key, label, run, high, owner: owner || 'reader' };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    if (high) this.jobs.unshift(job); else this.jobs.push(job);
    this.pump();
    return job.promise;
  },

  /** Drops a closed book's reader pages (not the background scan), so they never hold up anything else. */
  cancel(prefix, owner) {
    const mine = (j) => j.key.startsWith(prefix) && (!owner || j.owner === owner);
    for (const slot of this.slots) {
      const cur = slot.job;
      if (cur && mine(cur)) {        // a page in progress belongs to a closed book: let go of it now
        cur.cancelled = true;
        const e = new Error('cancelled'); e.reason = 'cancelled';
        cur.reject(e);
        slot.job = null;
      }
    }
    this.jobs = this.jobs.filter((j) => {
      if (!mine(j)) return true;
      const e = new Error('cancelled'); e.reason = 'cancelled';
      j.reject(e);
      return false;
    });
    setTimeout(() => this.pump());
    this.changed();
  },

  promote(key) {
    const i = this.jobs.findIndex((j) => j.key === key);
    if (i > 0) this.jobs.unshift(this.jobs.splice(i, 1)[0]);
    if (i >= 0) this.jobs[0].high = true;
  },

  pump() {
    while (this.jobs.length) {
      let slot = this.slots.find((s) => !s.job);
      if (!slot && this.slots.length < this.size()) slot = this.addSlot();
      if (!slot) break;
      this.runOn(slot, this.jobs.shift());
    }
    this.changed();
  },

  async runOn(slot, job) {
    slot.job = job;
    this.changed();
    let err = null;
    for (let attempt = 1; attempt <= 3 && !job.cancelled; attempt++) {
      try {
        const out = await this.timeout((async () => job.run(await this.ready(slot)))(), 120000);
        if (!job.cancelled) job.resolve(out);
        err = null;
        break;
      } catch (e) {
        err = e;
        if (!job.cancelled) await this.resetSlot(slot);  // a crashed scanner stays broken: start a fresh one
      }
    }
    if (!job.cancelled && err) job.reject(this.explain(err));
    if (slot.job === job) slot.job = null;
    this.pump();
  },

  changed() { if (this.onChange) this.onChange(this.current && this.current.label, this.jobs.length); },

  timeout(p, ms) {
    return Promise.race([p, new Promise((_, bad) => setTimeout(() => bad(new Error('timeout')), ms))]);
  },

  async resetSlot(slot) {
    const w = slot.worker;
    slot.worker = null;
    slot.ready = null;
    if (this.worker === w) this.worker = null;
    try { if (w) await w.terminate(); } catch (e) { /* already gone */ }
  },

  async reset() { for (const s of this.slots) await this.resetSlot(s); },

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
  async read(canvas, worker) {
    worker = worker || await this.init();
    const pre = await this.clean(canvas);
    await Words.load();
    const caps = await this.readDropCaps(pre.caps, worker);
    if (pre.gutter) {
      // Two columns: read the left column, then the right one, so their lines never get mixed.
      const W = pre.canvas.width, H = pre.canvas.height, g = pre.gutter;
      const left = await worker.recognize(pre.canvas, { rectangle: { left: 0, top: 0, width: g, height: H } });
      const right = await worker.recognize(pre.canvas, { rectangle: { left: g, top: 0, width: W - g, height: H } });
      return { html: this.layout(left.data, caps, pre.medH) + '\n' + this.layout(right.data, [], pre.medH), confidence: Math.min(left.data.confidence, right.data.confidence) };
    }
    const { data } = await worker.recognize(pre.canvas);
    const small = await this.readSmallPrint(pre.canvas, data, worker);
    if (small) return { html: this.layout(small.data, [], small.medH), confidence: small.data.confidence };
    return { html: this.layout(data, caps, pre.medH), confidence: data.confidence };
  },

  /**
   * Small print: when the words came out tiny and the scanner was unsure, read an enlarged copy of the
   * text area again and keep whichever reading is more confident.
   */
  async readSmallPrint(page, data, worker) {
    const words = (data.words || []).filter((w) => w.confidence > 15 && w.bbox.y1 > w.bbox.y0);
    if (words.length < 8 || data.confidence >= 80) return null;
    const hs = words.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
    const wordH = hs[hs.length >> 1];
    if (wordH >= 28) return null;
    const pad = wordH * 2;
    const x0 = Math.max(0, Math.min(...words.map((w) => w.bbox.x0)) - pad), y0 = Math.max(0, Math.min(...words.map((w) => w.bbox.y0)) - pad);
    const x1 = Math.min(page.width, Math.max(...words.map((w) => w.bbox.x1)) + pad), y1 = Math.min(page.height, Math.max(...words.map((w) => w.bbox.y1)) + pad);
    const f = Math.min(44 / wordH, 3, Math.sqrt(12e6 / Math.max(1, (x1 - x0) * (y1 - y0))));
    if (f < 1.3) return null;
    const big = document.createElement('canvas');
    big.width = Math.round((x1 - x0) * f); big.height = Math.round((y1 - y0) * f);
    const ctx = big.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, big.width, big.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(page, x0, y0, x1 - x0, y1 - y0, 0, 0, big.width, big.height);
    const again = (await worker.recognize(big)).data;
    return again.confidence > data.confidence + 5 ? { data: again, medH: Math.round(wordH * f * 0.6) } : null;
  },

  /* ---------------- 1 + 2: clean the image ---------------- */
  /** Cleans a page image in a background thread (the maths is in clean-worker.js) and returns canvases for the scanner. */
  clean(src) {
    const w = src.width, h = src.height;
    const img = src.getContext('2d').getImageData(0, 0, w, h).data;
    if (!this.cleaner) {
      this.cleaner = new Worker('js/clean-worker.js');
      this.cleanJobs = {};
      this.cleaner.onmessage = (e) => { const j = this.cleanJobs[e.data.id]; delete this.cleanJobs[e.data.id]; if (j) j.ok(e.data.r); };
      this.cleaner.onerror = (e) => { for (const id of Object.keys(this.cleanJobs)) { this.cleanJobs[id].bad(new Error('page clean-up failed: ' + (e.message || ''))); delete this.cleanJobs[id]; } this.cleaner = null; };
    }
    const id = (this.cleanId = (this.cleanId || 0) + 1);
    return new Promise((ok, bad) => {
      this.cleanJobs[id] = { ok, bad };
      this.cleaner.postMessage({ id, img: img.buffer, w, h }, [img.buffer]);
    }).then((r) => {
      const toCanvas = (data, cw, ch) => { const c = document.createElement('canvas'); c.width = cw; c.height = ch; c.getContext('2d').putImageData(new ImageData(data, cw, ch), 0, 0); return c; };
      for (const c of r.caps) c.variants = c.variants.map((v) => toCanvas(v.data, v.width, v.height));
      return { canvas: toCanvas(r.out, w, h), caps: r.caps, medH: r.medH, box: r.box, gutter: r.gutter };
    });
  },

  /* ---------------- 3: read the drop caps ---------------- */
  async readDropCaps(caps, worker) {
    const found = [];
    if (!caps.length) return found;
    await worker.setParameters({ tessedit_pageseg_mode: '10', tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' });
    try {
      for (const c of caps.slice(0, 4)) {
        let best = null;
        for (const cv of c.variants) {
          const { data } = await worker.recognize(cv);
          const t = (data.text || '').trim();
          if (/^[A-Z]$/.test(t) && data.confidence >= 78 && (!best || data.confidence > best.conf)) best = { letter: t, conf: data.confidence };
          if (best) break;                       // found it: skip the second try
        }
        if (best) found.push({ letter: best.letter, x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 });
      }
    } finally {
      await worker.setParameters({ tessedit_pageseg_mode: '3', tessedit_char_whitelist: '' });
    }
    return found;
  },

  /* ---------------- 3: build paragraphs ---------------- */
  layout(data, caps, medH) {
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const junk = /^[|\\/~_=<>^`´¨°•·.,;:]+$/;
    const lines = [];
    for (const ln of data.lines || []) {
      const words = (ln.words || []).map((w, k, all) => {
        // in sans-serif type a capital I looks like a bar: a lone bar or l next to words is "I"
        if (/^[|l1]$/.test((w.text || '').trim()) && all.length > 1) return { ...w, text: 'I', confidence: Math.max(w.confidence, 60) };
        // a real word with a speck glued to its edge (“lifted) scores low: keep the clean core
        const core = (w.text || '').trim().replace(/^[^A-Za-z0-9]+/, '');
        return w.confidence < 55 && w.confidence >= 30 && core.length >= 4 && /^[A-Za-z]+[.,;:!?'’”)]*$/.test(core) ? { ...w, text: core, confidence: 60 } : w;
      }).filter((w) => {
        const t = (w.text || '').trim();
        if (!t || junk.test(t)) return false;
        if (!/[A-Za-z0-9]/.test(t)) return t.length === 1 && /[—–-]/.test(t);       // keep a lone dash
        // a real English word is kept even when the scan is unsure (blurry copies); anything else needs confidence
        const core = t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
        const real = core.length >= 2 && Words.rank && Words.rank.has(core.toLowerCase());
        if (w.confidence < (real ? 20 : 55)) return false;
        if (t.length <= 2 && w.confidence < (real ? 30 : 75) && !/^(a|an|am|as|at|be|by|do|go|he|if|in|is|it|me|my|no|of|on|or|so|to|up|us|we|I|A)$/i.test(t)) return false;
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
      if (first[0] && first[0].toUpperCase() === cap.letter && first.length > 3) { /* the letter is already there */ }
      else if (/^[IA]$/.test(cap.letter) && !Words.known(cap.letter + first) && Words.known(first.replace(/[^A-Za-z]/g, ''))) cand.words.unshift(cap.letter);   // "I went", "A day"
      else cand.words[0] = cap.letter + first;   // "HE" -> "THE"
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

  CONFUSIONS: [['rn', 'm'], ['m', 'rn'], ['m', 'rr'], ['nn', 'm'], ['cl', 'd'], ['d', 'cl'], ['li', 'h'], ['h', 'li'], ['vv', 'w'], ['ii', 'u'], ['ri', 'n'],
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
