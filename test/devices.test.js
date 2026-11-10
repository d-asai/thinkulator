'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'input', 'devices.js')).href);

test('devices: controller family from real browser id strings', async () => {
  const { detectPadType } = await load();
  assert.equal(detectPadType('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), 'xbox');
  assert.equal(detectPadType('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'), 'xbox');
  assert.equal(detectPadType('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), 'playstation');
  assert.equal(detectPadType('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)'), 'playstation');
  assert.equal(detectPadType('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)'), 'nintendo');
  assert.equal(detectPadType('Some Generic USB Joystick'), 'xbox');
  assert.equal(detectPadType(undefined), 'xbox');
});

test('devices: Nintendo confirms with the right-hand button, others with the bottom one', async () => {
  const { faceButtons } = await load();
  assert.deepEqual(faceButtons('xbox'), { accept: 0, back: 1, flip: 2, spine: 3 });
  assert.deepEqual(faceButtons('playstation'), faceButtons('xbox'));
  assert.deepEqual(faceButtons('nintendo'), { accept: 1, back: 0, flip: 3, spine: 2 });
});

test('devices: every device names every action shown in the hints', async () => {
  const { GLYPHS } = await load();
  const actions = ['accept', 'back', 'flip', 'spine', 'play', 'settings', 'page', 'zoom'];
  for (const [device, glyphs] of Object.entries(GLYPHS)) {
    for (const action of actions) assert.ok(glyphs[action] && glyphs[action][0], `${device}.${action}`);
  }
});
