import { GLYPHS } from '../input/devices.js';

const LAUNCHERS = {
  steam: 'Steam', epic: 'Epic Games', xbox: 'Xbox app', battlenet: 'Battle.net',
  gog: 'GOG', ea: 'EA app', ubisoft: 'Ubisoft Connect',
};

// What each action does in each mode. Button names come from GLYPHS, per device.
const HINTS = {
  browse: [['accept', 'Inspect'], ['flip', 'Game menu'], ['spine', 'Search'], ['zoom', 'Letter'], ['play', 'Play'], ['settings', 'Menu']],
  inspect: [['accept', 'Play'], ['flip', 'Flip'], ['spine', 'Spine'], ['zoom', 'Zoom'], ['settings', 'Game menu'], ['back', 'Back']],
  menu: [['accept', 'Select'], ['back', 'Back']],
  entry: [['accept', 'Type'], ['flip', 'Delete'], ['spine', 'Space'], ['page', 'Result'], ['play', 'Done'], ['back', 'Cancel']],
  settings: [['back', 'Close']],
  none: [],
};
// The mouse has gestures rather than buttons, so it gets its own wording.
const MOUSE_HINTS = {
  browse: [['Click', 'Select, then inspect'], ['Right-click', 'Game menu'], ['Wheel', 'Scroll'], ['F1', 'Menu']],
  inspect: [['Drag', 'Rotate'], ['Wheel', 'Zoom'], ['Right-click', 'Game menu'], ['Click away', 'Back']],
  menu: [['Click', 'Select'], ['Esc', 'Back']],
  entry: [['Click', 'Pick a result'], ['Esc', 'Cancel']],
  settings: [['Esc', 'Close']],
  none: [],
};
// Typing replaces the on-screen keyboard, so the keyboard needs different entry hints.
const KEYBOARD_ENTRY = [['Type', 'Enter text'], ['↑ ↓', 'Result'], ['Enter', 'Done'], ['Esc', 'Cancel']];
const RAIL_CENTRE = 4; // the index shows nine rows; the active one sits on the fifth
const KEYBOARD_ZOOM = { browse: '[ ]', inspect: '− / =' };

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function ago(timestamp) {
  const days = Math.floor((Date.now() - timestamp) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

function duration(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * The 2D layer over the canvas. All text goes in through textContent: game
 * titles and descriptions come from file names, store manifests and scraped
 * pages, and are never trusted as markup.
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
    this.toasts = $('toasts');
    this.fadeEl = $('fade');
    this.fadeLabel = $('fade-label');
    this.info = $('info');
    this.details = $('details');
    this.letter = $('letter');
    this.railItems = [];
    this.hintMode = '';
    this.hintKey = '';
    this.device = 'keyboard';
    this.padType = 'xbox';
    this.lastKey = '';
    this.detailsKey = '';
  }

  /** Re-labels the hints for the device in use and hides the cursor off-mouse. */
  setDevice(device, padType) {
    this.device = device;
    this.padType = padType;
    document.body.dataset.input = device;
    this.setHints(this.hintMode || 'none');
  }

  setShelves(shelves) {
    // The index is a wheel: the list slides so the active shelf stays on the
    // centre line, and the rows above and below fade out through a mask.
    this.railTrack = el('div', 'rail-track');
    this.rail.replaceChildren(this.railTrack);
    this.rail.hidden = shelves.length < 2; // nothing to switch between
    this.railItems = shelves.map((shelf) => {
      const item = el('div', 'rail-item');
      item.append(el('span', '', shelf.system.short), el('span', 'rail-count', String(shelf.games.length)));
      this.railTrack.append(item);
      return item;
    });
    this.lastKey = '';
  }

  setEmpty(isEmpty, filtered = false) {
    this.empty.hidden = !isEmpty;
    this.info.hidden = isEmpty;
    this.empty.classList.toggle('filtered', filtered);
  }

  /** Forces the next setSelection to redraw (a game's data changed in place). */
  invalidate() {
    this.lastKey = '';
    this.detailsKey = '';
  }

  /** Reflects the current selection. Cheap to call every frame: it no-ops unless something changed. */
  setSelection(shelfIndex, shelf) {
    const game = shelf ? shelf.games[shelf.cursor] : null;
    const key = game ? `${shelfIndex}:${shelf.cursor}:${game.id}` : '';
    if (key === this.lastKey) return;
    this.lastKey = key;

    this.railItems.forEach((item, i) => item.classList.toggle('active', i === shelfIndex));
    if (this.railTrack) this.railTrack.style.transform = `translateY(calc(var(--row) * ${RAIL_CENTRE - shelfIndex}))`;
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
    if (game.user.favorite) parts.push('★ Favourite');
    if (shelf.system.kind !== 'system') parts.push(game.system.short);
    if (game.region) parts.push(game.region);
    if (game.launcher) parts.push(LAUNCHERS[game.launcher] || game.launcher);
    if (game.meta && game.meta.year) parts.push(String(game.meta.year));
    if (game.user.playCount) parts.push(`Played ${game.user.playCount}×`);
    if (game.user.hidden) parts.push('Hidden');
    this.meta.textContent = parts.join('  ·  ');
  }

  /** The details card beside an inspected box. Pass null to hide it. */
  setDetails(game) {
    const key = game ? `${game.id}:${game.user.playCount}:${game.meta ? game.meta.description.length : 0}` : '';
    if (key === this.detailsKey) return;
    this.detailsKey = key;
    this.details.replaceChildren();
    this.details.hidden = !game;
    if (!game) return;

    const meta = game.meta || {};
    const facts = [meta.year || '', meta.genre, meta.players && /^\d/.test(meta.players) ? `${meta.players} player${meta.players === '1' ? '' : 's'}` : meta.players]
      .filter(Boolean).join('  ·  ');
    if (facts) this.details.append(el('div', 'details-facts', facts));
    if (meta.rating) this.details.append(el('div', 'details-rating', `${Math.round(meta.rating * 100)} / 100`));
    if (meta.description) this.details.append(el('p', 'details-text', meta.description));
    const makers = [meta.developer, meta.publisher !== meta.developer ? meta.publisher : ''].filter(Boolean).join('  ·  ');
    if (makers) this.details.append(el('div', 'details-makers', makers));

    const u = game.user;
    const stats = u.playCount
      ? [`Played ${u.playCount} time${u.playCount === 1 ? '' : 's'}`, u.playSeconds >= 60 ? duration(u.playSeconds) : '', `last ${ago(u.lastPlayed)}`]
        .filter(Boolean).join('  ·  ')
      : 'Not played yet';
    this.details.append(el('div', 'details-stats', stats));
    if (!facts && !meta.description) this.details.append(el('div', 'details-none', 'No details found for this game.'));
  }

  /** Flashes the big letter shown while jumping through a shelf alphabetically. */
  flashLetter(letter) {
    this.letter.textContent = letter;
    this.letter.hidden = false;
    this.letter.classList.remove('show');
    void this.letter.offsetWidth; // restart the animation
    this.letter.classList.add('show');
    clearTimeout(this._letterTimer);
    this._letterTimer = setTimeout(() => { this.letter.hidden = true; }, 900);
  }

  setHints(mode) {
    const key = `${mode}|${this.device}|${this.padType}`;
    if (key === this.hintKey) return;
    this.hintKey = key;
    this.hintMode = mode;

    let rows;
    if (this.device === 'mouse') {
      rows = (MOUSE_HINTS[mode] || []).map(([glyph, label]) => [glyph, '', label]);
    } else if (this.device === 'keyboard' && mode === 'entry') {
      rows = KEYBOARD_ENTRY.map(([glyph, label]) => [glyph, '', label]);
    } else {
      const keyboard = this.device !== 'gamepad';
      const glyphs = GLYPHS[keyboard ? 'keyboard' : this.padType] || GLYPHS.xbox;
      rows = (HINTS[mode] || []).map(([action, label]) => {
        const glyph = keyboard && action === 'zoom' && KEYBOARD_ZOOM[mode] ? KEYBOARD_ZOOM[mode] : glyphs[action][0];
        return [glyph, glyphs[action][1] || '', label];
      });
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

export { el, LAUNCHERS };
