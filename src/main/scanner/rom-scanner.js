'use strict';

const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { SYSTEMS } = require('../systems');

/**
 * Scans all configured ROM directories on a worker thread.
 *
 * @param config   Config#data
 * @param onBatch  called on the main thread with each batch of game records
 * @param onWarn   called with non-fatal problems (unreadable directory, ...)
 * @returns {{ promise: Promise<object>, cancel: () => void }}
 */
function scanRoms(config, onBatch, onWarn = () => {}) {
  const jobs = [];
  for (const system of SYSTEMS) {
    if (system.kind !== 'rom') continue;
    const dirs = (config.systems[system.id] && config.systems[system.id].romDirs) || [];
    for (const dir of dirs) jobs.push({ systemId: system.id, dir, extensions: system.extensions });
  }
  if (!jobs.length) {
    return { promise: Promise.resolve({ files: 0, dirs: 0, games: 0, ms: 0 }), cancel() {} };
  }

  const worker = new Worker(path.join(__dirname, 'rom-scan-worker.js'), { workerData: { jobs } });
  let settled = false;

  const promise = new Promise((resolve, reject) => {
    worker.on('message', (msg) => {
      if (msg.type === 'batch') onBatch(msg.games);
      else if (msg.type === 'warn') onWarn(msg.message);
      else if (msg.type === 'done') { settled = true; resolve(msg.stats); }
    });
    worker.once('error', (err) => { settled = true; reject(err); });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`ROM scan worker exited early (code ${code})`));
    });
  });

  return {
    promise,
    cancel() {
      if (!settled) worker.terminate();
    },
  };
}

module.exports = { scanRoms };
