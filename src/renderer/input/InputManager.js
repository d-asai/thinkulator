/**
 * Unified input: Xbox controller (HTML5 Gamepad API, "standard" mapping) and
 * keyboard, reduced to one small vocabulary of actions.
 *
 *   Xbox                          Keyboard          Action
 *   D-pad / left stick            arrow keys        left right up down (auto-repeat)
 *   LB / RB                       PageUp / PageDown pageLeft / pageRight
 *   A                             Enter, Space      accept
 *   B                             Escape, Backspace back
 *   X                             X                 flip
 *   Y                             Y                 spine
 *   Menu (Start)                  P                 play
 *   View (Back)                   F1, Tab           settings
 *   right stick (left in inspect) arrows in inspect look.x / look.y
 *   LT / RT                       - / =             zoom
 *
 * The table shows Xbox names. PlayStation pads use the same positions; on
 * Nintendo pads A/B and X/Y are swapped so the letters still match (see
 * devices.js). The manager also tracks which device was used last, so the UI
 * can show the right button names and hide the cursor.
 */

import { detectPadType, faceButtons } from './devices.js';

// Standard-mapping indices (https://w3c.github.io/gamepad/#remapping).
const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const SHARED_BUTTON_ACTIONS = [
  [BTN.LB, 'pageLeft'], [BTN.RB, 'pageRight'], [BTN.MENU, 'play'], [BTN.VIEW, 'settings'],
];
const MOUSE_MOVE_THRESHOLD = 6; // px of travel before the mouse counts as "in use"
const KEY_ACTIONS = {
  Enter: 'accept', ' ': 'accept', Escape: 'back', Backspace: 'back',
  x: 'flip', X: 'flip', y: 'spine', Y: 'spine', p: 'play', P: 'play',
  PageUp: 'pageLeft', PageDown: 'pageRight', F1: 'settings', Tab: 'settings',
};
const HELD_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '-', '=', '+']);

const STICK_DEADZONE = 0.2;
const NAV_ENGAGE = 0.6; //  stick must pass this to register a direction...
const NAV_RELEASE = 0.35; // ...and fall below this to let go (hysteresis: no chatter at the edge)

/**
 * Turns a held direction into discrete steps: one immediately, a pause, then
 * a repeat that accelerates. The pause is what makes a single tap reliably
 * move exactly one slot; the acceleration is what makes a long shelf quick.
 */
class RepeatAxis {
  constructor({ delay, interval, minInterval, ramp }) {
    Object.assign(this, { delay, interval, minInterval, ramp });
    this.dir = 0;
    this.held = 0;
    this.next = 0;
  }

  update(dir, dt) {
    if (dir !== this.dir) {
      this.dir = dir;
      this.held = 0;
      this.next = this.delay;
      return dir;
    }
    if (!dir) return 0;
    this.held += dt;
    if (this.held < this.next) return 0;
    const k = Math.min(1, (this.held - this.delay) / this.ramp);
    this.next = this.held + this.interval + (this.minInterval - this.interval) * k;
    return dir;
  }

  reset() {
    this.dir = 0;
    this.held = 0;
  }
}

/** Radial dead zone, rescaled so output still spans 0..1 outside it. */
function stick(x, y) {
  const mag = Math.hypot(x, y);
  if (mag < STICK_DEADZONE) return [0, 0];
  const scaled = Math.min(1, (mag - STICK_DEADZONE) / (1 - STICK_DEADZONE)) / mag;
  return [x * scaled, y * scaled];
}

export class InputManager {
  constructor() {
    this.horizontal = new RepeatAxis({ delay: 0.3, interval: 0.115, minInterval: 0.042, ramp: 1.3 });
    this.vertical = new RepeatAxis({ delay: 0.38, interval: 0.24, minInterval: 0.15, ramp: 1.5 });
    /** 'navigate': directions step the cursor. 'inspect': they rotate the box. */
    this.mode = 'navigate';
    this.enabled = true;

    this.keys = new Set();
    this.pending = [];
    this.prevButtons = [];
    this.stickDir = { x: 0, y: 0 };
    this.gamepadIndex = -1;
    this.wheel = 0;

    /**
     * The input method in use right now: whichever device the user touched
     * last. 'gamepad' | 'keyboard' | 'mouse'. `padType` is the controller
     * family ('xbox' | 'playstation' | 'nintendo') and decides button labels
     * and which face button confirms.
     */
    this.device = 'keyboard';
    this.padType = 'xbox';
    this.onDeviceChange = null; //   (device, padType) => void
    this.onPadConnection = null; //  (connected, padType) => void
    this._mouse = { x: null, y: null, travel: 0 };

    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select');
      if (typing) return;
      if (HELD_KEYS.has(e.key) || KEY_ACTIONS[e.key]) this._setDevice('keyboard');
      if (HELD_KEYS.has(e.key)) {
        this.keys.add(e.key);
        e.preventDefault();
      } else if (KEY_ACTIONS[e.key] && !e.repeat) {
        this.pending.push(KEY_ACTIONS[e.key]);
        e.preventDefault();
      }
    };
    this._onKeyUp = (e) => this.keys.delete(e.key);
    this._onBlur = () => this.release();
    this._onConnect = (e) => {
      if (this.gamepadIndex < 0) this.gamepadIndex = e.gamepad.index;
      if (this.onPadConnection) this.onPadConnection(true, detectPadType(e.gamepad.id));
    };
    this._onDisconnect = (e) => {
      if (e.gamepad.index !== this.gamepadIndex) return;
      this.gamepadIndex = -1;
      this.prevButtons = [];
      if (this.onPadConnection) this.onPadConnection(false, this.padType);
      // Never leave the hints showing buttons for a controller that is gone.
      if (this.device === 'gamepad') this._setDevice('keyboard');
    };
    // The mouse only takes over after deliberate movement, so a bumped desk
    // or sensor jitter does not flip the hints away from the controller.
    this._onPointerMove = (e) => {
      const m = this._mouse;
      if (e.pointerType && e.pointerType !== 'mouse') return;
      if (m.x !== null) m.travel += Math.abs(e.clientX - m.x) + Math.abs(e.clientY - m.y);
      m.x = e.clientX;
      m.y = e.clientY;
      if (m.travel > MOUSE_MOVE_THRESHOLD) this._setDevice('mouse');
    };
    this._onPointerDown = () => this._setDevice('mouse');

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('gamepadconnected', this._onConnect);
    window.addEventListener('gamepaddisconnected', this._onDisconnect);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('wheel', this._onPointerDown, { passive: true });
  }

  _setDevice(device, padType = this.padType) {
    if (device !== 'mouse') this._mouse.travel = 0;
    if (device === this.device && padType === this.padType) return;
    this.device = device;
    this.padType = padType;
    if (this.onDeviceChange) this.onDeviceChange(device, padType);
  }

  /** Forget everything held. Called on blur so nothing "sticks" across a game session. */
  release() {
    this.keys.clear();
    this.pending.length = 0;
    this.horizontal.reset();
    this.vertical.reset();
    this.stickDir.x = 0;
    this.stickDir.y = 0;
    this.wheel = 0;
    // Treat every button as already down, so one held across the blur does not fire on return.
    this.prevButtons = this.prevButtons.map(() => true);
  }

  _gamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = this.gamepadIndex >= 0 ? pads[this.gamepadIndex] : null;
    if (!pad || !pad.connected) {
      pad = null;
      for (const p of pads) {
        if (p && p.connected && (p.mapping === 'standard' || !pad)) { pad = p; if (p.mapping === 'standard') break; }
      }
      this.gamepadIndex = pad ? pad.index : -1;
    }
    return pad;
  }

  /** A short haptic tick: the "detent" you feel as the shelf clicks over. */
  pulse(strength = 0.25, ms = 22) {
    const pad = this._gamepad();
    const actuator = pad && pad.vibrationActuator;
    if (!actuator || !actuator.playEffect) return;
    actuator.playEffect('dual-rumble', { duration: ms, startDelay: 0, weakMagnitude: strength, strongMagnitude: strength * 0.4 }).catch(() => {});
  }

  /**
   * Call once per frame.
   * @returns {{ actions: string[], look: {x,y}, zoom: number, held: boolean }}
   */
  poll(dt) {
    const actions = this.pending.splice(0);
    const look = { x: 0, y: 0 };
    let zoom = this.wheel;
    this.wheel = 0;
    let navX = 0, navY = 0;

    const k = this.keys;
    const keyX = (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0);
    const keyY = (k.has('ArrowDown') ? 1 : 0) - (k.has('ArrowUp') ? 1 : 0);
    zoom += ((k.has('=') || k.has('+')) ? 1 : 0) - (k.has('-') ? 1 : 0);

    // The page keeps receiving gamepad state while a game is in front of it,
    // so controller input only counts when this window has focus.
    const pad = this.enabled && document.hasFocus() ? this._gamepad() : null;
    if (pad) {
      const b = pad.buttons;
      const down = (i) => !!(b[i] && (b[i].pressed || b[i].value > 0.5));

      const padType = detectPadType(pad.id);
      const face = faceButtons(padType);
      const mapping = [
        [face.accept, 'accept'], [face.back, 'back'], [face.flip, 'flip'], [face.spine, 'spine'],
        ...SHARED_BUTTON_ACTIONS,
      ];
      for (const [index, action] of mapping) {
        if (down(index) && !this.prevButtons[index]) actions.push(action);
      }
      let anyButton = false;
      for (let i = 0; i < b.length; i++) {
        this.prevButtons[i] = down(i);
        anyButton = anyButton || this.prevButtons[i];
      }

      const [lx, ly] = stick(pad.axes[0] || 0, pad.axes[1] || 0);
      const [rx, ry] = stick(pad.axes[2] || 0, pad.axes[3] || 0);

      // Left stick as a digital direction: dominant axis only, with hysteresis.
      const sd = this.stickDir;
      const horizontalDominant = Math.abs(lx) >= Math.abs(ly);
      const edge = (value, current) => {
        const threshold = current ? NAV_RELEASE : NAV_ENGAGE;
        return Math.abs(value) > threshold ? Math.sign(value) : 0;
      };
      sd.x = horizontalDominant ? edge(lx, sd.x) : 0;
      sd.y = horizontalDominant ? 0 : edge(ly, sd.y);

      navX = (down(BTN.RIGHT) ? 1 : 0) - (down(BTN.LEFT) ? 1 : 0) || sd.x;
      navY = (down(BTN.DOWN) ? 1 : 0) - (down(BTN.UP) ? 1 : 0) || sd.y;

      look.x = rx;
      look.y = ry;
      if (this.mode === 'inspect') { look.x += lx; look.y += ly; }
      zoom += (b[BTN.RT] ? b[BTN.RT].value : 0) - (b[BTN.LT] ? b[BTN.LT].value : 0);

      // Any deliberate use of the pad (sticks are already past their dead zone here).
      if (anyButton || lx || ly || rx || ry) this._setDevice('gamepad', padType);
    }

    if (this.mode === 'inspect') {
      look.x += keyX;
      look.y += keyY;
      this.horizontal.reset();
      this.vertical.reset();
    } else {
      const stepX = this.horizontal.update(navX || keyX, dt);
      const stepY = this.vertical.update(navY || keyY, dt);
      if (stepX) actions.push(stepX > 0 ? 'right' : 'left');
      if (stepY) actions.push(stepY > 0 ? 'down' : 'up');
    }

    look.x = Math.max(-1, Math.min(1, look.x));
    look.y = Math.max(-1, Math.min(1, look.y));
    zoom = Math.max(-1, Math.min(1, zoom));
    const held = !!(navX || navY || keyX || keyY || look.x || look.y || zoom);
    return { actions, look, zoom, held };
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('gamepadconnected', this._onConnect);
    window.removeEventListener('gamepaddisconnected', this._onDisconnect);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('wheel', this._onPointerDown);
  }
}
