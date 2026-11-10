'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { queryRegistry, regValue } = require('./registry');
const { parseTitle, makeId } = require('../../titles');

const REPO = 'HKLM\\SOFTWARE\\Microsoft\\GamingServices\\PackageRepository';

const attr = (xml, tag, name) => {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*?\\b${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? m[1] : '';
};

async function readText(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Xbox app / Game Pass titles are MSIX packages registered by GamingServices:
 *
 *   ...\PackageRepository\Package   value name = package full name, data = id
 *   ...\PackageRepository\Root\<id>\<n>   "Root" = \\?\D:\XboxGames\<Game>\Content
 *
 * The install root holds appxmanifest.xml (identity + application id) and
 * MicrosoftGame.config (display name). Packaged apps cannot be started by exe
 * path, so the launch command activates  shell:AppsFolder\<family>!<appId>.
 */
async function scanXbox() {
  if (process.platform !== 'win32') return { games: [], detail: 'Windows only' };

  const roots = await queryRegistry(`${REPO}\\Root`);
  if (!roots.size) return { games: [], detail: 'No Xbox app games registered' };

  const packages = await queryRegistry(`${REPO}\\Package`, { recursive: false });
  const fullNameById = new Map();
  for (const values of packages.values()) {
    for (const [fullName, id] of Object.entries(values)) fullNameById.set(String(id).toLowerCase(), fullName);
  }

  const games = new Map();
  for (const [key, values] of roots) {
    const rawRoot = regValue(values, 'Root');
    if (!rawRoot) continue;
    const installDir = rawRoot.replace(/^\\\\\?\\/, '');

    const manifest = await readText(path.join(installDir, 'appxmanifest.xml'));
    if (!manifest) continue; // uninstalled leftovers

    const idInKey = (key.match(/\\Root\\([^\\]+)/i) || [])[1] || '';
    const fullName = regValue(values, 'Package') || fullNameById.get(idInKey.toLowerCase()) || '';
    const identityName = attr(manifest, 'Identity', 'Name') || fullName.split('_')[0];
    const publisherId = fullName.includes('_') ? fullName.slice(fullName.lastIndexOf('_') + 1) : '';
    const appId = attr(manifest, 'Application', 'Id');
    if (!identityName || !publisherId || !appId) continue;

    const gameConfig = await readText(path.join(installDir, 'MicrosoftGame.config'));
    let title = attr(gameConfig, 'ShellVisuals', 'DefaultDisplayName') || attr(manifest, 'uap:VisualElements', 'DisplayName');
    if (!title || /^ms-resource:/i.test(title)) {
      // ...\<Game Name>\Content
      const parent = path.basename(path.dirname(installDir));
      title = /^content$/i.test(path.basename(installDir)) && parent ? parent : identityName;
    }

    const family = `${identityName}_${publisherId}`;
    games.set(family, {
      id: makeId('pc', 'xbox', family), systemId: 'pc', source: 'pc', launcher: 'xbox',
      title, sortTitle: parseTitle(title).sortTitle, region: '',
      appId: family, installDir, size: 0,
      launch: { type: 'exec', command: 'explorer.exe', args: [`shell:AppsFolder\\${family}!${appId}`] },
    });
  }
  return { games: [...games.values()], detail: 'ok' };
}

module.exports = { scanXbox };
