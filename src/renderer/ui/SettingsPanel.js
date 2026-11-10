import { el } from './Hud.js';

const PC_LABELS = { steam: 'Steam', epic: 'Epic Games Store', xbox: 'Xbox app', battlenet: 'Battle.net' };

/**
 * Slide-over settings: emulator paths, ROM folders, launcher toggles.
 * It holds no state of its own; every action round-trips through the main
 * process and the panel re-renders from the description that comes back.
 */
export class SettingsPanel {
  constructor(api, { onClose }) {
    this.api = api;
    this.onClose = onClose;
    this.root = document.getElementById('settings');
  }

  get open() {
    return !this.root.hidden;
  }

  async show() {
    this.root.hidden = false;
    this.render(await this.api.getSettings());
  }

  hide() {
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  _button(label, onClick, className = '') {
    const b = el('button', className, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  async _apply(promise) {
    const settings = await promise;
    if (this.open && settings) this.render({ ...this.last, ...settings });
  }

  render(s) {
    this.last = s;
    const root = this.root;
    root.replaceChildren();

    const head = el('div', 'settings-head');
    const actions = el('div', 'settings-actions');
    actions.append(
      this._button('Rescan library', () => this.api.rescan(), 'primary'),
      this._button('Close', () => this.onClose()),
    );
    head.append(el('h2', '', 'Settings'), actions);
    root.append(head);
    if (s.demo) root.append(el('div', 'row-sub missing', 'Demo mode: the shelf shows generated titles and scanning is off.'));

    root.append(el('h3', '', 'Emulators'));
    for (const emu of s.emulators) {
      const row = el('div', 'row');
      const main = el('div', 'row-main');
      main.append(el('div', 'row-title', emu.name));
      main.append(el('div', `row-sub ${emu.found ? '' : 'missing'}`, emu.path ? (emu.found ? emu.path : `Not found: ${emu.path}`) : 'Not set'));
      const side = el('div', 'row-side');
      side.append(this._button(emu.path ? 'Change' : 'Locate', () => this._apply(this.api.pickEmulator(emu.id))));
      row.append(main, side);
      root.append(row);
    }

    root.append(el('h3', '', 'ROM folders'));
    for (const system of s.systems) {
      const row = el('div', 'row');
      const main = el('div', 'row-main');
      main.append(el('div', 'row-title', system.name));
      if (!system.romDirs.length) main.append(el('div', 'row-sub', 'No folders'));
      for (const dir of system.romDirs) {
        const line = el('div', 'dir');
        line.append(el('span', '', dir), this._button('Remove', () => this._apply(this.api.removeRomDir(system.id, dir)), 'quiet'));
        main.append(line);
      }
      const side = el('div', 'row-side');
      side.append(this._button('Add folder', () => this._apply(this.api.addRomDir(system.id))));
      row.append(main, side);
      root.append(row);
    }

    root.append(el('h3', '', 'PC launchers'));
    for (const [id, label] of Object.entries(PC_LABELS)) {
      const info = s.pcStatus && s.pcStatus[id];
      const sub = !s.pc[id] ? 'Off' : info ? `${info.count} game${info.count === 1 ? '' : 's'}${info.detail && info.detail !== 'ok' ? `  ·  ${info.detail}` : ''}` : 'Not scanned yet';
      root.append(this._toggleRow(label, sub, s.pc[id], (on) => this._apply(this.api.setOption(id, on))));
    }

    root.append(el('h3', '', 'Box art'));
    root.append(this._toggleRow(
      'Download missing box art',
      'Looks up covers by ROM file name (libretro thumbnails) and Steam app id. Art next to your ROMs is always used.',
      s.scraperOnline, (on) => this._apply(this.api.setOption('scraperOnline', on)),
    ));

    root.append(el('h3', '', 'Application'));
    const quit = el('div', 'row');
    const quitMain = el('div', 'row-main');
    quitMain.append(el('div', 'row-title', 'Quit MegaShelf'), el('div', 'row-sub', 'F11 toggles full screen. Ctrl+Alt+Backspace force-closes a running emulator.'));
    const quitSide = el('div', 'row-side');
    quitSide.append(this._button('Quit', () => this.api.quit()));
    quit.append(quitMain, quitSide);
    root.append(quit);
  }

  _toggleRow(title, sub, checked, onChange) {
    const row = el('div', 'row');
    const main = el('div', 'row-main');
    main.append(el('div', 'row-title', title), el('div', 'row-sub', sub));
    const label = el('label', 'switch');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    input.setAttribute('aria-label', title);
    input.addEventListener('change', () => onChange(input.checked));
    label.append(input);
    const side = el('div', 'row-side');
    side.append(label);
    row.append(main, side);
    return row;
  }
}
