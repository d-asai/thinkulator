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

const FONT = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';

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
    ctx.font = `${weight} ${size}px ${FONT}`;
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
    const lineHeight = size * 1.08;
    if (lines.length * lineHeight <= maxHeight) return { size, lines, lineHeight };
  }
  ctx.font = `${weight} 8px ${FONT}`;
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

function proceduralFront(ctx, m, tone, x, y, w, h) {
  const rand = mulberry32(hashString(m.id));
  clipRect(ctx, x, y, w, h, () => {
    const g = ctx.createLinearGradient(x, y, x + w * 0.6, y + h);
    g.addColorStop(0, hsl(tone.h, 0.62, 0.36));
    g.addColorStop(0.55, hsl(tone.h + 28, 0.6, 0.2));
    g.addColorStop(1, hsl(tone.h + 60, 0.55, 0.08));
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);

    // A seeded motif so every title gets its own, stable artwork.
    const motif = Math.floor(rand() * 3);
    ctx.globalCompositeOperation = 'screen';
    if (motif === 0) {
      for (let i = 0; i < 5; i++) {
        const r = w * (0.18 + rand() * 0.42);
        const cx = x + rand() * w, cy = y + rand() * h * 0.7;
        const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        rg.addColorStop(0, hsl(tone.h + 150 + rand() * 60, 0.8, 0.55, 0.55));
        rg.addColorStop(1, hsl(tone.h + 150, 0.8, 0.5, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(x, y, w, h);
      }
    } else if (motif === 1) {
      ctx.save();
      ctx.translate(x + w / 2, y + h * 0.38);
      ctx.rotate(-0.5 + rand() * 0.3);
      for (let i = -6; i < 7; i++) {
        ctx.fillStyle = hsl(tone.h + 170 + i * 6, 0.75, 0.55, 0.1 + rand() * 0.25);
        ctx.fillRect(-w * 1.2, i * h * 0.07, w * 2.4, h * (0.012 + rand() * 0.03));
      }
      ctx.restore();
    } else {
      const cx = x + w * (0.3 + rand() * 0.4), cy = y + h * (0.25 + rand() * 0.2);
      for (let i = 7; i > 0; i--) {
        ctx.strokeStyle = hsl(tone.h + 160 + i * 9, 0.8, 0.6, 0.08 + i * 0.035);
        ctx.lineWidth = w * 0.022;
        ctx.beginPath();
        ctx.arc(cx, cy, w * 0.09 * i, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';

    // Title block, lower third.
    const shade = ctx.createLinearGradient(0, y + h * 0.42, 0, y + h);
    shade.addColorStop(0, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(0,0,0,0.72)');
    ctx.fillStyle = shade;
    ctx.fillRect(x, y, w, h);

    const pad = w * 0.09;
    const fit = fitText(ctx, m.title.toUpperCase(), w - pad * 2, h * 0.34, h * 0.105);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = h * 0.02;
    let ty = y + h - pad - (fit.lines.length - 1) * fit.lineHeight;
    for (const line of fit.lines) {
      ctx.fillText(line, x + pad, ty);
      ty += fit.lineHeight;
    }
    ctx.shadowBlur = 0;

    // Platform band across the top.
    const band = h * 0.062;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x, y, w, band);
    ctx.fillStyle = hsl(tone.h + 180, 0.7, 0.72);
    ctx.fillRect(x, y + band, w, Math.max(1, h * 0.005));
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = `700 ${band * 0.5}px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(m.label.toUpperCase(), x + pad, y + band / 2, w - pad * 2);
  });
}

function proceduralSpine(ctx, m, tone, x, y, w, h) {
  clipRect(ctx, x, y, w, h, () => {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, hsl(tone.h, Math.min(0.65, tone.s + 0.1), 0.24));
    g.addColorStop(1, hsl(tone.h + 30, Math.min(0.6, tone.s + 0.1), 0.1));
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);

    // Western spines read top to bottom.
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(Math.PI / 2);
    const size = Math.max(6, Math.min(w * 0.56, h * 0.05));
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${size}px ${FONT}`;
    ctx.fillText(m.title, -h * 0.44, 0, h * 0.66);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = `700 ${size * 0.72}px ${FONT}`;
    ctx.fillText(m.label.toUpperCase(), h * 0.45, 0, h * 0.2);
    ctx.restore();
  });
}

function proceduralBack(ctx, m, tone, front, x, y, w, h) {
  const rand = mulberry32(hashString(m.id) ^ 0x9e3779b9);
  clipRect(ctx, x, y, w, h, () => {
    if (front) {
      // A blurred, darkened wash of the front cover keeps the two sides related.
      ctx.filter = `blur(${Math.round(h * 0.045)}px) saturate(1.2)`;
      drawCover(ctx, front, x - w * 0.1, y - h * 0.1, w * 1.2, h * 1.2);
      ctx.filter = 'none';
      ctx.fillStyle = 'rgba(6,8,12,0.66)';
      ctx.fillRect(x, y, w, h);
    } else {
      const g = ctx.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, hsl(tone.h + 20, 0.45, 0.16));
      g.addColorStop(1, hsl(tone.h + 70, 0.5, 0.07));
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
    }

    const pad = w * 0.09;
    const fit = fitText(ctx, m.title, w - pad * 2, h * 0.14, h * 0.05, 700);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    let ty = y + pad;
    for (const line of fit.lines) {
      ctx.fillText(line, x + pad, ty);
      ty += fit.lineHeight;
    }

    // Two "screenshot" panels.
    const panelW = (w - pad * 3) / 2, panelH = panelW * 0.62;
    ty += h * 0.03;
    for (let i = 0; i < 2; i++) {
      const px = x + pad + i * (panelW + pad);
      const pg = ctx.createLinearGradient(px, ty, px + panelW, ty + panelH);
      pg.addColorStop(0, hsl(tone.h + 140 + rand() * 80, 0.6, 0.42));
      pg.addColorStop(1, hsl(tone.h + rand() * 60, 0.6, 0.16));
      ctx.fillStyle = pg;
      ctx.fillRect(px, ty, panelW, panelH);
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = Math.max(1, h * 0.003);
      ctx.strokeRect(px, ty, panelW, panelH);
    }
    ty += panelH + h * 0.045;

    // Blurb, drawn as text-weight bars: reads as copy at shelf distance.
    ctx.fillStyle = 'rgba(255,255,255,0.34)';
    const barH = Math.max(1, h * 0.009);
    for (let i = 0; i < 9 && ty < y + h * 0.78; i++) {
      ctx.fillRect(x + pad, ty, (w - pad * 2) * (i % 4 === 3 ? 0.45 + rand() * 0.3 : 0.9 + rand() * 0.1), barH);
      ty += barH * 2.5 + (i % 4 === 3 ? barH * 2 : 0);
    }

    // Barcode.
    const bw = w * 0.3, bh = h * 0.085;
    const bx = x + w - pad - bw, by = y + h - pad - bh;
    ctx.fillStyle = '#f4f4f4';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = '#111';
    for (let cx = bx + bw * 0.06; cx < bx + bw * 0.94;) {
      const lw = bw * (0.008 + rand() * 0.022);
      ctx.fillRect(cx, by + bh * 0.1, lw, bh * 0.8);
      cx += lw + bw * (0.008 + rand() * 0.02);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = `700 ${h * 0.026}px ${FONT}`;
    ctx.textBaseline = 'bottom';
    ctx.fillText(m.label.toUpperCase(), x + pad, y + h - pad, w * 0.5);
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

  const tone = front ? averageHsl(front) : { h: hashString(m.id) % 360, s: 0.6, l: 0.3 };

  // Case plastic shows through wherever the sleeve does not cover.
  ctx.fillStyle = p.caseColor;
  ctx.fillRect(0, 0, W, H);

  const inset = p.style === 'case' ? p.inset * H : 0;
  const fx = cFront.x + inset, fw = cFront.w - inset * 2;
  const bx = cBack.x + inset, bw = cBack.w - inset * 2;
  const fy = inset, fh = H - inset * 2;

  if (front) drawCover(ctx, front, fx, fy, fw, fh);
  else proceduralFront(ctx, m, tone, fx, fy, fw, fh);

  if (back) drawCover(ctx, back, bx, fy, bw, fh);
  else proceduralBack(ctx, m, tone, front, bx, fy, bw, fh);

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
    proceduralSpine(ctx, m, tone, cSpine.x, fy, cSpine.w, fh);
  }

  // Edge swatch: bare card for cardboard boxes, plastic otherwise.
  ctx.fillStyle = p.style === 'cardboard' && p.id !== 'pc-steelbook' ? hsl(tone.h, Math.min(tone.s, 0.4), 0.12) : p.caseColor;
  ctx.fillRect(cEdge.x - 1, 0, cEdge.w + 2, H);

  faceShading(ctx, cFront.x, 0, cFront.w, H, 0.28);
  faceShading(ctx, cBack.x, 0, cBack.w, H, 0.28);
  faceShading(ctx, cSpine.x, 0, cSpine.w, H, 0.35);

  for (const b of [front, back, spine]) if (b) b.close();

  let persist = null;
  if (m.persist && front) {
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
    persist = await blob.arrayBuffer();
  }
  return { bitmap: canvas.transferToImageBitmap(), persist };
}
