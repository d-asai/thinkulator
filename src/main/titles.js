'use strict';

const crypto = require('node:crypto');

const REGIONS = [
  [/\b(usa|us|u)\b/i, 'USA'],
  [/\b(europe|eur|e|pal)\b/i, 'Europe'],
  [/\b(japan|jpn|j)\b/i, 'Japan'],
  [/\bworld\b/i, 'World'],
  [/\bkorea\b/i, 'Korea'],
  [/\b(brazil)\b/i, 'Brazil'],
  [/\b(australia)\b/i, 'Australia'],
];

/**
 * Turns a No-Intro / Redump style file name into a display title.
 *   "Legend of Zelda, The - A Link to the Past (USA) (Rev 1) [!]"
 *     -> { title: "The Legend of Zelda - A Link to the Past", region: "USA" }
 */
function parseTitle(baseName) {
  let name = String(baseName);
  if (!name.includes(' ')) name = name.replace(/[_.]+/g, ' ');

  const tags = [];
  name = name.replace(/\s*[([]([^)\]]*)[)\]]/g, (_m, tag) => { tags.push(tag); return ''; }).trim();
  if (!name) name = String(baseName);

  const article = name.match(/^(.*?), (The|A|An|Le|La|Les|Der|Die|Das)(\s+-\s+.*)?$/i);
  if (article) name = `${article[2]} ${article[1]}${article[3] || ''}`;
  name = name.replace(/\s{2,}/g, ' ').trim();

  let region = '';
  for (const tag of tags) {
    for (const [re, label] of REGIONS) {
      if (re.test(tag)) { region = label; break; }
    }
    if (region) break;
  }
  return { title: name, sortTitle: sortKey(name), region };
}

function sortKey(title) {
  return String(title).toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^\p{L}\p{N} ]+/gu, '').replace(/\s{2,}/g, ' ').trim();
}

/** Stable 16 hex char id. Paths are case-folded on Windows so a rescan keeps ids. */
function makeId(...parts) {
  const h = crypto.createHash('sha1');
  for (const p of parts) h.update(String(p)).update('\0');
  return h.digest('hex').slice(0, 16);
}

function romId(systemId, filePath) {
  return makeId(systemId, process.platform === 'win32' ? filePath.toLowerCase() : filePath);
}

const ID_RE = /^[a-f0-9]{16}$/;

module.exports = { parseTitle, sortKey, makeId, romId, ID_RE };
