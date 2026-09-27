/**
 * Audio engine — HOST only.
 * Owns the Tone.js context, the master bus and the transport tempo.
 * Nothing here touches the DOM: the UI calls `start()` from a user gesture.
 */

import { createMasterFx } from './effects.js';

const DEFAULT_BPM = 120;

export class AudioEngine {
  #tone;
  #master = null;
  #compressor = null;
  #limiter = null;
  #masterFx = null;
  #started = false;
  #bpm = DEFAULT_BPM;
  /** idle → starting → ready, or error if start() rejected. */
  #phase = 'idle';
  #error = null;

  constructor({ tone = globalThis.Tone, bpm = DEFAULT_BPM } = {}) {
    if (!tone) throw new Error('Tone.js is not loaded');
    this.#tone = tone;
    this.#bpm = bpm;
  }

  get tone() {
    return this.#tone;
  }

  get started() {
    return this.#started;
  }

  /** idle | starting | ready | error. The splash follows this, not a guessed timer. */
  get phase() {
    return this.#phase;
  }

  get error() {
    return this.#error;
  }

  /** Master bus every instrument chain connects into. */
  get master() {
    return this.#master;
  }

  get masterFx() {
    return this.#masterFx;
  }

  get bpm() {
    return this.#bpm;
  }

  get contextState() {
    return this.#tone.getContext().rawContext.state;
  }

  /** Must be called from a user gesture ("Start Audio"); browsers block audio otherwise. */
  async start() {
    if (this.#started) return this;
    this.#phase = 'starting';
    this.#error = null;
    try {
      await this.#tone.start();
      this.#limiter = new this.#tone.Limiter(-2).toDestination();
      this.#compressor = new this.#tone.Compressor({
        threshold: -16,
        ratio: 2.2,
        attack: 0.012,
        release: 0.22,
        knee: 8,
      });
      const context = this.#tone.getContext();
      if (Number(context.lookAhead) > 0.02) context.lookAhead = 0.02;
      this.#masterFx = createMasterFx(this.#tone, this.#bpm);
      this.#compressor.connect(this.#masterFx.input);
      this.#masterFx.output.connect(this.#limiter);
      this.#master = new this.#tone.Gain(0.78).connect(this.#compressor);
      this.#tone.getTransport().bpm.value = this.#bpm;
      this.#started = true;
      this.#phase = 'ready';
      return this;
    } catch (error) {
      this.#phase = 'error';
      this.#error = error instanceof Error ? error : new Error(String(error));
      throw this.#error;
    }
  }

  setBpm(bpm) {
    this.#bpm = Math.min(200, Math.max(40, Number(bpm) || DEFAULT_BPM));
    if (this.#started) {
      this.#tone.getTransport().bpm.value = this.#bpm;
      this.#masterFx?.setBpm(this.#bpm);
    }
    return this.#bpm;
  }

  setMasterVolume(gain) {
    if (this.#master) this.#master.gain.rampTo(Math.min(1, Math.max(0, gain)), 0.05);
  }

  /** Current master level, before a fade. */
  masterGain() {
    const value = this.#master?.gain?.value;
    return Number.isFinite(value) ? value : 0.78;
  }

  /** Even fade so a backgrounded tab does not cut the bus in one click. */
  duckMaster(seconds = 0.18) {
    const gain = this.masterGain();
    this.#master?.gain?.rampTo(0, seconds);
    return gain;
  }

  restoreMaster(gain, seconds = 0.18) {
    const value = Math.min(1, Math.max(0, Number(gain) || 0));
    this.#master?.gain?.rampTo(value, seconds);
    return value;
  }

  /** Chrome pauses the context in the background. This brings it back. */
  async resumeContext() {
    try {
      await this.#tone.start();
    } catch {
      // Already running, or the context will resume on the raw node below.
    }
    const raw = this.#tone.getContext()?.rawContext;
    if (raw && raw.state !== 'running' && typeof raw.resume === 'function') await raw.resume();
  }

  /** Park the clock at the top of the loop so the next start is in phase. */
  rewindTransport() {
    if (!this.#started) return;
    const transport = this.#tone.getTransport();
    try {
      if (transport.state === 'started') transport.stop();
    } catch {
      // The context was already suspended.
    }
    transport.position = 0;
  }

  startTransport() {
    if (this.#started) this.#tone.getTransport().start();
  }

  stopTransport() {
    if (this.#started) this.#tone.getTransport().stop();
  }

  get transportRunning() {
    return this.#started && this.#tone.getTransport().state === 'started';
  }

  dispose() {
    this.stopTransport();
    this.#master?.dispose();
    this.#compressor?.dispose();
    this.#masterFx?.dispose();
    this.#limiter?.dispose();
    this.#master = null;
    this.#compressor = null;
    this.#masterFx = null;
    this.#limiter = null;
    this.#started = false;
    this.#phase = 'idle';
  }
}
