import * as THREE from './three.js';
import { atlasSize } from './atlas-layout.js';

const MAX_IN_FLIGHT = 3;
const DEFAULT_BUDGET = 320 * 1024 * 1024;

/**
 * Owns every box texture: loading, sharing, and above all freeing.
 *
 * A library can hold thousands of games but only a few dozen boxes are ever
 * on screen, so textures are treated as a cache:
 *
 *   - acquire() returns a ref-counted handle; equal requests share one texture
 *   - release() drops the reference. Unreferenced textures stay cached (so
 *     scrolling back is instant) until the byte budget is exceeded, then the
 *     least recently used are disposed, which frees the GPU memory
 *   - requests that are released before they were dispatched are cancelled,
 *     so holding a direction never queues work for boxes already off screen
 *   - once a texture is uploaded its ImageBitmap is closed, so the decoded
 *     pixels exist once (on the GPU) instead of twice
 */
export class TextureManager {
  constructor({ renderer, saveAtlas, onLoaded, budgetBytes = DEFAULT_BUDGET }) {
    this.renderer = renderer;
    this.saveAtlas = saveAtlas;
    this.onLoaded = onLoaded;
    this.budget = budgetBytes;
    this.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

    this.entries = new Map(); // key -> entry
    this.queue = [];
    this.inFlight = 0;
    this.bytes = 0;
    this.clock = 0;
    this.nextReq = 1;
    this.byReq = new Map();

    this.worker = new Worker(new URL('./atlas-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this._onResult(e.data);
    this.worker.onerror = (e) => console.error('[atlas-worker]', e.message);
  }

  static key(game, profile, res) {
    return `${game.id}|${profile.id}|${res}|${game.art ? game.art.v : 0}`;
  }

  /**
   * @param priority lower loads sooner (distance from the cursor)
   * @returns {{ promise: Promise<THREE.Texture|null>, release: () => void }}
   */
  acquire(game, system, profile, res, priority = 0) {
    const key = TextureManager.key(game, profile, res);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, game, system, profile, res, priority, refs: 0, state: 'queued', texture: null, bytes: 0, used: 0 };
      entry.promise = new Promise((resolve) => { entry.resolve = resolve; });
      this.entries.set(key, entry);
      this.queue.push(entry);
    } else if (entry.state === 'queued') {
      entry.priority = Math.min(entry.priority, priority);
    }
    entry.refs++;
    entry.used = ++this.clock;
    this._pump();

    let released = false;
    return {
      promise: entry.promise,
      release: () => {
        if (released) return;
        released = true;
        this._release(entry);
      },
    };
  }

  _release(entry) {
    entry.refs--;
    if (entry.refs > 0) return;
    if (entry.state === 'queued') {
      // Never dispatched: drop it entirely.
      const i = this.queue.indexOf(entry);
      if (i >= 0) this.queue.splice(i, 1);
      this.entries.delete(entry.key);
      entry.state = 'dead';
      entry.resolve(null);
    } else if (entry.state === 'ready') {
      this._trim();
    }
    // 'loading': result handler sees refs === 0 and keeps or discards it.
  }

  _pump() {
    while (this.inFlight < MAX_IN_FLIGHT && this.queue.length) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        if (this.queue[i].priority < this.queue[best].priority) best = i;
      }
      const entry = this.queue.splice(best, 1)[0];
      entry.state = 'loading';
      this.inFlight++;

      const { game, profile, res } = entry;
      const art = game.art || {};
      const base = `/art/${game.id}/`;
      const v = `?v=${art.v || 0}`;
      const atlasKey = `${profile.id}-${res}`;
      const reqId = this.nextReq++;
      this.byReq.set(reqId, entry);
      entry.atlasKey = atlasKey;
      entry.artVersion = art.v || 0;

      this.worker.postMessage({
        reqId, id: game.id, title: game.title, label: entry.system.short, res,
        profile: { id: profile.id, w: profile.w, h: profile.h, d: profile.d, style: profile.style, inset: profile.inset, caseColor: profile.caseColor },
        urls: {
          front: art.front ? base + art.front + v : null,
          back: art.back ? base + art.back + v : null,
          spine: art.spine ? base + art.spine + v : null,
        },
        atlasUrl: art.atlases && art.atlases.includes(atlasKey) ? `${base}atlas-${atlasKey}.webp${v}` : null,
        // Only shelf-resolution atlases built from real art are worth keeping on disk.
        persist: res <= 512 && !!art.front,
      });
    }
  }

  _onResult(msg) {
    const entry = this.byReq.get(msg.reqId);
    this.byReq.delete(msg.reqId);
    this.inFlight--;
    if (!entry) {
      if (msg.bitmap) msg.bitmap.close();
      this._pump();
      return;
    }

    if (!msg.ok || entry.state === 'dead') {
      if (msg.bitmap) msg.bitmap.close();
      if (!msg.ok) console.warn('[textures]', entry.game.title, msg.error);
      this.entries.delete(entry.key);
      entry.state = 'dead';
      entry.resolve(null);
      this._pump();
      return;
    }

    const bitmap = msg.bitmap;
    const texture = new THREE.Texture(bitmap);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false; // ImageBitmaps ignore UNPACK_FLIP_Y; UVs are authored top-down
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = this.anisotropy;
    // The CPU copy is released as soon as the GPU has the pixels.
    texture.onUpdate = () => {
      bitmap.close();
      texture.onUpdate = null;
    };
    texture.needsUpdate = true;

    entry.texture = texture;
    entry.state = 'ready';
    entry.bytes = Math.round(bitmap.width * bitmap.height * 4 * 1.34); // + mip chain
    entry.used = ++this.clock;
    this.bytes += entry.bytes;

    if (msg.persist && this.saveAtlas) {
      this.saveAtlas(entry.game.id, entry.atlasKey, entry.artVersion, msg.persist).catch(() => {});
    }

    entry.resolve(texture);
    if (this.onLoaded) this.onLoaded();
    this._trim();
    this._pump();
  }

  /** Evicts unreferenced textures, oldest first, until under budget. */
  _trim() {
    if (this.bytes <= this.budget) return;
    const idle = [];
    for (const e of this.entries.values()) if (e.state === 'ready' && e.refs === 0) idle.push(e);
    idle.sort((a, b) => a.used - b.used);
    for (const e of idle) {
      if (this.bytes <= this.budget) break;
      this._evict(e);
    }
  }

  _evict(entry) {
    if (entry.texture) {
      entry.texture.onUpdate = null;
      if (entry.texture.image && entry.texture.image.close) entry.texture.image.close();
      entry.texture.dispose();
      entry.texture = null;
    }
    this.bytes -= entry.bytes;
    entry.state = 'dead';
    this.entries.delete(entry.key);
  }

  /** Drops unreferenced textures of one game (its art was replaced). */
  invalidate(gameId) {
    for (const e of [...this.entries.values()]) {
      if (e.game.id === gameId && e.state === 'ready' && e.refs === 0) this._evict(e);
    }
  }

  /** After a lost WebGL context every GPU texture is gone: forget them all. */
  reset() {
    for (const e of [...this.entries.values()]) {
      if (e.state === 'ready') this._evict(e);
    }
    this.bytes = 0;
  }

  stats() {
    return { textures: this.entries.size, megabytes: Math.round(this.bytes / 1048576), queued: this.queue.length };
  }

  dispose() {
    this.worker.terminate();
    for (const e of [...this.entries.values()]) {
      if (e.state === 'ready') this._evict(e);
      else e.resolve(null);
    }
    this.entries.clear();
    this.queue.length = 0;
    this.byReq.clear();
  }
}

export { atlasSize };
