'use strict';

const { scanSteam } = require('./steam');
const { scanEpic } = require('./epic');
const { scanXbox } = require('./xbox');
const { scanBattleNet } = require('./battlenet');
const { scanGog } = require('./gog');
const { scanEa } = require('./ea');
const { scanUbisoft } = require('./ubisoft');

const SCANNERS = {
  steam: scanSteam, epic: scanEpic, xbox: scanXbox, battlenet: scanBattleNet,
  gog: scanGog, ea: scanEa, ubisoft: scanUbisoft,
};
const PC_LAUNCHER_IDS = Object.keys(SCANNERS);

/**
 * Runs every enabled launcher scanner concurrently. One launcher failing
 * (corrupt manifest, missing registry hive) never hides the others.
 */
async function scanPcGames(enabled) {
  const ids = Object.keys(SCANNERS).filter((id) => enabled[id] !== false);
  const results = await Promise.allSettled(ids.map((id) => SCANNERS[id]()));

  const games = [];
  const status = {};
  results.forEach((r, i) => {
    const id = ids[i];
    if (r.status === 'fulfilled') {
      games.push(...r.value.games);
      status[id] = { count: r.value.games.length, detail: r.value.detail };
    } else {
      status[id] = { count: 0, detail: `error: ${r.reason && r.reason.message}` };
    }
  });
  return { games, status };
}

module.exports = { scanPcGames, PC_LAUNCHER_IDS };
