import * as THREE from './engine/three.js';
import { SceneManager } from './engine/SceneManager.js';
import { BoxFactory } from './engine/BoxFactory.js';
import { TextureManager } from './engine/TextureManager.js';
import { ShelfView } from './engine/ShelfView.js';
import { Inspector } from './engine/Inspector.js';
import { InputManager } from './input/InputManager.js';
import { PAD_NAMES } from './input/devices.js';
import { SoundEngine } from './audio/SoundEngine.js';
import { buildShelves, searchGames, DEFAULT_VIEW, SORTS, SORT_LABELS, REGIONS } from './library/shelves.js';
import { Hud } from './ui/Hud.js';
import { Menu } from './ui/Menu.js';
import { TextEntry } from './ui/TextEntry.js';
import { SettingsPanel } from './ui/SettingsPanel.js';

const api = window.megashelf;
const POSITION_KEY = 'megashelf.position';
const VIEW_KEY = 'megashelf.view';
const NO_PAUSE = new URLSearchParams(location.search).has('nopause');
const MAX_DT = 1 / 20;
const TWO_PI = Math.PI * 2;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cycle = (list, current) => list[(list.indexOf(current) + 1) % list.length];

function readStorage(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') || fallback;
  } catch {
    return fallback; // storage unavailable or corrupt
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* not fatal */ }
}

/** Splits "--flag "two words" x" into ['--flag', 'two words', 'x']. */
function splitArgs(text) {
  const out = [];
  for (const m of String(text).matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

/**
 * Wires the pieces together and owns the frame loop and the mode machine:
 *
 *   browse <-> inspect -> launching -> session (emulator running) -> back
 *
 * Menus, text entry and the settings panel are overlays on top of browse or
 * inspect; while one is open it receives the input instead.
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
    this.sound = new SoundEngine();
    this.hud = new Hud();
    const overlay = { onChange: () => this.syncMode(), onSound: (event) => this.sfx(event) };
    this.menu = new Menu(overlay);
    this.entry = new TextEntry(overlay);
    this.settings = new SettingsPanel(api, { onClose: () => this.closeSettings() });

    this.mode = 'browse';
    this.systems = [];
    this.games = [];
    this.collections = [];
    this.emulators = [];
    this.view = { ...DEFAULT_VIEW, sound: true, volume: 0.6, ...readStorage(VIEW_KEY, {}) };
    this.needsRebuild = false;
    this.ambienceFor = '';
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
      this.syncMode(); //           applies any rebuild that was waiting for the box to return
    };
    this.stage.onContextRestored = () => {
      this.textures.reset();
      this.rebuild();
    };

    this.input.onDeviceChange = (device, padType) => this.hud.setDevice(device, padType);
    this.input.onPadConnection = (connected, padType) => {
      this.hud.toast(`${PAD_NAMES[padType] || 'Controller'} ${connected ? 'connected' : 'disconnected'}`, 'info');
    };
    this.hud.setDevice(this.input.device, this.input.padType);

    this.frame = this.frame.bind(this);
    this._bindDom();
  }

  async start() {
    const lib = await api.getLibrary();
    this.systems = lib.systems;
    this.games = lib.games;
    this.collections = lib.collections;
    this.emulators = lib.emulators;
    this.sound.configure({ enabled: this.view.sound, volume: this.view.volume, custom: lib.sounds });

    this.setMode('browse');
    this.rebuild(readStorage(POSITION_KEY, null));
    this.hud.setStatus(lib.status);

    this.unsubscribe.push(
      api.onLibraryChanged(({ games }) => { this.games = games; this.rebuild(); }),
      api.onStatus((status) => this.hud.setStatus(status)),
      api.onArtUpdated(({ id, art }) => {
        const game = this.games.find((g) => g.id === id);
        if (game) game.art = art;
        this.shelf.refreshGame(id, art);
        this.invalidate();
      }),
      api.onGameUpdated(({ game }) => this.mergeGame(game)),
      api.onAppUpdate((update) => {
        if (update.state === 'available') this.hud.toast(`MegaShelf ${update.version} is downloading`, 'info');
        else if (update.state === 'ready') this.hud.toast(`MegaShelf ${update.version} is ready and will install when you quit`, 'info');
      }),
      api.onSessionStarted((info) => this.onSessionStarted(info)),
      api.onSessionEnded((info) => this.onSessionEnded(info)),
    );
    this.resume();
  }

  // ---- library -------------------------------------------------------------

  /** Recomputes the shelves from games + collections + view options. */
  rebuild(restore = null) {
    if (this.inspector.busy) {
      // The selection may be about to disappear: put the box back first.
      this.inspector.box = null;
      this.inspector.t.snap(0);
      this.shelf.dim.snap(0);
      this.mode = 'browse';
    }
    this.needsRebuild = false;
    const defs = buildShelves({ systems: this.systems, games: this.games, collections: this.collections, view: this.view });
    this.shelf.setShelves(defs, restore);
    this.hud.setShelves(this.shelf.shelves);
    this.hud.setEmpty(this.shelf.isEmpty, this.games.length > 0);
    this.hud.invalidate();
    this.ambienceFor = '';
    this.syncMode();
    this.invalidate();
  }

  /**
   * A single game changed (favourite, rename, play count, details). The
   * record is updated in place so every shelf showing it stays consistent;
   * the shelves themselves are rebuilt once no box is out and no menu is open.
   */
  mergeGame(next) {
    if (!next) return;
    const game = this.games.find((g) => g.id === next.id);
    if (!game) return;
    Object.assign(game, next);
    this.hud.invalidate();
    this.needsRebuild = true;
    this.syncMode();
    this.invalidate();
  }

  async patch(game, changes) {
    this.mergeGame(await api.patchGame(game.id, changes));
  }

  saveView() {
    writeStorage(VIEW_KEY, this.view);
    this.sound.configure({ enabled: this.view.sound, volume: this.view.volume });
    this.ambienceFor = '';
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
    this.sound.resume();
    this.rafId = requestAnimationFrame(this.frame);
  }

  pause() {
    this.paused = true;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.input.release();
    this.sound.suspend();
  }

  frame(now) {
    this.rafId = requestAnimationFrame(this.frame);
    const dt = this.lastTime ? Math.min(MAX_DT, (now - this.lastTime) / 1000) : 1 / 60;
    this.lastTime = now;

    const input = this.input.poll(dt);
    for (const action of input.actions) this.handle(action);

    const rotating = this.mode === 'inspect' && !this.overlay;
    let animating = this.inspector.update(dt, rotating ? input.look : { x: 0, y: 0 }, rotating ? input.zoom : 0);
    animating = this.shelf.update(dt) || animating;

    this.hud.setSelection(this.shelf.active, this.shelf.activeShelf);
    this.hud.setDetails(this.mode === 'inspect' ? this.shelf.activeGame : null);
    this.updateAmbience();

    if (animating || this.dirty || input.held) {
      this.dirty = false;
      this.stage.render();
    }
  }

  // ---- sound ---------------------------------------------------------------

  /** The console whose voice interface sounds use: the selected game's. */
  get soundSystem() {
    const game = this.shelf.activeGame;
    return game ? game.systemId : 'pc';
  }

  sfx(event) {
    this.sound.play(event, this.soundSystem);
  }

  updateAmbience() {
    const shelf = this.shelf.activeShelf;
    if (!shelf) return;
    // A console's shelf has one bed; mixed shelves follow the selected game.
    const systemId = shelf.system.kind === 'system' ? shelf.system.id : this.soundSystem;
    if (systemId === this.ambienceFor) return;
    this.ambienceFor = systemId;
    this.sound.setAmbience(systemId);
  }

  // ---- modes ---------------------------------------------------------------

  get overlay() {
    if (this.entry.open) return 'entry';
    if (this.menu.open) return 'menu';
    if (this.settings.open) return 'settings';
    return '';
  }

  setMode(mode) {
    this.mode = mode;
    this.syncMode();
  }

  /** Brings hints, input routing and deferred rebuilds in line with what is on screen. */
  syncMode() {
    const overlay = this.overlay;
    const plain = this.mode === 'browse' || this.mode === 'inspect';
    this.hud.setHints(overlay || (plain ? this.mode : 'none'));
    this.input.mode = this.mode === 'inspect' && !overlay ? 'inspect' : 'navigate';
    if (this.needsRebuild && !overlay && this.mode === 'browse' && !this.inspector.busy) {
      this.rebuild();
      this.persist();
    }
    this.invalidate();
  }

  handle(action) {
    if (this.mode === 'launching' || this.mode === 'session') return;
    if (this.entry.open) return this.entry.handle(action);
    if (this.menu.open) return this.menu.handle(action);
    if (this.settings.open) {
      if (action === 'back' || action === 'settings') this.closeSettings();
      return;
    }
    if (this.mode === 'browse') return this.handleBrowse(action);
    if (this.mode === 'inspect') return this.handleInspect(action);
  }

  handleBrowse(action) {
    switch (action) {
      case 'left': case 'right': case 'pageLeft': case 'pageRight': {
        const step = { left: -1, right: 1, pageLeft: -10, pageRight: 10 }[action];
        if (this.shelf.move(step)) { this.input.pulse(0.22, 18); this.sfx('move'); }
        else { this.input.pulse(0.7, 45); this.sfx('bump'); } // thud against the end of the shelf
        this.persist();
        break;
      }
      case 'up': case 'down':
        if (this.shelf.changeShelf(action === 'up' ? -1 : 1)) { this.input.pulse(0.45, 30); this.sfx('shelf'); }
        else { this.input.pulse(0.7, 45); this.sfx('bump'); }
        this.persist();
        break;
      case 'letterPrev': case 'letterNext': {
        const letter = this.shelf.jumpLetter(action === 'letterNext' ? 1 : -1);
        if (letter) { this.hud.flashLetter(letter); this.input.pulse(0.35, 24); this.sfx('shelf'); this.persist(); }
        else { this.input.pulse(0.7, 45); this.sfx('bump'); }
        break;
      }
      case 'accept': this.enterInspect(); break;
      case 'play': this.launch(); break;
      case 'flip': case 'gameMenu': this.openGameMenu(); break;
      case 'spine': case 'search': this.openSearch(); break;
      case 'favorite': this.toggleFavorite(); break;
      case 'settings': this.openMainMenu(); break;
      default:
    }
  }

  handleInspect(action) {
    switch (action) {
      case 'back': this.exitInspect(); break;
      case 'accept': case 'play': this.launch(); break;
      case 'flip': this.inspector.flip(); break;
      case 'spine': this.inspector.showSpine(); break;
      case 'favorite': this.toggleFavorite(); break;
      case 'settings': case 'gameMenu': this.openGameMenu(); break;
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
    this.sfx('select');
  }

  exitInspect() {
    this.inspector.exit();
    this.shelf.dim.target = 0;
    this.setMode('browse');
    this.sfx('back');
  }

  openSettings() {
    this.settings.show();
    this.syncMode();
  }

  closeSettings() {
    this.settings.hide();
    this.syncMode();
    this.canvas.focus();
  }

  persist() {
    writeStorage(POSITION_KEY, this.shelf.snapshot());
  }

  // ---- search and favourites -----------------------------------------------

  openSearch() {
    this.entry.show({
      title: 'Search your library',
      placeholder: 'Game title',
      search: (text) => searchGames(this.games, text).map((g) => ({ label: g.title, sub: g.system.short, value: g.id })),
      onSubmit: (_text, gameId) => {
        if (!gameId) return;
        if (this.shelf.goToGame(gameId)) this.persist();
        else this.hud.toast('That game is hidden by your current filters.', 'info');
      },
    });
  }

  async toggleFavorite() {
    const game = this.shelf.activeGame;
    if (!game) return;
    const favorite = !game.user.favorite;
    await this.patch(game, { favorite });
    this.sfx('favorite');
    this.hud.toast(favorite ? `Added ${game.title} to favourites` : `Removed ${game.title} from favourites`, 'info');
  }

  // ---- menus ---------------------------------------------------------------

  openMainMenu() {
    const v = this.view;
    const toggle = (label, key, hint) => ({
      label, hint, value: v[key] ? 'On' : 'Off',
      run: () => { v[key] = !v[key]; this.saveView(); this.rebuild(); },
    });
    this.menu.push({
      title: 'Menu',
      items: () => [
        { label: 'Search', run: () => { this.openSearch(); return 'close'; } },
        { label: 'Sort by', value: SORT_LABELS[v.sort], run: () => { v.sort = cycle(SORTS, v.sort); this.saveView(); this.rebuild(); } },
        { label: 'Region', value: v.region === 'all' ? 'All' : v.region, run: () => { v.region = cycle(REGIONS, v.region); this.saveView(); this.rebuild(); } },
        toggle('Favourites only', 'favoritesOnly'),
        toggle('Hide regional duplicates', 'collapseDuplicates', 'Show one copy of a game that you have in several regions'),
        toggle('Show hidden games', 'showHidden'),
        { label: 'Sound', value: v.sound ? 'On' : 'Off', run: () => { v.sound = !v.sound; this.saveView(); } },
        {
          label: 'Volume', value: `${Math.round(v.volume * 100)}%`,
          run: () => { v.volume = v.volume >= 0.99 ? 0.2 : Math.round((v.volume + 0.2) * 10) / 10; this.saveView(); this.sfx('select'); },
        },
        { label: 'Settings', hint: 'Emulators, ROM folders, launchers and updates', run: () => { this.openSettings(); return 'close'; } },
        { label: 'Rescan library', run: () => { api.rescan(); return 'close'; } },
        { label: 'Quit MegaShelf', danger: true, run: () => api.quit() },
      ],
    });
  }

  openGameMenu() {
    const game = this.shelf.activeGame;
    if (!game) return;
    const shelf = this.shelf.activeShelf.system;
    const inCollection = shelf.kind === 'collection';

    this.menu.push({
      title: () => game.title,
      items: () => [
        {
          label: game.user.favorite ? 'Remove from favourites' : 'Add to favourites',
          run: async () => { await this.patch(game, { favorite: !game.user.favorite }); this.sfx('favorite'); },
        },
        { label: 'Play', run: () => { this.launch(); return 'close'; } },
        game.canResume && {
          label: 'Continue', hint: 'Start from the most recent save state',
          run: () => { this.launch({ resume: true }); return 'close'; },
        },
        { label: 'Add to collection', run: () => this.menu.push(this.collectionLevel(game)) },
        { label: 'Box art', run: () => this.menu.push(this.artLevel(game)) },
        {
          label: 'Rename', value: game.title !== game.originalTitle ? 'Renamed' : undefined,
          run: () => this.entry.show({
            title: 'Rename game', value: game.title, placeholder: game.originalTitle,
            onSubmit: async (text) => {
              // An empty name or the original one restores the scanned title.
              await this.patch(game, { title: text && text !== game.originalTitle ? text : '' });
              if (this.menu.open) this.menu.render(false);
            },
          }),
        },
        game.source === 'rom' && {
          label: 'Launch settings', hint: 'Emulator, core and arguments for this game only',
          run: () => this.menu.push(this.launchLevel(game)),
        },
        {
          label: game.user.hidden ? 'Unhide game' : 'Hide game',
          hint: game.user.hidden ? undefined : 'Bring it back with Menu, Show hidden games',
          run: async () => { await this.patch(game, { hidden: !game.user.hidden }); return 'close'; },
        },
        inCollection && {
          label: `Remove from ${shelf.name}`,
          run: async () => {
            this.collections = await api.toggleInCollection(shelf.collectionId, game.id);
            this.needsRebuild = true;
            return 'close';
          },
        },
        inCollection && {
          label: `Delete collection "${shelf.name}"`, danger: true, hint: 'The games themselves are not affected',
          run: async () => {
            this.collections = await api.deleteCollection(shelf.collectionId);
            this.needsRebuild = true;
            return 'close';
          },
        },
      ].filter(Boolean),
    });
  }

  collectionLevel(game) {
    const toggle = async (collectionId) => {
      this.collections = await api.toggleInCollection(collectionId, game.id);
      this.needsRebuild = true;
    };
    return {
      title: 'Add to collection',
      items: () => [
        ...this.collections.map((c) => ({
          label: c.name, value: c.games.includes(game.id) ? 'Added' : undefined,
          run: () => toggle(c.id),
        })),
        {
          label: 'New collection',
          run: () => this.entry.show({
            title: 'Name the collection', placeholder: 'Co-op night',
            onSubmit: async (text) => {
              if (!text) return;
              this.collections = await api.createCollection(text);
              const created = this.collections.find((c) => c.name.toLowerCase() === text.toLowerCase());
              if (created && !created.games.includes(game.id)) await toggle(created.id);
              if (this.menu.open) this.menu.render(false);
            },
          }),
        },
      ],
    };
  }

  artLevel(game) {
    const pick = (slot, label) => ({
      label, value: game.art && game.art[slot] ? 'Set' : 'Generated',
      run: async () => {
        const result = await api.pickArt(game.id, slot);
        if (!result.ok && !result.canceled) this.hud.toast(result.error || 'Could not use that image.');
      },
    });
    return {
      title: 'Box art',
      items: () => [
        pick('front', 'Choose front cover'),
        pick('back', 'Choose back cover'),
        pick('spine', 'Choose spine'),
        { label: 'Look it up again', hint: 'Discards the current art and searches for it', run: async () => { await api.resetArt(game.id, 'auto'); } },
        { label: 'Use the generated cover', hint: 'Stops MegaShelf looking for art for this game', run: async () => { await api.resetArt(game.id, 'generated'); } },
        { label: 'Tip', hint: 'Inspect a box and drop an image onto the side facing you', disabled: true },
      ],
    };
  }

  launchLevel(game) {
    const name = (id) => (this.emulators.find((e) => e.id === id) || {}).name || 'System default';
    const refresh = () => { if (this.menu.open) this.menu.render(false); };
    return {
      title: 'Launch settings',
      items: () => [
        {
          label: 'Emulator', value: name(game.user.emulator),
          run: () => this.patch(game, { emulator: cycle(['', ...this.emulators.map((e) => e.id)], game.user.emulator) }),
        },
        {
          label: 'RetroArch core', value: game.user.core || 'System default', hint: 'For example snes9x or mgba',
          run: () => this.entry.show({
            title: 'RetroArch core', value: game.user.core, placeholder: 'snes9x',
            onSubmit: async (text) => { await this.patch(game, { core: text }); refresh(); },
          }),
        },
        {
          label: 'Extra arguments', value: game.user.extraArgs.length ? game.user.extraArgs.join(' ') : 'None',
          run: () => this.entry.show({
            title: 'Extra arguments', value: game.user.extraArgs.join(' '), placeholder: '--option value',
            onSubmit: async (text) => { await this.patch(game, { extraArgs: splitArgs(text) }); refresh(); },
          }),
        },
        { label: 'Reset to system defaults', run: () => this.patch(game, { emulator: '', core: '', extraArgs: [] }) },
      ],
    };
  }

  // ---- launching -----------------------------------------------------------

  async launch(options = {}) {
    const game = this.shelf.activeGame;
    if (!game || this.mode === 'launching' || this.mode === 'session') return;
    const returnTo = this.mode;
    this.setMode('launching');
    this.inspector.launch.target = 1;
    this.hud.fade(true, `Starting ${game.title}`);
    this.sfx('launch');
    this.sound.stopAmbience();
    this.persist();
    await wait(480); // let the dive-in finish before the emulator takes the screen

    const result = await api.launch(game.id, { resume: !!options.resume });
    if (!result.ok) {
      this.hud.toast(result.error || 'Launch failed.');
      this.finishLaunch(returnTo);
      return;
    }
    if (options.resume && !result.resumed) this.hud.toast('No save state found, so the game started from the beginning.', 'info');
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
    this.ambienceFor = '';
    this.setMode(returnTo === 'inspect' && this.inspector.active ? 'inspect' : 'browse');
  }

  onSessionStarted(info) {
    if (!info.tracked) return;
    this.sessionActive = true;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.input.release();
    this.sound.suspend();
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
    on(document.getElementById('empty-reset'), 'click', () => {
      Object.assign(this.view, DEFAULT_VIEW);
      this.saveView();
      this.rebuild();
    });

    const canvas = this.canvas;
    canvas.tabIndex = 0;

    on(canvas, 'pointerdown', (e) => {
      if (e.button !== 0) return;
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
      if (!p.down) return;
      p.down = false;
      if (p.moved > 6) return; // it was a drag, not a click
      this.click(e.clientX, e.clientY);
    });
    on(canvas, 'contextmenu', (e) => {
      e.preventDefault();
      if (this.overlay || (this.mode !== 'browse' && this.mode !== 'inspect')) return;
      if (this.mode === 'browse') {
        const box = this.pick(e.clientX, e.clientY);
        if (!box) return;
        this.shelf.goTo(box.shelf, box.item);
      }
      this.openGameMenu();
    });
    on(canvas, 'wheel', (e) => {
      if (this.mode === 'inspect') this.input.wheel += e.deltaY < 0 ? 1 : -1;
      else if (this.mode === 'browse') this.handleBrowse(e.deltaY > 0 || e.deltaX > 0 ? 'right' : 'left');
      this.invalidate();
    }, { passive: true });

    // Drop an image on the window to use it as box art for the selected game.
    on(window, 'dragover', (e) => e.preventDefault());
    on(window, 'drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer && e.dataTransfer.files[0];
      if (file) this.dropArt(file);
    });
  }

  /** While inspecting, the image lands on whichever face is turned towards you. */
  async dropArt(file) {
    const game = this.shelf.activeGame;
    if (!game || this.overlay || (this.mode !== 'browse' && this.mode !== 'inspect')) return;
    let slot = 'front';
    if (this.mode === 'inspect') {
      const yaw = ((this.inspector.yaw % TWO_PI) + TWO_PI) % TWO_PI;
      if (Math.abs(yaw - Math.PI) < Math.PI / 4) slot = 'back';
      else if (Math.abs(yaw - Math.PI / 2) < Math.PI / 4) slot = 'spine';
    }
    const result = await api.setArt(game.id, slot, await file.arrayBuffer());
    if (result.ok) this.hud.toast(`Set the ${slot} art for ${game.title}`, 'info');
    else this.hud.toast(result.error || 'Could not use that image.');
  }

  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.stage.camera);
    return this.shelf.pick(this.raycaster);
  }

  click(clientX, clientY) {
    if (this.overlay || (this.mode !== 'browse' && this.mode !== 'inspect')) return;
    const box = this.pick(clientX, clientY);

    if (this.mode === 'inspect') {
      if (box !== this.inspector.box) this.exitInspect(); // clicked away
      return;
    }
    if (!box) return;
    const isActive = box.shelf === this.shelf.active && box.item === this.shelf.activeShelf.cursor;
    if (isActive) this.enterInspect();
    else { this.shelf.goTo(box.shelf, box.item); this.sfx('move'); this.persist(); }
    this.invalidate();
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.input.dispose();
    this.sound.dispose();
    this.shelf.dispose();
    this.textures.dispose();
    this.factory.dispose();
    this.stage.dispose();
  }
}

const app = new App();
if (NO_PAUSE) {
  // Dev capture mode only: lets the main process read resource counts.
  window.__megashelfStats = async () => ({
    gpu: { ...app.stage.renderer.info.memory, programs: app.stage.renderer.info.programs.length },
    pool: { created: app.shelf.all.length, onScreen: app.shelf.assigned.size, free: app.shelf.free.length },
    textures: app.textures.stats(),
    shelves: app.shelf.shelves.map((s) => `${s.system.short}:${s.games.length}`),
    mode: app.mode, overlay: app.overlay, audio: app.sound.ctx ? app.sound.ctx.state : 'none',
    customSounds: await Promise.all(Object.entries(app.sound.custom).flatMap(([system, events]) => Object.entries(events)
      .map(([event, file]) => fetch(`/sounds/${system}/${file}`).then((r) => `${system}/${event}: HTTP ${r.status} ${r.headers.get('content-type')}`)))),
  });
}
app.start().catch((err) => {
  console.error(err);
  app.hud.toast(`MegaShelf failed to start: ${err.message}`);
});
