/**
 * The synthesised voice of each console: what its interface sounds are made of.
 * There is no background sound; these play only when you do something.
 *
 * Each voice is modelled on the sound hardware and audio character of the
 * machine, not on any recording:
 *
 *   NES / Game Boy   pulse waves at the chips' real duty cycles, dry, with a
 *                    noise channel for thuds.
 *   SNES             soft, sample-like tones with the DSP's trademark echo.
 *   Genesis          two-operator FM, bright and a little metallic.
 *   GBA              pulse waves through a bit-crusher, like its gritty DAC.
 *   N64 / DS         mellow filtered tones, lightly reverberant.
 *   PS1, Dreamcast   glassy bells and soft plucks in a large reverb.
 *   GameCube, Wii    short, rounded, playful plucks.
 *   PS2, Xbox        low, dark tones; the Xbox one swept through a resonant filter.
 *   PSP, PS3, PC     quiet sine ticks; restrained and modern.
 *
 * These are original sounds in the manner of each machine. A file the user
 * supplies for an event takes its place.
 */

const A2 = 110;
const hz = (semitones) => A2 * 2 ** (semitones / 12);

// A phrase is a list of notes: [semitones above the voice's root, start (s), length (s), level].
const PHRASES = {
  // Fast, dry arpeggios: the vocabulary of 8-bit menus.
  chip: {
    move: [[24, 0, 0.035, 0.5]],
    shelf: [[12, 0, 0.045, 0.5], [24, 0.045, 0.06, 0.5]],
    select: [[12, 0, 0.045, 0.5], [19, 0.045, 0.045, 0.5], [24, 0.09, 0.045, 0.5], [31, 0.135, 0.13, 0.5]],
    back: [[24, 0, 0.045, 0.45], [19, 0.045, 0.045, 0.45], [12, 0.09, 0.1, 0.45]],
    favorite: [[24, 0, 0.04, 0.5], [28, 0.04, 0.04, 0.5], [31, 0.08, 0.04, 0.5], [36, 0.12, 0.14, 0.5]],
    launch: [[0, 0, 0.07, 0.5], [7, 0.07, 0.07, 0.5], [12, 0.14, 0.07, 0.5], [19, 0.21, 0.07, 0.5], [24, 0.28, 0.07, 0.5], [31, 0.35, 0.3, 0.5]],
    bump: 'noise',
  },
  // Rounder, slower, harmonised: 16-bit.
  console16: {
    move: [[19, 0, 0.06, 0.5]],
    shelf: [[12, 0, 0.08, 0.5], [19, 0.07, 0.13, 0.5]],
    select: [[12, 0, 0.08, 0.5], [16, 0.07, 0.08, 0.5], [19, 0.14, 0.22, 0.55]],
    back: [[16, 0, 0.08, 0.45], [12, 0.07, 0.17, 0.45]],
    favorite: [[19, 0, 0.07, 0.5], [24, 0.07, 0.07, 0.5], [28, 0.14, 0.2, 0.5]],
    launch: [[0, 0, 0.8, 0.5], [7, 0.06, 0.8, 0.45], [12, 0.12, 0.9, 0.45], [16, 0.2, 1.0, 0.4]],
    bump: [[-12, 0, 0.14, 0.6]],
  },
  // Two-note chimes with room around them: the early disc era.
  chime: {
    move: [[24, 0, 0.09, 0.4]],
    shelf: [[19, 0, 0.12, 0.45], [24, 0.09, 0.22, 0.45]],
    select: [[12, 0, 0.14, 0.5], [24, 0.1, 0.34, 0.5]],
    back: [[24, 0, 0.1, 0.4], [17, 0.09, 0.22, 0.4]],
    favorite: [[24, 0, 0.1, 0.45], [31, 0.09, 0.3, 0.45]],
    launch: [[0, 0, 1.2, 0.45], [12, 0.12, 1.2, 0.45], [19, 0.24, 1.4, 0.4], [28, 0.4, 1.6, 0.35]],
    bump: [[-5, 0, 0.16, 0.5]],
  },
  // Low and unhurried.
  deep: {
    move: [[12, 0, 0.05, 0.45]],
    shelf: [[0, 0, 0.14, 0.5], [7, 0.08, 0.22, 0.45]],
    select: [[0, 0, 0.26, 0.55], [12, 0.06, 0.32, 0.45]],
    back: [[7, 0, 0.1, 0.45], [0, 0.08, 0.26, 0.45]],
    favorite: [[12, 0, 0.12, 0.45], [19, 0.1, 0.3, 0.45]],
    launch: [[-12, 0, 2.2, 0.5], [-5, 0.15, 2.2, 0.45], [0, 0.3, 2.4, 0.45], [7, 0.6, 2.6, 0.35]],
    bump: [[-12, 0, 0.2, 0.6]],
  },
  // Barely-there ticks: later machines kept out of the way.
  soft: {
    move: [[31, 0, 0.03, 0.3]],
    shelf: [[24, 0, 0.08, 0.38]],
    select: [[19, 0, 0.1, 0.42], [26, 0.08, 0.22, 0.42]],
    back: [[19, 0, 0.13, 0.36]],
    favorite: [[26, 0, 0.09, 0.4], [31, 0.08, 0.22, 0.4]],
    launch: [[-12, 0, 1.5, 0.45], [0, 0.1, 1.5, 0.4], [7, 0.2, 1.6, 0.38], [16, 0.4, 1.8, 0.32]],
    bump: [[0, 0, 0.12, 0.4]],
  },
};

/**
 *   osc       pulse12 | pulse25 | pulse50 | triangle | sine | saw | fm | pluck | bell
 *   root      key, in semitones above A2
 *   set       which phrase vocabulary it speaks
 *   gain      overall level (voices differ a lot in loudness)
 *   cutoff    low-pass in Hz (0 = none); q adds resonance
 *   crush     bit-crusher steps (0 = none)
 *   echo      send to the shared echo, 0..1
 *   reverb    send to the shared reverb, 0..1
 */
export const VOICES = {
  nes: { osc: 'pulse25', root: 0, set: 'chip', gain: 0.5 },
  gb: { osc: 'pulse50', root: 5, set: 'chip', gain: 0.45 },
  gbc: { osc: 'pulse12', root: 7, set: 'chip', gain: 0.55 },
  gba: { osc: 'pulse50', root: 10, set: 'chip', gain: 0.5, crush: 10, cutoff: 5200 },
  snes: { osc: 'triangle', root: 3, set: 'console16', gain: 1, cutoff: 3200, echo: 0.42 },
  genesis: { osc: 'fm', fmRatio: 2, fmIndex: 3.2, root: 2, set: 'console16', gain: 0.75, cutoff: 6000 },
  n64: { osc: 'saw', root: 7, set: 'console16', gain: 0.5, cutoff: 1500, attack: 0.012, reverb: 0.28 },
  nds: { osc: 'triangle', root: 8, set: 'chime', gain: 0.9, reverb: 0.12 },
  ps1: { osc: 'bell', root: 0, set: 'chime', gain: 0.7, reverb: 0.55 },
  dreamcast: { osc: 'pluck', root: 5, set: 'chime', gain: 0.9, reverb: 0.5 },
  gamecube: { osc: 'pluck', root: 4, set: 'chime', gain: 0.9, reverb: 0.2, decay: 0.6 },
  ps2: { osc: 'sine', root: -2, set: 'deep', gain: 1, reverb: 0.6 },
  xbox: { osc: 'saw', root: -3, set: 'deep', gain: 0.6, cutoff: 900, q: 7, reverb: 0.35 },
  psp: { osc: 'sine', root: 2, set: 'soft', gain: 1, reverb: 0.3 },
  wii: { osc: 'pluck', root: 7, set: 'chime', gain: 0.8, reverb: 0.3, decay: 0.7 },
  ps3: { osc: 'sine', root: 5, set: 'soft', gain: 1, reverb: 0.5 },
  pc: { osc: 'sine', root: 0, set: 'soft', gain: 0.9, reverb: 0.1 },
};

const PULSE_DUTY = { pulse12: 0.125, pulse25: 0.25, pulse50: 0.5 };

/**
 * Plays voices into a destination node. Owns the shared effects (echo,
 * reverb) and one small effects chain per console, all built on first use.
 */
export class Synth {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.out = destination;
    this.buses = new Map();
    this.waves = new Map();
    this._noise = null;
    this._echo = null;
    this._reverb = null;
  }

  voice(systemId) {
    return VOICES[systemId] || VOICES.pc;
  }

  /** A pulse wave of a given duty cycle, from its Fourier series. */
  _pulse(duty) {
    if (!this.waves.has(duty)) {
      const n = 48;
      const real = new Float32Array(n);
      const imag = new Float32Array(n);
      for (let k = 1; k < n; k++) imag[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
      this.waves.set(duty, this.ctx.createPeriodicWave(real, imag));
    }
    return this.waves.get(duty);
  }

  _noiseBuffer() {
    if (!this._noise) {
      const length = this.ctx.sampleRate;
      this._noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this._noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    return this._noise;
  }

  /** A tape-style echo: one repeat every 150 ms, each darker and quieter. */
  _echoBus() {
    if (!this._echo) {
      const ctx = this.ctx;
      const input = ctx.createGain();
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.15;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.38;
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 2400;
      input.connect(delay).connect(tone).connect(feedback).connect(delay);
      tone.connect(this.out);
      this._echo = input;
    }
    return this._echo;
  }

  /** A hall, from a generated impulse response (decaying noise). */
  _reverbBus() {
    if (!this._reverb) {
      const ctx = this.ctx;
      const seconds = 2.2;
      const length = Math.floor(ctx.sampleRate * seconds);
      const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = impulse.getChannelData(ch);
        for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
      }
      const convolver = ctx.createConvolver();
      convolver.buffer = impulse;
      const level = ctx.createGain();
      level.gain.value = 0.9;
      convolver.connect(level).connect(this.out);
      this._reverb = convolver;
    }
    return this._reverb;
  }

  /** The per-console chain a voice plays through: filter, then dry and effect sends. */
  _bus(systemId) {
    if (this.buses.has(systemId)) return this.buses.get(systemId);
    const ctx = this.ctx;
    const v = this.voice(systemId);
    const input = ctx.createGain();
    let tail = input;

    if (v.cutoff) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = v.cutoff;
      filter.Q.value = v.q || 0.7;
      tail.connect(filter);
      tail = filter;
    }
    tail.connect(this.out);
    if (v.echo) {
      const send = ctx.createGain();
      send.gain.value = v.echo;
      tail.connect(send).connect(this._echoBus());
    }
    if (v.reverb) {
      const send = ctx.createGain();
      send.gain.value = v.reverb;
      tail.connect(send).connect(this._reverbBus());
    }
    this.buses.set(systemId, input);
    return input;
  }

  /** Plays one interface event in a console's voice. */
  play(systemId, event) {
    const v = this.voice(systemId);
    const phrase = PHRASES[v.set][event];
    if (!phrase) return;
    const bus = this._bus(systemId);
    const at = this.ctx.currentTime + 0.005;
    if (phrase === 'noise') {
      this._thud(bus, at, v.gain);
      return;
    }
    for (const [interval, start, length, level] of phrase) {
      this._note(bus, v, hz(v.root + interval), at + start, length * (v.decay || 1), level * v.gain * 0.2);
    }
  }

  /**
   * Quantises a waveform to a few levels: the grit of a low-bit DAC. It sits
   * between the oscillator and its envelope, where the signal is full-scale;
   * after the envelope a quiet note would round away to silence.
   */
  _crusher(steps) {
    const key = `crush${steps}`;
    if (!this.waves.has(key)) {
      const curve = new Float32Array(1024);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1;
        curve[i] = Math.round(x * steps) / steps;
      }
      this.waves.set(key, curve);
    }
    const shaper = this.ctx.createWaveShaper();
    shaper.curve = this.waves.get(key);
    return shaper;
  }

  /** The noise channel: a short low burst. */
  _thud(bus, at, gain) {
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = this._noiseBuffer();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(900, at);
    filter.frequency.exponentialRampToValueAtTime(120, at + 0.12);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.22 * gain, at);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
    source.connect(filter).connect(amp).connect(bus);
    source.start(at);
    source.stop(at + 0.16);
    source.onended = () => amp.disconnect();
  }

  _note(bus, v, frequency, at, length, level) {
    const ctx = this.ctx;
    const amp = ctx.createGain();
    const attack = v.attack || 0.003;
    amp.gain.setValueAtTime(0, at);
    amp.gain.linearRampToValueAtTime(level, at + attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + attack + length);
    amp.connect(bus);

    const end = at + attack + length + 0.03;
    const osc = ctx.createOscillator();
    const extra = [];

    if (PULSE_DUTY[v.osc]) {
      osc.setPeriodicWave(this._pulse(PULSE_DUTY[v.osc]));
      osc.frequency.value = frequency;
    } else if (v.osc === 'saw') {
      osc.type = 'sawtooth';
      osc.frequency.value = frequency;
    } else if (v.osc === 'fm' || v.osc === 'bell') {
      // Frequency modulation: a second oscillator bends the pitch of the first
      // very fast. A whole-number ratio is brassy; an uneven one rings like a bell.
      const bell = v.osc === 'bell';
      osc.type = 'sine';
      osc.frequency.value = frequency;
      const modulator = ctx.createOscillator();
      modulator.frequency.value = frequency * (bell ? 3.5 : v.fmRatio || 2);
      const depth = ctx.createGain();
      const index = bell ? 2.2 : v.fmIndex || 2;
      depth.gain.setValueAtTime(frequency * index, at);
      depth.gain.exponentialRampToValueAtTime(frequency * 0.05, at + length);
      modulator.connect(depth).connect(osc.frequency);
      modulator.start(at);
      modulator.stop(end);
      extra.push(depth);
    } else if (v.osc === 'pluck') {
      // The pitch starts high and drops in a few milliseconds: a struck bar or a water drop.
      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency * 2.2, at);
      osc.frequency.exponentialRampToValueAtTime(frequency, at + 0.028);
      const overtone = ctx.createOscillator();
      overtone.type = 'sine';
      overtone.frequency.value = frequency * 4;
      const overtoneAmp = ctx.createGain();
      overtoneAmp.gain.setValueAtTime(level * 0.22, at);
      overtoneAmp.gain.exponentialRampToValueAtTime(0.0001, at + length * 0.3);
      overtone.connect(overtoneAmp).connect(bus);
      overtone.start(at);
      overtone.stop(end);
      extra.push(overtoneAmp);
    } else {
      osc.type = v.osc === 'triangle' ? 'triangle' : 'sine';
      osc.frequency.value = frequency;
    }

    if (v.crush) {
      const shaper = this._crusher(v.crush);
      osc.connect(shaper).connect(amp);
      extra.push(shaper);
    } else {
      osc.connect(amp);
    }
    osc.start(at);
    osc.stop(end);
    osc.onended = () => {
      amp.disconnect();
      for (const node of extra) node.disconnect();
    };
  }
}
