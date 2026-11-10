import * as THREE from './three.js';
import { profileFor } from './BoxFactory.js';
import { SmoothValue, clamp } from '../util/motion.js';
import { letterOf } from '../library/shelves.js';

export const SHELF_SPACING = 2.95; //  vertical distance between shelves
const BOX_GAP = 0.2; //                 air between neighbouring boxes
const FOCUS_SPREAD = 0.2; //            extra room cleared around the selected box
const FOCUS_FORWARD = 0.62; //          how far the selected box steps off the shelf
const FOCUS_SCALE = 0.1;
const NEIGHBOUR_YAW = 0.2; //           neighbours turn slightly towards the centre
const SHELF_RES = 512;
const PLANKS = 5;

/**
 * The matrix: one shelf per system stacked along Y, games laid out along X.
 *
 * Navigation never moves a box directly. It changes integer cursors, and two
 * kinds of damped values chase them: each shelf's `scroll` (which game is
 * centred) and the camera's `camY` (which shelf is centred). Every box
 * position is a pure function of those values, so motion is always
 * continuous, however fast the input repeats.
 *
 * Only boxes inside the camera's window exist. Each is a pooled mesh that is
 * re-pointed at a different game as the window slides, so scrolling a shelf
 * of 5,000 games allocates nothing.
 */
export class ShelfView {
  constructor({ stage, factory, textures }) {
    this.stage = stage;
    this.factory = factory;
    this.textures = textures;

    this.root = new THREE.Group();
    stage.scene.add(this.root);

    this.shelves = [];
    this.active = 0;
    this.camY = new SmoothValue(0, 0.17);
    this.dim = new SmoothValue(0, 0.16); // 1 while a box is being inspected

    this.assigned = new Map(); // slot key -> box
    this.free = [];
    this.all = [];
    this.windowKey = '';
    this.pinned = null;
    this.onTransform = null; // (box, base) => void, set by the inspector

    this._buildPlanks();
  }

  _buildPlanks() {
    this.plankGeometry = new THREE.BoxGeometry(60, 0.1, 1.9);
    this.ledGeometry = new THREE.BoxGeometry(60, 0.022, 0.03);
    // A little emissive keeps the underside of the shelf above from reading as a pure black bar.
    this.plankMaterial = new THREE.MeshStandardMaterial({ color: 0x2a1f18, roughness: 0.55, metalness: 0.05, emissive: 0x17130f });
    this.planks = [];
    for (let i = 0; i < PLANKS; i++) {
      const plank = new THREE.Mesh(this.plankGeometry, this.plankMaterial);
      plank.receiveShadow = true;
      const led = new THREE.Mesh(this.ledGeometry, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, fog: false }));
      led.position.set(0, -0.02, 0.96);
      plank.add(led);
      plank.visible = false;
      this.root.add(plank);
      this.planks.push({ plank, led, color: new THREE.Color() });
    }
  }

  // ---- library -------------------------------------------------------------

  /**
   * @param defs    shelves from library/shelves.js: { id, name, short, accent, kind, games }
   *                (games are already filtered and sorted)
   * @param restore optional { systemId, cursors: { [shelfId]: gameId } }
   */
  setShelves(defs, restore = null) {
    const previous = restore || this.snapshot();
    this._releaseAll();

    this.shelves = [];
    for (const def of defs) {
      if (!def.games.length) continue;
      let maxW = 0;
      for (const g of def.games) {
        g.profile = profileFor(g, g.system);
        maxW = Math.max(maxW, g.profile.w);
      }
      let cursor = 0;
      const wanted = previous && previous.cursors && previous.cursors[def.id];
      if (wanted) cursor = Math.max(0, def.games.findIndex((g) => g.id === wanted));

      this.shelves.push({
        // `system` is the shelf's identity (name, short, accent). For a
        // per-console shelf that is the console; a game's own console is game.system.
        system: def, games: def.games, cursor,
        spacing: maxW + BOX_GAP,
        scroll: new SmoothValue(cursor, 0.115),
        focus: new SmoothValue(0, 0.13),
        accent: new THREE.Color(def.accent),
      });
    }

    const index = previous ? this.shelves.findIndex((sh) => sh.system.id === previous.systemId) : -1;
    this.active = index >= 0 ? index : 0;
    this.camY.snap(this._shelfY(this.active));
    this.shelves.forEach((sh, i) => sh.focus.snap(i === this.active ? 1 : 0));
    this.windowKey = '';
  }

  /** Enough to put the user back where they were after a rescan or restart. */
  snapshot() {
    if (!this.shelves.length) return null;
    const cursors = {};
    for (const s of this.shelves) if (s.games[s.cursor]) cursors[s.system.id] = s.games[s.cursor].id;
    return { systemId: this.shelves[this.active].system.id, cursors };
  }

  get isEmpty() {
    return this.shelves.length === 0;
  }

  get activeShelf() {
    return this.shelves[this.active] || null;
  }

  get activeGame() {
    const s = this.activeShelf;
    return s ? s.games[s.cursor] : null;
  }

  /** The pooled box currently showing the selected game, if it is on screen. */
  get activeBox() {
    const s = this.activeShelf;
    return s ? this.assigned.get(this._slot(this.active, s.cursor)) || null : null;
  }

  // ---- navigation ----------------------------------------------------------

  /** @returns true if the cursor moved (false at either end of the shelf). */
  move(delta) {
    const s = this.activeShelf;
    if (!s) return false;
    const next = clamp(s.cursor + delta, 0, s.games.length - 1);
    if (next === s.cursor) return false;
    s.cursor = next;
    s.scroll.target = next;
    return true;
  }

  changeShelf(delta) {
    const next = clamp(this.active + delta, 0, this.shelves.length - 1);
    if (next === this.active) return false;
    this.active = next;
    this.camY.target = this._shelfY(next);
    return true;
  }

  /**
   * Jumps to the start of the next or previous letter group on the active shelf.
   * @returns the letter landed on, or '' if the cursor could not move.
   */
  jumpLetter(direction) {
    const sh = this.activeShelf;
    if (!sh) return '';
    const games = sh.games;
    const current = letterOf(games[sh.cursor]);
    let i = sh.cursor;
    if (direction > 0) {
      while (i < games.length && letterOf(games[i]) === current) i++;
      if (i >= games.length) return '';
    } else {
      // First go to the start of this group; only then step into the previous one.
      while (i > 0 && letterOf(games[i - 1]) === current) i--;
      if (i === sh.cursor) {
        if (i === 0) return '';
        const previous = letterOf(games[i - 1]);
        i--;
        while (i > 0 && letterOf(games[i - 1]) === previous) i--;
      }
    }
    sh.cursor = i;
    sh.scroll.target = i;
    return letterOf(games[i]);
  }

  /** Moves the selection to a game wherever it is shelved. Prefers its console's shelf. */
  goToGame(gameId) {
    let fallback = null;
    for (let si = 0; si < this.shelves.length; si++) {
      const item = this.shelves[si].games.findIndex((g) => g.id === gameId);
      if (item < 0) continue;
      if (this.shelves[si].system.kind === 'system') { this.goTo(si, item); return true; }
      fallback = fallback || [si, item];
    }
    if (fallback) this.goTo(fallback[0], fallback[1]);
    return !!fallback;
  }

  goTo(shelfIndex, itemIndex) {
    if (!this.shelves[shelfIndex]) return;
    this.active = shelfIndex;
    this.camY.target = this._shelfY(shelfIndex);
    const s = this.shelves[shelfIndex];
    s.cursor = clamp(itemIndex, 0, s.games.length - 1);
    s.scroll.target = s.cursor;
  }

  /** The art for one game changed: reload it wherever it is on screen. */
  refreshGame(gameId, art) {
    for (const shelf of this.shelves) {
      const game = shelf.games.find((g) => g.id === gameId);
      if (game) game.art = art;
    }
    for (const box of this.assigned.values()) {
      if (box.game.id === gameId) this._loadTexture(box);
    }
    this.textures.invalidate(gameId);
  }

  // ---- pooling -------------------------------------------------------------

  _shelfY(index) {
    return -index * SHELF_SPACING;
  }

  _slot(shelf, item) {
    return shelf * 1000003 + item;
  }

  _createBox(geometry) {
    const material = this.factory.createMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.visible = false;
    this.root.add(mesh);
    const box = {
      mesh, material, game: null, shelf: 0, item: 0, profile: null,
      handle: null, hiHandle: null, texture: null, hiTexture: null,
      token: 0, fade: new SmoothValue(0, 0.2), shade: -1,
      base: { x: 0, y: 0, z: 0, yaw: 0, scale: 1 },
    };
    mesh.userData.box = box;
    this.all.push(box);
    return box;
  }

  _assign(shelfIndex, itemIndex) {
    const shelf = this.shelves[shelfIndex];
    const game = shelf.games[itemIndex];
    const geometry = this.factory.geometry(game.profile);
    const box = this.free.pop() || this._createBox(geometry);
    box.game = game;
    box.shelf = shelfIndex;
    box.item = itemIndex;
    box.profile = game.profile;
    box.mesh.geometry = geometry;
    this.factory.applySurface(box.material, game.profile);
    box.mesh.visible = true;
    box.shade = -1;
    this._loadTexture(box);
    return box;
  }

  _loadTexture(box) {
    if (box.handle) box.handle.release();
    const shelf = this.shelves[box.shelf];
    const token = ++box.token;
    const priority = Math.abs(box.item - shelf.cursor) + Math.abs(box.shelf - this.active) * 20;
    const handle = this.textures.acquire(box.game, box.game.system, box.profile, SHELF_RES, priority);
    box.handle = handle;
    if (handle.ready) {
      // Already cached (a shelf rebuild, or scrolling back): show it at once, no fade.
      box.texture = handle.ready;
      box.material.map = handle.ready;
      box.fade.snap(1);
      return;
    }
    box.material.map = this.factory.placeholder;
    box.fade.snap(0);
    handle.promise.then((texture) => {
      // The box may have been recycled for another game while this loaded.
      if (!texture || box.token !== token || box.handle !== handle) return;
      if (!box.hiTexture) box.material.map = texture;
      box.texture = texture;
      box.fade.target = 1;
    });
  }

  _release(box) {
    box.token++;
    if (box.handle) { box.handle.release(); box.handle = null; }
    if (box.hiHandle) { box.hiHandle.release(); box.hiHandle = null; }
    box.texture = null;
    box.hiTexture = null;
    box.material.map = this.factory.placeholder;
    box.mesh.visible = false;
    box.game = null;
    this.free.push(box);
  }

  _releaseAll() {
    for (const box of this.assigned.values()) this._release(box);
    this.assigned.clear();
    this.pinned = null;
    this.windowKey = '';
  }

  /** Swaps in a high resolution atlas for close inspection (and back). */
  setHighRes(box, on) {
    if (on && !box.hiHandle) {
      const token = box.token;
      const res = box.game.art && box.game.art.front ? 2048 : 1024;
      const handle = this.textures.acquire(box.game, box.game.system, box.profile, res, -1);
      box.hiHandle = handle;
      handle.promise.then((texture) => {
        if (!texture || box.token !== token || box.hiHandle !== handle) return;
        box.hiTexture = texture;
        box.material.map = texture;
      });
    } else if (!on && box.hiHandle) {
      box.hiHandle.release();
      box.hiHandle = null;
      box.hiTexture = null;
      box.material.map = box.texture || this.factory.placeholder;
    }
  }

  /** Recomputes which (shelf, item) slots need a mesh, and recycles the rest. */
  _syncWindow() {
    const camIndex = -this.camY.value / SHELF_SPACING;
    const first = Math.max(0, Math.floor(camIndex) - 1);
    const last = Math.min(this.shelves.length - 1, Math.ceil(camIndex) + 1);
    const halfWidth = this.stage.halfWidth * 1.3 + 1.5;

    let key = `${first}:${last}:${Math.round(halfWidth * 4)}`;
    for (let s = first; s <= last; s++) key += `|${Math.round(this.shelves[s].scroll.value)}`;
    if (key === this.windowKey) return;
    this.windowKey = key;

    const need = new Map();
    for (let s = first; s <= last; s++) {
      const shelf = this.shelves[s];
      const centre = Math.round(shelf.scroll.value);
      const reach = Math.ceil(halfWidth / shelf.spacing) + 1;
      const from = Math.max(0, centre - reach);
      const to = Math.min(shelf.games.length - 1, centre + reach);
      for (let i = from; i <= to; i++) need.set(this._slot(s, i), [s, i]);
    }
    for (const [slot, box] of this.assigned) {
      if (need.has(slot) || box === this.pinned) continue;
      this._release(box);
      this.assigned.delete(slot);
    }
    for (const [slot, [s, i]] of need) {
      if (!this.assigned.has(slot)) this.assigned.set(slot, this._assign(s, i));
    }
  }

  // ---- per-frame -----------------------------------------------------------

  /** @returns true while anything is still moving (another frame is needed). */
  update(dt) {
    if (!this.shelves.length) {
      for (const p of this.planks) p.plank.visible = false;
      return false;
    }

    let moving = this.camY.update(dt);
    moving = this.dim.update(dt) || moving;
    this.shelves.forEach((shelf, i) => {
      shelf.focus.target = i === this.active ? 1 : 0;
      moving = shelf.scroll.update(dt) || moving;
      moving = shelf.focus.update(dt) || moving;
    });

    const stage = this.stage;
    // The camera leans a touch into fast horizontal travel.
    const active = this.shelves[this.active];
    stage.camera.position.x = clamp(active.scroll.velocity * 0.012, -0.35, 0.35);
    stage.follow(this.camY.value);

    this._syncWindow();

    const dim = this.dim.value;
    for (const box of this.assigned.values()) {
      const shelf = this.shelves[box.shelf];
      moving = box.fade.update(dt) || moving;

      const d = box.item - shelf.scroll.value;
      const focus = shelf.focus.value;
      const near = Math.max(0, 1 - Math.abs(d));
      const f = near * near * (3 - 2 * near) * focus; // 1 on the selected box, 0 one slot away
      const side = clamp(d, -1, 1);
      const scale = 1 + FOCUS_SCALE * f;

      const base = box.base;
      base.x = d * shelf.spacing + side * FOCUS_SPREAD * focus;
      base.y = this._shelfY(box.shelf) + (box.profile.h * scale) / 2;
      base.z = 0.2 + box.profile.d / 2 + f * FOCUS_FORWARD;
      base.yaw = -side * NEIGHBOUR_YAW * focus;
      base.scale = scale;

      if (box === this.pinned && this.onTransform) {
        this.onTransform(box, base);
      } else {
        box.mesh.position.set(base.x, base.y, base.z);
        box.mesh.rotation.set(0, base.yaw, 0);
        box.mesh.scale.setScalar(scale);
      }

      // Brightness: inactive shelves recede, everything dims behind an inspected box.
      let shade = (0.4 + 0.6 * focus) * (0.3 + 0.7 * box.fade.value);
      if (box !== this.pinned) shade *= 1 - 0.85 * dim;
      if (Math.abs(shade - box.shade) > 0.002) {
        box.shade = shade;
        box.material.color.setScalar(shade);
      }
    }

    this._updatePlanks();
    return moving;
  }

  _updatePlanks() {
    const camIndex = Math.round(-this.camY.value / SHELF_SPACING);
    for (const p of this.planks) p.plank.visible = false;
    for (let s = camIndex - 2; s <= camIndex + 2; s++) {
      const shelf = this.shelves[s];
      if (!shelf) continue;
      const p = this.planks[((s % PLANKS) + PLANKS) % PLANKS];
      p.plank.visible = true;
      p.plank.position.set(0, this._shelfY(s) - 0.05, 0.15);
      const glow = (0.12 + 0.88 * shelf.focus.value) * (1 - 0.8 * this.dim.value);
      p.led.material.color.copy(shelf.accent).multiplyScalar(glow * 1.6);
    }
  }

  /** Mouse picking: the on-screen box under a pointer position, if any. */
  pick(raycaster) {
    const meshes = [];
    for (const box of this.assigned.values()) meshes.push(box.mesh);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    return hit ? hit.object.userData.box : null;
  }

  dispose() {
    this._releaseAll();
    for (const box of this.all) {
      box.material.dispose();
      box.mesh.userData.box = null;
    }
    for (const p of this.planks) p.led.material.dispose();
    this.plankGeometry.dispose();
    this.ledGeometry.dispose();
    this.plankMaterial.dispose();
    this.stage.scene.remove(this.root);
    this.all.length = 0;
    this.free.length = 0;
  }
}
