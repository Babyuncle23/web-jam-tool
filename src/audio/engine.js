/**
 * Audio engine — HOST only.
 * Owns the Tone.js context, the master bus and the transport tempo.
 * Nothing here touches the DOM: the UI calls `start()` from a user gesture.
 */

import { createMasterFx } from './effects.js';

const DEFAULT_BPM = 120;
/** Pre-compressor master bus level. The Master sheet volume slider writes this. */
export const DEFAULT_MASTER_GAIN = 0.78;
/**
 * Lite runs the whole graph at 24 kHz: every node — oscillators, filters,
 * the convolver, delay lines — bills per sample, so the audio thread roughly
 * halves. The context is kept for re-entries: Chrome caps live AudioContexts.
 */
const LITE_SAMPLE_RATE = 24000;
let liteContext = null;

export class AudioEngine {
  #tone;
  #lite;
  #master = null;
  #compressor = null;
  #limiter = null;
  #masterFx = null;
  #started = false;
  #bpm = DEFAULT_BPM;
  /** idle → starting → ready, or error if start() rejected. */
  #phase = 'idle';
  #error = null;

  constructor({ tone = globalThis.Tone, bpm = DEFAULT_BPM, lite = null } = {}) {
    if (!tone) throw new Error('Tone.js is not loaded');
    this.#tone = tone;
    this.#bpm = bpm;
    this.#lite = lite;
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

  /** Actual output rate — the log line and the lite probe read it. */
  get sampleRate() {
    return this.#tone.getContext().rawContext.sampleRate;
  }

  /**
   * Swap Tone onto a 24 kHz AudioContext before anything touches the default
   * one. Must run before tone.start()/getContext() — once a context exists,
   * replacing it strands the nodes built on it. A native AudioContext is
   * wrapped by setContext; old Safari/Firefox refuse the option — lite then
   * just keeps the device rate.
   */
  #pickLiteContext() {
    if (!this.#lite?.lowSampleRate || typeof this.#tone.setContext !== 'function') return;
    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Ctor) return;
    try {
      if (!liteContext) liteContext = new Ctor({ sampleRate: LITE_SAMPLE_RATE });
      this.#tone.setContext(liteContext);
    } catch {
      liteContext = null;
    }
  }

  /** Must be called from a user gesture ("Start Audio"); browsers block audio otherwise. */
  async start() {
    if (this.#started) return this;
    this.#phase = 'starting';
    this.#error = null;
    try {
      this.#pickLiteContext();
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
      /** Lite widens the window to 50 ms: the transport clock wakes half as
       * often and a weak CPU gets jitter headroom, at ~30 ms more latency. */
      const ahead = this.#lite?.wideLookAhead ? 0.05 : 0.02;
      if (Number(context.lookAhead) !== ahead) context.lookAhead = ahead;
      this.#masterFx = createMasterFx(this.#tone, this.#bpm);
      this.#compressor.connect(this.#masterFx.input);
      this.#masterFx.output.connect(this.#limiter);
      this.#master = new this.#tone.Gain(DEFAULT_MASTER_GAIN).connect(this.#compressor);
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
    return Number.isFinite(value) ? value : DEFAULT_MASTER_GAIN;
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
