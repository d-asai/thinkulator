'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text) {
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_m, name) => ENTITIES[name])
    .trim();
}

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
};

/**
 * Parses an EmulationStation gamelist.xml, the de facto metadata format that
 * Skraper, ES-DE, Batocera and RetroPie all write next to ROMs:
 *
 *   <game><path>./Chrono Trigger (USA).sfc</path><name>Chrono Trigger</name>
 *         <desc>...</desc><releasedate>19950311T000000</releasedate>
 *         <genre>RPG</genre><players>1</players><rating>0.95</rating></game>
 *
 * @returns Map keyed by lower-case ROM file name (with extension).
 */
function parseGamelist(xml) {
  const games = new Map();
  for (const m of String(xml).matchAll(/<game\b[^>]*>([\s\S]*?)<\/game>/gi)) {
    const block = m[1];
    const file = path.basename(tag(block, 'path').replace(/\\/g, '/'));
    if (!file) continue;
    const date = tag(block, 'releasedate');
    const rating = Number(tag(block, 'rating'));
    const meta = {
      description: tag(block, 'desc'),
      year: /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : 0,
      genre: tag(block, 'genre'),
      players: tag(block, 'players'),
      rating: rating > 0 && rating <= 1 ? rating : 0,
      developer: tag(block, 'developer'),
      publisher: tag(block, 'publisher'),
    };
    games.set(file.toLowerCase(), meta);
  }
  return games;
}

async function readGamelist(dir) {
  try {
    return parseGamelist(await fsp.readFile(path.join(dir, 'gamelist.xml'), 'utf8'));
  } catch {
    return new Map();
  }
}

/** True if a metadata record carries anything worth showing. */
function hasMeta(meta) {
  return !!(meta && (meta.description || meta.year || meta.genre || meta.developer));
}

module.exports = { parseGamelist, readGamelist, hasMeta };
