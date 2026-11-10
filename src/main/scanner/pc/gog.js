'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { queryRegistry, regValue } = require('./registry');
const { parseTitle, makeId } = require('../../titles');

/**
 * GOG installers (with or without Galaxy) register each game under
 *   HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\<gameId>
 * with gameName, path, exe and workingDir. GOG games are DRM-free, so the
 * executable is started directly and Galaxy does not need to be running.
 */
async function scanGog() {
  if (process.platform !== 'win32') return { games: [], detail: 'Windows only' };

  const keys = await queryRegistry('HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games');
  const games = new Map();
  for (const values of keys.values()) {
    const id = regValue(values, 'gameID');
    const name = regValue(values, 'gameName');
    const exe = regValue(values, 'exe');
    if (!id || !name || !exe) continue;
    if (regValue(values, 'dependsOn')) continue; // DLC rides on its base game
    if (!fs.existsSync(exe)) continue; //           stale entry from a removed install

    const installDir = regValue(values, 'path') || path.dirname(exe);
    games.set(id, {
      id: makeId('pc', 'gog', id), systemId: 'pc', source: 'pc', launcher: 'gog',
      title: name, sortTitle: parseTitle(name).sortTitle, region: '',
      appId: id, installDir, size: 0,
      launch: { type: 'exec', command: exe, args: [], cwd: regValue(values, 'workingDir') || installDir },
    });
  }
  return { games: [...games.values()], detail: keys.size ? 'ok' : 'No GOG games installed' };
}

module.exports = { scanGog };
