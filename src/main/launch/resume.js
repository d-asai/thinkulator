'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/**
 * "Continue where you left off": extra arguments that make an emulator boot
 * straight into the most recent save state. Each function returns an argv
 * fragment, or null when there is nothing to resume (the game then starts
 * normally). Only emulators with a documented way to do this are covered.
 */

/**
 * RetroArch: an appended config turns on its own auto-state pair, so quitting
 * saves a state and the next launch loads it. --appendconfig layers on top of
 * the user's retroarch.cfg for this run only; their settings are not changed.
 */
async function retroarchResume({ userDir }) {
  const cfg = path.join(userDir, 'retroarch-resume.cfg');
  await fsp.writeFile(cfg, 'savestate_auto_save = "true"\nsavestate_auto_load = "true"\n', 'utf8');
  return ['--appendconfig', cfg];
}

/** GameCube / Wii disc id: six characters at the start of the image (0x200 in a WBFS). */
async function readDolphinGameId(file) {
  const ext = path.extname(file).toLowerCase();
  const offset = ext === '.wbfs' ? 0x200 : ext === '.iso' || ext === '.gcm' ? 0 : -1;
  if (offset < 0) return ''; // compressed formats (rvz, gcz, wia) keep the id elsewhere
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const buf = Buffer.alloc(6);
    await handle.read(buf, 0, 6, offset);
    const id = buf.toString('latin1');
    return /^[A-Z0-9]{6}$/.test(id) ? id : '';
  } catch {
    return '';
  } finally {
    if (handle) await handle.close();
  }
}

/** Dolphin names states <GAMEID>.s01 ... in StateSaves; pick the newest and load it with -s. */
async function dolphinResume({ gamePath, exe }) {
  const id = await readDolphinGameId(gamePath);
  if (!id) return null;

  const dirs = [
    path.join(path.dirname(exe), 'User', 'StateSaves'), // portable install
    path.join(process.env.APPDATA || '', 'Dolphin Emulator', 'StateSaves'),
    path.join(os.homedir(), 'Documents', 'Dolphin Emulator', 'StateSaves'),
    path.join(os.homedir(), '.local', 'share', 'dolphin-emu', 'StateSaves'),
  ];
  let newest = null;
  for (const dir of dirs) {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(`${id}.s`) || !/\.s\d\d$/.test(name)) continue;
      const file = path.join(dir, name);
      const { mtimeMs } = await fsp.stat(file).catch(() => ({ mtimeMs: 0 }));
      if (!newest || mtimeMs > newest.mtimeMs) newest = { file, mtimeMs };
    }
  }
  return newest ? ['-s', newest.file] : null;
}

module.exports = { retroarchResume, dolphinResume, readDolphinGameId };
