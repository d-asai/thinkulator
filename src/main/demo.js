'use strict';

const { SYSTEMS } = require('./systems');
const { makeId, parseTitle } = require('./titles');

const FIRST = ['Crystal', 'Iron', 'Neon', 'Shadow', 'Turbo', 'Star', 'Thunder', 'Pixel', 'Lunar', 'Ember', 'Frost', 'Solar',
  'Phantom', 'Cobalt', 'Velvet', 'Rogue', 'Quantum', 'Golden', 'Silent', 'Hyper', 'Astro', 'Crimson', 'Jade', 'Midnight'];
const SECOND = ['Quest', 'Racers', 'Legends', 'Tactics', 'Odyssey', 'Fighters', 'Kingdom', 'Circuit', 'Drifter', 'Saga',
  'Protocol', 'Horizon', 'Frontier', 'Rally', 'Chronicle', 'Arena', 'Voyage', 'Syndicate', 'Garden', 'Engine'];
const SUFFIX = ['', '', '', ' II', ' III', ' 64', ' Zero', ' DX', ': Origins', ' Online', ': Remastered', ' Advance'];
const REGION = ['USA', 'USA', 'Europe', 'Japan', 'World'];
const PC_LAUNCHERS = ['steam', 'steam', 'steam', 'epic', 'xbox', 'battlenet', 'gog', 'ea', 'ubisoft'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A deterministic library of invented titles, used by `npm run demo` so the
 * shelf can be explored (and profiled) without any ROMs or launchers. Entries
 * are marked source:'demo' and the launch bridge refuses to start them.
 */
function demoLibrary(perSystem = 40) {
  const games = [];
  SYSTEMS.forEach((system, si) => {
    const rand = mulberry32(1337 + si * 97);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const used = new Set();
    while (used.size < perSystem) {
      const title = `${pick(FIRST)} ${pick(SECOND)}${pick(SUFFIX)}`;
      if (used.has(title)) continue;
      used.add(title);
      games.push({
        id: makeId('demo', system.id, title), systemId: system.id, source: 'demo',
        title, sortTitle: parseTitle(title).sortTitle,
        region: system.kind === 'pc' ? '' : pick(REGION),
        launcher: system.kind === 'pc' ? pick(PC_LAUNCHERS) : undefined,
        path: '', fileName: title, size: 0, mtime: 0,
      });
    }
  });
  return games;
}

module.exports = { demoLibrary };
