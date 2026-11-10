/**
 * Interface sounds and shelf ambience, voiced per console.
 *
 * Everything here is synthesised with Web Audio, so nothing is shipped as a
 * recording. Each system belongs to a sound family that imitates the audio
 * hardware of its era (pulse waves for the 8-bit machines, two-operator FM
 * for the Genesis, soft sine pads for the disc consoles) and has its own key,
 * so moving between shelves changes what the same action sounds like.
 *
 * These are original sounds in the style of each era, not the consoles' real
 * boot or menu audio. To use your own recordings, put files in
 *   <userData>/sounds/<systemId>/<event>.ogg | .mp3 | .wav
 * where event is ambient, move, shelf, select, back or launch. A file there
 * replaces the synthesised sound for that system.
 */

const FAMILIES = {
  //          UI oscillator      ambience oscillator, filter cutoff and level
  chip: { wave: 'square', gain: 0.5, pad: 'triangle', cutoff: 700, padGain: 0.5 },
  bit16: { wave: 'triangle', gain: 0.9, pad: 'sawtooth', cutoff: 520, padGain: 0.3 },
  fm: { wave: 'fm', gain: 0.75, pad: 'sawtooth', cutoff: 460, padGain: 0.3 },
  poly: { wave: 'sawtooth', gain: 0.45, pad: 'triangle', cutoff: 900, padGain: 0.55 },
  glass: { wave: 'sine', gain: 1, pad: 'sine', cutoff: 1400, padGain: 0.8 },
  soft: { wave: 'sine', gain: 0.9, pad: 'sine', cutoff: 1100, padGain: 0.7 },
};

// family, and the key of the shelf as semitones above A2
const SYSTEMS = {
  nes: ['chip', 0], gb: ['chip', 5], gbc: ['chip', 7],
  snes: ['bit16', 3], gba: ['bit16', 10], nds: ['bit16', 8],
  genesis: ['fm', 2],
  n64: ['poly', 7], ps1: ['poly', 0], dreamcast: ['poly', 5],
  gamecube: ['glass', 4], ps2: ['glass', 0], xbox: ['glass', 9], wii: ['glass', 7], psp: ['glass', 2],
  ps3: ['soft', 5], pc: ['soft', 0],
};

const A2 = 110;
const semis = (n) => A2 * 2 ** (n / 12);

// Each event is a short phrase: [semitones above the key, start (s), length (s), level].
const PHRASES = {
  move: [[24, 0, 0.045, 0.5]],
  shelf: [[12, 0, 0.07, 0.55], [19, 0.06, 0.09, 0.5]],
  select: [[12, 0, 0.07, 0.55], [16, 0.06, 0.07, 0.55], [19, 0.12, 0.14, 0.6]],
  back: [[19, 0, 0.07, 0.5], [12, 0.06, 0.12, 0.45]],
  launch: [[0, 0, 0.5, 0.6], [7, 0.08, 0.5, 0.5], [12, 0.16, 0.6, 0.5], [16, 0.26, 0.7, 0.45], [24, 0.38, 0.9, 0.4]],
  favorite: [[24, 0, 0.06, 0.5], [28, 0.06, 0.06, 0.5], [31, 0.12, 0.18, 0.5]],
  bump: [[-12, 0, 0.12, 0.7]],
};

export class SoundEngine {
  constructor() {
    this.enabled = true;
    this.volume = 0.6;
    this.custom = {}; //     { systemId: { event: fileName } }
    this.buffers = new Map(); // url -> Promise<AudioBuffer|null>
    this.ctx = null;
    this.ambience = null;
    this.ambienceKey = '';
  }

  _context() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.enabled ? this.volume : 0;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  configure({ enabled, volume, custom }) {
    if (custom) this.custom = custom;
    if (typeof enabled === 'boolean') this.enabled = enabled;
    if (typeof volume === 'number') this.volume = Math.max(0, Math.min(1, volume));
    if (this.ctx) this.master.gain.setTargetAtTime(this.enabled ? this.volume : 0, this.ctx.currentTime, 0.05);
    if (!this.enabled) this.stopAmbience();
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
        source.connect(this.master);
        source.start();
        return null;
      });
      return;
    }
    this._phrase(event, systemId);
  }

  _phrase(event, systemId) {
    const phrase = PHRASES[event];
    if (!phrase) return;
    const ctx = this._context();
    const [familyId, key] = SYSTEMS[systemId] || SYSTEMS.pc;
    const family = FAMILIES[familyId];
    const now = ctx.currentTime + 0.005;
    for (const [interval, start, length, level] of phrase) {
      this._note(family, semis(key + interval), now + start, length, level * family.gain * 0.22);
    }
  }

  _note(family, frequency, at, length, level) {
    const ctx = this.ctx;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, at);
    amp.gain.linearRampToValueAtTime(level, at + 0.004);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + length);
    amp.connect(this.master);

    const osc = ctx.createOscillator();
    osc.frequency.value = frequency;
    let modulator = null;
    if (family.wave === 'fm') {
      // Two-operator FM: a modulator at twice the pitch drives the carrier's frequency.
      osc.type = 'sine';
      modulator = ctx.createOscillator();
      modulator.frequency.value = frequency * 2;
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(frequency * 2.2, at);
      depth.gain.exponentialRampToValueAtTime(frequency * 0.2, at + length);
      modulator.connect(depth).connect(osc.frequency);
      modulator.start(at);
      modulator.stop(at + length + 0.02);
    } else {
      osc.type = family.wave;
    }
    osc.connect(amp);
    osc.start(at);
    osc.stop(at + length + 0.02);
    osc.onended = () => { amp.disconnect(); };
  }

  /** Cross-fades the background bed to the given system's. */
  setAmbience(systemId) {
    if (!this.enabled) return;
    const url = this._customUrl(systemId, 'ambient');
    const [familyId, key] = SYSTEMS[systemId] || SYSTEMS.pc;
    const ambienceKey = url || `${familyId}:${key}`;
    if (ambienceKey === this.ambienceKey) return;
    this.stopAmbience();
    this.ambienceKey = ambienceKey;

    const ctx = this._context();
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.master);
    const bed = { out, nodes: [] };
    this.ambience = bed;

    if (url) {
      this._buffer(url).then((buffer) => {
        if (!buffer || this.ambience !== bed) return;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.connect(out);
        source.start();
        bed.nodes.push(source);
        out.gain.setTargetAtTime(0.5, ctx.currentTime, 0.8);
      });
      return;
    }

    // A slow, filtered chord: root, fifth and octave, each slightly detuned.
    const family = FAMILIES[familyId];
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = family.cutoff;
    filter.Q.value = 0.6;
    filter.connect(out);

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = family.cutoff * 0.35;
    lfo.connect(lfoDepth).connect(filter.frequency);
    lfo.start();
    bed.nodes.push(lfo);

    for (const [interval, detune, level] of [[-12, -4, 0.5], [-5, 5, 0.32], [0, -3, 0.3], [7, 6, 0.16]]) {
      const osc = ctx.createOscillator();
      osc.type = family.pad;
      osc.frequency.value = semis(key + interval);
      osc.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(filter);
      osc.start();
      bed.nodes.push(osc);
    }
    out.gain.setTargetAtTime(0.085 * family.padGain, ctx.currentTime, 1.2);
  }

  stopAmbience() {
    const bed = this.ambience;
    this.ambience = null;
    this.ambienceKey = '';
    if (!bed || !this.ctx) return;
    const t = this.ctx.currentTime;
    bed.out.gain.setTargetAtTime(0, t, 0.25);
    for (const node of bed.nodes) node.stop(t + 1.5);
    setTimeout(() => bed.out.disconnect(), 1800);
  }

  dispose() {
    this.stopAmbience();
    if (this.ctx) this.ctx.close();
    this.ctx = null;
    this.buffers.clear();
  }
}
