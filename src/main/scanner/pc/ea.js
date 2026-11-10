'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { queryRegistry, regValue } = require('./registry');
const { parseTitle, makeId } = require('../../titles');

/**
 * Pulls the game executable out of an EA installer manifest. The launcher
 * entry is a registry reference followed by a relative path:
 *   <filePath>[HKEY_LOCAL_MACHINE\SOFTWARE\EA Games\Title\Install Dir]Game.exe</filePath>
 * The first non-trial launcher wins.
 */
function launcherFromInstallerData(xml) {
  for (const m of String(xml).matchAll(/<launcher\b[^>]*>([\s\S]*?)<\/launcher>/gi)) {
    const block = m[1];
    if (/<trial>\s*1\s*<\/trial>/i.test(block)) continue;
    const file = block.match(/<filePath>\s*(?:\[[^\]]*\])?([^<]+?)\s*<\/filePath>/i);
    if (file && /\.exe$/i.test(file[1])) return file[1].replace(/^[\\/]+/, '');
  }
  return '';
}

/**
 * The EA app (and Origin before it) writes one key per installed game under
 *   HKLM\SOFTWARE\WOW6432Node\EA Games\<Title>   ("Install Dir", "DisplayName")
 * and each install carries __Installer\installerdata.xml naming its
 * executable. Starting that executable hands off to the EA app for licensing,
 * so no store-specific URI is needed.
 */
async function scanEa() {
  if (process.platform !== 'win32') return { games: [], detail: 'Windows only' };

  const keys = new Map([
    ...(await queryRegistry('HKLM\\SOFTWARE\\WOW6432Node\\EA Games')),
    ...(await queryRegistry('HKLM\\SOFTWARE\\WOW6432Node\\Electronic Arts')),
  ]);

  const games = new Map();
  for (const [key, values] of keys) {
    const installDir = (regValue(values, 'Install Dir') || '').replace(/[\\/]+$/, '');
    if (!installDir || games.has(installDir.toLowerCase())) continue;

    let xml;
    try {
      xml = await fsp.readFile(path.join(installDir, '__Installer', 'installerdata.xml'), 'utf8');
    } catch {
      continue; // not an EA app install (or already removed)
    }
    const relative = launcherFromInstallerData(xml);
    const exe = relative ? path.join(installDir, relative) : '';
    if (!exe || !fs.existsSync(exe)) continue;

    const title = regValue(values, 'DisplayName') || key.slice(key.lastIndexOf('\\') + 1);
    games.set(installDir.toLowerCase(), {
      id: makeId('pc', 'ea', installDir.toLowerCase()), systemId: 'pc', source: 'pc', launcher: 'ea',
      title, sortTitle: parseTitle(title).sortTitle, region: '',
      appId: title, installDir, size: 0,
      launch: { type: 'exec', command: exe, args: [], cwd: path.dirname(exe) },
    });
  }
  return { games: [...games.values()], detail: keys.size ? 'ok' : 'EA app not installed' };
}

module.exports = { scanEa, launcherFromInstallerData };
