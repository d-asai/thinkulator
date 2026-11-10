'use strict';

/**
 * Static description of every shelf. The order here is the vertical order of
 * the shelves in the 3D view (index 0 is the top shelf).
 *
 * - extensions:      file types the ROM scanner accepts for the system
 * - emulator / core: default launch target (see launch/emulators.js)
 * - libretro:        directory name on thumbnails.libretro.com
 * - screenscraperId: "systemeid" of the ScreenScraper v2 API
 * - profile:         box profile id used by the renderer's mesh factory
 * - accent:          shelf LED / HUD colour
 */
const SYSTEMS = [
  {
    id: 'nes', name: 'Nintendo Entertainment System', short: 'NES', kind: 'rom',
    extensions: ['.nes', '.fds', '.unf', '.unif', '.zip', '.7z'],
    emulator: 'retroarch', core: 'mesen',
    libretro: 'Nintendo - Nintendo Entertainment System', screenscraperId: 3,
    profile: 'nes-cardboard', accent: '#e4002b',
  },
  {
    id: 'snes', name: 'Super Nintendo', short: 'SNES', kind: 'rom',
    extensions: ['.sfc', '.smc', '.swc', '.fig', '.zip', '.7z'],
    emulator: 'retroarch', core: 'snes9x',
    libretro: 'Nintendo - Super Nintendo Entertainment System', screenscraperId: 4,
    profile: 'snes-cardboard', accent: '#7b5aa6',
  },
  {
    id: 'gamecube', name: 'Nintendo GameCube', short: 'GameCube', kind: 'rom',
    extensions: ['.iso', '.gcm', '.gcz', '.rvz', '.ciso', '.wia'],
    emulator: 'dolphin',
    libretro: 'Nintendo - GameCube', screenscraperId: 13,
    profile: 'gamecube-case', accent: '#6a5fbd',
  },
  {
    id: 'ps2', name: 'PlayStation 2', short: 'PS2', kind: 'rom',
    extensions: ['.iso', '.chd', '.cso', '.zso', '.gz', '.cue', '.bin', '.img', '.mdf', '.nrg'],
    emulator: 'pcsx2',
    libretro: 'Sony - PlayStation 2', screenscraperId: 58,
    profile: 'ps2-case', accent: '#2f6bff',
  },
  {
    id: 'xbox', name: 'Xbox', short: 'Xbox', kind: 'rom',
    extensions: ['.iso', '.xiso'],
    emulator: 'xemu',
    libretro: 'Microsoft - Xbox', screenscraperId: 32,
    profile: 'xbox-case', accent: '#7ac143',
  },
  {
    id: 'wii', name: 'Nintendo Wii', short: 'Wii', kind: 'rom',
    extensions: ['.iso', '.wbfs', '.rvz', '.gcz', '.ciso', '.wia', '.wad'],
    emulator: 'dolphin',
    libretro: 'Nintendo - Wii', screenscraperId: 16,
    profile: 'wii-case', accent: '#35c6e8',
  },
  {
    id: 'ps3', name: 'PlayStation 3', short: 'PS3', kind: 'rom',
    extensions: ['.iso'],
    emulator: 'rpcs3',
    libretro: 'Sony - PlayStation 3', screenscraperId: 59,
    profile: 'ps3-case', accent: '#b8c2d6',
  },
  {
    id: 'pc', name: 'PC', short: 'PC', kind: 'pc',
    extensions: [],
    profile: 'pc-slim', accent: '#4aa3ff',
  },
];

const SYSTEM_BY_ID = new Map(SYSTEMS.map((s) => [s.id, s]));

/** The subset of a system the renderer needs. */
function publicSystem(s) {
  return { id: s.id, name: s.name, short: s.short, kind: s.kind, profile: s.profile, accent: s.accent };
}

module.exports = { SYSTEMS, SYSTEM_BY_ID, publicSystem };
