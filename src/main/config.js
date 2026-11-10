'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { SYSTEMS } = require('./systems');
const { EMULATORS } = require('./launch/emulators');

function defaults() {
  const systems = {};
  for (const s of SYSTEMS) {
    if (s.kind !== 'rom') continue;
    systems[s.id] = { romDirs: [], emulator: s.emulator, core: s.core || '' };
  }
  const emulators = {};
  for (const id of Object.keys(EMULATORS)) emulators[id] = { path: '', extraArgs: [] };
  return {
    version: 1,
    systems,
    emulators,
    pc: { steam: true, epic: true, xbox: true, battlenet: true },
    scraper: {
      online: true,
      screenscraper: { devid: '', devpassword: '', softname: 'megashelf', ssid: '', sspassword: '' },
    },
  };
}

function merge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return base;
  for (const [k, v] of Object.entries(extra)) {
    if (!(k in base)) continue; // unknown keys are dropped
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) merge(base[k], v);
    else if (typeof v === typeof base[k] && Array.isArray(v) === Array.isArray(base[k])) base[k] = v;
  }
  return base;
}

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

class Config {
  constructor(file) {
    this.file = file;
    this.data = defaults();
    this._saving = Promise.resolve();
  }

  async load() {
    this.data = merge(defaults(), await readJson(this.file, null));
    let detected = false;
    for (const [id, emu] of Object.entries(EMULATORS)) {
      const entry = this.data.emulators[id];
      if (entry.path && fs.existsSync(entry.path)) continue;
      const found = emu.candidates().find((p) => fs.existsSync(p));
      if (found) { entry.path = found; detected = true; }
    }
    if (detected) await this.save();
    return this;
  }

  /** Writes are serialised so two quick changes can never interleave. */
  save() {
    this._saving = this._saving.then(() => writeJsonAtomic(this.file, this.data)).catch((err) => {
      console.error('[config] save failed:', err.message);
    });
    return this._saving;
  }

  addRomDir(systemId, dir) {
    const sys = this.data.systems[systemId];
    if (!sys) return false;
    const norm = path.resolve(dir);
    if (sys.romDirs.some((d) => path.resolve(d).toLowerCase() === norm.toLowerCase())) return false;
    sys.romDirs.push(norm);
    return true;
  }

  removeRomDir(systemId, dir) {
    const sys = this.data.systems[systemId];
    if (!sys) return false;
    const before = sys.romDirs.length;
    sys.romDirs = sys.romDirs.filter((d) => d !== dir);
    return sys.romDirs.length !== before;
  }

  /** What the settings panel shows. Scraper credentials never leave the main process. */
  describe() {
    return {
      emulators: Object.entries(EMULATORS).map(([id, emu]) => ({
        id, name: emu.name,
        path: this.data.emulators[id].path,
        found: !!this.data.emulators[id].path && fs.existsSync(this.data.emulators[id].path),
      })),
      systems: SYSTEMS.filter((s) => s.kind === 'rom').map((s) => ({
        id: s.id, name: s.name,
        emulator: this.data.systems[s.id].emulator,
        romDirs: [...this.data.systems[s.id].romDirs],
      })),
      pc: { ...this.data.pc },
      scraperOnline: this.data.scraper.online,
    };
  }
}

module.exports = { Config, readJson, writeJsonAtomic };
