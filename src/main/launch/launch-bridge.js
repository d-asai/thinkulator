'use strict';

const { spawn, spawnSync, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { resolveLaunch, LaunchError } = require('./emulators');

const WIN = process.platform === 'win32';
const STDERR_TAIL = 4096;
const GRACE_MS = 3000;
const URI_ALLOW = /^(steam|com\.epicgames\.launcher|battlenet):/i;

/**
 * Owns the lifetime of the one game that can run at a time.
 *
 * Emulators are "tracked": we hold the child process, so we know exactly when
 * the game ends and can kill its whole process tree. Store launchers (Steam,
 * Epic, ...) are started through their URI handler and are "untracked": the
 * launcher owns the game process, so there is nothing for us to reap.
 *
 * Events:
 *   started { gameId, title, tracked, emulator }
 *   ended   { gameId, code, signal, durationMs, failed, stderr }
 */
class LaunchBridge extends EventEmitter {
  constructor({ openExternal }) {
    super();
    this.openExternal = openExternal;
    this.session = null;
  }

  get active() {
    return this.session !== null;
  }

  async launch(game, system, config) {
    if (this.session) throw new LaunchError('BUSY', 'A game is already running.');
    if (game.source === 'demo') throw new LaunchError('DEMO', 'Demo entries cannot be launched. Add a ROM folder in Settings.');
    if (game.source === 'pc') return this._launchPc(game);
    return this._launchEmulated(game, system, config);
  }

  async _launchEmulated(game, system, config) {
    const plan = await resolveLaunch(game, system, config);

    // A placeholder session blocks a second launch while spawn is in flight.
    const session = { gameId: game.id, title: game.title, child: null, startedAt: Date.now(), stderr: '', killTimer: null, ended: false };
    this.session = session;

    let child;
    try {
      child = spawn(plan.exe, plan.args, {
        cwd: plan.cwd,
        stdio: ['ignore', 'ignore', 'pipe'],
        // POSIX: own process group, so terminate() can signal the whole tree.
        detached: !WIN,
        windowsHide: false,
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } catch (err) {
      this.session = null;
      throw new LaunchError('SPAWN_FAILED', `Could not start ${plan.emulatorName}: ${err.message}`);
    }

    session.child = child;
    // stderr must be drained or a chatty emulator blocks on a full pipe.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      session.stderr = (session.stderr + chunk).slice(-STDERR_TAIL);
    });
    child.on('error', (err) => {
      session.stderr = `${session.stderr}\n${err.message}`.slice(-STDERR_TAIL);
    });
    child.once('exit', (code, signal) => this._finish(session, code, signal));

    this.emit('started', { gameId: game.id, title: game.title, tracked: true, emulator: plan.emulatorName });
    return { tracked: true };
  }

  async _launchPc(game) {
    const launch = game.launch || {};
    if (launch.type === 'uri') {
      if (!URI_ALLOW.test(launch.uri)) throw new LaunchError('BAD_URI', 'Refusing to open an unexpected launcher URI.');
      await this.openExternal(launch.uri);
    } else if (launch.type === 'exec') {
      await new Promise((resolve, reject) => {
        const child = spawn(launch.command, launch.args || [], {
          cwd: launch.cwd || (path.isAbsolute(launch.command) ? path.dirname(launch.command) : undefined),
          stdio: 'ignore',
          detached: true,
        });
        child.once('spawn', () => { child.unref(); resolve(); });
        child.once('error', (err) => reject(new LaunchError('SPAWN_FAILED', `Could not start launcher: ${err.message}`)));
      });
    } else {
      throw new LaunchError('NO_LAUNCH', 'This entry has no launch command.');
    }
    this.emit('started', { gameId: game.id, title: game.title, tracked: false, emulator: game.launcher });
    return { tracked: false };
  }

  _finish(session, code, signal) {
    if (session.ended) return;
    session.ended = true;
    clearTimeout(session.killTimer);
    if (session.child) {
      session.child.stderr?.removeAllListeners('data');
      session.child.stderr?.destroy();
      session.child.removeAllListeners('error');
    }
    if (this.session === session) this.session = null;

    const durationMs = Date.now() - session.startedAt;
    // A non-zero exit within a few seconds is a failed boot, not a play session.
    const failed = !session.terminating && code !== 0 && durationMs < 8000;
    this.emit('ended', {
      gameId: session.gameId, title: session.title, code, signal, durationMs, failed,
      stderr: failed ? session.stderr.trim().split(/\r?\n/).slice(-6).join('\n') : '',
    });
  }

  /** Asks the running emulator to close, then force-kills its tree after a grace period. */
  terminate() {
    const session = this.session;
    if (!session || !session.child || session.ended) return false;
    session.terminating = true;
    const pid = session.child.pid;

    if (WIN) {
      // Without /F taskkill posts WM_CLOSE, which lets emulators flush saves.
      execFile('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true }, () => {});
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
    }

    clearTimeout(session.killTimer);
    session.killTimer = setTimeout(() => {
      if (session.ended) return;
      if (WIN) execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      else try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    }, GRACE_MS);
    return true;
  }

  /** Synchronous last resort for app shutdown: never leave an orphaned emulator. */
  dispose() {
    const session = this.session;
    this.removeAllListeners();
    if (!session || !session.child || session.ended) return;
    clearTimeout(session.killTimer);
    const pid = session.child.pid;
    try {
      if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      else process.kill(-pid, 'SIGKILL');
    } catch { /* already gone */ }
    this.session = null;
  }
}

module.exports = { LaunchBridge };
