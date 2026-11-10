'use strict';

/**
 * Rasterises build/icon.svg into build/icon.png (512px, used for the window
 * in development) and build/icon.ico (used by the Windows exe and installer).
 *
 * Run with:  npm run icons
 *
 * Chromium does the SVG rendering, so no image library is needed. The .ico is
 * written by hand: a directory of PNG-compressed images, one per size.
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const BUILD = path.join(__dirname, '..', 'build');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const RENDER = 1024;

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, png }, i) => {
    const at = i * 16;
    directory.writeUInt8(size === 256 ? 0 : size, at); //     width  (0 means 256)
    directory.writeUInt8(size === 256 ? 0 : size, at + 1); // height
    directory.writeUInt8(0, at + 2); //  palette size
    directory.writeUInt8(0, at + 3); //  reserved
    directory.writeUInt16LE(1, at + 4); //  colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...images.map((i) => i.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const svg = fs.readFileSync(path.join(BUILD, 'icon.svg'), 'utf8');
    const win = new BrowserWindow({
      width: RENDER, height: RENDER, show: false, frame: false, transparent: true,
      webPreferences: { offscreen: true, sandbox: true },
    });
    const html = `<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:${RENDER}px;height:${RENDER}px}</style>${svg}`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const master = await win.webContents.capturePage();
    const sized = (size) => master.resize({ width: size, height: size, quality: 'best' }).toPNG();

    fs.writeFileSync(path.join(BUILD, 'icon.png'), sized(512));
    fs.writeFileSync(path.join(BUILD, 'icon.ico'), buildIco(ICO_SIZES.map((size) => ({ size, png: sized(size) }))));
    console.log(`[icons] wrote icon.png and icon.ico (${ICO_SIZES.join(', ')} px) from a ${master.getSize().width}px render`);
  } catch (err) {
    console.error('[icons] failed:', err);
    process.exitCode = 1;
  }
  app.quit();
});
