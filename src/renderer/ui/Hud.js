const LAUNCHERS = { steam: 'Steam', epic: 'Epic Games', xbox: 'Xbox app', battlenet: 'Battle.net' };

const HINTS = {
  browse: [['a', 'A', 'Inspect'], ['', 'Menu', 'Play'], ['', 'LB/RB', 'Skip 10'], ['', 'View', 'Settings']],
  inspect: [['a', 'A', 'Play'], ['x', 'X', 'Flip'], ['y', 'Y', 'Spine'], ['', 'LT/RT', 'Zoom'], ['b', 'B', 'Back']],
  settings: [['b', 'B', 'Close']],
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
    this.lastKey = '';
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
    if (mode === this.hintMode) return;
    this.hintMode = mode;
    this.hints.replaceChildren(...(HINTS[mode] || []).map(([cls, glyph, label]) => {
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
