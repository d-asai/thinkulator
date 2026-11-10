import { el } from './Hud.js';

/**
 * A stack of list menus driven by the same actions as the shelf (up, down,
 * accept, back), so everything is reachable from a controller. The mouse
 * works too: hover highlights, click activates.
 *
 * A level is { title, items: () => [...] }; title may also be a function. `items` is a function because the
 * list is rebuilt after every activation, which is how a toggle or a cycling
 * value shows its new state.
 *
 * An item is { label, value?, hint?, disabled?, danger?, run }. `run` may be
 * async and returns 'close' (dismiss everything), 'back' (one level up), or
 * nothing (stay and refresh).
 */
export class Menu {
  constructor({ onChange, onSound }) {
    this.root = document.getElementById('menu');
    this.onChange = onChange; //  called whenever the menu opens, closes or changes level
    this.onSound = onSound || (() => {});
    this.stack = [];
    this.busy = false;
  }

  get open() {
    return this.stack.length > 0;
  }

  push(level) {
    this.stack.push({ ...level, index: 0 });
    this.render(true);
    this.onChange();
  }

  pop() {
    this.stack.pop();
    if (this.stack.length) this.render(false);
    else this.close();
    this.onChange();
  }

  close() {
    this.stack.length = 0;
    this.root.hidden = true;
    this.root.replaceChildren();
    this.onChange();
  }

  handle(action) {
    const level = this.stack[this.stack.length - 1];
    if (!level || this.busy) return;
    if (action === 'up' || action === 'down') {
      const step = action === 'up' ? -1 : 1;
      const n = level.current.length;
      for (let i = 1; i <= n; i++) {
        const next = (level.index + step * i + n * i) % n;
        if (!level.current[next].disabled) { level.index = next; break; }
      }
      this.onSound('move');
      this.highlight();
    } else if (action === 'accept') {
      this.activate(level.index);
    } else if (action === 'back' || action === 'settings') {
      this.onSound('back');
      this.pop();
    }
  }

  async activate(index) {
    const level = this.stack[this.stack.length - 1];
    const item = level && level.current[index];
    if (!item || item.disabled || this.busy) return;
    this.onSound('select');
    this.busy = true;
    let result;
    try {
      result = await item.run();
    } finally {
      this.busy = false;
    }
    if (result === 'close') this.close();
    else if (result === 'back') this.pop();
    else if (this.stack[this.stack.length - 1] === level) this.render(false);
  }

  highlight() {
    const level = this.stack[this.stack.length - 1];
    [...this.list.children].forEach((node, i) => {
      node.classList.toggle('active', i === level.index);
      if (i === level.index) node.scrollIntoView({ block: 'nearest' });
    });
  }

  render(fresh) {
    const level = this.stack[this.stack.length - 1];
    level.current = level.items();
    if (fresh || level.index >= level.current.length || level.current[level.index].disabled) {
      level.index = Math.max(0, level.current.findIndex((i) => !i.disabled));
    }

    this.list = el('div', 'menu-list');
    level.current.forEach((item, i) => {
      const row = el('button', `menu-item${item.danger ? ' danger' : ''}`);
      row.type = 'button';
      row.disabled = !!item.disabled;
      const text = el('span', 'menu-text');
      text.append(el('span', 'menu-label', item.label));
      if (item.hint) text.append(el('span', 'menu-hint', item.hint));
      row.append(text);
      if (item.value !== undefined) row.append(el('span', 'menu-value', item.value));
      row.addEventListener('mouseenter', () => { if (!item.disabled) { level.index = i; this.highlight(); } });
      row.addEventListener('click', () => this.activate(i));
      this.list.append(row);
    });

    const panel = el('div', 'menu-panel');
    panel.append(el('h2', '', typeof level.title === 'function' ? level.title() : level.title), this.list);
    this.root.replaceChildren(panel);
    this.root.hidden = false;
    this.highlight();
  }
}
