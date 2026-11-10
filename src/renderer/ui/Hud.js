import { GLYPHS } from '../input/devices.js';

const LAUNCHERS = { steam: 'Steam', epic: 'Epic Games', xbox: 'Xbox app', battlenet: 'Battle.net' };

// What each action does in each mode. Button names come from GLYPHS, per device.
const HINTS = {
  browse: [['accept', 'Inspect'], ['play', 'Play'], ['page', 'Skip 10'], ['settings', 'Settings']],
  inspect: [['accept', 'Play'], ['flip', 'Flip'], ['spine', 'Spine'], ['zoom', 'Zoom'], ['back', 'Back']],
  settings: [['back', 'Close']],
  none: [],
};
// The mouse has gestures rather than buttons, so it gets its own wording.
const MOUSE_HINTS = {
  browse: [['Click', 'Select, then inspect'], ['Wheel', 'Scroll'], ['F1', 'Settings']],
  inspect: [['Drag', 'Rotate'], ['Wheel', 'Zoom'], ['Click away', 'Back'], ['Enter', 'Play']],
  settings: [['Esc', 'Close']],
  none: [],
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * The 2D layer over the canvas. All text goes in through textContent: game
 * titles come from file names and store manifests and are never trusted as markup.
 */
export class Hud {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.rail = $('rail');
    this.status = $('status');
    this.system = $('info-system');
    this.title = $('info-title');
    this.meta = $('info-meta');
    this.hints = $('hints');
    this.empty = $('empty');
    this.emptyOpen = $('empty-open');
    this.toasts = $('toasts');
    this.fadeEl = $('fade');
    this.fadeLabel = $('fade-label');
    this.info = $('info');
    this.railItems = [];
    this.hintMode = '';
    this.hintKey = '';
    this.device = 'keyboard';
    this.padType = 'xbox';
    this.lastKey = '';
  }

  /** Re-labels the hints for the device in use and hides the cursor off-mouse. */
  setDevice(device, padType) {
    this.device = device;
    this.padType = padType;
    document.body.dataset.input = device;
    this.setHints(this.hintMode || 'none');
  }

  setShelves(shelves) {
    this.rail.replaceChildren();
    this.rail.hidden = shelves.length < 2; // nothing to switch between
    this.railItems = shelves.map((shelf) => {
      const item = el('div', 'rail-item');
      item.style.setProperty('--item-accent', shelf.system.accent);
      item.append(el('span', '', shelf.system.short), el('span', 'rail-count', String(shelf.games.length)));
      this.rail.append(item);
      return item;
    });
    this.lastKey = '';
  }

  setEmpty(isEmpty) {
    this.empty.hidden = !isEmpty;
    this.info.hidden = isEmpty;
  }

  /** Reflects the current selection. Cheap to call every frame: it no-ops unless something changed. */
  setSelection(shelfIndex, shelf) {
    const game = shelf ? shelf.games[shelf.cursor] : null;
    const key = game ? `${shelfIndex}:${shelf.cursor}:${game.id}` : '';
    if (key === this.lastKey) return;
    this.lastKey = key;

    this.railItems.forEach((item, i) => item.classList.toggle('active', i === shelfIndex));
    if (!game) {
      this.system.textContent = '';
      this.title.textContent = '';
      this.meta.textContent = '';
      return;
    }
    document.documentElement.style.setProperty('--accent', shelf.system.accent);
    this.system.textContent = shelf.system.name;
    this.title.textContent = game.title;
    const parts = [`${shelf.cursor + 1} / ${shelf.games.length}`];
    if (game.region) parts.push(game.region);
    if (game.launcher) parts.push(LAUNCHERS[game.launcher] || game.launcher);
    this.meta.textContent = parts.join('  ·  ');
  }

  setHints(mode) {
    const key = `${mode}|${this.device}|${this.padType}`;
    if (key === this.hintKey) return;
    this.hintKey = key;
    this.hintMode = mode;

    let rows;
    if (this.device === 'mouse') {
      rows = (MOUSE_HINTS[mode] || []).map(([glyph, label]) => [glyph, '', label]);
    } else {
      const glyphs = GLYPHS[this.device === 'gamepad' ? this.padType : 'keyboard'] || GLYPHS.xbox;
      rows = (HINTS[mode] || []).map(([action, label]) => [glyphs[action][0], glyphs[action][1] || '', label]);
    }
    this.hints.replaceChildren(...rows.map(([glyph, cls, label]) => {
      const hint = el('div', 'hint');
      hint.append(el('span', `glyph ${cls}`, glyph), el('span', '', label));
      return hint;
    }));
    document.body.classList.toggle('inspecting', mode === 'inspect');
  }

  setStatus(status) {
    let text = '';
    if (status.phase === 'scanning') text = `${status.message || 'Scanning'}… ${status.found} found`;
    else if (status.phase === 'error') text = `Scan failed: ${status.message}`;
    else if (status.message) text = status.message;
    this.status.textContent = text;
    this.status.hidden = !text;
    clearTimeout(this._statusTimer);
    if (text && status.phase !== 'scanning') this._statusTimer = setTimeout(() => { this.status.hidden = true; }, 9000);
  }

  toast(message, kind = 'error') {
    const node = el('div', `toast ${kind === 'info' ? 'info' : ''}`, message);
    this.toasts.append(node);
    setTimeout(() => node.remove(), kind === 'info' ? 3500 : 7000);
  }

  fade(on, label = '') {
    this.fadeEl.classList.toggle('on', on);
    this.fadeLabel.textContent = label;
  }
}

export { el };
