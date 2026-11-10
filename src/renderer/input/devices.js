/**
 * Which controller family a Gamepad is, from its id string. Browsers report
 * ids like "Xbox 360 Controller (XInput STANDARD GAMEPAD)" or
 * "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)".
 * Anything unrecognised is treated as Xbox, the layout the standard mapping
 * was modelled on.
 */
export function detectPadType(id) {
  const s = String(id || '').toLowerCase();
  if (/054c|dualsense|dualshock|playstation|ps[345] controller/.test(s)) return 'playstation';
  if (/057e|nintendo|switch|joy-con|pro controller/.test(s)) return 'nintendo';
  return 'xbox';
}

/**
 * Standard-mapping button index for each face action. The standard mapping is
 * positional (0 = bottom, 1 = right, 2 = left, 3 = top). Xbox and PlayStation
 * confirm with the bottom button; Nintendo confirms with the right one (A),
 * so its pairs are swapped to keep "A accepts, B goes back" true by letter.
 */
export function faceButtons(padType) {
  return padType === 'nintendo'
    ? { accept: 1, back: 0, flip: 3, spine: 2 }
    : { accept: 0, back: 1, flip: 2, spine: 3 };
}

/** What each action's button is called on each device, for the on-screen hints. */
export const GLYPHS = {
  xbox: {
    accept: ['A', 'a'], back: ['B', 'b'], flip: ['X', 'x'], spine: ['Y', 'y'],
    play: ['Menu'], settings: ['View'], page: ['LB/RB'], zoom: ['LT/RT'],
  },
  playstation: {
    accept: ['✕', 'ps-cross'], back: ['○', 'ps-circle'], flip: ['□', 'ps-square'], spine: ['△', 'ps-triangle'],
    play: ['Options'], settings: ['Create'], page: ['L1/R1'], zoom: ['L2/R2'],
  },
  nintendo: {
    accept: ['A'], back: ['B'], flip: ['X'], spine: ['Y'],
    play: ['+'], settings: ['−'], page: ['L/R'], zoom: ['ZL/ZR'],
  },
  keyboard: {
    accept: ['Enter'], back: ['Esc'], flip: ['X'], spine: ['Y'],
    play: ['P'], settings: ['F1'], page: ['PgUp/PgDn'], zoom: ['− / ='],
  },
};

export const PAD_NAMES = { xbox: 'Xbox controller', playstation: 'PlayStation controller', nintendo: 'Nintendo controller' };
