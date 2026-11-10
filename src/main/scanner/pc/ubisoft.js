'use strict';

const { queryRegistry, regValue } = require('./registry');
const { parseTitle, makeId } = require('../../titles');
const path = require('node:path');

const INSTALLS = 'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs';
const UNINSTALL = 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

/**
 * Ubisoft Connect records each install as ...\Launcher\Installs\<id> with an
 * InstallDir, and a matching "Uplay Install <id>" uninstall entry that carries
 * the display name. Games start through the launcher's own URI.
 */
async function scanUbisoft() {
  if (process.platform !== 'win32') return { games: [], detail: 'Windows only' };

  const installs = await queryRegistry(INSTALLS);
  if (!installs.size) return { games: [], detail: 'Ubisoft Connect not installed' };

  const names = new Map();
  for (const [key, values] of await queryRegistry(UNINSTALL)) {
    const m = key.match(/\\Uplay Install (\d+)$/i);
    if (m) names.set(m[1], regValue(values, 'DisplayName') || '');
  }

  const games = new Map();
  for (const [key, values] of installs) {
    const id = (key.match(/\\Installs\\(\d+)$/i) || [])[1];
    const installDir = (regValue(values, 'InstallDir') || '').replace(/[\\/]+$/, '');
    if (!id || !installDir) continue;
    const title = names.get(id) || path.basename(installDir);
    games.set(id, {
      id: makeId('pc', 'ubisoft', id), systemId: 'pc', source: 'pc', launcher: 'ubisoft',
      title, sortTitle: parseTitle(title).sortTitle, region: '',
      appId: id, installDir, size: 0,
      launch: { type: 'uri', uri: `uplay://launch/${id}/0` },
    });
  }
  return { games: [...games.values()], detail: 'ok' };
}

module.exports = { scanUbisoft };
