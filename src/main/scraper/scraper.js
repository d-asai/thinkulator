'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { SYSTEM_BY_ID } = require('../systems');
const { sniffImage } = require('./art-store');
const { readGamelist, hasMeta } = require('./gamelist');
const { readJson, writeJsonAtomic } = require('../config');

const CONCURRENCY = 3;
const RETRY_AFTER_MS = 14 * 24 * 3600 * 1000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
const USER_AGENT = 'MegaShelf/0.1';
const SLOTS = ['front', 'back', 'spine'];

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'follow', headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) return null;
  if (Number(res.headers.get('content-length') || 0) > MAX_IMAGE_BYTES) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length <= MAX_IMAGE_BYTES && sniffImage(buf) ? buf : null;
}

async function readImage(file) {
  try {
    const buf = await fsp.readFile(file);
    return sniffImage(buf) ? buf : null;
  } catch {
    return null;
  }
}

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Plain text from a scraped HTML fragment: tags dropped, entities decoded. */
const stripHtml = (s) => String(s || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
  .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_m, name) => HTML_ENTITIES[name])
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Finds box art and game details for games that lack them.
 *
 * Art providers run in order and each fills whichever of front/back/spine it can:
 *
 *   ROMs   1. sidecar files next to the ROM  (<name>-front.png, boxart/<name>.jpg ...)
 *          2. ScreenScraper (front + back + spine), only if credentials are configured
 *          3. libretro-thumbnails (front only, no account needed)
 *   Steam  1. the Steam client's own library cache on disk
 *          2. the Steam CDN
 *
 * Details (description, year, genre, players, rating) come from:
 *
 *   ROMs   1. an EmulationStation gamelist.xml beside the ROMs (offline)
 *          2. ScreenScraper, from the same response that supplied the art
 *   Steam  the store's public appdetails endpoint
 *
 * Missing art is not an error: the renderer synthesises a spine and back from
 * the front cover, or a whole procedural box when nothing was found.
 *
 * Emits 'updated' (gameId) when art changed and 'meta' (gameId) when details did.
 */
class Scraper extends EventEmitter {
  constructor({ artStore, metaStore, userData, config, attemptsFile }) {
    super();
    this.art = artStore;
    this.meta = metaStore;
    this.user = userData;
    this.config = config;
    this.attemptsFile = attemptsFile;
    this.attempts = {};
    this.queue = [];
    this.queued = new Set();
    this.running = 0;
    this.dirCache = new Map();
    this.gamelists = new Map();
    this.stopped = false;
    this._saveTimer = null;
  }

  async init() {
    this.attempts = (await readJson(this.attemptsFile, {})) || {};
    return this;
  }

  _needsArt(game) {
    return !this.art.has(game.id, 'front') && !this.user.raw(game.id).noArt;
  }

  _needsMeta(game) {
    return !hasMeta(this.meta.get(game.id));
  }

  enqueue(games) {
    const now = Date.now();
    for (const g of games) {
      if (g.source === 'demo' || this.queued.has(g.id)) continue;
      const art = this._needsArt(g) && now - (this.attempts[g.id] || 0) >= RETRY_AFTER_MS;
      const meta = this._needsMeta(g) && now - (this.attempts[`${g.id}:meta`] || 0) >= RETRY_AFTER_MS;
      if (!art && !meta) continue;
      this.queued.add(g.id);
      this.queue.push(g);
    }
    this._pump();
  }

  /** Forget negative results so the next enqueue() retries. Pass an id to reset one game. */
  resetAttempts(gameId) {
    if (gameId) {
      delete this.attempts[gameId];
      delete this.attempts[`${gameId}:meta`];
    } else {
      this.attempts = {};
    }
    this._scheduleSave();
  }

  stop() {
    this.stopped = true;
    this.queue.length = 0;
    clearTimeout(this._saveTimer);
    this.removeAllListeners();
  }

  _pump() {
    while (!this.stopped && this.running < CONCURRENCY && this.queue.length) {
      const game = this.queue.shift();
      this.running++;
      this._scrape(game)
        .catch((err) => console.warn(`[scraper] ${game.title}: ${err.message}`))
        .finally(() => {
          this.running--;
          this.queued.delete(game.id);
          if (!this.queue.length && !this.running) { this.dirCache.clear(); this.gamelists.clear(); }
          this._pump();
        });
    }
  }

  async _scrape(game) {
    const ctx = {}; // per-game scratch space so providers can share one HTTP response

    if (this._needsArt(game)) {
      const want = () => SLOTS.filter((s) => !this.art.has(game.id, s));
      const providers = game.source === 'pc'
        ? (game.launcher === 'steam' ? [this._steamLocal, this._steamCdn] : [])
        : [this._sidecar, this._screenScraper, this._libretro];

      let changed = false;
      for (const provider of providers) {
        const missing = want();
        if (!missing.length || this.stopped) break;
        let found;
        try {
          found = await provider.call(this, game, missing, ctx);
        } catch {
          found = null; // offline, timeout, bad payload: try the next provider
        }
        for (const [slot, buf] of Object.entries(found || {})) {
          if (!buf || this.art.has(game.id, slot)) continue;
          try {
            await this.art.saveImage(game.id, slot, buf);
            changed = true;
          } catch { /* unsupported image: ignore */ }
        }
      }
      if (changed) this.emit('updated', game.id);
      if (!this.art.has(game.id, 'front')) this.attempts[game.id] = Date.now();
    }

    if (this._needsMeta(game) && !this.stopped) {
      const providers = game.source === 'pc'
        ? (game.launcher === 'steam' ? [this._steamMeta] : [])
        : [this._gamelistMeta, this._screenScraperMeta];
      let meta = null;
      for (const provider of providers) {
        try {
          meta = await provider.call(this, game, ctx);
        } catch {
          meta = null;
        }
        if (hasMeta(meta)) break;
      }
      if (hasMeta(meta)) {
        this.meta.set(game.id, meta);
        this.emit('meta', game.id);
      } else {
        this.attempts[`${game.id}:meta`] = Date.now();
      }
    }
    this._scheduleSave();
  }

  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      writeJsonAtomic(this.attemptsFile, this.attempts).catch(() => {});
    }, 2000);
  }

  get online() {
    return !!this.config.data.scraper.online;
  }

  // ---- art providers ---------------------------------------------------------

  async _listDir(dir) {
    if (!this.dirCache.has(dir)) {
      this.dirCache.set(dir, fsp.readdir(dir).then(
        (names) => new Map(names.map((n) => [n.toLowerCase(), n])),
        () => new Map(),
      ));
    }
    return this.dirCache.get(dir);
  }

  async _sidecar(game, missing) {
    const romDir = path.dirname(game.path);
    const base = game.fileName.toLowerCase();
    const out = {};
    for (const dir of [romDir, path.join(romDir, 'boxart'), path.join(romDir, 'media'), path.join(romDir, 'covers')]) {
      const names = await this._listDir(dir);
      if (!names.size) continue;
      for (const slot of missing) {
        if (out[slot]) continue;
        const stems = [`${base}-${slot}`, `${base}.${slot}`, `${base}_${slot}`];
        if (slot === 'front' && dir !== romDir) stems.push(base);
        for (const stem of stems) {
          const ext = IMAGE_EXTS.find((e) => names.has(stem + e));
          if (!ext) continue;
          out[slot] = await readImage(path.join(dir, names.get(stem + ext)));
          if (out[slot]) break;
        }
      }
    }
    return out;
  }

  async _libretro(game, missing) {
    if (!this.online || !missing.includes('front')) return null;
    const system = SYSTEM_BY_ID.get(game.systemId);
    if (!system || !system.libretro) return null;
    // libretro-thumbnails file naming: these characters become "_".
    const name = game.fileName.replace(/[&*/:`<>?\\|"]/g, '_');
    const url = `https://thumbnails.libretro.com/${encodeURIComponent(system.libretro)}/Named_Boxarts/${encodeURIComponent(name)}.png`;
    return { front: await download(url) };
  }

  /** One ScreenScraper lookup per game, shared by the art and details providers. */
  async _screenScraperGame(game, ctx) {
    if ('ss' in ctx) return ctx.ss;
    ctx.ss = null;
    const creds = this.config.data.scraper.screenscraper;
    const system = SYSTEM_BY_ID.get(game.systemId);
    if (!this.online || !creds.devid || !creds.devpassword || !system || !system.screenscraperId) return null;

    const q = new URLSearchParams({
      devid: creds.devid, devpassword: creds.devpassword, softname: creds.softname || 'megashelf',
      output: 'json', systemeid: String(system.screenscraperId),
      romtype: 'rom', romnom: path.basename(game.path),
    });
    if (creds.ssid) { q.set('ssid', creds.ssid); q.set('sspassword', creds.sspassword); }
    if (game.size) q.set('romtaille', String(game.size));

    const res = await fetch(`https://api.screenscraper.fr/api2/jeuInfos.php?${q}`, {
      signal: AbortSignal.timeout(20000), headers: { 'user-agent': USER_AGENT },
    });
    if (!res.ok) return null;
    const body = await res.json();
    ctx.ss = (body && body.response && body.response.jeu) || null;
    return ctx.ss;
  }

  async _screenScraper(game, missing, ctx) {
    const jeu = await this._screenScraperGame(game, ctx);
    const medias = jeu && jeu.medias;
    if (!Array.isArray(medias)) return null;

    const regionPref = { USA: ['us', 'wor', 'eu', 'jp'], Europe: ['eu', 'wor', 'us', 'jp'], Japan: ['jp', 'wor', 'us', 'eu'] }[game.region]
      || ['us', 'wor', 'eu', 'jp'];
    const pick = (type) => {
      const all = medias.filter((m) => m.type === type && m.url);
      for (const r of regionPref) {
        const hit = all.find((m) => m.region === r);
        if (hit) return hit.url;
      }
      return all.length ? all[0].url : null;
    };

    const types = { front: 'box-2D', back: 'box-2D-back', spine: 'box-2D-side' };
    const out = {};
    for (const slot of missing) {
      const url = pick(types[slot]);
      if (url) out[slot] = await download(url);
    }
    return out;
  }

  async _steamLocal(game, missing) {
    if (!missing.includes('front') || !game.steamRoot) return null;
    const cache = path.join(game.steamRoot, 'appcache', 'librarycache');
    const names = ['library_600x900.jpg', 'library_capsule.jpg'];
    const candidates = [path.join(cache, `${game.appId}_library_600x900.jpg`)];
    const appDir = path.join(cache, String(game.appId));
    for (const n of names) candidates.push(path.join(appDir, n));
    // Newer clients nest the files one hashed directory deeper.
    try {
      for (const d of await fsp.readdir(appDir, { withFileTypes: true })) {
        if (d.isDirectory()) for (const n of names) candidates.push(path.join(appDir, d.name, n));
      }
    } catch { /* no per-app directory */ }
    for (const file of candidates) {
      const buf = await readImage(file);
      if (buf) return { front: buf };
    }
    return null;
  }

  async _steamCdn(game, missing) {
    if (!this.online || !missing.includes('front') || !/^\d+$/.test(String(game.appId))) return null;
    const bases = [
      `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${game.appId}`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appId}`,
    ];
    for (const base of bases) {
      for (const file of ['library_600x900_2x.jpg', 'library_600x900.jpg']) {
        const buf = await download(`${base}/${file}`);
        if (buf) return { front: buf };
      }
    }
    return null;
  }

  // ---- details providers -----------------------------------------------------

  async _gamelistMeta(game) {
    const romDir = path.dirname(game.path);
    const file = path.basename(game.path).toLowerCase();
    for (const dir of [romDir, path.dirname(romDir)]) {
      if (!this.gamelists.has(dir)) this.gamelists.set(dir, readGamelist(dir));
      const hit = (await this.gamelists.get(dir)).get(file);
      if (hit) return hit;
    }
    return null;
  }

  async _screenScraperMeta(game, ctx) {
    const jeu = await this._screenScraperGame(game, ctx);
    if (!jeu) return null;
    const text = (list, lang = 'en') => {
      if (!Array.isArray(list)) return '';
      const hit = list.find((x) => x.langue === lang) || list[0];
      return hit ? String(hit.text || '') : '';
    };
    const date = Array.isArray(jeu.dates) && jeu.dates.length ? String(jeu.dates[0].text || '') : '';
    const genre = Array.isArray(jeu.genres) && jeu.genres.length ? text(jeu.genres[0].noms) : '';
    const note = jeu.note && Number(jeu.note.text);
    return {
      description: stripHtml(text(jeu.synopsis)),
      year: /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : 0,
      genre,
      players: jeu.joueurs ? String(jeu.joueurs.text || '') : '',
      rating: note > 0 ? Math.min(1, note / 20) : 0,
      developer: jeu.developpeur ? String(jeu.developpeur.text || '') : '',
      publisher: jeu.editeur ? String(jeu.editeur.text || '') : '',
    };
  }

  async _steamMeta(game) {
    if (!this.online || !/^\d+$/.test(String(game.appId))) return null;
    const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${game.appId}&l=english`, {
      signal: AbortSignal.timeout(15000), headers: { 'user-agent': USER_AGENT },
    });
    if (!res.ok) return null;
    const body = await res.json();
    const data = body && body[game.appId] && body[game.appId].success ? body[game.appId].data : null;
    if (!data) return null;
    const year = /(\d{4})/.exec((data.release_date && data.release_date.date) || '');
    const categories = (data.categories || []).map((c) => c.description);
    return {
      description: stripHtml(data.short_description),
      year: year ? Number(year[1]) : 0,
      genre: (data.genres || []).slice(0, 2).map((g) => g.description).join(', '),
      players: categories.includes('Multi-player') ? (categories.includes('Single-player') ? 'Single and multiplayer' : 'Multiplayer') : 'Single player',
      rating: data.metacritic && data.metacritic.score ? data.metacritic.score / 100 : 0,
      developer: (data.developers || []).slice(0, 2).join(', '),
      publisher: (data.publishers || []).slice(0, 2).join(', '),
    };
  }
}

module.exports = { Scraper, stripHtml };
