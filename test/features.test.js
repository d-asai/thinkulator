'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { UserData } = require('../src/main/userdata');
const { MetaStore } = require('../src/main/scraper/meta-store');
const { parseGamelist, hasMeta } = require('../src/main/scraper/gamelist');
const { readDolphinGameId, dolphinResume, retroarchResume } = require('../src/main/launch/resume');
const { resolveLaunch } = require('../src/main/launch/emulators');
const { launcherFromInstallerData } = require('../src/main/scanner/pc/ea');
const { SYSTEMS, SYSTEM_BY_ID } = require('../src/main/systems');
const { EMULATORS } = require('../src/main/launch/emulators');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `megashelf-${name}-`));
const shelves = () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'library', 'shelves.js')).href);
const boxes = () => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'engine', 'BoxFactory.js'), 'utf8');

// ---- systems -----------------------------------------------------------------

test('systems: every system has a known emulator, a box profile and unique id', () => {
  const source = boxes();
  const ids = new Set();
  for (const s of SYSTEMS) {
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`);
    ids.add(s.id);
    assert.ok(source.includes(`'${s.profile}': {`), `${s.id}: box profile ${s.profile} is not defined`);
    if (s.kind !== 'rom') continue;
    assert.ok(EMULATORS[s.emulator], `${s.id}: unknown emulator ${s.emulator}`);
    if (s.emulator === 'retroarch') assert.ok(s.core, `${s.id}: RetroArch system needs a core`);
    assert.ok(s.extensions.length && s.extensions.every((e) => /^\.[a-z0-9]+$/.test(e)), `${s.id}: extensions`);
    assert.ok(s.libretro && s.screenscraperId, `${s.id}: scraper ids`);
  }
  for (const id of ['gb', 'gbc', 'gba', 'n64', 'nds', 'ps1', 'psp', 'genesis', 'dreamcast']) assert.ok(ids.has(id), id);
});

// ---- user data ---------------------------------------------------------------

test('userdata: patches, defaults are not stored, play stats, persistence', async () => {
  const dir = tmp('user');
  const file = path.join(dir, 'userdata.json');
  const user = await new UserData(file).load();
  const id = 'a'.repeat(16);

  assert.deepEqual(user.describe(id).favorite, false);
  user.patch(id, { favorite: true, title: 'My Name' });
  user.recordLaunch(id);
  user.recordLaunch(id);
  user.addPlayTime(id, 125.4);
  const d = user.describe(id);
  assert.equal(d.favorite, true);
  assert.equal(d.title, 'My Name');
  assert.equal(d.playCount, 2);
  assert.equal(d.playSeconds, 125);
  assert.ok(d.lastPlayed > 0);

  user.patch(id, { favorite: false, title: '' });
  assert.equal('favorite' in user.raw(id), false, 'defaults are removed, not stored');

  const other = 'b'.repeat(16);
  user.patch(other, { hidden: true });
  user.patch(other, { hidden: false });
  assert.equal(other in user.data.games, false, 'a game with no settings leaves no record');

  await user.flush();
  const reloaded = await new UserData(file).load();
  assert.equal(reloaded.describe(id).playCount, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('userdata: collections', async () => {
  const dir = tmp('user');
  const user = await new UserData(path.join(dir, 'u.json')).load();
  const a = user.createCollection('  Co-op   night ');
  assert.equal(user.collections()[0].name, 'Co-op night');
  assert.equal(user.createCollection('co-op night'), a, 'same name returns the existing collection');
  assert.equal(user.createCollection('   '), null);

  user.toggleInCollection(a, 'x'.repeat(16));
  user.toggleInCollection(a, 'y'.repeat(16));
  user.toggleInCollection(a, 'x'.repeat(16)); // toggles off
  assert.deepEqual(user.collections()[0].games, ['y'.repeat(16)]);
  user.deleteCollection(a);
  assert.equal(user.collections().length, 0);
  await user.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- metadata ----------------------------------------------------------------

test('gamelist.xml: fields, entities, CDATA and path forms', () => {
  const games = parseGamelist(`<?xml version="1.0"?><gameList>
    <game id="1"><path>./Chrono Quest (USA).sfc</path><name>Chrono Quest</name>
      <desc>Time &amp; again. &quot;Classic&quot; &#233;pop&#xE9;e.</desc><releasedate>19950311T000000</releasedate>
      <genre>Role-Playing</genre><players>1-2</players><rating>0.95</rating>
      <developer>Dev Co</developer><publisher>Pub Co</publisher></game>
    <game><path>sub\\Other Game.sfc</path><desc><![CDATA[Raw <b>text</b>]]></desc><rating>7</rating></game>
    <game><name>No path</name></game>
  </gameList>`);
  assert.equal(games.size, 2);
  const g = games.get('chrono quest (usa).sfc');
  assert.equal(g.description, 'Time & again. "Classic" épopée.');
  assert.equal(g.year, 1995);
  assert.equal(g.genre, 'Role-Playing');
  assert.equal(g.players, '1-2');
  assert.equal(g.rating, 0.95);
  assert.equal(g.developer, 'Dev Co');
  const o = games.get('other game.sfc');
  assert.equal(o.description, 'Raw <b>text</b>');
  assert.equal(o.rating, 0, 'out-of-range rating is dropped');
  assert.equal(hasMeta(g), true);
  assert.equal(hasMeta({ description: '', year: 0, genre: '', developer: '' }), false);
});

test('meta store: clamps and persists', async () => {
  const dir = tmp('meta');
  const file = path.join(dir, 'meta.json');
  const store = await new MetaStore(file).init();
  store.set('id1', { description: 'x'.repeat(5000), year: 3000, genre: 'Action', rating: 1.5, players: '2', developer: 'D', publisher: 'P' });
  const m = store.get('id1');
  assert.equal(m.description.length, 1200);
  assert.equal(m.year, 0);
  assert.equal(m.rating, 0);
  await store.flush();
  assert.equal((await new MetaStore(file).init()).get('id1').genre, 'Action');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- resume and per-game launch settings ---------------------------------------

test('resume: Dolphin game id, newest state wins, RetroArch config', async () => {
  const dir = tmp('resume');
  const iso = path.join(dir, 'game.iso');
  fs.writeFileSync(iso, Buffer.concat([Buffer.from('GALE01'), Buffer.alloc(64)]));
  const wbfs = path.join(dir, 'game.wbfs');
  fs.writeFileSync(wbfs, Buffer.concat([Buffer.alloc(0x200), Buffer.from('RSBE01'), Buffer.alloc(16)]));
  assert.equal(await readDolphinGameId(iso), 'GALE01');
  assert.equal(await readDolphinGameId(wbfs), 'RSBE01');
  assert.equal(await readDolphinGameId(path.join(dir, 'game.rvz')), '', 'compressed images are not guessed at');
  fs.writeFileSync(path.join(dir, 'junk.iso'), Buffer.alloc(32));
  assert.equal(await readDolphinGameId(path.join(dir, 'junk.iso')), '');

  // A portable Dolphin: states live in <exe dir>/User/StateSaves.
  const exe = path.join(dir, 'Dolphin.exe');
  const states = path.join(dir, 'User', 'StateSaves');
  fs.mkdirSync(states, { recursive: true });
  assert.equal(await dolphinResume({ gamePath: iso, exe }), null, 'no states yet');
  fs.writeFileSync(path.join(states, 'GALE01.s01'), 'old');
  fs.writeFileSync(path.join(states, 'GALE01.s03'), 'new');
  fs.writeFileSync(path.join(states, 'RSBE01.s01'), 'other game');
  const old = new Date(Date.now() - 86400000);
  fs.utimesSync(path.join(states, 'GALE01.s01'), old, old);
  assert.deepEqual(await dolphinResume({ gamePath: iso, exe }), ['-s', path.join(states, 'GALE01.s03')]);

  const args = await retroarchResume({ userDir: dir });
  assert.equal(args[0], '--appendconfig');
  const cfg = fs.readFileSync(args[1], 'utf8');
  assert.match(cfg, /savestate_auto_load = "true"/);
  assert.match(cfg, /savestate_auto_save = "true"/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('launch: per-game emulator, core and arguments override the system; resume appends', async () => {
  const dir = tmp('launch');
  const rom = path.join(dir, 'game.sfc');
  fs.writeFileSync(rom, 'x');
  const ext = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';
  fs.mkdirSync(path.join(dir, 'cores'));
  for (const core of ['snes9x', 'bsnes']) fs.writeFileSync(path.join(dir, 'cores', `${core}_libretro.${ext}`), 'x');
  const exe = path.join(dir, 'retroarch.exe');
  fs.writeFileSync(exe, 'x');

  const system = SYSTEM_BY_ID.get('snes');
  const config = {
    systems: { snes: { emulator: 'retroarch', core: 'snes9x' } },
    emulators: { retroarch: { path: exe, extraArgs: ['--verbose'] }, dolphin: { path: exe, extraArgs: [] } },
  };
  const game = { id: 'x', systemId: 'snes', path: rom };

  const base = await resolveLaunch(game, system, config);
  assert.deepEqual(base.args, ['--verbose', '-L', path.join(dir, 'cores', `snes9x_libretro.${ext}`), '--fullscreen', rom]);
  assert.equal(base.resumed, false);

  const custom = await resolveLaunch(game, system, config, { overrides: { core: 'bsnes', extraArgs: ['--set', 'a b'] } });
  assert.deepEqual(custom.args, ['--verbose', '--set', 'a b', '-L', path.join(dir, 'cores', `bsnes_libretro.${ext}`), '--fullscreen', rom]);

  const other = await resolveLaunch(game, system, config, { overrides: { emulator: 'dolphin' } });
  assert.equal(other.emulatorId, 'dolphin');
  assert.deepEqual(other.args, ['-b', '-e', rom, '-C', 'Dolphin.Display.Fullscreen=True']);

  const resumed = await resolveLaunch(game, system, config, { resume: true, userDir: dir });
  assert.equal(resumed.resumed, true);
  assert.deepEqual(resumed.args.slice(0, 3), ['--verbose', '--appendconfig', path.join(dir, 'retroarch-resume.cfg')]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- PC launchers --------------------------------------------------------------

test('EA: executable from installerdata.xml, skipping trial launchers', () => {
  const xml = `<DiPManifest><runtime>
    <launcher><filePath>[HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\Title\\Install Dir]Trial.exe</filePath><trial>1</trial></launcher>
    <launcher uid="1"><filePath>[HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\Title\\Install Dir]bin\\Game.exe</filePath><trial>0</trial></launcher>
  </runtime></DiPManifest>`;
  assert.equal(launcherFromInstallerData(xml), 'bin\\Game.exe');
  assert.equal(launcherFromInstallerData('<DiPManifest></DiPManifest>'), '');
});

// ---- shelves -------------------------------------------------------------------

const systems = [
  { id: 'snes', name: 'Super Nintendo', short: 'SNES', accent: '#000', kind: 'rom' },
  { id: 'pc', name: 'PC', short: 'PC', accent: '#000', kind: 'pc' },
];
let seq = 0;
const game = (title, systemId, extra = {}) => ({
  id: `g${seq++}`, systemId, title, sortTitle: title.toLowerCase().replace(/^the /, ''), region: extra.region || '',
  meta: extra.year ? { year: extra.year, description: '' } : null,
  user: { favorite: false, hidden: false, playCount: 0, lastPlayed: 0, ...extra.user },
});

test('shelves: virtual shelves, ordering and hidden games', async () => {
  const { buildShelves, DEFAULT_VIEW } = await shelves();
  const zelda = game('The Zelda', 'snes', { user: { favorite: true, lastPlayed: 50, playCount: 3 } });
  const mario = game('Mario 10', 'snes', { user: { lastPlayed: 90, playCount: 1 } });
  const mario2 = game('Mario 2', 'snes');
  const secret = game('Secret', 'snes', { user: { hidden: true, favorite: true } });
  const doom = game('Doom', 'pc', { user: { favorite: true } });
  const orphan = game('Orphan', 'gone');
  const games = [zelda, mario, mario2, secret, doom, orphan];
  const collections = [{ id: 'c1', name: 'Night', games: [doom.id, 'missing', mario2.id] }, { id: 'c2', name: 'Empty', games: [] }];

  const out = buildShelves({ systems, games, collections, view: DEFAULT_VIEW });
  assert.deepEqual(out.map((s) => s.id), ['@favorites', '@recent', '@collection:c1', 'snes', 'pc']);
  const titles = (id) => out.find((s) => s.id === id).games.map((g) => g.title);
  assert.deepEqual(titles('@favorites'), ['Doom', 'The Zelda']);
  assert.deepEqual(titles('@recent'), ['Mario 10', 'The Zelda'], 'most recent first');
  assert.deepEqual(titles('@collection:c1'), ['Doom', 'Mario 2'], 'collection keeps its own order');
  assert.deepEqual(titles('snes'), ['Mario 2', 'Mario 10', 'The Zelda'], 'numeric sort, article ignored');
  assert.equal(zelda.system.id, 'snes', 'each game is linked to its console');

  const withHidden = buildShelves({ systems, games, collections, view: { ...DEFAULT_VIEW, showHidden: true } });
  assert.ok(withHidden.find((s) => s.id === 'snes').games.includes(secret));

  const played = buildShelves({ systems, games, collections, view: { ...DEFAULT_VIEW, sort: 'played' } });
  assert.deepEqual(played.find((s) => s.id === 'snes').games.map((g) => g.title), ['The Zelda', 'Mario 10', 'Mario 2']);

  const favOnly = buildShelves({ systems, games, collections, view: { ...DEFAULT_VIEW, favoritesOnly: true } });
  assert.deepEqual(favOnly.find((s) => s.id === 'snes').games.map((g) => g.title), ['The Zelda']);
});

test('shelves: region filter, duplicate collapsing, year sort', async () => {
  const { buildShelves, DEFAULT_VIEW } = await shelves();
  const games = [
    game('Racer', 'snes', { region: 'Japan', year: 1993 }),
    game('Racer', 'snes', { region: 'USA', year: 1994 }),
    game('Racer', 'snes', { region: 'Europe' }),
    game('Globe', 'snes', { region: 'World', year: 1991 }),
    game('Sakura', 'snes', { region: 'Japan', year: 1990 }),
    game('Untagged', 'snes'),
  ];
  const list = (view) => buildShelves({ systems, games, view: { ...DEFAULT_VIEW, ...view } })[0].games.map((g) => `${g.title}/${g.region}`);

  assert.deepEqual(list({ region: 'Japan' }), ['Globe/World', 'Racer/Japan', 'Sakura/Japan', 'Untagged/']);
  assert.deepEqual(list({ collapseDuplicates: true }), ['Globe/World', 'Racer/USA', 'Sakura/Japan', 'Untagged/'], 'USA copy preferred by default');
  assert.deepEqual(list({ collapseDuplicates: true, region: 'Europe' }), ['Globe/World', 'Racer/Europe', 'Untagged/']);
  assert.deepEqual(list({ sort: 'year' }).slice(0, 4), ['Sakura/Japan', 'Globe/World', 'Racer/Japan', 'Racer/USA'], 'unknown years last');
});

test('shelves: search ranking and letter groups', async () => {
  const { searchGames, letterOf } = await shelves();
  const games = [game('Super Mario World', 'snes'), game('Mario Kart', 'snes'), game('Dr. Mario', 'snes'),
    game('Marionette', 'snes'), game('Hidden Mario', 'snes', { user: { hidden: true } }), game('Zelda', 'snes')];
  assert.deepEqual(searchGames(games, 'mario').map((g) => g.title), ['Mario Kart', 'Marionette', 'Dr. Mario', 'Super Mario World']);
  assert.deepEqual(searchGames(games, 'mario world').map((g) => g.title), ['Super Mario World']);
  assert.deepEqual(searchGames(games, 'KART mario').map((g) => g.title), ['Mario Kart'], 'word order and case do not matter');
  assert.deepEqual(searchGames(games, '   '), []);
  assert.deepEqual(searchGames(games, 'a(').length, 0, 'regex characters are literal');
  assert.equal(letterOf({ sortTitle: 'zelda' }), 'Z');
  assert.equal(letterOf({ sortTitle: '007 racing' }), '#');
});
