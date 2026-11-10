'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { queryRegistry, regValue } = require('./registry');
const { parseTitle, makeId } = require('../../titles');

async function manifestDirs() {
  const dirs = [];
  if (process.platform === 'win32') {
    dirs.push(path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'));
    const reg = await queryRegistry('HKLM\\SOFTWARE\\WOW6432Node\\Epic Games\\EpicGamesLauncher', { recursive: false });
    for (const values of reg.values()) {
      const appData = regValue(values, 'AppDataPath');
      if (appData) dirs.push(path.join(appData, 'Manifests'));
    }
  } else if (process.platform === 'darwin') {
    dirs.push(path.join(process.env.HOME || '', 'Library', 'Application Support', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'));
  }
  return [...new Set(dirs.map((d) => path.normalize(d)))];
}

/**
 * The Epic launcher writes one JSON ".item" manifest per installed product.
 * The launch URI needs the namespace:catalogItem:appName triple, not just the
 * app name, or the launcher opens the store page instead of starting the game.
 */
async function scanEpic() {
  const games = new Map();
  let found = false;

  for (const dir of await manifestDirs()) {
    let files;
    try {
      files = await fsp.readdir(dir);
    } catch {
      continue;
    }
    found = true;
    for (const file of files) {
      if (!file.toLowerCase().endsWith('.item')) continue;
      let m;
      try {
        m = JSON.parse(await fsp.readFile(path.join(dir, file), 'utf8'));
      } catch {
        continue;
      }
      if (!m.AppName || !m.DisplayName || m.bIsIncompleteInstall) continue;
      if (m.MainGameAppName && m.MainGameAppName !== m.AppName) continue; // DLC
      if (Array.isArray(m.AppCategories) && m.AppCategories.length && !m.AppCategories.includes('games')) continue;
      if (/^UE_/.test(m.AppName)) continue; // Unreal Engine installs

      const triple = [m.CatalogNamespace, m.CatalogItemId, m.AppName].map(encodeURIComponent).join('%3A');
      const target = m.CatalogNamespace && m.CatalogItemId ? triple : encodeURIComponent(m.AppName);
      games.set(m.AppName, {
        id: makeId('pc', 'epic', m.AppName), systemId: 'pc', source: 'pc', launcher: 'epic',
        title: m.DisplayName, sortTitle: parseTitle(m.DisplayName).sortTitle, region: '',
        appId: m.AppName, installDir: m.InstallLocation || '', size: Number(m.InstallSize) || 0,
        launch: { type: 'uri', uri: `com.epicgames.launcher://apps/${target}?action=launch&silent=true` },
      });
    }
  }
  return { games: [...games.values()], detail: found ? 'ok' : 'Epic Games Launcher not installed' };
}

module.exports = { scanEpic };
