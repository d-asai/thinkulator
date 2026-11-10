'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { SYSTEMS } = require('../src/main/systems');

const renderer = (file) => path.join(__dirname, '..', 'src', 'renderer', file);
const load = (file) => import(pathToFileURL(renderer(file)).href);
const HEX = /^#[0-9a-f]{6}$/i;

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('themes: every console has one, with valid colours and known motifs', async () => {
  const { THEMES, themeFor } = await load('themes.js');
  const motifSource = fs.readFileSync(renderer('engine/Backdrop.js'), 'utf8');

  for (const system of SYSTEMS) {
    const theme = THEMES[system.id];
    assert.ok(theme, `${system.id} has no theme`);
    for (const colour of [...theme.base, theme.shelf, theme.rail, theme.card.paper, theme.card.ink]) {
      assert.match(colour, HEX, `${system.id}: ${colour}`);
    }
    assert.ok(['light', 'dark'].includes(theme.ink), `${system.id}: ink`);
    assert.ok(theme.edge >= 0 && theme.edge <= 1, `${system.id}: edge`);
    for (const [type] of theme.motifs) {
      assert.ok(new RegExp(`\\n  ${type}\\(ctx`).test(motifSource), `${system.id}: unknown motif ${type}`);
    }
  }
  assert.equal(themeFor({ kind: 'system', id: 'snes' }).id, 'snes');
  assert.equal(themeFor({ kind: 'collection', id: '@collection:x' }).id, 'neutral', 'mixed shelves are neutral');
  assert.equal(themeFor(null).id, 'neutral');
});

test('themes: interface text and shelf labels are readable on every backdrop', async () => {
  const { THEMES, themeFor } = await load('themes.js');
  for (const id of Object.keys(THEMES)) {
    const theme = themeFor({ kind: 'system', id });
    // Text sits over the lower part of the backdrop, behind a scrim of the same tone.
    const overBackdrop = contrast(theme.hud.ink, theme.base[1]);
    assert.ok(overBackdrop >= 4.5, `${id}: HUD text contrast ${overBackdrop.toFixed(1)} is below 4.5`);
    const onCard = contrast(theme.card.ink, theme.card.paper);
    assert.ok(onCard >= 7, `${id}: label contrast ${onCard.toFixed(1)} is below 7`);
  }
});

test('voices: every console has one, and it only uses things the synth implements', async () => {
  const { VOICES } = await load('audio/voices.js');
  const oscillators = ['pulse12', 'pulse25', 'pulse50', 'triangle', 'sine', 'saw', 'fm', 'pluck', 'bell'];
  const sets = ['chip', 'console16', 'chime', 'deep', 'soft'];
  for (const system of SYSTEMS) {
    const v = VOICES[system.id];
    assert.ok(v, `${system.id} has no voice`);
    assert.ok(oscillators.includes(v.osc), `${system.id}: oscillator ${v.osc}`);
    assert.ok(sets.includes(v.set), `${system.id}: phrase set ${v.set}`);
    assert.ok(v.gain > 0 && v.gain <= 1, `${system.id}: gain`);
    assert.equal(v.bed, undefined, `${system.id}: there is no background sound`);
  }
});
