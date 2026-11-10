'use strict';

const { EventEmitter } = require('node:events');
const { scanRoms } = require('./scanner/rom-scanner');
const { scanPcGames } = require('./scanner/pc');
const { readJson, writeJsonAtomic } = require('./config');
const { demoLibrary } = require('./demo');
const { SYSTEM_BY_ID } = require('./systems');
const { EMULATORS } = require('./launch/emulators');
const { sortKey } = require('./titles');

/**
 * The game index. Holds full records (paths, launch commands) in the main
 * process and hands the renderer a reduced, path-free view that is already
 * merged with the user's own data (favourites, renames, play history) and
 * any scraped details.
 *
 * Start-up shows the index cached from the previous run immediately, then a
 * background rescan reconciles it with the disk and emits 'changed'.
 *
 * Events: 'status' { phase, found, message }   'changed' ()
 */
class Library extends EventEmitter {
  constructor({ file, config, artStore, metaStore, userData, demo = false }) {
    super();
    this.file = file;
    this.config = config;
    this.art = artStore;
    this.meta = metaStore;
    this.user = userData;
    this.demo = demo;
    this.games = new Map();
    this.status = { phase: 'idle', found: 0, message: '' };
    this.pcStatus = {};
    this._scan = null;
    this._cancel = null;
  }

  async init() {
    if (this.demo) {
      for (const g of demoLibrary()) this.games.set(g.id, g);
      return this;
    }
    const cached = await readJson(this.file, null);
    if (cached && cached.version === 1 && Array.isArray(cached.games)) {
      for (const g of cached.games) if (g && g.id && g.systemId && SYSTEM_BY_ID.has(g.systemId)) this.games.set(g.id, g);
    }
    return this;
  }

  get(id) {
    return this.games.get(id);
  }

  all() {
    return [...this.games.values()];
  }

  /** The emulator a ROM would launch with: per-game choice, then the system's. */
  emulatorFor(game) {
    const system = SYSTEM_BY_ID.get(game.systemId);
    if (!system || system.kind !== 'rom') return '';
    const configured = this.config.data.systems[system.id] || {};
    return this.user.raw(game.id).emulator || configured.emulator || system.emulator;
  }

  /** Renderer view of one game: no file paths, no launch commands. */
  publicGame(g) {
    const user = this.user.describe(g.id);
    const emulator = this.emulatorFor(g);
    return {
      id: g.id, systemId: g.systemId, source: g.source,
      title: user.title || g.title,
      sortTitle: user.title ? sortKey(user.title) : g.sortTitle,
      originalTitle: g.title,
      region: g.region || '', launcher: g.launcher || '',
      art: this.art.describe(g.id),
      meta: this.meta.get(g.id),
      user,
      canResume: !!(emulator && EMULATORS[emulator] && EMULATORS[emulator].resume),
    };
  }

  list() {
    return this.all().map((g) => this.publicGame(g));
  }

  _setStatus(phase, message = '', found = this.status.found) {
    this.status = { phase, found, message };
    this.emit('status', this.status);
  }

  /** Rescans everything. Concurrent calls share the scan already in flight. */
  rescan() {
    if (this.demo) return Promise.resolve();
    if (!this._scan) {
      this._scan = this._rescan()
        .catch((err) => this._setStatus('error', err.message))
        .finally(() => { this._scan = null; this._cancel = null; });
    }
    return this._scan;
  }

  async _rescan() {
    const next = new Map();
    const warnings = [];
    this._setStatus('scanning', 'Scanning ROM folders', 0);

    let lastTick = 0;
    const roms = scanRoms(this.config.data, (batch) => {
      for (const g of batch) next.set(g.id, g);
      const now = Date.now();
      if (now - lastTick > 120) { // throttle IPC, not the scan
        lastTick = now;
        this._setStatus('scanning', 'Scanning ROM folders', next.size);
      }
    }, (w) => warnings.push(w));
    this._cancel = roms.cancel;

    const [romResult, pcResult] = await Promise.allSettled([roms.promise, scanPcGames(this.config.data.pc)]);
    if (romResult.status === 'rejected') warnings.push(`ROM scan failed: ${romResult.reason.message}`);
    if (pcResult.status === 'fulfilled') {
      for (const g of pcResult.value.games) next.set(g.id, g);
      this.pcStatus = pcResult.value.status;
    } else {
      warnings.push(`PC scan failed: ${pcResult.reason.message}`);
    }

    this.games = next;
    await writeJsonAtomic(this.file, { version: 1, games: this.all() }).catch((err) => warnings.push(err.message));
    this.emit('changed');
    this._setStatus('idle', warnings.length ? warnings.slice(0, 3).join(' · ') : '', next.size);
  }

  dispose() {
    if (this._cancel) this._cancel();
    this.removeAllListeners();
  }
}

module.exports = { Library };
