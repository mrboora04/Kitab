'use strict';
/* Page clean-up for the scanner, run off the main thread so the screen never freezes (see ocr.js, clean()). */
function cleanCore(img, w, h) {
    const n = w * h;
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
    // A page with very little text has less than 1% ink, so the darkest 1% can be plain paper.
    // Never treat paper as black: black is at least well below the paper tone.
    lo = Math.min(lo, Math.max(0, hi - 110));
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
          g[q] = 255;                                   // paint the ornament (and its soft edge) out of the page
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
          const pad = 24, vw = Math.ceil(cw) + pad * 2, vh = Math.ceil(ch) + pad * 2;
          const data = new Uint8ClampedArray(vw * vh * 4).fill(255);
          for (const p of px) {
            const X = (p % w) - cx0 + pad, Y = ((p / w) | 0) - cy0 + pad;
            if (X < 0 || Y < 0 || X >= vw || Y >= vh) continue;
            const o = (Y | 0) * vw + (X | 0);
            data[o * 4] = data[o * 4 + 1] = data[o * 4 + 2] = 0;
          }
          return { width: vw, height: vh, data };
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
    // The scanner gets the even-toned greyscale page (minus ornaments): letter edges carry detail that
    // pure black-and-white loses on small print and blurry copies.
    for (let i = 0, o = 0; i < n; i++, o += 4) out[o] = out[o + 1] = out[o + 2] = g[i];

    // The text area (letter-sized shapes only) and, if there is one, the empty gutter between two columns.
    let box = null, gutter = null;
    const letters = comps.filter((c) => c.h >= medH * 0.3 && c.h <= medH * 3.8 && c.w <= medH * 30);
    if (letters.length > 20) {
      box = { x0: w, y0: h, x1: 0, y1: 0 };
      for (const c of letters) { box.x0 = Math.min(box.x0, c.x0); box.y0 = Math.min(box.y0, c.y0); box.x1 = Math.max(box.x1, c.x1); box.y1 = Math.max(box.y1, c.y1); }
      const pad = Math.round(medH * 1.5);
      box = { x0: Math.max(0, box.x0 - pad), y0: Math.max(0, box.y0 - pad), x1: Math.min(w, box.x1 + pad), y1: Math.min(h, box.y1 + pad) };
      if (box.y1 - box.y0 > medH * 8) {
        const cols = new Uint32Array(w);
        for (const c of letters) for (let x = c.x0; x <= c.x1; x++) cols[x] += c.h;
        const from = Math.round(box.x0 + (box.x1 - box.x0) * 0.25), to = Math.round(box.x0 + (box.x1 - box.x0) * 0.75);
        let best = null, run = 0;
        for (let x = from; x <= to; x++) {
          if (cols[x] === 0) { run++; if (!best || run > best.len) best = { len: run, end: x }; } else run = 0;
        }
        if (best && best.len >= Math.max(medH * 1.2, (box.x1 - box.x0) * 0.025)) {
          const mid = best.end - Math.floor(best.len / 2);
          let l = 0, r = 0;
          for (let x = box.x0; x < box.x1; x++) (x < mid ? (l += cols[x]) : (r += cols[x]));
          if (l > (l + r) * 0.25 && r > (l + r) * 0.25) gutter = mid;
        }
      }
    }
    return { out, caps, medH, box, gutter };
}

self.onmessage = (e) => {
  const { id, img, w, h } = e.data;
  const r = cleanCore(new Uint8ClampedArray(img), w, h);
  const transfer = [r.out.buffer];
  for (const c of r.caps) for (const v of c.variants) transfer.push(v.data.buffer);
  self.postMessage({ id, r }, transfer);
};
