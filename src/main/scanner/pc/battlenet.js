'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { queryRegistry, regValue } = require('./registry');
const { parseTitle, makeId } = require('../../titles');

const UNINSTALL_KEYS = [
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

/**
 * The uninstaller's --uid is Blizzard's internal product id; the launcher's
 * "launch" command wants a different short code. Unknown uids still appear on
 * the shelf and fall back to opening the Battle.net client.
 */
const LAUNCH_CODES = {
  wow: 'WoW', wow_classic: 'WoW', wow_classic_era: 'WoW',
  d3: 'D3', diablo3: 'D3', fenris: 'Fen', osi: 'OSI',
  hs_beta: 'WTCG', s1: 'S1', s2: 'S2', w3: 'W3', heroes: 'Hero',
  prometheus: 'Pro', pro: 'Pro',
  viper: 'VIPR', odin: 'ODIN', lazarus: 'LAZR', zeus: 'ZEUS', auks: 'AUKS', fore: 'FORE', pinta: 'PNTA',
  wlby: 'WLBY', rtro: 'RTRO', anbs: 'ANBS',
};

/**
 * Battle.net keeps no readable manifest, but every installed game registers a
 * Windows uninstall entry whose command runs "Blizzard Uninstaller.exe
 * --uid=<product>". That entry gives the name, install path and product id.
 */
async function scanBattleNet() {
  if (process.platform !== 'win32') return { games: [], detail: 'Windows only' };

  let clientExe = '';
  const entries = [];
  for (const root of UNINSTALL_KEYS) {
    for (const [key, values] of await queryRegistry(root)) {
      const uninstall = regValue(values, 'UninstallString') || '';
      const name = regValue(values, 'DisplayName') || '';
      const location = regValue(values, 'InstallLocation') || '';
      if (/\\Battle\.net$/i.test(key) || /^Battle\.net$/i.test(name)) {
        const exe = path.join(location, 'Battle.net.exe');
        if (location && fs.existsSync(exe)) clientExe = exe;
        continue;
      }
      const uid = (uninstall.match(/--uid=([\w-]+)/i) || [])[1];
      if (!uid || !/Blizzard Uninstaller|Battle\.net/i.test(uninstall) || !name) continue;
      entries.push({ uid: uid.toLowerCase(), name, location });
    }
  }

  const games = new Map();
  for (const e of entries) {
    const code = LAUNCH_CODES[e.uid];
    let launch;
    if (clientExe && code) launch = { type: 'exec', command: clientExe, args: [`--exec=launch ${code}`] };
    else if (clientExe) launch = { type: 'exec', command: clientExe, args: [] };
    else launch = { type: 'uri', uri: `battlenet://${code || ''}` };
    games.set(e.uid, {
      id: makeId('pc', 'battlenet', e.uid), systemId: 'pc', source: 'pc', launcher: 'battlenet',
      title: e.name, sortTitle: parseTitle(e.name).sortTitle, region: '',
      appId: e.uid, installDir: e.location, size: 0, launch,
    });
  }
  return { games: [...games.values()], detail: clientExe || (entries.length ? 'client not found' : 'Battle.net not installed') };
}

module.exports = { scanBattleNet };
