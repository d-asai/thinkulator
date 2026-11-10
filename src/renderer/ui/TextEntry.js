import { el } from './Hud.js';

const ROWS = ['1234567890', 'QWERTYUIOP', "ASDFGHJKL'", 'ZXCVBNM-:.'];
const SPECIAL = [['SPACE', 'Space'], ['DEL', 'Delete'], ['DONE', 'Done']];
const MAX_LENGTH = 120;

/**
 * Text input that works without a keyboard. With a keyboard you just type;
 * with a controller an on-screen keyboard appears and the D-pad walks it.
 * Used for search (with live results) and for naming things.
 *
 *   open({ title, value, placeholder, search, onSubmit, onCancel })
 *
 * `search(text)` is optional and returns [{ label, sub, value }]; the list
 * updates as you type and the highlighted result is passed to onSubmit.
 */
export class TextEntry {
  constructor({ onChange, onSound }) {
    this.root = document.getElementById('entry');
    this.onChange = onChange;
    this.onSound = onSound || (() => {});
    this.options = null;
    this.row = 1;
    this.col = 0;
    this.results = [];
    this.resultIndex = 0;
  }

  get open() {
    return this.options !== null;
  }

  show(options) {
    this.options = options;
    this.row = 1;
    this.col = 0;
    this.results = [];
    this.resultIndex = 0;

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.maxLength = MAX_LENGTH;
    this.input.value = options.value || '';
    this.input.placeholder = options.placeholder || '';
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', options.title);
    this.input.addEventListener('input', () => this.refresh());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.cancel(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.moveResult(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.moveResult(-1); }
    });

    this.resultList = el('div', 'entry-results');
    this.keyboard = el('div', 'osk');
    this.keys = [];
    ROWS.forEach((chars, r) => {
      const rowEl = el('div', 'osk-row');
      this.keys[r] = [...chars].map((ch, c) => this.makeKey(ch, ch, r, c, rowEl));
      this.keyboard.append(rowEl);
    });
    const last = el('div', 'osk-row');
    this.keys[ROWS.length] = SPECIAL.map(([id, label], c) => this.makeKey(id, label, ROWS.length, c, last, true));
    this.keyboard.append(last);

    const panel = el('div', 'entry-panel');
    panel.append(el('h2', '', options.title), this.input, this.resultList, this.keyboard);
    this.root.replaceChildren(panel);
    this.root.hidden = false;
    this.input.focus();
    this.input.select();
    this.highlight();
    this.refresh();
    this.onChange();
  }

  makeKey(id, label, row, col, parent, wide = false) {
    const key = el('button', `osk-key${wide ? ' wide' : ''}`, label);
    key.type = 'button';
    key.tabIndex = -1;
    key.addEventListener('click', () => { this.row = row; this.col = col; this.highlight(); this.press(id); this.input.focus(); });
    parent.append(key);
    return { id, node: key };
  }

  close() {
    this.options = null;
    this.root.hidden = true;
    this.root.replaceChildren();
    this.onChange();
  }

  cancel() {
    const { onCancel } = this.options;
    this.onSound('back');
    this.close();
    if (onCancel) onCancel();
  }

  submit() {
    const { onSubmit } = this.options;
    const text = this.input.value.trim();
    const result = this.results[this.resultIndex];
    this.onSound('select');
    this.close();
    onSubmit(text, result ? result.value : undefined);
  }

  press(id) {
    const v = this.input.value;
    if (id === 'DONE') return this.submit();
    if (id === 'DEL') this.input.value = v.slice(0, -1);
    else if (v.length < MAX_LENGTH) this.input.value = v + (id === 'SPACE' ? ' ' : id);
    this.onSound('move');
    this.refresh();
  }

  refresh() {
    if (!this.options || !this.options.search) return;
    this.results = this.options.search(this.input.value) || [];
    this.resultIndex = 0;
    this.resultList.replaceChildren(...this.results.map((r, i) => {
      const row = el('button', 'entry-result');
      row.type = 'button';
      row.tabIndex = -1;
      row.append(el('span', 'entry-result-label', r.label), el('span', 'entry-result-sub', r.sub || ''));
      row.addEventListener('click', () => { this.resultIndex = i; this.submit(); });
      return row;
    }));
    if (!this.results.length && this.input.value.trim()) this.resultList.append(el('div', 'entry-empty', 'No matches'));
    this.highlightResult();
  }

  moveResult(step) {
    if (!this.results.length) return;
    this.resultIndex = (this.resultIndex + step + this.results.length) % this.results.length;
    this.onSound('move');
    this.highlightResult();
  }

  highlightResult() {
    [...this.resultList.querySelectorAll('.entry-result')].forEach((node, i) => node.classList.toggle('active', i === this.resultIndex));
  }

  highlight() {
    this.keys.forEach((row, r) => row.forEach((key, c) => key.node.classList.toggle('active', r === this.row && c === this.col)));
  }

  /** Controller actions. Keyboard typing goes straight to the input instead. */
  handle(action) {
    if (!this.open) return;
    const rows = this.keys.length;
    switch (action) {
      case 'up': case 'down': {
        const before = this.keys[this.row].length;
        this.row = (this.row + (action === 'up' ? -1 : 1) + rows) % rows;
        // Keep the same horizontal position when moving to or from the short bottom row.
        this.col = Math.min(this.keys[this.row].length - 1, Math.round((this.col / Math.max(1, before - 1)) * (this.keys[this.row].length - 1)));
        break;
      }
      case 'left': case 'right': {
        const n = this.keys[this.row].length;
        this.col = (this.col + (action === 'left' ? -1 : 1) + n) % n;
        break;
      }
      case 'accept': this.press(this.keys[this.row][this.col].id); return;
      case 'flip': this.press('DEL'); return;
      case 'spine': this.press('SPACE'); return;
      case 'pageLeft': this.moveResult(-1); return;
      case 'pageRight': this.moveResult(1); return;
      case 'play': this.submit(); return;
      case 'back': this.cancel(); return;
      default: return;
    }
    this.onSound('move');
    this.highlight();
  }
}
