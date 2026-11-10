/**
 * One visual theme per console: the backdrop behind the shelf, the shelf's
 * own colour, the printed label card, and whether interface text over it is
 * light or dark.
 *
 * Each theme is an original design built from that console's hardware
 * colours and the visual language of its era (LCD dot matrix for Game Boy,
 * CRT scanlines for NES, a cool white studio for Wii). They are not copies of
 * any console's own menu screens.
 *
 *   base      top and bottom colour of the backdrop
 *   motifs    [type, colour, strength] layers drawn over it (see Backdrop.js)
 *   edge      how much the corners darken, 0..1
 *   shelf     board colour, and `rail` for its front edge
 *   card      the shelf label: paper and ink
 *   ink       'light' or 'dark' interface text over this backdrop
 */
export const THEMES = {
  neutral: {
    base: ['#17181b', '#0d0e10'], motifs: [], edge: 0.45,
    shelf: '#2a2b2f', rail: '#1b1c1f', card: { paper: '#e2e0da', ink: '#17181b' }, ink: 'light',
  },

  // Grey console, black panel, red lettering; a CRT's scanlines.
  nes: {
    base: ['#26262a', '#131316'], motifs: [['scanlines', '#000000', 0.26], ['glow', '#b3121f', 0.1]], edge: 0.5,
    shelf: '#3a3a40', rail: '#1d1d21', card: { paper: '#d6d5d0', ink: '#1a1a1c' }, ink: 'light',
  },
  // Pale grey shell with lavender and purple controls.
  snes: {
    base: ['#d6d4de', '#b4b0c4'], motifs: [['pinstripe', '#6f5fa8', 0.16]], edge: 0.16,
    shelf: '#8d88a6', rail: '#6c6688', card: { paper: '#f1f0f5', ink: '#2a2540' }, ink: 'dark',
  },
  // Black console; the era's blue grid-line look.
  genesis: {
    base: ['#0b0c12', '#050508'], motifs: [['grid', '#2b54c9', 0.22], ['glow', '#1a3aa8', 0.16]], edge: 0.5,
    shelf: '#17181f', rail: '#0c0c11', card: { paper: '#101117', ink: '#e8e9f0' }, ink: 'light',
  },
  // The four greens of the original LCD, as a dot matrix.
  gb: {
    base: ['#c8d4a2', '#aebd7f'], motifs: [['dotmatrix', '#56672f', 0.2]], edge: 0.14,
    shelf: '#5b6b38', rail: '#3f4c25', card: { paper: '#dfe7c4', ink: '#26320f' }, ink: 'dark',
  },
  // Translucent grape plastic.
  gbc: {
    base: ['#4a2f86', '#261447'], motifs: [['dotmatrix', '#b79cf2', 0.1], ['glow', '#f0b400', 0.07]], edge: 0.42,
    shelf: '#5a3f99', rail: '#33205e', card: { paper: '#efe9fb', ink: '#27143f' }, ink: 'light',
  },
  // Indigo shell.
  gba: {
    base: ['#352b8f', '#18124a'], motifs: [['diagonal', '#7f76ea', 0.1]], edge: 0.42,
    shelf: '#3f369f', rail: '#221a66', card: { paper: '#eceafc', ink: '#18124a' }, ink: 'light',
  },
  // Charcoal console with its four primary colours.
  n64: {
    base: ['#1a1a1f', '#0c0c0f'], motifs: [['corners', ['#d81e2a', '#1d57c4', '#1f9a4a', '#e8b411'], 0.34]], edge: 0.4,
    shelf: '#2a2a31', rail: '#16161a', card: { paper: '#e4e3de', ink: '#16161a' }, ink: 'light',
  },
  // Light grey plastic, photographed in a dim room.
  ps1: {
    base: ['#5b5c63', '#2c2d32'], motifs: [['sheen', '#ffffff', 0.07]], edge: 0.42,
    shelf: '#7d7e86', rail: '#4d4e55', card: { paper: '#dcdcde', ink: '#222327' }, ink: 'light',
  },
  // White console, orange accent, soft daylight.
  dreamcast: {
    base: ['#f4f2ec', '#dcd8cc'], motifs: [['rings', '#e2731b', 0.14]], edge: 0.12,
    shelf: '#c9c4b5', rail: '#a8a292', card: { paper: '#ffffff', ink: '#33302a' }, ink: 'dark',
  },
  // Indigo cube.
  gamecube: {
    base: ['#3a2f86', '#150f3a'], motifs: [['tiles', '#8f83e6', 0.09]], edge: 0.45,
    shelf: '#4a3e9c', rail: '#281f63', card: { paper: '#e9e6fa', ink: '#1a1340' }, ink: 'light',
  },
  // Black tower, deep blue light.
  ps2: {
    base: ['#050817', '#020308'], motifs: [['glow', '#1c3fb8', 0.34], ['motes', '#8fb0ff', 0.2]], edge: 0.55,
    shelf: '#0f1220', rail: '#070810', card: { paper: '#0c0f1c', ink: '#dfe5fb' }, ink: 'light',
  },
  // Black and acid green.
  xbox: {
    base: ['#060a05', '#020302'], motifs: [['glow', '#3fa310', 0.3], ['rings', '#6fd12c', 0.12]], edge: 0.55,
    shelf: '#12180f', rail: '#090c08', card: { paper: '#0c110a', ink: '#c8f2a8' }, ink: 'light',
  },
  // Silver clamshell, fine grid.
  nds: {
    base: ['#eceef2', '#c9cdd6'], motifs: [['grid', '#7b8394', 0.14]], edge: 0.14,
    shelf: '#aab0bd', rail: '#878e9c', card: { paper: '#ffffff', ink: '#262a33' }, ink: 'dark',
  },
  // Piano black with a blue-hour gradient.
  psp: {
    base: ['#2c4a78', '#0f1a30'], motifs: [['bands', '#bcd6ff', 0.08]], edge: 0.4,
    shelf: '#1a2540', rail: '#0e1526', card: { paper: '#e6ecf6', ink: '#111a2e' }, ink: 'light',
  },
  // White, clean, a breath of cyan.
  wii: {
    base: ['#f8f9fb', '#dde4ec'], motifs: [['bands', '#35c6e8', 0.1]], edge: 0.1,
    shelf: '#cfd6de', rail: '#aab4c0', card: { paper: '#ffffff', ink: '#3b4653' }, ink: 'dark',
  },
  // Glossy black.
  ps3: {
    base: ['#18181c', '#070709'], motifs: [['sheen', '#ffffff', 0.06]], edge: 0.5,
    shelf: '#1d1d22', rail: '#0d0d10', card: { paper: '#111114', ink: '#e6e6ea' }, ink: 'light',
  },
  pc: {
    base: ['#1b1e24', '#0e1014'], motifs: [['grid', '#4aa3ff', 0.05]], edge: 0.45,
    shelf: '#272b33', rail: '#171a20', card: { paper: '#e1e4ea', ink: '#14171d' }, ink: 'light',
  },
};

// Interface text colours over a backdrop: primary, secondary, tertiary, and the scrim behind them.
const INK = {
  light: { ink: '#f4f2ec', ink2: '#b4b1a9', ink3: '#7d7a73', scrim: '8, 8, 9' },
  dark: { ink: '#17171a', ink2: '#4b4a50', ink3: '#7f7e86', scrim: '250, 250, 250' },
};

/** The theme for a shelf: a console's own, or neutral for mixed shelves (favourites, collections). */
export function themeFor(shelf) {
  const id = shelf && shelf.kind === 'system' && THEMES[shelf.id] ? shelf.id : 'neutral';
  return { id, ...THEMES[id], hud: INK[THEMES[id].ink] };
}
