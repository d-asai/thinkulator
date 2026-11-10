import * as THREE from './engine/three.js';
import { SceneManager } from './engine/SceneManager.js';
import { BoxFactory } from './engine/BoxFactory.js';
import { TextureManager } from './engine/TextureManager.js';
import { ShelfView } from './engine/ShelfView.js';
import { Inspector } from './engine/Inspector.js';
import { InputManager } from './input/InputManager.js';
import { Hud } from './ui/Hud.js';
import { SettingsPanel } from './ui/SettingsPanel.js';

const api = window.megashelf;
const STORAGE_KEY = 'megashelf.position';
const NO_PAUSE = new URLSearchParams(location.search).has('nopause');
const MAX_DT = 1 / 20;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wires the pieces together and owns the frame loop and the mode machine:
 *
 *   browse <-> inspect -> launching -> session (emulator running) -> back
 *     ^-> settings
 */
class App {
  constructor() {
    this.canvas = document.getElementById('stage');
    this.stage = new SceneManager(this.canvas);
    this.factory = new BoxFactory();
    this.textures = new TextureManager({
      renderer: this.stage.renderer,
      saveAtlas: (id, key, version, bytes) => api.saveAtlas(id, key, version, bytes),
      onLoaded: () => this.invalidate(),
    });
    this.shelf = new ShelfView({ stage: this.stage, factory: this.factory, textures: this.textures });
    this.inspector = new Inspector(this.stage);
    this.input = new InputManager();
    this.hud = new Hud();
    this.settings = new SettingsPanel(api, { onClose: () => this.closeSettings() });

    this.mode = 'browse';
    this.systems = [];
    this.dirty = true; //   a frame must be drawn even if nothing is animating
    this.rafId = 0;
    this.lastTime = 0;
    this.paused = false;
    this.sessionActive = false;
    this.unsubscribe = [];
    this.raycaster = new THREE.Raycaster();
    this.pointer = { down: false, moved: 0, x: 0, y: 0, t: 0 };

    this.shelf.onTransform = (box, base) => this.inspector.apply(box, base);
    this.inspector.onClosed = (box) => {
      this.shelf.setHighRes(box, false);
      if (this.shelf.pinned === box) this.shelf.pinned = null;
      this.shelf.windowKey = ''; // the pinned box may now be outside the window
    };
    this.stage.onContextRestored = () => {
      this.textures.reset();
      this.shelf.setLibrary(this.systems, this.games, this.shelf.snapshot());
      this.invalidate();
    };

    this.frame = this.frame.bind(this);
    this._bindDom();
  }

  async start() {
    const lib = await api.getLibrary();
    this.systems = lib.systems;
    this.games = lib.games;

    let restore = null;
    try {
      restore = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch { /* storage unavailable or corrupt: start at the top */ }
    this.setMode('browse');
    this.applyLibrary(restore);
    this.hud.setStatus(lib.status);

    this.unsubscribe.push(
      api.onLibraryChanged(({ games }) => { this.games = games; this.applyLibrary(null); }),
      api.onStatus((status) => this.hud.setStatus(status)),
      api.onArtUpdated(({ id, art }) => {
        const game = this.games.find((g) => g.id === id);
        if (game) game.art = art;
        this.shelf.refreshGame(id, art);
        this.invalidate();
      }),
      api.onSessionStarted((info) => this.onSessionStarted(info)),
      api.onSessionEnded((info) => this.onSessionEnded(info)),
    );
    this.resume();
  }

  applyLibrary(restore) {
    if (this.inspector.busy) {
      // The selection may be about to disappear: put the box back first.
      this.inspector.box = null;
      this.inspector.t.snap(0);
      this.shelf.dim.snap(0);
      this.setMode('browse');
    }
    this.shelf.setLibrary(this.systems, this.games, restore);
    this.hud.setShelves(this.shelf.shelves);
    this.hud.setEmpty(this.shelf.isEmpty);
    this.invalidate();
  }

  // ---- loop ----------------------------------------------------------------

  invalidate() {
    this.dirty = true;
  }

  /**
   * The loop runs only while the window is focused and no tracked game is
   * running, and even then it only draws when something changed. An idle
   * shelf costs no GPU time; a running emulator gets all of it.
   */
  resume() {
    this.paused = false;
    if (this.rafId || this.sessionActive) return;
    this.lastTime = 0;
    this.dirty = true;
    this.rafId = requestAnimationFrame(this.frame);
  }

  pause() {
    this.paused = true;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.input.release();
  }

  frame(now) {
    this.rafId = requestAnimationFrame(this.frame);
    const dt = this.lastTime ? Math.min(MAX_DT, (now - this.lastTime) / 1000) : 1 / 60;
    this.lastTime = now;

    const input = this.input.poll(dt);
    for (const action of input.actions) this.handle(action);

    const inspecting = this.mode === 'inspect';
    let animating = this.inspector.update(dt, inspecting ? input.look : { x: 0, y: 0 }, inspecting ? input.zoom : 0);
    animating = this.shelf.update(dt) || animating;

    this.hud.setSelection(this.shelf.active, this.shelf.activeShelf);

    if (animating || this.dirty || input.held) {
      this.dirty = false;
      this.stage.render();
    }
  }

  // ---- modes ---------------------------------------------------------------

  setMode(mode) {
    this.mode = mode;
    this.input.mode = mode === 'inspect' ? 'inspect' : 'navigate';
    this.hud.setHints(mode === 'browse' || mode === 'inspect' || mode === 'settings' ? mode : 'none');
  }

  handle(action) {
    if (this.mode === 'settings') {
      if (action === 'back' || action === 'settings') this.closeSettings();
      return;
    }
    if (this.mode === 'browse') return this.handleBrowse(action);
    if (this.mode === 'inspect') return this.handleInspect(action);
    // 'launching' and 'session' ignore input.
  }

  handleBrowse(action) {
    switch (action) {
      case 'left': case 'right': case 'pageLeft': case 'pageRight': {
        const step = { left: -1, right: 1, pageLeft: -10, pageRight: 10 }[action];
        if (this.shelf.move(step)) this.input.pulse(0.22, 18);
        else this.input.pulse(0.7, 45); // thud against the end of the shelf
        this.persist();
        break;
      }
      case 'up': case 'down':
        if (this.shelf.changeShelf(action === 'up' ? -1 : 1)) this.input.pulse(0.45, 30);
        else this.input.pulse(0.7, 45);
        this.persist();
        break;
      case 'accept': this.enterInspect(); break;
      case 'play': this.launch(); break;
      case 'settings': this.openSettings(); break;
      default:
    }
  }

  handleInspect(action) {
    switch (action) {
      case 'back': this.exitInspect(); break;
      case 'accept': case 'play': this.launch(); break;
      case 'flip': this.inspector.flip(); break;
      case 'spine': this.inspector.showSpine(); break;
      default:
    }
  }

  enterInspect() {
    const box = this.shelf.activeBox;
    if (!box || this.inspector.busy) return;
    this.shelf.pinned = box;
    this.shelf.dim.target = 1;
    this.shelf.setHighRes(box, true);
    this.inspector.enter(box);
    this.setMode('inspect');
    this.input.pulse(0.4, 30);
  }

  exitInspect() {
    this.inspector.exit();
    this.shelf.dim.target = 0;
    this.setMode('browse');
  }

  openSettings() {
    this.setMode('settings');
    this.settings.show();
  }

  closeSettings() {
    this.settings.hide();
    this.setMode('browse');
    this.canvas.focus();
  }

  persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.shelf.snapshot()));
    } catch { /* not fatal */ }
  }

  // ---- launching -----------------------------------------------------------

  async launch() {
    const game = this.shelf.activeGame;
    if (!game || this.mode === 'launching' || this.mode === 'session') return;
    const returnTo = this.mode;
    this.setMode('launching');
    this.inspector.launch.target = 1;
    this.hud.fade(true, `Starting ${game.title}`);
    this.persist();
    await wait(480); // let the dive-in finish before the emulator takes the screen

    const result = await api.launch(game.id);
    if (!result.ok) {
      this.hud.toast(result.error || 'Launch failed.');
      this.finishLaunch(returnTo);
      return;
    }
    if (result.tracked) {
      this.setMode('session');
      this.hud.fade(true, `${game.title}\nCtrl+Alt+Backspace force-closes the emulator`);
      return; // onSessionEnded brings the shelf back
    }
    // A store launcher owns the game from here; the loop pauses when it takes focus.
    await wait(2600);
    this.finishLaunch(returnTo);
  }

  finishLaunch(returnTo) {
    this.inspector.launch.target = 0;
    this.hud.fade(false);
    this.setMode(returnTo === 'inspect' && this.inspector.active ? 'inspect' : 'browse');
    this.invalidate();
  }

  onSessionStarted(info) {
    if (!info.tracked) return;
    this.sessionActive = true;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.input.release();
  }

  onSessionEnded(info) {
    this.sessionActive = false;
    if (info.failed) {
      this.hud.toast(`${info.title} closed right away (exit code ${info.code}).${info.stderr ? `\n${info.stderr}` : ''}`);
    }
    this.finishLaunch(this.inspector.active ? 'inspect' : 'browse');
    if (!this.paused || NO_PAUSE) this.resume();
  }

  // ---- DOM events ----------------------------------------------------------

  _bindDom() {
    const on = (target, type, fn, options) => {
      target.addEventListener(type, fn, options);
      this.unsubscribe.push(() => target.removeEventListener(type, fn, options));
    };

    on(window, 'resize', () => { this.stage.resize(); this.shelf.windowKey = ''; this.invalidate(); });
    on(window, 'blur', () => { if (!NO_PAUSE) this.pause(); });
    on(window, 'focus', () => this.resume());
    on(document, 'visibilitychange', () => {
      if (document.hidden) { if (!NO_PAUSE) this.pause(); } else this.resume();
    });
    on(window, 'beforeunload', () => this.dispose());
    on(document.getElementById('empty-open'), 'click', () => this.openSettings());

    const canvas = this.canvas;
    canvas.tabIndex = 0;

    on(canvas, 'pointerdown', (e) => {
      this.pointer = { down: true, moved: 0, x: e.clientX, y: e.clientY, t: e.timeStamp };
      canvas.setPointerCapture(e.pointerId);
    });
    on(canvas, 'pointermove', (e) => {
      const p = this.pointer;
      if (!p.down) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      const dt = Math.max(0.001, (e.timeStamp - p.t) / 1000);
      p.moved += Math.abs(dx) + Math.abs(dy);
      p.x = e.clientX; p.y = e.clientY; p.t = e.timeStamp;
      if (this.mode === 'inspect') {
        this.inspector.drag(dx * 0.008, dy * 0.006, dt);
        this.invalidate();
      }
    });
    on(canvas, 'pointerup', (e) => {
      const p = this.pointer;
      p.down = false;
      if (p.moved > 6) return; // it was a drag, not a click
      this.click(e.clientX, e.clientY);
    });
    on(canvas, 'wheel', (e) => {
      if (this.mode === 'inspect') this.input.wheel += e.deltaY < 0 ? 1 : -1;
      else if (this.mode === 'browse') this.handleBrowse(e.deltaY > 0 || e.deltaX > 0 ? 'right' : 'left');
      this.invalidate();
    }, { passive: true });
  }

  click(clientX, clientY) {
    if (this.mode !== 'browse' && this.mode !== 'inspect') return;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.stage.camera);
    const box = this.shelf.pick(this.raycaster);

    if (this.mode === 'inspect') {
      if (box !== this.inspector.box) this.exitInspect(); // clicked away
      return;
    }
    if (!box) return;
    const isActive = box.shelf === this.shelf.active && box.item === this.shelf.activeShelf.cursor;
    if (isActive) this.enterInspect();
    else { this.shelf.goTo(box.shelf, box.item); this.persist(); }
    this.invalidate();
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.input.dispose();
    this.shelf.dispose();
    this.textures.dispose();
    this.factory.dispose();
    this.stage.dispose();
  }
}

const app = new App();
if (NO_PAUSE) {
  // Dev capture mode only: lets the main process read resource counts.
  window.__megashelfStats = () => ({
    gpu: { ...app.stage.renderer.info.memory, programs: app.stage.renderer.info.programs.length },
    pool: { created: app.shelf.all.length, onScreen: app.shelf.assigned.size, free: app.shelf.free.length },
    textures: app.textures.stats(),
  });
}
app.start().catch((err) => {
  console.error(err);
  app.hud.toast(`MegaShelf failed to start: ${err.message}`);
});
