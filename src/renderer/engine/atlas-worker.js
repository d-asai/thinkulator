/**
 * Texture stitching worker.
 *
 * Takes up to three separate scans (front, back, spine) and composites them
 * into the single back|spine|front|edge atlas described in atlas-layout.js.
 * Image decoding, scaling and compositing all happen here on an
 * OffscreenCanvas, so the render thread never hitches while a shelf fills in.
 *
 * Whatever is missing is synthesised: a spine and back are derived from the
 * front cover's colours, and a game with no art at all gets a generated cover
 * so the shelf never shows a blank box.
 *
 * in : { reqId, id, title, label, profile, res, urls: {front,back,spine}, atlasUrl, persist }
 * out: { reqId, ok, bitmap, persist?: ArrayBuffer }   (bitmap + buffer transferred)
 */
import { atlasLayout, atlasSize } from './atlas-layout.js';

const FONT = '"Bahnschrift", "DIN Alternate", "Roboto Condensed", "Arial Narrow", sans-serif';

// Sleeve colours for games with no artwork: a small, fixed set of printed
// inks, so a shelf of them looks like one series rather than random noise.
const SLEEVES = [
  { paper: '#7c2f2a', ink: '#f1e7d3', second: '#5f211d' }, // oxblood
  { paper: '#1f3b5c', ink: '#efe6d2', second: '#162c46' }, // navy
  { paper: '#2f4d3b', ink: '#efe6d2', second: '#223a2c' }, // forest
  { paper: '#c99a2e', ink: '#1c1711', second: '#a97f1f' }, // mustard
  { paper: '#1e5a60', ink: '#efe6d2', second: '#154449' }, // teal
  { paper: '#4c3156', ink: '#efe6d2', second: '#382340' }, // plum
  { paper: '#a9552b', ink: '#f4ead6', second: '#86411f' }, // rust
  { paper: '#3b4650', ink: '#efe6d2', second: '#2b343c' }, // slate
  { paper: '#cfc2a4', ink: '#1c1711', second: '#b9aa88' }, // cream
  { paper: '#24211e', ink: '#e4dac3', second: '#34302b' }, // charcoal
];

function setType(ctx, weight, size, spacing = 0) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  if ('fontStretch' in ctx) ctx.fontStretch = 'condensed';
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`;
}

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    const out = await stitch(msg);
    const transfer = [out.bitmap];
    if (out.persist) transfer.push(out.persist);
    self.postMessage({ reqId: msg.reqId, ok: true, ...out }, transfer);
  } catch (err) {
    self.postMessage({ reqId: msg.reqId, ok: false, error: String(err && err.message ? err.message : err) });
  }
};

async function loadBitmap(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Average colour of an image, as HSL. Drives the synthesised spine and back. */
function averageHsl(bitmap) {
  const c = new OffscreenCanvas(8, 8);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, 8, 8);
  const d = ctx.getImageData(0, 0, 8, 8).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  return rgbToHsl(r / n / 255, g / n / 255, b / n / 255);
}

function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

const hsl = (h, s, l, a = 1) => `hsla(${((h % 360) + 360) % 360}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%, ${a})`;

/** Scale-to-fill ("cover") draw, centred. */
function drawCover(ctx, bmp, x, y, w, h) {
  const scale = Math.max(w / bmp.width, h / bmp.height);
  const sw = w / scale, sh = h / scale;
  ctx.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, x, y, w, h);
}

/** Greedy word wrap at the largest font size (<= maxSize) that fits the box. */
function fitText(ctx, text, maxWidth, maxHeight, maxSize, weight = 800) {
  const words = text.split(/\s+/).filter(Boolean);
  for (let size = maxSize; size >= 8; size -= Math.max(1, Math.round(size * 0.06))) {
    setType(ctx, weight, size);
    const lines = [];
    let line = '';
    let ok = true;
    for (const word of words) {
      if (ctx.measureText(word).width > maxWidth) { ok = false; break; }
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= maxWidth) line = next;
      else { lines.push(line); line = word; }
    }
    if (!ok) continue;
    if (line) lines.push(line);
    const lineHeight = size * 0.98;
    if (lines.length * lineHeight <= maxHeight) return { size, lines, lineHeight };
  }
  setType(ctx, weight, 8);
  return { size: 8, lines: [text], lineHeight: 9 };
}

function clipRect(ctx, x, y, w, h, fn) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  fn();
  ctx.restore();
}

// ---- synthesised faces -----------------------------------------------------
//
// A game with no artwork gets a typographic sleeve in the manner of an
// archive edition: one flat ink, one geometric mark, the title set large in
// condensed capitals, and a catalogue number. Flat colour only, so it prints
// crisply at any size and never looks like a missing image.

const catalogue = (id) => String(hashString(id) % 10000).padStart(4, '0');

function proceduralFront(ctx, m, sleeve, x, y, w, h) {
  const rand = mulberry32(hashString(m.id));
  clipRect(ctx, x, y, w, h, () => {
    ctx.fillStyle = sleeve.paper;
    ctx.fillRect(x, y, w, h);

    // One mark per title, chosen and placed by its id so it never changes.
    const pad = w * 0.085;
    const mark = Math.floor(rand() * 4);
    ctx.fillStyle = sleeve.second;
    if (mark === 0) {
      ctx.beginPath();
      ctx.arc(x + w * (0.56 + rand() * 0.2), y + h * 0.36, w * 0.34, 0, Math.PI * 2);
      ctx.fill();
    } else if (mark === 1) {
      ctx.beginPath();
      ctx.moveTo(x + w, y);
      ctx.arc(x + w, y, w * 0.78, Math.PI / 2, Math.PI);
      ctx.closePath();
      ctx.fill();
    } else if (mark === 2) {
      const bars = 5;
      const barH = h * 0.052;
      for (let i = 0; i < bars; i++) ctx.fillRect(x + pad + (w * 0.09) * i, y + h * 0.18 + i * barH * 1.7, w - pad * 2 - (w * 0.09) * i, barH);
    } else {
      ctx.beginPath();
      ctx.moveTo(x, y + h * 0.62);
      ctx.lineTo(x + w, y + h * 0.2);
      ctx.lineTo(x + w, y + h * 0.5);
      ctx.lineTo(x, y + h * 0.92);
      ctx.closePath();
      ctx.fill();
    }

    // Header line: platform on the left, catalogue number on the right.
    const small = Math.max(7, h * 0.03);
    ctx.fillStyle = sleeve.ink;
    ctx.textBaseline = 'alphabetic';
    setType(ctx, 600, small, small * 0.14);
    ctx.textAlign = 'left';
    ctx.fillText(m.label.toUpperCase(), x + pad, y + pad + small * 0.8, w * 0.6);
    ctx.textAlign = 'right';
    ctx.globalAlpha = 0.75;
    ctx.fillText(`No. ${catalogue(m.id)}`, x + w - pad, y + pad + small * 0.8);
    ctx.globalAlpha = 1;
    ctx.fillRect(x + pad, y + pad + small * 1.35, w - pad * 2, Math.max(1, h * 0.0045));

    // Title, bottom-left, as large as it will go.
    const fit = fitText(ctx, m.title.toUpperCase(), w - pad * 2, h * 0.42, h * 0.15, 700);
    ctx.textAlign = 'left';
    let ty = y + h - pad - (fit.lines.length - 1) * fit.lineHeight;
    for (const line of fit.lines) {
      ctx.fillText(line, x + pad, ty);
      ty += fit.lineHeight;
    }
  });
}

function proceduralSpine(ctx, m, sleeve, x, y, w, h) {
  clipRect(ctx, x, y, w, h, () => {
    ctx.fillStyle = sleeve.paper;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = sleeve.second;
    ctx.fillRect(x, y + h * 0.9, w, h * 0.1);

    // Western spines read top to bottom.
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(Math.PI / 2);
    const size = Math.max(6, Math.min(w * 0.6, h * 0.055));
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = sleeve.ink;
    setType(ctx, 700, size, size * 0.04);
    ctx.fillText(m.title.toUpperCase(), -h * 0.44, size * 0.06, h * 0.62);
    ctx.textAlign = 'right';
    setType(ctx, 600, size * 0.62, size * 0.08);
    ctx.fillText(m.label.toUpperCase(), h * 0.385, size * 0.06, h * 0.18);
    ctx.restore();
  });
}

function proceduralBack(ctx, m, sleeve, front, x, y, w, h) {
  const rand = mulberry32(hashString(m.id) ^ 0x9e3779b9);
  clipRect(ctx, x, y, w, h, () => {
    let ink = sleeve.ink;
    if (front) {
      // Real front art but no back scan: a dark wash of the cover keeps them related.
      ctx.filter = `blur(${Math.round(h * 0.05)}px) saturate(1.1)`;
      drawCover(ctx, front, x - w * 0.12, y - h * 0.12, w * 1.24, h * 1.24);
      ctx.filter = 'none';
      ctx.fillStyle = 'rgba(10, 9, 8, 0.74)';
      ctx.fillRect(x, y, w, h);
      ink = '#efe6d2';
    } else {
      ctx.fillStyle = sleeve.paper;
      ctx.fillRect(x, y, w, h);
    }

    const pad = w * 0.085;
    const small = Math.max(7, h * 0.03);
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    setType(ctx, 600, small, small * 0.14);
    ctx.fillText(m.label.toUpperCase(), x + pad, y + pad + small * 0.8, w - pad * 2);
    ctx.fillRect(x + pad, y + pad + small * 1.35, w - pad * 2, Math.max(1, h * 0.0045));

    const fit = fitText(ctx, m.title.toUpperCase(), w - pad * 2, h * 0.22, h * 0.075, 700);
    let ty = y + pad + small * 1.35 + h * 0.03 + fit.size * 0.86;
    for (const line of fit.lines) {
      ctx.fillText(line, x + pad, ty);
      ty += fit.lineHeight;
    }

    // Catalogue number bottom-left, barcode bottom-right.
    setType(ctx, 600, small, small * 0.14);
    ctx.globalAlpha = 0.8;
    ctx.fillText(`No. ${catalogue(m.id)}`, x + pad, y + h - pad);
    ctx.globalAlpha = 1;

    const bw = w * 0.3, bh = h * 0.08;
    const bx = x + w - pad - bw, by = y + h - pad - bh;
    ctx.fillStyle = '#f3efe6';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = '#14110e';
    for (let cx = bx + bw * 0.06; cx < bx + bw * 0.94;) {
      const lw = bw * (0.008 + rand() * 0.022);
      ctx.fillRect(cx, by + bh * 0.12, lw, bh * 0.76);
      cx += lw + bw * (0.008 + rand() * 0.02);
    }
  });
}

/** Soft darkening towards each face's border: reads as depth / print wear. */
function faceShading(ctx, x, y, w, h, strength) {
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, `rgba(0,0,0,${strength})`);
  g.addColorStop(0.06, 'rgba(0,0,0,0)');
  g.addColorStop(0.94, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${strength})`);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}

// ---- main ------------------------------------------------------------------

async function stitch(m) {
  // Fast path: an atlas stitched on a previous run.
  if (m.atlasUrl) {
    const cached = await loadBitmap(m.atlasUrl);
    if (cached) return { bitmap: cached, persist: null };
  }

  const [front, back, spine] = await Promise.all([loadBitmap(m.urls.front), loadBitmap(m.urls.back), loadBitmap(m.urls.spine)]);

  const p = m.profile;
  const { width: W, height: H } = atlasSize(p, m.res);
  const layout = atlasLayout(p);
  const col = (name) => ({ x: layout[name][0] * W, w: (layout[name][1] - layout[name][0]) * W });
  const cBack = col('back'), cSpine = col('spine'), cFront = col('front'), cEdge = col('edge');

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';

  const sleeve = SLEEVES[hashString(`${m.id}:sleeve`) % SLEEVES.length];
  const tone = front ? averageHsl(front) : null;
  // A missing spine beside real cover art takes its colour from that art.
  const spineSleeve = tone
    ? { paper: hsl(tone.h, Math.min(0.5, tone.s), 0.16), second: hsl(tone.h, Math.min(0.5, tone.s), 0.1), ink: '#efe6d2' }
    : sleeve;

  // Case plastic shows through wherever the sleeve does not cover.
  ctx.fillStyle = p.caseColor;
  ctx.fillRect(0, 0, W, H);

  const inset = p.style === 'case' ? p.inset * H : 0;
  const fx = cFront.x + inset, fw = cFront.w - inset * 2;
  const bx = cBack.x + inset, bw = cBack.w - inset * 2;
  const fy = inset, fh = H - inset * 2;

  if (front) drawCover(ctx, front, fx, fy, fw, fh);
  else proceduralFront(ctx, m, sleeve, fx, fy, fw, fh);

  if (back) drawCover(ctx, back, bx, fy, bw, fh);
  else proceduralBack(ctx, m, sleeve, front, bx, fy, bw, fh);

  if (spine) {
    if (spine.width > spine.height) {
      // Scanned lying down: stand it up.
      ctx.save();
      ctx.translate(cSpine.x + cSpine.w / 2, H / 2);
      ctx.rotate(Math.PI / 2);
      drawCover(ctx, spine, -fh / 2, -cSpine.w / 2, fh, cSpine.w);
      ctx.restore();
    } else {
      drawCover(ctx, spine, cSpine.x, fy, cSpine.w, fh);
    }
  } else {
    proceduralSpine(ctx, m, spineSleeve, cSpine.x, fy, cSpine.w, fh);
  }

  // Edge swatch: bare card for cardboard boxes, plastic otherwise.
  const card = tone ? hsl(tone.h, Math.min(tone.s, 0.4), 0.12) : sleeve.second;
  ctx.fillStyle = p.style === 'cardboard' && p.id !== 'pc-steelbook' ? card : p.caseColor;
  ctx.fillRect(cEdge.x - 1, 0, cEdge.w + 2, H);

  faceShading(ctx, cFront.x, 0, cFront.w, H, 0.16);
  faceShading(ctx, cBack.x, 0, cBack.w, H, 0.16);
  faceShading(ctx, cSpine.x, 0, cSpine.w, H, 0.24);

  for (const b of [front, back, spine]) if (b) b.close();

  let persist = null;
  if (m.persist && front) {
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
    persist = await blob.arrayBuffer();
  }
  return { bitmap: canvas.transferToImageBitmap(), persist };
}
