'use strict';

const { app } = require('electron');

/**
 * Self-update from the project's GitHub releases.
 *
 * Only runs in an installed build: electron-builder writes the release feed
 * location into the package at build time, so a development checkout has
 * nothing to update from. The download happens in the background and is
 * applied when the app next quits, so it never interrupts a session.
 *
 * @param notify ({ state: 'available' | 'ready' | 'error', version?, message? }) => void
 */
function startUpdater({ enabled, notify, verbose = false }) {
  if (!enabled || !app.isPackaged) return null;

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.warn('[updater] unavailable:', err.message);
    return null;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Follow pre-releases while this build is itself one (0.1.0-beta.2 -> beta.3).
  autoUpdater.allowPrerelease = /-/.test(app.getVersion());
  autoUpdater.logger = null;

  autoUpdater.on('update-available', (info) => notify({ state: 'available', version: info.version }));
  autoUpdater.on('update-downloaded', (info) => notify({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => console.warn('[updater]', err && String(err.message).split('\n')[0]));
  if (verbose) {
    autoUpdater.on('checking-for-update', () => console.log('[updater] checking, current version', app.getVersion()));
    autoUpdater.on('update-not-available', (info) => console.log('[updater] up to date; latest is', info.version));
    autoUpdater.on('update-available', (info) => console.log('[updater] update available:', info.version));
  }

  // Offline or rate-limited is normal; it is retried on the next start.
  autoUpdater.checkForUpdates().catch((err) => console.warn('[updater] check failed:', String(err.message).split('\n')[0]));
  return autoUpdater;
}

module.exports = { startUpdater };
