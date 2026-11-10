/**
 * Interface sounds, voiced per console. They play only in response to an
 * action (moving, selecting, launching); there is no background sound.
 *
 * Two layers, in priority order:
 *   1. A file the user supplied in <userData>/sounds/<systemId>/<event>.ogg|mp3|wav
 *      (event is move, shelf, select, back or launch).
 *   2. A synthesised voice, one per console, modelled on that machine's
 *      sound hardware (see voices.js): pulse waves at the NES and Game Boy
 *      duty cycles, the SNES echo, Genesis FM, and so on.
 *
 * Nothing is shipped as a recording.
 */

import { Synth } from './voices.js';

export class SoundEngine {
  constructor() {
    this.enabled = true;
    this.volume = 0.6;
    this.custom = {}; //     { systemId: { event: fileName } }
    this.buffers = new Map(); // url -> Promise<AudioBuffer|null>
    this.ctx = null;
  }

  _context() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.enabled ? this.volume : 0;
      this.master.connect(this.ctx.destination);
      this.synth = new Synth(this.ctx, this.master);
    }
    return this.ctx;
  }

  configure({ enabled, volume, custom }) {
    if (custom) this.custom = custom;
    if (typeof enabled === 'boolean') this.enabled = enabled;
    if (typeof volume === 'number') this.volume = Math.max(0, Math.min(1, volume));
    if (this.ctx) this.master.gain.setTargetAtTime(this.enabled ? this.volume : 0, this.ctx.currentTime, 0.05);
  }

  /** Silences everything while the window is unfocused or a game is running. */
  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  _customUrl(systemId, event) {
    const file = this.custom[systemId] && this.custom[systemId][event];
    return file ? `/sounds/${systemId}/${file}` : '';
  }

  _buffer(url) {
    if (!this.buffers.has(url)) {
      this.buffers.set(url, fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('missing'))))
        .then((data) => this._context().decodeAudioData(data))
        .catch(() => null));
    }
    return this.buffers.get(url);
  }

  /** Plays one interface sound in the voice of `systemId`. */
  play(event, systemId = 'pc') {
    if (!this.enabled) return;
    const ctx = this._context();
    const url = this._customUrl(systemId, event);
    if (url) {
      this._buffer(url).then((buffer) => {
        if (!buffer) return this._phrase(event, systemId);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        // Recordings are usually much louder than the synthesised voices; pull
        // them down so both sit at the same level on the volume setting.
        const gain = ctx.createGain();
        gain.gain.value = event === 'launch' ? 0.6 : 0.35;
        source.connect(gain).connect(this.master);
        source.start();
        return null;
      });
      return;
    }
    this._phrase(event, systemId);
  }

  /** The synthesised layer: used when no sample exists for this console and event. */
  _phrase(event, systemId) {
    this._context();
    this.synth.play(systemId, event);
  }

  dispose() {
    if (this.ctx) this.ctx.close();
    this.ctx = null;
    this.synth = null;
    this.buffers.clear();
  }
}
