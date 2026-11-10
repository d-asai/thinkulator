'use strict';

const { readJson, writeJsonAtomic } = require('../config');

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Cache of scraped game details (description, year, genre...), keyed by game id. */
class MetaStore {
  constructor(file) {
    this.file = file;
    this.data = {};
    this._timer = null;
  }

  async init() {
    const raw = await readJson(this.file, null);
    if (raw && typeof raw === 'object') this.data = raw;
    return this;
  }

  get(id) {
    return this.data[id] || null;
  }

  set(id, meta) {
    this.data[id] = {
      description: str(meta.description, 1200),
      year: Number.isInteger(meta.year) && meta.year > 1950 && meta.year < 2100 ? meta.year : 0,
      genre: str(meta.genre, 80),
      players: str(meta.players, 40),
      rating: meta.rating > 0 && meta.rating <= 1 ? Math.round(meta.rating * 100) / 100 : 0,
      developer: str(meta.developer, 80),
      publisher: str(meta.publisher, 80),
    };
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 1500);
  }

  flush() {
    clearTimeout(this._timer);
    return writeJsonAtomic(this.file, this.data).catch(() => {});
  }
}

module.exports = { MetaStore };
