'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseVdf, vdfGet } = require('../src/main/scanner/pc/vdf');
const { parseRegOutput } = require('../src/main/scanner/pc/registry');
const { parseTitle } = require('../src/main/titles');
const { scanRoms } = require('../src/main/scanner/rom-scanner');
const { EMULATORS, resolveLaunch } = require('../src/main/launch/emulators');
const { LaunchBridge } = require('../src/main/launch/launch-bridge');
const { ArtStore, sniffImage } = require('../src/main/scraper/art-store');
const { SYSTEM_BY_ID } = require('../src/main/systems');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `megashelf-${name}-`));
const touch = (file, bytes = 16) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
};

test('vdf: new and old libraryfolders layouts, escapes, comments', () => {
  const doc = parseVdf(`
    // comment
    "libraryfolders"
    {
      "0" { "path" "C:\\\\Program Files (x86)\\\\Steam" "apps" { "620" "1234" } }
      "1" { "path" "D:\\\\Games" }
      "contentstatsid" "42"
    }`);
  const folders = vdfGet(doc, 'LibraryFolders');
  assert.equal(folders['0'].path, 'C:\\Program Files (x86)\\Steam');
  assert.equal(folders['1'].path, 'D:\\Games');
  assert.equal(folders['0'].apps['620'], '1234');

  const old = parseVdf('"LibraryFolders" { "1" "E:\\\\SteamLibrary" }');
  assert.equal(old.LibraryFolders['1'], 'E:\\SteamLibrary');
  assert.throws(() => parseVdf('"a" {'));
});

test('registry: parses reg.exe output including empty and spaced values', () => {
  const out = [
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Test\\Game One',
    '    DisplayName    REG_SZ    Game    One',
    '    Empty    REG_SZ    ',
    '    (Default)    REG_SZ    x',
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Test\\Two',
    '    Size    REG_DWORD    0x10',
  ].join('\r\n');
  const keys = parseRegOutput(out);
  assert.equal(keys.size, 2);
  assert.equal(keys.get('HKEY_LOCAL_MACHINE\\SOFTWARE\\Test\\Game One').DisplayName, 'Game    One');
  assert.equal(keys.get('HKEY_LOCAL_MACHINE\\SOFTWARE\\Test\\Game One').Empty, '');
  assert.equal(keys.get('HKEY_LOCAL_MACHINE\\SOFTWARE\\Test\\Two').Size, '0x10');
});

test('titles: tags, regions and trailing articles', () => {
  const t = parseTitle('Legend of Zelda, The - A Link to the Past (USA) (Rev 1) [!]');
  assert.equal(t.title, 'The Legend of Zelda - A Link to the Past');
  assert.equal(t.region, 'USA');
  assert.equal(t.sortTitle, 'legend of zelda a link to the past');
  assert.equal(parseTitle('Super_Game_2').title, 'Super Game 2');
  assert.equal(parseTitle('Gran Turismo 4 (Europe) (En,Fr,De)').region, 'Europe');
});

test('rom scanner: extensions, cue/bin pairs, skipped folders, PS3 folders', async () => {
  const root = tmp('roms');
  touch(path.join(root, 'snes', 'Chrono Quest (USA).sfc'));
  touch(path.join(root, 'snes', 'notes.txt'));
  touch(path.join(root, 'snes', 'sub', 'Deep Game (Japan).smc'));
  touch(path.join(root, 'snes', 'boxart', 'Chrono Quest (USA).sfc')); // inside a skipped dir
  touch(path.join(root, 'ps2', 'Racer (Europe).cue'));
  touch(path.join(root, 'ps2', 'Racer (Europe).bin'));
  touch(path.join(root, 'ps2', 'Racer (Europe) (Track 2).bin'));
  touch(path.join(root, 'ps2', 'Loose Image.bin'));
  touch(path.join(root, 'ps2', 'Big Game (USA).iso'), 2048);
  touch(path.join(root, 'ps3', 'BLUS12345', 'PS3_GAME', 'USRDIR', 'EBOOT.BIN'));
  touch(path.join(root, 'ps3', 'BLUS12345', 'PS3_GAME', 'USRDIR', 'data.iso')); // must not be listed

  const config = { systems: {
    snes: { romDirs: [path.join(root, 'snes')] },
    ps2: { romDirs: [path.join(root, 'ps2')] },
    ps3: { romDirs: [path.join(root, 'ps3')] },
  } };
  const games = [];
  const warnings = [];
  const stats = await scanRoms(config, (batch) => games.push(...batch), (w) => warnings.push(w)).promise;

  const titles = (sys) => games.filter((g) => g.systemId === sys).map((g) => g.title).sort();
  assert.deepEqual(titles('snes'), ['Chrono Quest', 'Deep Game']);
  assert.deepEqual(titles('ps2'), ['Big Game', 'Loose Image', 'Racer']);
  assert.deepEqual(titles('ps3'), ['BLUS12345']);
  assert.equal(stats.games, 6);
  assert.deepEqual(warnings, []);

  const ps3 = games.find((g) => g.systemId === 'ps3');
  assert.ok(ps3.launchPath.endsWith(path.join('USRDIR', 'EBOOT.BIN')));
  assert.equal(games.find((g) => g.title === 'Big Game').size, 2048);
  assert.equal(new Set(games.map((g) => g.id)).size, games.length);
  fs.rmSync(root, { recursive: true, force: true });
});

test('rom scanner: a missing directory is a warning, not a failure', async () => {
  const warnings = [];
  const stats = await scanRoms({ systems: { nes: { romDirs: [path.join(os.tmpdir(), 'megashelf-does-not-exist')] } } },
    () => {}, (w) => warnings.push(w)).promise;
  assert.equal(stats.games, 0);
  assert.equal(warnings.length, 1);
});

test('emulators: launch arguments', async () => {
  const gamePath = 'C:\\roms\\game.iso';
  const args = (id) => EMULATORS[id].args({ gamePath, exe: 'C:\\emu\\emu.exe', core: '', emulatorConfig: {} });
  assert.deepEqual(await args('pcsx2'), ['-batch', '-fullscreen', '-nogui', '--', gamePath]);
  assert.deepEqual(await args('rpcs3'), ['--no-gui', '--fullscreen', gamePath]);
  assert.deepEqual(await args('dolphin'), ['-b', '-e', gamePath, '-C', 'Dolphin.Display.Fullscreen=True']);
  assert.deepEqual(await args('xemu'), ['-full-screen', '-dvd_path', gamePath]);

  const dir = tmp('ra');
  const ext = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';
  const core = path.join(dir, 'cores', `snes9x_libretro.${ext}`);
  touch(core);
  const exe = path.join(dir, 'retroarch.exe');
  assert.deepEqual(await EMULATORS.retroarch.args({ gamePath, exe, core: 'snes9x', emulatorConfig: {} }), ['-L', core, '--fullscreen', gamePath]);
  await assert.rejects(EMULATORS.retroarch.args({ gamePath, exe, core: 'missing', emulatorConfig: {} }), { code: 'CORE_MISSING' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('emulators: unconfigured emulator and missing game are reported clearly', async () => {
  const system = SYSTEM_BY_ID.get('ps2');
  const game = { id: 'x', systemId: 'ps2', path: path.join(os.tmpdir(), 'nope.iso') };
  await assert.rejects(resolveLaunch(game, system, { systems: { ps2: { emulator: 'pcsx2' } }, emulators: { pcsx2: { path: '' } } }), { code: 'EMULATOR_NOT_SET' });
  await assert.rejects(resolveLaunch(game, system, { systems: { ps2: { emulator: 'pcsx2' } }, emulators: { pcsx2: { path: process.execPath } } }), { code: 'GAME_MISSING' });
});

/** A config whose "Dolphin" is really node, running a script we control. */
function fakeEmulatorConfig(script) {
  return {
    systems: { gamecube: { emulator: 'dolphin' } },
    emulators: { dolphin: { path: process.execPath, extraArgs: ['-e', script, '--'] } },
  };
}

test('launch bridge: tracks a session, refuses a second, terminates the process', async () => {
  const dir = tmp('launch');
  const rom = path.join(dir, 'game.iso');
  touch(rom);
  const game = { id: 'a'.repeat(16), systemId: 'gamecube', source: 'rom', title: 'Test', path: rom };
  const system = SYSTEM_BY_ID.get('gamecube');
  const bridge = new LaunchBridge({ openExternal: async () => {} });

  const started = [];
  bridge.on('started', (e) => started.push(e));
  const ended = new Promise((resolve) => bridge.once('ended', resolve));

  const result = await bridge.launch(game, system, fakeEmulatorConfig('setInterval(() => {}, 1000)'));
  assert.equal(result.tracked, true);
  assert.equal(bridge.active, true);
  assert.equal(started[0].gameId, game.id);
  const pid = bridge.session.child.pid;

  await assert.rejects(bridge.launch(game, system, fakeEmulatorConfig('0')), { code: 'BUSY' });

  assert.equal(bridge.terminate(), true);
  const info = await ended;
  assert.equal(info.gameId, game.id);
  assert.equal(info.failed, false, 'a user-requested stop is not a failed boot');
  assert.equal(bridge.active, false);
  assert.throws(() => process.kill(pid, 0), 'process must be gone');
  bridge.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('launch bridge: an emulator that dies at boot is reported with its stderr', async () => {
  const dir = tmp('launch');
  const rom = path.join(dir, 'game.iso');
  touch(rom);
  const game = { id: 'b'.repeat(16), systemId: 'gamecube', source: 'rom', title: 'Broken', path: rom };
  const bridge = new LaunchBridge({ openExternal: async () => {} });
  const ended = new Promise((resolve) => bridge.once('ended', resolve));
  await bridge.launch(game, SYSTEM_BY_ID.get('gamecube'), fakeEmulatorConfig('console.error("bad bios"); process.exit(3)'));
  const info = await ended;
  assert.equal(info.code, 3);
  assert.equal(info.failed, true);
  assert.match(info.stderr, /bad bios/);
  assert.equal(bridge.active, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('launch bridge: store URIs are allow-listed; demo entries never launch', async () => {
  const opened = [];
  const bridge = new LaunchBridge({ openExternal: async (uri) => opened.push(uri) });
  const pc = (uri) => ({ id: 'c'.repeat(16), source: 'pc', launcher: 'steam', title: 'G', launch: { type: 'uri', uri } });
  assert.deepEqual(await bridge.launch(pc('steam://rungameid/620')), { tracked: false });
  assert.deepEqual(opened, ['steam://rungameid/620']);
  await assert.rejects(bridge.launch(pc('file:///C:/Windows/System32/calc.exe')), { code: 'BAD_URI' });
  await assert.rejects(bridge.launch({ source: 'demo' }), { code: 'DEMO' });
  assert.equal(bridge.active, false);
});

test('art store: sniffing, versioning, stale atlas rejection, path safety', async () => {
  const root = tmp('art');
  const store = await new ArtStore(root).init();
  const id = 'd'.repeat(16);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
  assert.equal(sniffImage(png), 'png');
  assert.equal(sniffImage(Buffer.from('<html>not an image</html>')), null);

  await assert.rejects(store.saveImage(id, 'front', Buffer.from('<html>not an image</html>')));
  await assert.rejects(store.saveImage('../evil', 'front', png));
  await store.saveImage(id, 'front', png);
  const v = store.describe(id).v;
  assert.equal(store.describe(id).front, 'front.png');

  assert.equal(await store.saveAtlas(id, 'ps2-case-512', webp, v), true);
  assert.deepEqual(store.describe(id).atlases, ['ps2-case-512']);
  assert.equal(await store.saveAtlas(id, 'ps2-case-512', webp, v - 1), false, 'atlas from older art is dropped');

  await store.saveImage(id, 'back', png); // new source art invalidates stitched atlases
  assert.deepEqual(store.describe(id).atlases, []);
  assert.ok(!fs.existsSync(path.join(root, id, 'atlas-ps2-case-512.webp')));

  assert.ok(store.resolve(`${id}/front.png`));
  assert.equal(store.resolve(`${id}/../../secret.png`), null);
  assert.equal(store.resolve('nope/front.png'), null);

  const reloaded = await new ArtStore(root).init();
  assert.equal(reloaded.describe(id).front, 'front.png');
  assert.equal(reloaded.describe(id).back, 'back.png');
  fs.rmSync(root, { recursive: true, force: true });
});
