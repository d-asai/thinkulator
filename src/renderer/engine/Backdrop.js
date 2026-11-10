import * as THREE from './three.js';
import { SmoothValue } from '../util/motion.js';

// The plane is sized to just cover the view, so one canvas pixel is close to
// one screen pixel and fine patterns (scanlines, LCD dots) stay crisp.
const WIDTH = 1920;
const HEIGHT = 960;
const PLANE_WIDTH = 14;
const BASE_DISTANCE = 8.8; // camera distance the plane size was chosen for

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * The motif layers a theme can ask for. Each is deliberately quiet: the
 * backdrop sets a mood behind the boxes and must never compete with them.
 */
const MOTIFS = {
  // CRT: a dark line every few pixels.
  scanlines(ctx, w, h, color, a) {
    ctx.fillStyle = rgba(color, a);
    for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1.5);
  },
  pinstripe(ctx, w, h, color, a) {
    ctx.fillStyle = rgba(color, a);
    for (let y = 10; y < h; y += 18) ctx.fillRect(0, y, w, 1.5);
  },
  grid(ctx, w, h, color, a) {
    ctx.fillStyle = rgba(color, a);
    for (let x = 0; x < w; x += 56) ctx.fillRect(x, 0, 1.5, h);
    for (let y = 0; y < h; y += 56) ctx.fillRect(0, y, w, 1.5);
  },
  // LCD: a field of small square pixels.
  dotmatrix(ctx, w, h, color, a) {
    ctx.fillStyle = rgba(color, a);
    for (let y = 0; y < h; y += 6) for (let x = 0; x < w; x += 6) ctx.fillRect(x, y, 4, 4);
  },
  diagonal(ctx, w, h, color, a) {
    ctx.fillStyle = rgba(color, a);
    for (let i = -1; i < 4; i++) {
      const x = i * w * 0.34;
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x + w * 0.16, h);
      ctx.lineTo(x + w * 0.16 + h * 0.7, 0);
      ctx.lineTo(x + h * 0.7, 0);
      ctx.closePath();
      ctx.fill();
    }
  },
  // A soft pool of each colour in each corner.
  corners(ctx, w, h, colors, a) {
    const at = [[0, 0], [w, 0], [0, h], [w, h]];
    colors.forEach((color, i) => {
      const [x, y] = at[i % 4];
      const g = ctx.createRadialGradient(x, y, 0, x, y, w * 0.42);
      g.addColorStop(0, rgba(color, a));
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    });
  },
  // Concentric arcs entering from the lower right.
  rings(ctx, w, h, color, a) {
    ctx.strokeStyle = rgba(color, a);
    ctx.lineWidth = 2;
    for (let r = h * 0.3; r < w * 1.1; r += h * 0.13) {
      ctx.beginPath();
      ctx.arc(w * 1.02, h * 1.1, r, Math.PI, Math.PI * 1.5);
      ctx.stroke();
    }
  },
  tiles(ctx, w, h, color, a) {
    const size = 120;
    for (let y = 0, row = 0; y < h; y += size, row++) {
      for (let x = 0, col = 0; x < w; x += size, col++) {
        ctx.fillStyle = rgba(color, (row + col) % 2 ? a : a * 0.35);
        ctx.fillRect(x + 3, y + 3, size - 6, size - 6);
      }
    }
  },
  // A handful of soft points of light, placed once.
  motes(ctx, w, h, color, a) {
    const rand = mulberry32(41);
    for (let i = 0; i < 46; i++) {
      const x = rand() * w, y = rand() * h, r = 2 + rand() * 9;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(color, a * (0.3 + rand() * 0.7)));
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  },
  // Light rising from below the shelf.
  glow(ctx, w, h, color, a) {
    const g = ctx.createRadialGradient(w / 2, h * 1.05, 0, w / 2, h * 1.05, w * 0.62);
    g.addColorStop(0, rgba(color, a));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  },
  bands(ctx, w, h, color, a) {
    for (const [y, t] of [[0.3, 0.16], [0.52, 0.09], [0.7, 0.2]]) {
      const g = ctx.createLinearGradient(0, h * (y - t / 2), 0, h * (y + t / 2));
      g.addColorStop(0, rgba(color, 0));
      g.addColorStop(0.5, rgba(color, a));
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, h * (y - t / 2), w, h * t);
    }
  },
  // One diagonal highlight, like light catching a glossy surface.
  sheen(ctx, w, h, color, a) {
    const g = ctx.createLinearGradient(w * 0.15, 0, w * 0.75, h);
    g.addColorStop(0.3, rgba(color, 0));
    g.addColorStop(0.5, rgba(color, a));
    g.addColorStop(0.7, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  },
};

export function drawBackdrop(canvas, theme) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const base = ctx.createLinearGradient(0, 0, 0, h);
  base.addColorStop(0, theme.base[0]);
  base.addColorStop(1, theme.base[1]);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  for (const [type, color, strength] of theme.motifs) {
    if (MOTIFS[type]) MOTIFS[type](ctx, w, h, color, strength);
  }

  // Corners fall away, so the eye settles on the middle of the shelf.
  const edge = ctx.createRadialGradient(w / 2, h * 0.5, h * 0.25, w / 2, h * 0.5, w * 0.68);
  edge.addColorStop(0, 'rgba(0, 0, 0, 0)');
  edge.addColorStop(1, `rgba(0, 0, 0, ${theme.edge})`);
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, w, h);
}

/**
 * The wall behind the shelves. It shows the active console's theme and
 * cross-fades when the shelf changes. Two planes and two canvases exist in
 * total; a change redraws one canvas, so memory does not grow with the number
 * of consoles. The planes are unlit, so the colours are exactly the theme's.
 */
export class Backdrop {
  constructor(stage) {
    this.stage = stage;
    this.geometry = new THREE.PlaneGeometry(PLANE_WIDTH, PLANE_WIDTH * (HEIGHT / WIDTH));
    this.layers = [0, 1].map((i) => {
      const canvas = document.createElement('canvas');
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, fog: false, transparent: true, opacity: 0, depthWrite: false });
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.position.z = -0.95 + i * 0.004;
      mesh.renderOrder = -10 + i;
      stage.scene.add(mesh);
      return { canvas, texture, material, mesh };
    });
    this.front = 0; //            index of the layer fading in
    this.fade = new SmoothValue(1, 0.22);
    this.themeId = '';
    this.atmosphere = new THREE.Color(stage.scene.background);
    this.targetAtmosphere = new THREE.Color(stage.scene.background);
  }

  /** @param instant skip the cross-fade (first frame, or after a rebuild) */
  set(theme, instant = false) {
    if (theme.id === this.themeId) return;
    this.themeId = theme.id;

    // The layer that was fading in becomes the settled one underneath.
    this.front = 1 - this.front;
    const next = this.layers[this.front];
    const prev = this.layers[1 - this.front];
    drawBackdrop(next.canvas, theme);
    next.texture.needsUpdate = true;
    // The incoming layer must always be the nearer of the two.
    next.mesh.position.z = -0.946;
    prev.mesh.position.z = -0.95;
    next.mesh.renderOrder = -9;
    prev.mesh.renderOrder = -10;
    prev.material.opacity = 1;
    const first = !this.started;
    this.started = true;
    this.fade.snap(instant || first ? 1 : 0);
    this.fade.target = 1;
    if (first) instant = true;
    next.material.opacity = this.fade.value;

    // Fog and clear colour follow the backdrop's own edge, so distant boxes fade into it.
    this.targetAtmosphere.set(theme.base[1]).multiplyScalar(1 - theme.edge * 0.6);
    if (instant) this.atmosphere.copy(this.targetAtmosphere);
  }

  /** @returns true while a cross-fade is in progress */
  update(dt, y) {
    // Narrow windows pull the camera back; grow the wall to keep the view covered.
    const scale = Math.max(1, this.stage.cameraDistance / BASE_DISTANCE) * Math.max(1, this.stage.camera.aspect / 2.3);
    for (const layer of this.layers) {
      layer.mesh.position.y = y + 1;
      layer.mesh.scale.setScalar(scale);
    }
    let moving = this.fade.update(dt);
    this.layers[this.front].material.opacity = this.fade.value;

    if (!this.atmosphere.equals(this.targetAtmosphere)) {
      this.atmosphere.lerp(this.targetAtmosphere, 1 - Math.exp(-7 * dt));
      const d = Math.abs(this.atmosphere.r - this.targetAtmosphere.r) + Math.abs(this.atmosphere.g - this.targetAtmosphere.g)
        + Math.abs(this.atmosphere.b - this.targetAtmosphere.b);
      if (d < 0.002) this.atmosphere.copy(this.targetAtmosphere);
      moving = true;
    }
    this.stage.scene.background.copy(this.atmosphere);
    this.stage.scene.fog.color.copy(this.atmosphere);
    return moving;
  }

  dispose() {
    for (const layer of this.layers) {
      this.stage.scene.remove(layer.mesh);
      layer.material.dispose();
      layer.texture.dispose();
    }
    this.geometry.dispose();
  }
}
