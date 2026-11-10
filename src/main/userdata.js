'use strict';

const { readJson, writeJsonAtomic } = require('./config');
const { makeId } = require('./titles');

const MAX_COLLECTIONS = 64;

/**
 * Everything the user has decided about their games, kept apart from the
 * scanned index so a rescan can never lose it:
 *
 *   games[id]    favourite, hidden, renamed title, play statistics,
 *                per-game emulator / core / extra arguments, art preference
 *   collections  user-made shelves: { id, name, games: [gameId] }
 *
 * Only non-default values are stored, so the file stays small and readable.
 */
class UserData {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, games: {}, collections: [] };
    this._saving = Promise.resolve();
    this._timer = null;
  }

  async load() {
    const raw = await readJson(this.file, null);
    if (raw && typeof raw === 'object') {
      if (raw.games && typeof raw.games === 'object') this.data.games = raw.games;
      if (Array.isArray(raw.collections)) {
        this.data.collections = raw.collections
          .filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string' && Array.isArray(c.games));
      }
    }
    return this;
  }

  /** Debounced: rapid changes (favouriting several games) become one write. */
  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this._timer);
    this._saving = this._saving
      .then(() => writeJsonAtomic(this.file, this.data))
      .catch((err) => console.error('[userdata] save failed:', err.message));
    return this._saving;
  }

  raw(id) {
    return this.data.games[id] || {};
  }

  describe(id) {
    const g = this.raw(id);
    return {
      favorite: !!g.favorite, hidden: !!g.hidden, title: g.title || '',
      playCount: g.playCount || 0, lastPlayed: g.lastPlayed || 0, playSeconds: g.playSeconds || 0,
      emulator: g.emulator || '', core: g.core || '', extraArgs: Array.isArray(g.extraArgs) ? g.extraArgs : [],
      noArt: !!g.noArt,
    };
  }

  /** Merges `changes` into a game. Empty values remove the key (back to default). */
  patch(id, changes) {
    const g = this.data.games[id] || (this.data.games[id] = {});
    for (const [key, value] of Object.entries(changes)) {
      const empty = value === null || value === undefined || value === false || value === ''
        || (Array.isArray(value) && value.length === 0);
      if (empty) delete g[key];
      else g[key] = value;
    }
    if (!Object.keys(g).length) delete this.data.games[id];
    this.save();
  }

  recordLaunch(id) {
    const g = this.raw(id);
    this.patch(id, { playCount: (g.playCount || 0) + 1, lastPlayed: Date.now() });
  }

  addPlayTime(id, seconds) {
    if (!(seconds > 0)) return;
    this.patch(id, { playSeconds: Math.round((this.raw(id).playSeconds || 0) + seconds) });
  }

  // ---- collections -----------------------------------------------------------

  collections() {
    return this.data.collections.map((c) => ({ id: c.id, name: c.name, games: [...c.games] }));
  }

  createCollection(name) {
    const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!clean || this.data.collections.length >= MAX_COLLECTIONS) return null;
    const existing = this.data.collections.find((c) => c.name.toLowerCase() === clean.toLowerCase());
    if (existing) return existing.id;
    const collection = { id: makeId('collection', clean, Date.now()), name: clean, games: [] };
    this.data.collections.push(collection);
    this.save();
    return collection.id;
  }

  deleteCollection(id) {
    const before = this.data.collections.length;
    this.data.collections = this.data.collections.filter((c) => c.id !== id);
    if (this.data.collections.length !== before) this.save();
  }

  /** Adds the game to the collection, or removes it if it is already there. */
  toggleInCollection(collectionId, gameId) {
    const c = this.data.collections.find((x) => x.id === collectionId);
    if (!c) return;
    const at = c.games.indexOf(gameId);
    if (at >= 0) c.games.splice(at, 1);
    else c.games.push(gameId);
    this.save();
  }
}

module.exports = { UserData };
