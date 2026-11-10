import * as THREE from './three.js';

/**
 * The materials that make the room read as a real place rather than a 3D
 * scene: wood grain for the shelves, plaster for the wall, and the printed
 * card that sits in each shelf's edge rail. All are drawn to small canvases
 * once at start-up, so nothing is downloaded and nothing is shipped as an image.
 */

export const DISPLAY_FONT = '"Bahnschrift", "DIN Alternate", "Roboto Condensed", "Arial Narrow", sans-serif';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function finish(canvas, renderer, repeatX, repeatY) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

/** Oiled walnut: long, slightly wandering grain lines over a warm base. */
export function makeWoodTexture(renderer) {
  const w = 1024, h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(7);

  ctx.fillStyle = '#4a3324';
  ctx.fillRect(0, 0, w, h);

  // Broad tonal bands first, then fine grain on top.
  for (let i = 0; i < 26; i++) {
    const y = rand() * h;
    ctx.fillStyle = rand() > 0.5 ? `rgba(92, 62, 40, ${0.1 + rand() * 0.22})` : `rgba(34, 21, 13, ${0.1 + rand() * 0.22})`;
    ctx.fillRect(0, y, w, 4 + rand() * 22);
  }
  for (let i = 0; i < 520; i++) {
    const y0 = rand() * h;
    const drift = (rand() - 0.5) * 7;
    const wobble = rand() * 2.5;
    const phase = rand() * 6.28;
    ctx.strokeStyle = rand() > 0.42 ? `rgba(24, 14, 8, ${0.05 + rand() * 0.2})` : `rgba(140, 100, 66, ${0.04 + rand() * 0.13})`;
    ctx.lineWidth = 0.5 + rand() * 1.3;
    ctx.beginPath();
    // The line ends where it starts (plus a whole number of waves) so the texture tiles.
    for (let x = 0; x <= w; x += 32) {
      const t = x / w;
      const y = y0 + Math.sin(t * 6.283 * 2 + phase) * wobble + Math.sin(t * 6.283) * drift;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return finish(canvas, renderer, 7, 1);
}

/** Matte painted plaster: a flat warm grey with a faint, uneven tooth. */
export function makePlasterTexture(renderer) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(19);
  ctx.fillStyle = '#2a2622';
  ctx.fillRect(0, 0, size, size);
  // Single-pixel flecks at very low contrast: felt rather than seen.
  for (let i = 0; i < 9000; i++) {
    ctx.fillStyle = rand() > 0.5 ? `rgba(255, 244, 228, ${0.006 + rand() * 0.016})` : `rgba(0, 0, 0, ${0.01 + rand() * 0.03})`;
    ctx.fillRect(Math.floor(rand() * size), Math.floor(rand() * size), 1, 1 + Math.floor(rand() * 2));
  }
  return finish(canvas, renderer, 40, 20);
}

export const LABEL_SIZE = { width: 1024, height: 96 };

/**
 * The card in a shelf's edge rail: system name on the left of an off-white
 * card, the count on the right, and a tab of the system's own colour. This is
 * the only place a system colour appears in the room.
 */
export function drawShelfLabel(canvas, shelf) {
  const { width: w, height: h } = LABEL_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = '#ebe4d2';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = shelf.accent;
  ctx.fillRect(0, 0, 22, h);
  // A printed keyline just inside the card edge.
  ctx.strokeStyle = 'rgba(30, 24, 18, 0.5)';
  ctx.lineWidth = 2;
  ctx.strokeRect(34, 10, w - 46, h - 20);

  ctx.fillStyle = '#1c1712';
  ctx.textBaseline = 'middle';
  ctx.font = `700 50px ${DISPLAY_FONT}`;
  if ('fontStretch' in ctx) ctx.fontStretch = 'condensed';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '3px';
  ctx.textAlign = 'left';
  ctx.fillText(shelf.name.toUpperCase(), 56, h / 2 + 3, w - 250);

  ctx.font = `400 34px ${DISPLAY_FONT}`;
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(28, 23, 18, 0.7)';
  ctx.fillText(`${shelf.games.length} ${shelf.games.length === 1 ? 'GAME' : 'GAMES'}`, w - 30, h / 2 + 3);
}
