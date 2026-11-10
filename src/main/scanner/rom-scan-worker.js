'use strict';

/**
 * Runs inside a worker_thread. Walks every configured ROM directory and posts
 * the games it finds back in batches. Nothing here touches the Electron main
 * thread's event loop, so the UI stays responsive on a cold disk or a slow NAS.
 *
 * Messages out:
 *   { type: 'batch', games: [...] }
 *   { type: 'warn',  message }
 *   { type: 'done',  stats: { files, dirs, games, ms } }
 */

const { parentPort, workerData } = require('node:worker_threads');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { parseTitle, romId } = require('../titles');

const WIN = process.platform === 'win32';
const MAX_DEPTH = 8;
const BATCH = 64;
const SKIP_DIRS = new Set(['media', 'boxart', 'covers', 'images', 'saves', 'savestates', 'states', 'screenshots', 'manuals', '$recycle.bin', 'system volume information']);
const RAW_TRACKS = new Set(['.bin', '.img']);
const SHEETS = new Set(['.cue', '.gdi', '.ccd', '.mds']);

const stats = { files: 0, dirs: 0, games: 0 };
let batch = [];

function flush() {
  if (!batch.length) return;
  parentPort.postMessage({ type: 'batch', games: batch });
  batch = [];
}

function emit(game) {
  stats.games++;
  batch.push(game);
  if (batch.length >= BATCH) flush();
}

function warn(message) {
  parentPort.postMessage({ type: 'warn', message });
}

/** Minimal PARAM.SFO reader: returns the string/int entries as an object. */
async function readSfo(file) {
  let buf;
  try {
    buf = await fsp.readFile(file);
  } catch {
    return null;
  }
  if (buf.length < 20 || buf.readUInt32BE(0) !== 0x00505346) return null; // "\0PSF"
  const keyTable = buf.readUInt32LE(8);
  const dataTable = buf.readUInt32LE(12);
  const count = buf.readUInt32LE(16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const at = 20 + i * 16;
    if (at + 16 > buf.length) break;
    const keyOffset = buf.readUInt16LE(at);
    const format = buf.readUInt16LE(at + 2);
    const length = buf.readUInt32LE(at + 4);
    const dataOffset = buf.readUInt32LE(at + 12);
    const keyStart = keyTable + keyOffset;
    const keyEnd = buf.indexOf(0, keyStart);
    if (keyEnd < 0) break;
    const key = buf.toString('utf8', keyStart, keyEnd);
    const start = dataTable + dataOffset;
    if (start + length > buf.length) continue;
    if (format === 0x0404) out[key] = buf.readUInt32LE(start);
    else out[key] = buf.toString('utf8', start, start + length).replace(/\0+$/, '');
  }
  return out;
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * A PS3 title is a directory, either a disc dump (<dir>/PS3_GAME/...) or an
 * installed package (<dir>/PARAM.SFO + USRDIR). Returns true when `dir` was
 * consumed as a game and must not be descended into.
 */
async function tryPs3Folder(job, dir, names) {
  let root = null;
  if (names.has('ps3_game')) root = path.join(dir, 'PS3_GAME');
  else if (names.has('param.sfo') && names.has('usrdir')) root = dir;
  if (!root) return false;

  const eboot = path.join(root, 'USRDIR', 'EBOOT.BIN');
  if (!(await exists(eboot))) return false;
  const sfo = await readSfo(path.join(root, 'PARAM.SFO'));
  if (sfo && sfo.CATEGORY === 'GD') return true; // game data / patch, not a title

  const fallback = parseTitle(path.basename(dir));
  const title = sfo && sfo.TITLE ? sfo.TITLE.replace(/\s+/g, ' ').trim() : fallback.title;
  let mtime = 0;
  try {
    mtime = (await fsp.stat(eboot)).mtimeMs;
  } catch { /* keep 0 */ }
  emit({
    id: romId(job.systemId, dir), systemId: job.systemId, source: 'rom',
    title, sortTitle: parseTitle(title).sortTitle, region: fallback.region,
    path: dir, launchPath: eboot, fileName: path.basename(dir),
    serial: sfo ? sfo.TITLE_ID || '' : '', size: 0, mtime,
  });
  return true;
}

async function walk(job, seen) {
  const extensions = new Set(job.extensions);
  const stack = [{ dir: job.dir, depth: 0 }];

  while (stack.length) {
    const { dir, depth } = stack.pop();

    // realpath de-duplicates junctions / symlink loops and overlapping roots.
    let real;
    try {
      real = await fsp.realpath(dir);
    } catch (err) {
      warn(`Cannot open ${dir}: ${err.code || err.message}`);
      continue;
    }
    const key = `${job.systemId}|${WIN ? real.toLowerCase() : real}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      warn(`Cannot read ${dir}: ${err.code || err.message}`);
      continue;
    }
    stats.dirs++;

    const names = new Set(entries.map((e) => e.name.toLowerCase()));
    if (job.systemId === 'ps3' && (await tryPs3Folder(job, dir, names))) continue;

    // Bases that have a cue sheet: their raw .bin/.img tracks are not games.
    const sheetBases = new Set();
    let anySheet = false;
    for (const e of entries) {
      const ext = path.extname(e.name).toLowerCase();
      if (SHEETS.has(ext)) {
        anySheet = true;
        sheetBases.add(e.name.slice(0, -ext.length).toLowerCase());
      }
    }

    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);

      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name.toLowerCase())) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;
      stats.files++;

      const ext = path.extname(e.name).toLowerCase();
      if (!extensions.has(ext)) continue;
      const base = e.name.slice(0, -ext.length);
      if (RAW_TRACKS.has(ext) && anySheet) {
        // "Game (Track 2).bin" or "Game.bin" next to "Game.cue".
        const stem = base.toLowerCase().replace(/\s*\(track \d+\)$/, '');
        if (sheetBases.has(stem) || sheetBases.has(base.toLowerCase())) continue;
      }

      let st;
      try {
        st = await fsp.stat(full);
      } catch {
        continue; // vanished mid-scan
      }
      const parsed = parseTitle(base);
      emit({
        id: romId(job.systemId, full), systemId: job.systemId, source: 'rom',
        title: parsed.title, sortTitle: parsed.sortTitle, region: parsed.region,
        path: full, fileName: base, size: st.size, mtime: st.mtimeMs,
      });
    }
  }
}

(async () => {
  const started = Date.now();
  const seen = new Set();
  for (const job of workerData.jobs) {
    try {
      await walk(job, seen);
    } catch (err) {
      warn(`Scan of ${job.dir} failed: ${err.message}`);
    }
  }
  flush();
  parentPort.postMessage({ type: 'done', stats: { ...stats, ms: Date.now() - started } });
})();
