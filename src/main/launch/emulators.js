'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { retroarchResume, dolphinResume } = require('./resume');

const WIN = process.platform === 'win32';
const env = (name, fallback = '') => process.env[name] || fallback;

class LaunchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const libExt = WIN ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';

/**
 * One entry per emulator. `args` receives the absolute game path and returns
 * the argv that starts that game full-screen with no launcher UI, in a form
 * where the emulator process exits when the game is closed.
 *
 *   RetroArch  retroarch -L cores/<core>_libretro.dll --fullscreen "<rom>"
 *   PCSX2      pcsx2-qt -batch -fullscreen -nogui -- "<iso>"
 *   RPCS3      rpcs3 --no-gui --fullscreen "<EBOOT.BIN | iso>"
 *   Dolphin    Dolphin -b -e "<iso>" -C Dolphin.Display.Fullscreen=True
 *   xemu       xemu -full-screen -dvd_path "<iso>"
 */
const EMULATORS = {
  retroarch: {
    name: 'RetroArch',
    candidates: () => WIN ? [
      'C:\\RetroArch-Win64\\retroarch.exe',
      path.join(env('APPDATA'), 'RetroArch', 'retroarch.exe'),
      'C:\\Program Files\\RetroArch\\retroarch.exe',
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\RetroArch\\retroarch.exe',
    ] : ['/usr/bin/retroarch', '/usr/local/bin/retroarch', '/Applications/RetroArch.app/Contents/MacOS/RetroArch'],
    async args({ gamePath, exe, core, emulatorConfig }) {
      if (!core) throw new LaunchError('NO_CORE', 'No libretro core is configured for this system.');
      const coresDir = emulatorConfig.coresDir || path.join(path.dirname(exe), 'cores');
      const corePath = path.isAbsolute(core) ? core : path.join(coresDir, `${core}_libretro.${libExt}`);
      try {
        await fs.access(corePath);
      } catch {
        throw new LaunchError('CORE_MISSING', `RetroArch core not found: ${corePath}. Install it from RetroArch's Online Updater.`);
      }
      return ['-L', corePath, '--fullscreen', gamePath];
    },
    resume: retroarchResume,
  },

  pcsx2: {
    name: 'PCSX2',
    candidates: () => WIN ? [
      'C:\\Program Files\\PCSX2\\pcsx2-qt.exe',
      'C:\\Program Files (x86)\\PCSX2\\pcsx2-qt.exe',
      'C:\\PCSX2\\pcsx2-qt.exe',
    ] : ['/usr/bin/pcsx2-qt', '/Applications/PCSX2.app/Contents/MacOS/PCSX2'],
    // -batch quits PCSX2 when the VM shuts down, -nogui hides the main window.
    async args({ gamePath }) {
      return ['-batch', '-fullscreen', '-nogui', '--', gamePath];
    },
  },

  rpcs3: {
    name: 'RPCS3',
    candidates: () => WIN ? [
      'C:\\RPCS3\\rpcs3.exe',
      'C:\\Program Files\\RPCS3\\rpcs3.exe',
      path.join(env('LOCALAPPDATA'), 'RPCS3', 'rpcs3.exe'),
    ] : ['/usr/bin/rpcs3', '/Applications/RPCS3.app/Contents/MacOS/rpcs3'],
    // --fullscreen is only honoured together with --no-gui.
    async args({ gamePath }) {
      return ['--no-gui', '--fullscreen', gamePath];
    },
  },

  dolphin: {
    name: 'Dolphin',
    candidates: () => WIN ? [
      'C:\\Program Files\\Dolphin\\Dolphin.exe',
      'C:\\Program Files\\Dolphin-x64\\Dolphin.exe',
      'C:\\Dolphin-x64\\Dolphin.exe',
    ] : ['/usr/bin/dolphin-emu', '/Applications/Dolphin.app/Contents/MacOS/Dolphin'],
    // -b exits with the game; -C overrides one setting for this run only.
    async args({ gamePath }) {
      return ['-b', '-e', gamePath, '-C', 'Dolphin.Display.Fullscreen=True'];
    },
    resume: dolphinResume,
  },

  xemu: {
    name: 'xemu',
    candidates: () => WIN ? [
      'C:\\Program Files\\xemu\\xemu.exe',
      path.join(env('LOCALAPPDATA'), 'Programs', 'xemu', 'xemu.exe'),
      'C:\\xemu\\xemu.exe',
    ] : ['/usr/bin/xemu', '/Applications/xemu.app/Contents/MacOS/xemu'],
    async args({ gamePath }) {
      return ['-full-screen', '-dvd_path', gamePath];
    },
  },
};

/**
 * Resolves a ROM record into a concrete { exe, args, cwd } launch plan and
 * verifies that everything it references exists, so a failure surfaces as a
 * readable message instead of a spawn ENOENT.
 */
async function resolveLaunch(game, system, config, { overrides = {}, resume = false, userDir = '' } = {}) {
  const systemConfig = config.systems[system.id] || {};
  // A per-game choice beats the system's, which beats the built-in default.
  const emulatorId = overrides.emulator || systemConfig.emulator || system.emulator;
  const emulator = EMULATORS[emulatorId];
  if (!emulator) throw new LaunchError('NO_EMULATOR', `Unknown emulator "${emulatorId}" for ${system.name}.`);

  const emulatorConfig = config.emulators[emulatorId] || {};
  const exe = emulatorConfig.path;
  if (!exe) throw new LaunchError('EMULATOR_NOT_SET', `${emulator.name} is not configured. Set its path in Settings.`);
  try {
    await fs.access(exe);
  } catch {
    throw new LaunchError('EMULATOR_MISSING', `${emulator.name} was not found at ${exe}.`);
  }

  const gamePath = game.launchPath || game.path;
  try {
    await fs.access(gamePath);
  } catch {
    throw new LaunchError('GAME_MISSING', `Game file is missing: ${gamePath}`);
  }

  // A core only carries over when the game still uses the system's own emulator.
  const sameEmulator = emulatorId === (systemConfig.emulator || system.emulator);
  const core = overrides.core || (sameEmulator ? systemConfig.core || system.core : '');
  const args = await emulator.args({ gamePath, exe, core, emulatorConfig });

  const strings = (list) => (Array.isArray(list) ? list.filter((a) => typeof a === 'string') : []);
  const extra = [...strings(emulatorConfig.extraArgs), ...strings(overrides.extraArgs)];

  let resumed = false;
  if (resume && emulator.resume) {
    const resumeArgs = await emulator.resume({ gamePath, exe, userDir }).catch(() => null);
    if (resumeArgs) { extra.push(...resumeArgs); resumed = true; }
  }
  return { emulatorId, emulatorName: emulator.name, exe, args: [...extra, ...args], cwd: path.dirname(exe), resumed };
}

module.exports = { EMULATORS, resolveLaunch, LaunchError };
