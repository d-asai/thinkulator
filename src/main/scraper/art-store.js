'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { ID_RE } = require('../titles');

const SLOTS = ['front', 'back', 'spine'];
const ATLAS_KEY_RE = /^[a-z0-9-]{1,48}$/;
const MAX_ATLAS_BYTES = 24 * 1024 * 1024;

/** Identifies an image by its magic bytes; the URL or file extension is never trusted. */
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * On-disk art cache:  <root>/<gameId>/front.jpg | back.png | spine.png
 *                                      atlas-<profile>-<res>.webp
 *
 * front/back/spine are the scraped source images. An atlas is the stitched
 * back|spine|front texture the renderer produced from them; it is a pure
 * cache, so it is dropped whenever one of its source images changes.
 */
class ArtStore {
  constructor(root) {
    this.root = root;
    this.index = new Map(); // id -> { front, back, spine, atlases:Set, v }
  }

  async init() {
    await fsp.mkdir(this.root, { recursive: true });
    const dirs = await fsp.readdir(this.root, { withFileTypes: true });
    await Promise.all(dirs.map(async (d) => {
      if (!d.isDirectory() || !ID_RE.test(d.name)) return;
      let files;
      try {
        files = await fsp.readdir(path.join(this.root, d.name));
      } catch {
        return;
      }
      const entry = this._entry(d.name);
      for (const f of files) {
        const slot = SLOTS.find((s) => f.startsWith(`${s}.`));
        if (slot) entry[slot] = f;
        const atlas = f.match(/^atlas-([a-z0-9-]+)\.webp$/);
        if (atlas) entry.atlases.add(atlas[1]);
      }
    }));
    return this;
  }

  _entry(id) {
    let e = this.index.get(id);
    if (!e) {
      e = { front: null, back: null, spine: null, atlases: new Set(), v: 1 };
      this.index.set(id, e);
    }
    return e;
  }

  /** Renderer-facing description; file names resolve under shelf://app/art/<id>/. */
  describe(id) {
    const e = this.index.get(id);
    if (!e) return { front: null, back: null, spine: null, atlases: [], v: 0 };
    return { front: e.front, back: e.back, spine: e.spine, atlases: [...e.atlases], v: e.v };
  }

  has(id, slot) {
    const e = this.index.get(id);
    return !!(e && e[slot]);
  }

  async saveImage(id, slot, buffer) {
    if (!ID_RE.test(id) || !SLOTS.includes(slot)) throw new Error('bad art target');
    const ext = sniffImage(buffer);
    if (!ext) throw new Error('not a supported image');

    const dir = path.join(this.root, id);
    await fsp.mkdir(dir, { recursive: true });
    const entry = this._entry(id);
    const name = `${slot}.${ext}`;
    const tmp = path.join(dir, `${name}.tmp`);
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, path.join(dir, name));
    if (entry[slot] && entry[slot] !== name) await fsp.rm(path.join(dir, entry[slot]), { force: true });
    entry[slot] = name;

    // Source changed: every stitched atlas for this game is stale.
    for (const key of entry.atlases) await fsp.rm(path.join(dir, `atlas-${key}.webp`), { force: true });
    entry.atlases.clear();
    entry.v++;
  }

  async saveAtlas(id, key, buffer, forVersion) {
    if (!ID_RE.test(id) || !ATLAS_KEY_RE.test(key)) throw new Error('bad atlas target');
    if (buffer.length > MAX_ATLAS_BYTES || sniffImage(buffer) !== 'webp') throw new Error('bad atlas payload');
    const entry = this.index.get(id);
    // Stitched from art that has since been replaced: discard.
    if (!entry || entry.v !== forVersion) return false;

    const dir = path.join(this.root, id);
    const file = path.join(dir, `atlas-${key}.webp`);
    await fsp.writeFile(`${file}.tmp`, buffer);
    await fsp.rename(`${file}.tmp`, file);
    entry.atlases.add(key);
    return true;
  }

  /** Maps "/<id>/<file>" from the shelf:// protocol to a real path, or null. */
  resolve(relative) {
    const m = relative.match(/^([a-f0-9]{16})\/([a-z0-9][a-z0-9.-]*\.(?:png|jpg|webp))$/);
    return m ? path.join(this.root, m[1], m[2]) : null;
  }
}

module.exports = { ArtStore, sniffImage, SLOTS };
