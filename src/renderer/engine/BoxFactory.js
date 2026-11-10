import * as THREE from './three.js';
import { atlasLayout } from './atlas-layout.js';

/**
 * Physical box profiles. Dimensions are real-world millimetres / 100, so one
 * scene unit is 10 cm and a DVD case is 1.9 units tall.
 *
 *   style     how the stitcher paints the sleeve ('cardboard' prints edge to
 *             edge; 'case' insets the paper sleeve inside a plastic rim)
 *   inset     width of that rim, as a fraction of the box height
 *   caseColor colour of the rim and of the top/bottom/opening edges
 *   surface   PBR response: cardboard is rough and matte, a DVD case has a
 *             glossy clear-coat film over the sleeve, a steelbook is metal
 */
export const PROFILES = {
  'nes-cardboard': {
    w: 1.27, h: 1.78, d: 0.25, style: 'cardboard', inset: 0, caseColor: '#141414',
    surface: { roughness: 0.88, metalness: 0, clearcoat: 0.04, clearcoatRoughness: 0.9, envMapIntensity: 0.35 },
  },
  // SNES boxes are landscape.
  'snes-cardboard': {
    w: 1.78, h: 1.27, d: 0.3, style: 'cardboard', inset: 0, caseColor: '#101010',
    surface: { roughness: 0.88, metalness: 0, clearcoat: 0.04, clearcoatRoughness: 0.9, envMapIntensity: 0.35 },
  },
  // Genesis games came in a chunky black plastic clamshell.
  'genesis-clamshell': {
    w: 1.32, h: 1.8, d: 0.25, style: 'case', inset: 0.014, caseColor: '#0c0c0e',
    surface: { roughness: 0.5, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.25, envMapIntensity: 0.7 },
  },
  // Game Boy family: small, nearly square cardboard.
  'gb-cardboard': {
    w: 1.24, h: 1.24, d: 0.22, style: 'cardboard', inset: 0, caseColor: '#121212',
    surface: { roughness: 0.88, metalness: 0, clearcoat: 0.04, clearcoatRoughness: 0.9, envMapIntensity: 0.35 },
  },
  // N64 boxes are landscape, like SNES.
  'n64-cardboard': {
    w: 1.78, h: 1.27, d: 0.3, style: 'cardboard', inset: 0, caseColor: '#101010',
    surface: { roughness: 0.88, metalness: 0, clearcoat: 0.04, clearcoatRoughness: 0.9, envMapIntensity: 0.35 },
  },
  // CD jewel case (PlayStation, Dreamcast): wider than tall, hard clear plastic.
  'jewel-case': {
    w: 1.42, h: 1.25, d: 0.1, style: 'case', inset: 0.02, caseColor: '#cfd6de',
    surface: { roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.2 },
  },
  'nds-case': {
    w: 1.37, h: 1.25, d: 0.15, style: 'case', inset: 0.018, caseColor: '#17171b',
    surface: { roughness: 0.42, metalness: 0, clearcoat: 0.85, clearcoatRoughness: 0.12, envMapIntensity: 0.9 },
  },
  // UMD case: tall and narrow, clear.
  'psp-case': {
    w: 1.05, h: 1.77, d: 0.14, style: 'case', inset: 0.016, caseColor: '#dfe6ee',
    surface: { roughness: 0.25, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.1 },
  },
  'gamecube-case': {
    w: 1.35, h: 1.9, d: 0.14, style: 'case', inset: 0.018, caseColor: '#16161a',
    surface: { roughness: 0.42, metalness: 0, clearcoat: 0.85, clearcoatRoughness: 0.12, envMapIntensity: 0.9 },
  },
  'ps2-case': {
    w: 1.35, h: 1.9, d: 0.14, style: 'case', inset: 0.018, caseColor: '#0d0d10',
    surface: { roughness: 0.42, metalness: 0, clearcoat: 0.85, clearcoatRoughness: 0.12, envMapIntensity: 0.9 },
  },
  'xbox-case': {
    w: 1.35, h: 1.9, d: 0.14, style: 'case', inset: 0.018, caseColor: '#5fae2e',
    surface: { roughness: 0.42, metalness: 0, clearcoat: 0.85, clearcoatRoughness: 0.12, envMapIntensity: 0.9 },
  },
  'wii-case': {
    w: 1.35, h: 1.9, d: 0.15, style: 'case', inset: 0.018, caseColor: '#eef0f2',
    surface: { roughness: 0.4, metalness: 0, clearcoat: 0.85, clearcoatRoughness: 0.12, envMapIntensity: 0.9 },
  },
  // Blu-ray size: shorter than a DVD case, translucent rim.
  'ps3-case': {
    w: 1.35, h: 1.71, d: 0.14, style: 'case', inset: 0.016, caseColor: '#c9d2dc',
    surface: { roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.05 },
  },
  // Modern slim clear case.
  'pc-slim': {
    w: 1.35, h: 1.9, d: 0.075, style: 'case', inset: 0.012, caseColor: '#dfe6ee',
    surface: { roughness: 0.22, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.15 },
  },
  // Printed metal: the cover art itself is the reflective surface.
  'pc-steelbook': {
    w: 1.35, h: 1.72, d: 0.13, style: 'cardboard', inset: 0, caseColor: '#9aa3ad',
    surface: { roughness: 0.34, metalness: 0.92, clearcoat: 0.5, clearcoatRoughness: 0.2, envMapIntensity: 1.35 },
  },
  'pc-xbox': {
    w: 1.35, h: 1.9, d: 0.1, style: 'case', inset: 0.016, caseColor: '#107c10',
    surface: { roughness: 0.36, metalness: 0, clearcoat: 0.9, clearcoatRoughness: 0.1, envMapIntensity: 1 },
  },
  // 1990s PC "big box".
  'pc-bigbox': {
    w: 1.9, h: 2.35, d: 0.45, style: 'cardboard', inset: 0, caseColor: '#0f1014',
    surface: { roughness: 0.8, metalness: 0, clearcoat: 0.1, clearcoatRoughness: 0.7, envMapIntensity: 0.45 },
  },
};

for (const [id, profile] of Object.entries(PROFILES)) profile.id = id;

// GOG's catalogue is classic PC games, so it gets the big box too.
const PC_BY_LAUNCHER = {
  steam: 'pc-slim', epic: 'pc-steelbook', xbox: 'pc-xbox', battlenet: 'pc-bigbox',
  gog: 'pc-bigbox', ea: 'pc-slim', ubisoft: 'pc-steelbook',
};

/** Chooses the physical box for a game: platform first, PC storefront second. */
export function profileFor(game, system) {
  if (system.kind === 'pc') return PROFILES[PC_BY_LAUNCHER[game.launcher]] || PROFILES['pc-slim'];
  return PROFILES[system.profile] || PROFILES['ps2-case'];
}

// BoxGeometry emits faces in this order, four vertices each, in the order
// top-left, top-right, bottom-left, bottom-right as seen from outside.
const FACE_COLUMNS = ['edge', 'spine', 'edge', 'edge', 'front', 'back']; // +x -x +y -y +z -z

/**
 * Builds box geometry and materials.
 *
 * Geometry is created once per profile and shared by every box of that
 * platform: a thousand PS2 games reference the same 24 vertices. Only the
 * material (a few uniforms plus one texture reference) is per box, and those
 * are pooled by ShelfView, so the number of GPU objects is bounded by what is
 * on screen, never by the size of the library.
 */
export class BoxFactory {
  constructor() {
    this.geometries = new Map();
    this.placeholder = BoxFactory.makePlaceholder();
  }

  static makePlaceholder() {
    const data = new Uint8Array([46, 49, 58, 255]);
    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  geometry(profile) {
    let geo = this.geometries.get(profile.id);
    if (geo) return geo;

    geo = new THREE.BoxGeometry(profile.w, profile.h, profile.d);
    const layout = atlasLayout(profile);
    const uv = geo.attributes.uv;
    // Pull each column in slightly so mip-mapping never bleeds a neighbour.
    const pad = 0.0015;
    FACE_COLUMNS.forEach((column, face) => {
      const [u0, u1] = layout[column];
      const a = u0 + pad;
      const b = u1 - pad;
      const i = face * 4;
      // Atlas textures are uploaded unflipped (ImageBitmap), so v = 0 is the top row.
      uv.setXY(i, a, 0);
      uv.setXY(i + 1, b, 0);
      uv.setXY(i + 2, a, 1);
      uv.setXY(i + 3, b, 1);
    });
    uv.needsUpdate = true;
    this.geometries.set(profile.id, geo);
    return geo;
  }

  /** One per pooled box. Every profile enables clear-coat, so they all share one shader program. */
  createMaterial() {
    return new THREE.MeshPhysicalMaterial({ map: this.placeholder, color: 0xffffff });
  }

  applySurface(material, profile) {
    const s = profile.surface;
    material.roughness = s.roughness;
    material.metalness = s.metalness;
    material.clearcoat = s.clearcoat;
    material.clearcoatRoughness = s.clearcoatRoughness;
    material.envMapIntensity = s.envMapIntensity;
  }

  dispose() {
    for (const geo of this.geometries.values()) geo.dispose();
    this.geometries.clear();
    this.placeholder.dispose();
  }
}
