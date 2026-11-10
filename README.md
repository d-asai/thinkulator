# MegaShelf

A 3D shelf for your games. Every console is a shelf, every game is a box you
can pick up and turn over, and pressing A starts it in the right emulator or
store launcher.

![MegaShelf in demo mode](docs/demo.png)

## Run it

```bash
npm install
```

```bash
npm run demo
```

`npm run demo` fills the shelves with generated titles so you can try it with
no setup. `npm start` runs full-screen against your real library, and
`npm run dev` does the same in a window. `npm test` runs the unit tests.

To build the Windows installer into `dist/`:

```bash
npm run dist
```

## What it does

- **Shelves per console**, plus Favourites, Recently played and your own
  collections at the top.
- **Search** your whole library, and **jump by letter** along a shelf.
- **Inspect a box**: rotate it, flip it, read the spine, and see the game's
  description, year, genre, rating and your play history.
- **Continue** from your latest save state (RetroArch and Dolphin).
- **Sort and filter**: by title, recently played, most played or year; by
  region; favourites only; one copy of each regional duplicate.
- **Per-game settings**: a different emulator, core or arguments for the
  games that need them.
- **Hide and rename** games, and **choose your own box art**.
- **A theme per console**: its own backdrop, shelf colours and sounds, in the
  style of that console's era.
- **Updates itself** from GitHub releases.

## Set up your library

Press **View** on the controller (or **F1**) and choose Settings.

- **Emulators:** common install locations are detected. Use *Locate* for the rest.
- **ROM folders:** add one or more folders per system. Subfolders are scanned.
- **PC games:** Steam, Epic, GOG, EA app, Ubisoft Connect, the Xbox app and
  Battle.net are detected automatically.
- **Box art:** fronts are fetched by ROM file name (libretro thumbnails) and
  Steam app id. To supply your own, put `<rom name>-front.png`, `-back.png`
  and `-spine.png` next to the ROM, pick a file from the game menu, or drop an
  image onto an inspected box. Missing faces are generated.
- **Game details:** read from an EmulationStation `gamelist.xml` beside your
  ROMs if there is one, and from Steam for Steam games.

RetroArch needs its cores installed from its Online Updater (the defaults are
listed below). Change a system's core, or add per-emulator `extraArgs`, in
`config.json` in the app's user data folder (`%APPDATA%\megashelf` on Windows).

## Controls

MegaShelf detects which input you are using and relabels the on-screen hints
to match: Xbox, PlayStation (✕ ○ □ △, L1/R1) or Nintendo button names,
keyboard keys, or mouse gestures. On Nintendo pads A confirms and B goes back.

| Xbox controller | Keyboard | On the shelf | Inspecting a box |
|---|---|---|---|
| D-pad / left stick | Arrow keys | Move game, change shelf | Rotate |
| Right stick | | | Rotate |
| A | Enter | Inspect | Play |
| B | Esc | | Back |
| X | X (or M) | Game menu | Flip to back |
| Y | Y (or /) | Search | Show spine |
| LB / RB | PageUp / PageDown | Jump 10 games | |
| LT / RT | [ and ] on the shelf, - and = inspecting | Previous / next letter | Zoom |
| Menu | P | Play | Play |
| View | F1 | Main menu | Game menu |
| | F | Toggle favourite | Toggle favourite |

Only the essentials are shown on screen; the full list is under Menu, Controls.

Mouse: click a box to select it, click again to inspect, right-click for the
game menu, drag to rotate, wheel to scroll or zoom. **F11** toggles full
screen. **Ctrl+Alt+Backspace** force-closes a running emulator.

The **game menu** holds favourite, Play, Continue, collections, box art,
rename, per-game launch settings and hide. The **main menu** holds search,
sorting and filters, sound, settings and quit.

## Supported systems

| System | Emulator | Default RetroArch core |
|---|---|---|
| NES | RetroArch | `mesen` |
| SNES | RetroArch | `snes9x` |
| Genesis / Mega Drive | RetroArch | `genesis_plus_gx` |
| Game Boy, Game Boy Color | RetroArch | `gambatte` |
| Game Boy Advance | RetroArch | `mgba` |
| Nintendo 64 | RetroArch | `mupen64plus_next` |
| PlayStation | RetroArch | `swanstation` |
| Dreamcast | RetroArch | `flycast` |
| Nintendo DS | RetroArch | `melonds` |
| PSP | RetroArch | `ppsspp` |
| GameCube, Wii | Dolphin | |
| PlayStation 2 | PCSX2 | |
| PlayStation 3 | RPCS3 | |
| Xbox | xemu | |
| PC | Steam, Epic, GOG, EA app, Ubisoft Connect, Xbox app, Battle.net | |

To add a system, add an entry to `src/main/systems.js` and, if it needs a new
box shape, a profile in `src/renderer/engine/BoxFactory.js`.

## Look and sound

Each console's shelf has its own backdrop, colours and sounds, designed from
that console's hardware colours and the style of its era. They are original
designs, not copies of the consoles' own menus or audio. Sounds play only
when you do something (move, select, launch); there is no background sound.

To use your own recordings, create a folder named after the system id (`nes`,
`snes`, `ps2`, `pc`, ...) in `%APPDATA%\megashelf\sounds` and add any of
`move`, `shelf`, `select`, `back` or `launch` as `.ogg`, `.mp3` or
`.wav`. Sound and volume are in the main menu.

## Releasing

`npm run dist` writes the installer, its `.blockmap` and `latest.yml` to
`dist/`. Upload all three to the GitHub release: installed copies read
`latest.yml` to find the update.

## How it works

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), including what has and has
not been tested.
