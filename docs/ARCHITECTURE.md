# MegaShelf architecture

MegaShelf is an Electron desktop app. The main process (Node.js) owns the file
system, the registry, the network and every child process. The renderer is a
sandboxed page that draws the shelf with Three.js and knows games only by id.

```
┌──────────────────────── main process (Node) ────────────────────────┐
│  Config ── Library ──┬── ROM scanner ──► worker_thread (fs walk)     │
│   UserData  MetaStore└── PC scanners (Steam, Epic, Xbox, Battle.net, │
│                                       GOG, EA, Ubisoft)              │
│  ArtStore ◄── Scraper (sidecar, ScreenScraper, libretro, Steam)      │
│  Updater (GitHub releases)                                           │
│  LaunchBridge ──► child_process (emulators) / URI handlers (stores)  │
│  shelf:// protocol  (renderer files, three.js, cached art)           │
└───────────────▲──────────────────────────────────┬──────────────────┘
        ipcRenderer.invoke (verbs + game ids)       │ events
┌───────────────┴──────────────────────────────────▼──────────────────┐
│  renderer (sandboxed, contextIsolation, strict CSP)                  │
│  App ── InputManager (gamepad + keyboard)                            │
│      ── shelves.js (favourites, recents, collections, filters)      │
│      ── Menu / TextEntry (controller-driven overlays) ── SoundEngine │
│      ── ShelfView (layout, pooling) ── BoxFactory (geometry, PBR)    │
│      ── Inspector (360° inspection)                                  │
│      ── TextureManager (LRU cache) ──► Worker (atlas stitching)      │
│      ── SceneManager (renderer, lights, environment)                 │
└──────────────────────────────────────────────────────────────────────┘
```

## 1. Process model and trust boundary

| Decision | Reason |
|---|---|
| Renderer is sandboxed with `contextIsolation`, no Node integration | A game title is untrusted text (it comes from a file name or a store manifest). Nothing the page does can reach the disk or spawn a process directly. |
| The preload exposes verbs, never paths: `launch(gameId)`, `addRomDir(systemId)` | The main process maps an id to a file and an argv. The page cannot ask for an arbitrary executable or argument. |
| Every IPC handler checks the calling frame's URL | Only the app's own page can use the bridge. |
| Custom `shelf://app` origin instead of `file://` | Gives ES modules, module workers, `fetch` and untainted WebGL textures under a CSP of `default-src 'none'; script-src 'self'`. The handler serves three roots only (renderer, `three`, art cache) and rejects path traversal. |
| Emulators are spawned with an argv array, never through a shell | A ROM named `a & del *.iso` is one argument, not a command. |
| Store URIs are allow-listed (`steam:`, `com.epicgames.launcher:`, `battlenet:`) | A corrupted library index cannot make the app open an arbitrary URL. |

## 2. Library indexing

### 2.1 ROM scanner (`src/main/scanner/`)

The walk runs in a `worker_thread`, so neither the Electron main loop nor the
UI ever waits on the disk. The worker streams results back in batches of 64;
the main process forwards a throttled progress count to the HUD.

Rules the walker applies:

- Iterative depth-first walk (max depth 8). Each directory's `realpath` is
  recorded, which removes junction/symlink loops and overlapping roots.
- A file is a game if its extension is in the system's list (`systems.js`).
- `.bin`/`.img` tracks are skipped when a `.cue`/`.gdi`/`.ccd`/`.mds` sheet
  with the same base name sits beside them, so a multi-track disc is one game.
- PS3 titles are directories. A folder containing `PS3_GAME/USRDIR/EBOOT.BIN`
  (disc dump) or `PARAM.SFO` + `USRDIR/EBOOT.BIN` (installed package) becomes
  one game and is not descended into. The title comes from a small
  `PARAM.SFO` parser; patches (`CATEGORY = GD`) are ignored.
- Art and save folders (`boxart`, `media`, `saves`, ...) are not walked.
- An unreadable directory is a warning, never a failed scan.

Ids are `sha1(system + path)` truncated to 16 hex characters, so a rescan
keeps the same id for the same file and cached art stays attached.

Start-up is two-phase: the index saved by the previous run (`library.json`) is
shown immediately, then a background rescan reconciles it with the disk and
the renderer swaps lists while keeping the cursor on the same game.

### 2.2 PC launchers (`src/main/scanner/pc/`)

All four run concurrently under `Promise.allSettled`; one failing never hides
the others. No native modules: the registry is read by running `reg.exe query`
(output forced to UTF-8) and parsing its text.

| Launcher | Source of truth | Launch command |
|---|---|---|
| Steam | Install path from `HKCU\Software\Valve\Steam`. `steamapps/libraryfolders.vdf` lists every library; each `appmanifest_<id>.acf` is one app. Both are Valve KeyValues, parsed by `vdf.js` (handles the nested and the pre-2021 flat layout). Only `StateFlags & 4` (fully installed), minus runtimes such as Proton and the Steamworks redistributables. | `steam://rungameid/<appid>` |
| Epic | `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item` (JSON). Skips incomplete installs, DLC (`MainGameAppName` differs) and Unreal Engine builds. | `com.epicgames.launcher://apps/<namespace>:<catalogItemId>:<appName>?action=launch&silent=true` |
| Xbox app | `HKLM\SOFTWARE\Microsoft\GamingServices\PackageRepository`: `Root\<id>` gives the install folder, `Package` gives the package full name. `appxmanifest.xml` supplies the application id, `MicrosoftGame.config` the display name. | `explorer.exe shell:AppsFolder\<PackageFamilyName>!<AppId>` |
| Battle.net | Windows uninstall entries whose command runs `Blizzard Uninstaller.exe --uid=<product>`. | `Battle.net.exe --exec="launch <code>"`, falling back to `battlenet://<code>` |
| GOG | `HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\<id>` (name, exe, working directory). DLC entries (`dependsOn`) are skipped. | The game's own executable, directly. GOG games are DRM-free, so Galaxy is not needed. |
| EA app | `HKLM\SOFTWARE\WOW6432Node\EA Games\<title>` gives the install folder; `__Installer\installerdata.xml` there names the executable. | That executable, which hands off to the EA app for licensing. |
| Ubisoft Connect | `...\Ubisoft\Launcher\Installs\<id>` for the folder, the `Uplay Install <id>` uninstall entry for the name. | `uplay://launch/<id>/0` |

## 3. Box art: scraping and the unified texture

### 3.1 Scraper (`src/main/scraper/scraper.js`)

A background queue (three at a time) visits every game that has no front
cover. Providers run in order, each filling whichever faces it can:

1. **Sidecar files** next to the ROM: `<name>-front.png`, `<name>-back.jpg`,
   `<name>-spine.png`, or `boxart/<name>.png`. Always used, never needs a network.
2. **ScreenScraper** (`box-2D`, `box-2D-back`, `box-2D-side`), the only source
   that has backs and spines. Used only if developer credentials are set in
   `config.json`.
3. **libretro-thumbnails** for a front cover, keyed by the ROM file name.
4. For Steam: the client's own `appcache/librarycache` on disk, then the CDN.

Downloads are size-capped and identified by magic bytes, never by URL or
extension. A miss is remembered for 14 days so start-up does not re-request
hundreds of 404s. Online lookups can be turned off in Settings.

### 3.2 Stitching (`src/renderer/engine/atlas-worker.js`)

The three scans become **one** texture, laid out like a cover sleeve unfolded:

```
+----------+-------+----------+------+
|   back   | spine |  front   | edge |     column width ∝ real box dimension
+----------+-------+----------+------+
```

- Column widths are proportional to the box's width and depth, so texel
  density is equal on every face. `atlas-layout.js` is imported by both the
  worker (pixels) and the mesh factory (UVs); they cannot drift apart.
- Positions are fractions of the atlas width, so one set of UVs serves the
  512 px shelf atlas and the 2048 px inspection atlas.
- For plastic cases the sleeve is inset inside a rim of case colour (black
  PS2, green Xbox, white Wii, clear PC).
- A missing spine or back is synthesised from the front cover's average
  colour (the back gets a blurred wash of the front). A game with no art at
  all gets a typographic sleeve: one flat ink from a fixed set of ten, one
  geometric mark, the title in condensed capitals and a catalogue number, all
  chosen from its id so it never changes. A shelf of them reads as one series.
- Decoding and compositing happen on an `OffscreenCanvas` in a Web Worker;
  the result returns as a transferred `ImageBitmap` (zero copy).
- Shelf-resolution atlases built from real art are saved as WebP in the art
  cache. The next start loads one small file per box instead of three
  downloads and a composite. Replacing any source image deletes its atlases,
  and a save is rejected if the art changed while it was being stitched.

Why stitch in the renderer rather than in Node: Chromium's canvas already has
hardware-accelerated decode, scale, blur and text, so this needs no native
image library, and only on-screen boxes are ever stitched.

## 4. Universal launch bridge (`src/main/launch/`)

`emulators.js` is a table: for each emulator, where to look for it and how to
build the argv that boots a game full-screen and exits when the game closes.

| Emulator | Systems | Arguments |
|---|---|---|
| RetroArch | NES (`mesen`), SNES (`snes9x`), Genesis (`genesis_plus_gx`), Game Boy and GBC (`gambatte`), GBA (`mgba`), N64 (`mupen64plus_next`), PS1 (`swanstation`), Dreamcast (`flycast`), DS (`melonds`), PSP (`ppsspp`) | `-L <cores>/<core>_libretro.dll --fullscreen "<rom>"` |
| PCSX2 (Qt) | PS2 | `-batch -fullscreen -nogui -- "<iso>"` |
| RPCS3 | PS3 | `--no-gui --fullscreen "<EBOOT.BIN or iso>"` |
| Dolphin | GameCube, Wii | `-b -e "<iso>" -C Dolphin.Display.Fullscreen=True` |
| xemu | Xbox | `-full-screen -dvd_path "<iso>"` |

`resolveLaunch()` checks that the emulator, the core and the game file exist
before anything is spawned, so a problem is a sentence ("RetroArch core not
found: ...") rather than `ENOENT`. Per-emulator `extraArgs` in `config.json`
are prepended.

**Per-game launch settings.** A game can override the emulator, the RetroArch
core and add its own arguments (game menu, Launch settings). The order is
game, then system, then built-in default. A system's core is only inherited
while the game still uses that system's emulator.

**Continue (`resume.js`).** Starts a game from its latest save state, for the
emulators that have a documented way to do it:

- RetroArch: `--appendconfig` layers a two-line config that turns on
  `savestate_auto_save` and `savestate_auto_load` for that run, so quitting
  saves and the next Continue loads. The user's own `retroarch.cfg` is not
  modified.
- Dolphin: the six-character disc id is read from the image (offset 0 of an
  `.iso`/`.gcm`, `0x200` of a `.wbfs`), the newest `<ID>.sNN` in `StateSaves`
  is found, and it is loaded with `-s`. Compressed images (`.rvz`, `.gcz`) are
  not supported; with no state, the game simply starts normally.

PCSX2, RPCS3 and xemu have no equivalent command line, so their games do not
offer Continue.

`LaunchBridge` runs one session at a time:

- **Tracked sessions (emulators).** `spawn()` without a shell; stderr is
  drained into a 4 KB ring so a chatty emulator cannot block on a full pipe.
  On exit it emits `ended` with code, duration and, if the process died with
  a non-zero code within 8 s, the last stderr lines for the error toast.
- **Termination.** `terminate()` first asks politely (`taskkill /T`, which
  posts `WM_CLOSE`; `SIGTERM` to the process group on POSIX) so the emulator
  can flush saves, then force-kills the whole tree after 3 s. While a session
  runs, `Ctrl+Alt+Backspace` is a global shortcut for this.
- **Clean-up.** On exit: timers cleared, stream listeners removed, the stderr
  pipe destroyed, the shortcut unregistered, the window restored and focused.
  On app quit, `dispose()` synchronously kills any remaining tree so an
  emulator is never orphaned.
- **Untracked sessions (stores).** The launcher owns the game process, so
  there is nothing to reap. The renderer simply stops drawing when its window
  loses focus.

While an emulator runs the renderer cancels its animation frame loop
completely: the GPU belongs to the game.

## 5. The 3D shelf engine (`src/renderer/engine/`)

### 5.1 Scene

Scene units are decimetres (a DVD case is 1.9 tall). One perspective camera
(32° FOV) looks slightly down at the active shelf so the shelves above and
below peek into frame. Lighting is a warm shadow-casting key light, a cool rim
light, a spot on the centre slot, a hemisphere fill, and image-based lighting
from a small emissive "studio" scene pre-filtered with PMREM. The IBL is what
makes clear cases and steelbooks actually reflect. The whole rig follows the
camera vertically, so a single 2048² shadow map serves any shelf. Tone mapping
is Khronos PBR Neutral, which keeps cover-art colours true.

The room is dressed by `ShelfDressing.js`: a walnut grain for the shelves, a
matte plaster for the wall, and a printed card in each shelf's edge rail that
names the system and counts its games. All three are drawn to small canvases
at start-up, so no image files are shipped. The card is the only place a
system's colour appears; the interface itself uses one warm off-white ink, a
condensed signage typeface (Bahnschrift, with DIN-style fallbacks), hairline
rules and solid surfaces.

### 5.2 The matrix layout (`ShelfView.js`)

- **Y axis:** shelf *i* sits at `y = -i × 2.95`. One shelf per system.
- **X axis:** game *j* on a shelf sits at `x = (j − scroll) × spacing`.

Input never moves a box. It changes integer cursors; two damped values chase
them (`scroll` per shelf, `camY` for the camera) and every box transform is a
pure function of those. The selected box steps forward, scales up 10% and its
neighbours part and turn towards it; all of that is driven by a smoothstep of
the distance from `scroll`, so it stays continuous however fast input repeats.
Each shelf remembers its own cursor.

### 5.3 Dynamic mesh factory (`BoxFactory.js`)

A profile gives real dimensions, how the sleeve is printed, and a PBR response:

| Profile | W × H × D (mm) | Surface |
|---|---|---|
| `nes-cardboard` | 127 × 178 × 25 | matte card: roughness 0.88 |
| `snes-cardboard` | 178 × 127 × 30 (landscape) | matte card |
| `gamecube-case`, `ps2-case`, `xbox-case`, `wii-case` | 135 × 190 × 14 | glossy sleeve film: clear-coat 0.85 over roughness 0.42 |
| `ps3-case` | 135 × 171 × 14 | clear case: clear-coat 1.0 |
| `pc-slim` (Steam) | 135 × 190 × 7.5 | slim clear case: roughness 0.22, strong reflections |
| `pc-steelbook` (Epic) | 135 × 172 × 13 | printed metal: metalness 0.92 |
| `pc-xbox` (Xbox app) | 135 × 190 × 10 | green case |
| `pc-bigbox` (Battle.net) | 190 × 235 × 45 | 1990s big box, matte |

`profileFor()` picks by platform, and by storefront for PC. Geometry is one
`BoxGeometry` per profile with its UVs remapped onto the atlas columns. A box
is therefore one draw call with one texture.

### 5.4 Inspection (`Inspector.js`)

`t` blends the selected box from its shelf slot to a pose in front of the
camera, sized to fill half the view height whatever the box's proportions.
While inspected the user owns its orientation: the stick sets an angular
velocity that coasts when released (a weighted turntable, not a cursor), yaw
is unlimited (full 360°), pitch is clamped. X snaps to the back cover, Y turns
the spine to face you, triggers zoom. The mouse can drag and flick it. On
entry the texture is upgraded to a 2048 px atlas; on exit the yaw unwinds the
short way round and the hi-res texture is released. Everything else dims.

## 6. Input (`src/renderer/input/InputManager.js`)

Gamepad API, standard mapping (an Xbox controller reports it natively):

| Control | Shelf | Inspecting | Menus | Text entry |
|---|---|---|---|---|
| D-pad / left stick | move game (X), change shelf (Y) | rotate (stick) | move | move over keys |
| Right stick | | rotate | | |
| A | inspect | play | select | type key |
| B | | back | back | cancel |
| X | game menu | flip to back | | delete |
| Y | search | show spine | | space |
| LB / RB | jump 10 games | | | previous / next result |
| LT / RT | jump to previous / next letter | zoom | | |
| Menu | play | play | | done |
| View | main menu | game menu | back | |

Keyboard equivalents: arrows, Enter, Esc, X, Y, PageUp/PageDown, `[` `]`
(letter), `/` (search), F (favourite), M (game menu), P (play), F1 (menu).
Right-click opens the game menu.

What makes it feel mechanical:

- **Auto-repeat with a detent.** A direction fires once immediately, waits
  300 ms, then repeats from 115 ms down to 42 ms over 1.3 s. A tap always
  moves exactly one slot; holding crosses a long shelf quickly.
- **Stick as a clean digital direction.** Radial dead zone, dominant axis
  only, and hysteresis (engage at 0.6, release at 0.35) so resting near the
  threshold cannot chatter.
- **Critically damped motion** (`util/motion.js`). `SmoothValue` carries
  velocity, so retargeting mid-flight never snaps: a held direction glides at
  constant speed and release decelerates into place with no overshoot. It is
  frame-rate independent, the same on a 60 Hz TV and a 240 Hz monitor.
- **Haptics.** A short rumble tick per slot, a heavier one per shelf, and a
  thud at the end of a shelf.
- **Input method detection.** `InputManager.device` is whichever device was
  touched last: `gamepad` on any button or stick past its dead zone,
  `keyboard` on a bound key, `mouse` on a click, wheel or more than 6 px of
  pointer travel (so sensor jitter cannot steal focus from a controller). The
  controller family comes from the Gamepad `id` string (`devices.js`):
  vendor `054c` is PlayStation, `057e` is Nintendo, anything else is treated
  as Xbox. The HUD relabels its hints from a per-device glyph table, the
  cursor is hidden off-mouse, and on Nintendo pads the confirm and back
  buttons are swapped so A still accepts. Unplugging the active controller
  falls back to keyboard hints.
- **Focus gating.** Chromium keeps delivering gamepad state to a page while
  another app is in front. Controller input is ignored unless the window has
  focus, and held state is cleared on blur, so playing a game never scrolls
  the shelf behind it.

## 7. Memory and GPU resource management

The risk with a 3D library is that resources grow with library size. Here they
are bounded by what is on screen.

| Resource | Strategy |
|---|---|
| Geometry | One per box profile (11 total), shared by every game of that platform. |
| Meshes and materials | Pooled. Only slots inside the camera window have a mesh; as the window slides, a mesh leaving one edge is re-pointed at the game entering the other. Scrolling allocates nothing. |
| Shader programs | Every profile uses the same material type with clear-coat enabled, so all boxes share one program (four in the whole scene). |
| Textures | Ref-counted LRU cache with a byte budget (320 MB). Unreferenced textures stay cached until the budget is exceeded, then the least recently used are `dispose()`d. |
| CPU-side pixels | Each `ImageBitmap` is closed as soon as the GPU upload happens, so decoded pixels exist once, not twice. |
| In-flight work | A request released before it was dispatched is cancelled; at most three stitches run at once, nearest to the cursor first. Holding a direction queues nothing for boxes already off screen. |
| Hi-res atlas | Only the inspected box has one, and it is released on exit. |
| Idle cost | Rendering is on demand: a frame is drawn only while something is animating, input is held or a texture arrived. The loop stops entirely on blur and during an emulator session. |
| Stale async results | Each pooled box carries a token; a texture that resolves after the box was recycled is ignored. |
| Teardown | Every class has `dispose()`: listeners removed, worker terminated, GPU objects freed. A lost WebGL context drops the cache and rebuilds. |

Measured in demo mode (480 games, 8 shelves, 1600×900):

| State | Meshes created | Geometries | Programs | GPU textures | Texture memory |
|---|---|---|---|---|---|
| Idle at start | 18 | 8 | 4 | 12 | 39 MB |
| After paging through every game on every shelf, inspecting and flipping | 31 | 11 | 4 | 65 | 170 MB |

## 8. Data on disk

Under Electron's `userData` directory:

| File | Contents |
|---|---|
| `config.json` | ROM folders, emulator paths and extra args, launcher toggles, scraper settings |
| `library.json` | The cached game index |
| `art/<gameId>/front.*`, `back.*`, `spine.*` | Scraped source images |
| `art/<gameId>/atlas-<profile>-512.webp` | Stitched texture cache |
| `art/_attempts.json` | When each art or details lookup last failed |
| `userdata.json` | Favourites, hidden games, renames, play history, per-game launch settings, collections |
| `meta.json` | Scraped game details |
| `sounds/<systemId>/` | Your own audio files, if any |

## 9. Library features

**User data (`userdata.js`).** Favourites, hidden flags, renamed titles, play
counts and time, per-game launch settings and collections live in
`userdata.json`, separate from the scanned index, so a rescan never loses
them. Only non-default values are stored. The renderer changes them through
one validated IPC call (`game:patch`).

**Shelves (`renderer/library/shelves.js`).** A pure function turns
`games + collections + view options` into the shelf list: Favourites,
Recently played (24 most recent), the user's collections, then one shelf per
system. View options are sort (title, recently played, most played, release
year), a region filter, favourites only, show hidden, and hide regional
duplicates (one copy per title per system, preferring the chosen region, then
USA, World, Europe, Japan). A game can sit on several shelves; it is one
object, so a change shows everywhere. Because it is pure, the rules are
unit-tested directly.

**Search and letter jump.** Search matches every word of the query against
titles and ranks titles that start with it first. Results update as you type.
The triggers jump to the next or previous letter group on the shelf and flash
the letter.

**Menus and text entry.** `Menu` is a stack of lists driven by the same
actions as the shelf, so every feature is reachable from a controller.
`TextEntry` shows an on-screen keyboard for controllers and hides it when a
real keyboard is in use. Game data is rebuilt into shelves only once no menu
is open and no box is out, so the shelf never shifts under the user.

**Game details.** Description, year, genre, players and rating appear beside
an inspected box. Sources, in order: an EmulationStation `gamelist.xml`
beside the ROMs (offline; the format Skraper, ES-DE, Batocera and RetroPie
write), ScreenScraper when credentials are configured, and Steam's public
`appdetails` endpoint for Steam games. Other storefronts have no keyless
source, so their games show play statistics only.

**Art picker.** From the game menu, choose a file for the front, back or
spine, look the art up again, or keep the generated cover. Dropping an image
on an inspected box sets whichever face is turned towards you.

**Sound (`audio/SoundEngine.js`).** Interface sounds and a quiet ambient bed,
all synthesised with Web Audio. Each system belongs to a family that imitates
its era's sound hardware (pulse waves for NES and Game Boy, two-operator FM
for Genesis, sine pads for the disc consoles) and has its own key. These are
original sounds, not the consoles' real boot or menu audio, which is
copyrighted. To use your own recordings, put `ambient`, `move`, `shelf`,
`select`, `back` or `launch` (`.ogg`, `.mp3`, `.wav`) in
`<userData>/sounds/<systemId>/`; a file there replaces the synthesised sound.
Audio is suspended with the render loop.

**Auto-update (`updater.js`).** Installed builds check the project's GitHub
releases with `electron-updater`, download in the background and install on
quit. A pre-release build follows pre-releases. It needs `latest.yml` (written
by `npm run dist`) uploaded with each release, next to the installer and its
`.blockmap`.

## 10. What has and has not been verified

Verified by running it (Windows 11, Electron 38, three r180):

- The shelf renders, navigates, inspects, flips and shows spines; the front,
  back and spine map onto the correct faces, unmirrored.
- Unit tests (`npm test`, 25 passing): VDF, registry and `gamelist.xml`
  parsers, title parsing, the ROM scanner on a fixture tree, every emulator's
  argv, per-game overrides, Continue (Dolphin disc ids, newest-state
  selection, the RetroArch config), the launch bridge against a stand-in
  process, user data and collections, the shelf rules (virtual shelves,
  sorting, region filter, duplicate collapsing), search ranking, controller
  detection, and that every system has a real emulator and box profile.
- In the running app: favourites, collections, hiding, renaming, per-game
  launch settings, search, letter jump, filters, the details card from a
  `gamelist.xml`, input-method switching, and all of it persisting across a
  restart. Custom sound files are served from the sounds folder.
- Steam and Xbox app scanning against a real machine, real covers through the
  whole art pipeline, and the Steam details endpoint against one public app.
- The packaged build starts with these features and its updater reaches the
  GitHub release feed.
- Resource counts after a full-library scroll (table above).

Not verified, because the environment had nothing to test against:

- Launching the real emulators, including Continue. The argument strings
  follow each project's documented CLI and are unit-tested as strings, but no
  emulator was installed. The core names for the newer systems are the
  standard libretro ones but were not launched.
- A physical controller. Controller input was simulated with real id strings;
  keyboard input, which shares the same action path, was tested directly.
- What the sounds sound like. The audio graph runs, but nobody listened.
- A complete update. The updater finds the release feed, but downloading and
  installing a newer version needs two published releases that both carry
  `latest.yml`.
- Epic, Battle.net, GOG, EA and Ubisoft detection (none installed; EA's
  manifest parsing is unit-tested), ScreenScraper (needs credentials), and
  the online libretro and Steam CDN art lookups.
- macOS and Linux. Paths and process-group handling are written for them but
  only Windows was run.
