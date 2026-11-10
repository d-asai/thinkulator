'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseVdf, vdfGet } = require('./vdf');
const { queryRegistry, regValue } = require('./registry');
const { parseTitle, makeId } = require('../../titles');

// Runtimes and tools that live in steamapps but are not games.
const NOT_GAMES = /^(Steamworks Common Redistributables|Steam Linux Runtime|Proton( |$)|Steam Controller Configs|SteamVR$|Steam Audio)/i;
const SOUNDTRACK = /\b(Soundtrack|OST)$/i;
const STATE_FULLY_INSTALLED = 4;

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function findSteamRoot() {
  const candidates = [];
  if (process.platform === 'win32') {
    const user = await queryRegistry('HKCU\\Software\\Valve\\Steam', { recursive: false });
    for (const values of user.values()) candidates.push(regValue(values, 'SteamPath'));
    const machine = await queryRegistry('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', { recursive: false });
    for (const values of machine.values()) candidates.push(regValue(values, 'InstallPath'));
    candidates.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam');
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'Steam'));
  } else {
    candidates.push(path.join(os.homedir(), '.steam', 'steam'), path.join(os.homedir(), '.local', 'share', 'Steam'));
  }
  for (const c of candidates) {
    if (c && (await exists(path.join(c, 'steamapps')))) return path.normalize(c);
  }
  return null;
}

/** Every library root, from libraryfolders.vdf (new nested and old flat layout). */
async function libraryRoots(steamRoot) {
  const roots = new Map([[steamRoot.toLowerCase(), steamRoot]]);
  for (const rel of ['steamapps/libraryfolders.vdf', 'config/libraryfolders.vdf']) {
    let text;
    try {
      text = await fsp.readFile(path.join(steamRoot, rel), 'utf8');
    } catch {
      continue;
    }
    let folders;
    try {
      const doc = parseVdf(text);
      folders = vdfGet(doc, 'libraryfolders') || vdfGet(doc, 'LibraryFolders');
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(folders || {})) {
      if (!/^\d+$/.test(key)) continue;
      const p = typeof value === 'string' ? value : vdfGet(value, 'path');
      if (p) roots.set(path.normalize(p).toLowerCase(), path.normalize(p));
    }
  }
  return [...roots.values()];
}

async function scanSteam() {
  const steamRoot = await findSteamRoot();
  if (!steamRoot) return { games: [], detail: 'Steam not installed' };

  const games = new Map();
  for (const root of await libraryRoots(steamRoot)) {
    const appsDir = path.join(root, 'steamapps');
    let files;
    try {
      files = await fsp.readdir(appsDir);
    } catch {
      continue; // library on an unplugged drive
    }
    for (const file of files) {
      if (!/^appmanifest_\d+\.acf$/i.test(file)) continue;
      let state;
      try {
        state = vdfGet(parseVdf(await fsp.readFile(path.join(appsDir, file), 'utf8')), 'AppState');
      } catch {
        continue;
      }
      const appId = vdfGet(state, 'appid');
      const name = vdfGet(state, 'name');
      if (!appId || !name || NOT_GAMES.test(name) || SOUNDTRACK.test(name)) continue;
      if (!(Number(vdfGet(state, 'StateFlags')) & STATE_FULLY_INSTALLED)) continue;

      const installDir = path.join(appsDir, 'common', vdfGet(state, 'installdir') || '');
      games.set(appId, {
        id: makeId('pc', 'steam', appId), systemId: 'pc', source: 'pc', launcher: 'steam',
        title: name, sortTitle: parseTitle(name).sortTitle, region: '',
        appId, installDir, steamRoot,
        size: Number(vdfGet(state, 'SizeOnDisk')) || 0,
        launch: { type: 'uri', uri: `steam://rungameid/${appId}` },
      });
    }
  }
  return { games: [...games.values()], detail: steamRoot };
}

module.exports = { scanSteam, findSteamRoot };
