'use strict';

const { app, BrowserWindow, ipcMain, protocol, dialog, shell, globalShortcut, Menu } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { SYSTEMS, SYSTEM_BY_ID, publicSystem } = require('./systems');
const { Config } = require('./config');
const { Library } = require('./library');
const { ArtStore } = require('./scraper/art-store');
const { Scraper } = require('./scraper/scraper');
const { LaunchBridge } = require('./launch/launch-bridge');
const { EMULATORS } = require('./launch/emulators');
const { ID_RE } = require('./titles');

const argv = process.argv.slice(1);
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};

const DEMO = flag('demo');
const WINDOWED = flag('windowed');
const CAPTURE = option('capture'); // dev aid: screenshot to this path, then quit
const SCRIPT = option('script'); //   dev aid: comma separated key presses to send first

const ORIGIN = 'shelf://app';
const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');
// require.resolve('three') is <three>/build/three.cjs; the package root is one level up.
const THREE_ROOT = path.resolve(path.dirname(require.resolve('three')), '..');
const KILL_SHORTCUT = 'Control+Alt+Backspace';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

// A real origin (instead of file://) gives the page ES modules, module
// workers, fetch() and untainted WebGL textures under a strict CSP.
protocol.registerSchemesAsPrivileged([
  { scheme: 'shelf', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

let win = null;
let config, artStore, library, scraper, bridge;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Resolves `relative` under `root`, refusing anything that escapes it. */
function safeJoin(root, relative) {
  const full = path.resolve(root, `.${path.sep}${relative}`);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

async function serve(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (url.host !== 'app' || request.method !== 'GET') return new Response(null, { status: 404 });

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response(null, { status: 400 });
  }

  let file = null;
  let cache = 'no-cache';
  if (pathname.startsWith('/art/')) {
    file = artStore.resolve(pathname.slice(5));
    cache = 'no-store'; // art is versioned by the renderer and may be replaced
  } else if (pathname.startsWith('/vendor/three/')) {
    file = safeJoin(THREE_ROOT, pathname.slice('/vendor/three/'.length));
  } else {
    file = safeJoin(RENDERER_ROOT, pathname === '/' ? 'index.html' : pathname.slice(1));
  }
  const type = file && MIME[path.extname(file).toLowerCase()];
  if (!file || !type) return new Response(null, { status: 404 });

  try {
    const body = await fsp.readFile(file);
    return new Response(body, { headers: { 'content-type': type, 'cache-control': cache, 'x-content-type-options': 'nosniff' } });
  } catch {
    return new Response(null, { status: 404 });
  }
}

/** IPC handler wrapper: only our own page may call, and errors become values. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    const frameUrl = event.senderFrame ? event.senderFrame.url : '';
    if (!frameUrl.startsWith(`${ORIGIN}/`)) throw new Error('forbidden');
    return fn(...args);
  });
}

function registerIpc() {
  handle('library:get', () => ({
    systems: SYSTEMS.map(publicSystem),
    games: library.list(),
    status: library.status,
    demo: DEMO,
  }));

  handle('library:rescan', () => { library.rescan(); return true; });

  handle('game:launch', async (gameId) => {
    const game = typeof gameId === 'string' && ID_RE.test(gameId) ? library.get(gameId) : null;
    if (!game) return { ok: false, error: 'Unknown game.' };
    try {
      const result = await bridge.launch(game, SYSTEM_BY_ID.get(game.systemId), config.data);
      return { ok: true, tracked: result.tracked };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code || 'ERROR' };
    }
  });

  handle('session:terminate', () => bridge.terminate());

  handle('art:saveAtlas', async (gameId, key, version, bytes) => {
    if (typeof gameId !== 'string' || typeof key !== 'string' || !(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes))) return false;
    try {
      return await artStore.saveAtlas(gameId, key, Buffer.from(bytes), Number(version));
    } catch {
      return false;
    }
  });

  handle('settings:get', () => ({ ...config.describe(), pcStatus: library.pcStatus, demo: DEMO }));

  handle('settings:pickEmulator', async (emulatorId) => {
    if (!Object.hasOwn(EMULATORS, emulatorId)) return config.describe();
    const result = await dialog.showOpenDialog(win, {
      title: `Locate ${EMULATORS[emulatorId].name}`,
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : [],
    });
    if (!result.canceled && result.filePaths[0]) {
      config.data.emulators[emulatorId].path = result.filePaths[0];
      await config.save();
    }
    return config.describe();
  });

  handle('settings:addRomDir', async (systemId) => {
    const system = SYSTEM_BY_ID.get(systemId);
    if (!system || system.kind !== 'rom') return config.describe();
    const result = await dialog.showOpenDialog(win, {
      title: `Add a ${system.name} ROM folder`,
      properties: ['openDirectory'],
    });
    if (!result.canceled && result.filePaths[0] && config.addRomDir(systemId, result.filePaths[0])) {
      await config.save();
      library.rescan();
    }
    return config.describe();
  });

  handle('settings:removeRomDir', async (systemId, dir) => {
    if (typeof dir === 'string' && config.removeRomDir(systemId, dir)) {
      await config.save();
      library.rescan();
    }
    return config.describe();
  });

  handle('settings:setOption', async (name, value) => {
    const on = value === true;
    if (name === 'scraperOnline') {
      config.data.scraper.online = on;
      if (on) { scraper.resetAttempts(); scraper.enqueue(library.all()); }
    } else if (['steam', 'epic', 'xbox', 'battlenet'].includes(name)) {
      config.data.pc[name] = on;
      library.rescan();
    } else {
      return config.describe();
    }
    await config.save();
    return config.describe();
  });

  handle('app:quit', () => app.quit());
}

function wireServices() {
  library.on('status', (status) => send('library:status', status));
  library.on('changed', () => {
    send('library:changed', { games: library.list() });
    scraper.enqueue(library.all());
  });

  scraper.on('updated', (gameId) => send('art:updated', { id: gameId, art: artStore.describe(gameId) }));

  bridge.on('started', (info) => {
    send('session:started', info);
    if (info.tracked) {
      // Panic button for an emulator that hangs in exclusive full-screen.
      globalShortcut.register(KILL_SHORTCUT, () => bridge.terminate());
    }
  });
  bridge.on('ended', (info) => {
    globalShortcut.unregister(KILL_SHORTCUT);
    send('session:ended', info);
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 900, minWidth: 960, minHeight: 540,
    fullscreen: !WINDOWED && !CAPTURE,
    backgroundColor: '#06070a',
    show: false,
    autoHideMenuBar: true,
    title: 'MegaShelf',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      backgroundThrottling: !CAPTURE,
    },
  });

  // The window only ever shows our own bundle.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); event.preventDefault(); }
    if (input.key === 'F12' && !app.isPackaged) win.webContents.toggleDevTools();
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  win.loadURL(`${ORIGIN}/index.html${CAPTURE ? '?nopause=1' : ''}`);
  if (CAPTURE) runCapture();
}

/** Dev aid: drive the UI with key presses, save a screenshot, quit. */
function runCapture() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  win.webContents.once('did-finish-load', async () => {
    try {
      win.webContents.on('console-message', (e) => console.log('[renderer]', e.message));
      await wait(3500);
      for (const key of SCRIPT.split(',').filter(Boolean)) {
        if (/^\d+$/.test(key)) { await wait(Number(key)); continue; }
        if (key.startsWith('Pad:')) { // press D-pad right on a simulated controller with this id
          const id = JSON.stringify(key.slice(4));
          await win.webContents.executeJavaScript(`(() => {
            const real = navigator.getGamepads.bind(navigator);
            const pad = (pressed) => ({ id: ${id}, index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0],
              buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed && i === 15, value: pressed && i === 15 ? 1 : 0 })) });
            let pressed = true;
            navigator.getGamepads = () => [pad(pressed)];
            Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true });
            setTimeout(() => { pressed = false; }, 120);
            setTimeout(() => { navigator.getGamepads = real; }, 600);
          })()`);
          await wait(700);
          continue;
        }
        if (key === 'Mouse') { // sweep the pointer across the window
          for (let x = 300; x <= 600; x += 60) {
            win.webContents.sendInputEvent({ type: 'mouseMove', x, y: 300 });
            await wait(40); // separate frames, or Chromium coalesces them into one event
          }
          continue;
        }
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
        await wait(60);
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
        await wait(260);
      }
      await wait(1800);
      const stats = await win.webContents.executeJavaScript('window.__megashelfStats ? JSON.stringify(window.__megashelfStats()) : ""');
      if (stats) console.log('[stats]', stats);
      const image = await win.webContents.capturePage();
      await fsp.writeFile(CAPTURE, image.toPNG());
      console.log('[capture] wrote', CAPTURE);
    } catch (err) {
      console.error('[capture] failed:', err);
    }
    app.quit();
  });
}

if (!CAPTURE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const userDir = app.getPath('userData');

    config = await new Config(path.join(userDir, 'config.json')).load();
    artStore = await new ArtStore(path.join(userDir, 'art')).init();
    library = await new Library({ file: path.join(userDir, 'library.json'), config, artStore, demo: DEMO }).init();
    scraper = await new Scraper({ artStore, config, attemptsFile: path.join(userDir, 'art', '_attempts.json') }).init();
    bridge = new LaunchBridge({ openExternal: (uri) => shell.openExternal(uri) });

    protocol.handle('shelf', serve);
    registerIpc();
    wireServices();
    createWindow();

    // The cached index is already on screen; reconcile it with the disk.
    library.rescan();
  });

  app.on('window-all-closed', () => app.quit());

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (bridge) bridge.dispose();
    if (scraper) scraper.stop();
    if (library) library.dispose();
  });
}
