import { normalizeLoopSteps } from './synth.js';

/**
 * Drum machine — HOST only.
 * 32-step editable grid. Kick, snare, hi-hat and clap load the Michael Fischer
 * TR-808 set from the public jsDelivr CDN. If a file cannot be fetched, that
 * voice stays on the synthesised fallback built below.
 */

export const STEPS = 32;
export const DRUM_STEPS_MAX = 64;
/** Presets are written as one bar of sixteenths and tile to the live drum length. */
export const PRESET_STEPS = 16;

/**
 * Tile a preset pattern over the live loop. Entries are bare step numbers or
 * `{ s: step, d: 3 }` for a triplet cell. Returns Map(step → division).
 */
export function tileCells(hits, length, native = PRESET_STEPS) {
  const cells = new Map();
  const span = Math.max(1, native);
  const total = Math.max(0, length);
  for (const hit of hits || []) {
    const raw = typeof hit === 'object' && hit !== null ? Number(hit.s) : Number(hit);
    if (!Number.isFinite(raw)) continue;
    const base = ((Math.round(raw) % span) + span) % span;
    const division = typeof hit === 'object' && hit !== null && Number(hit.d) === 3 ? 3 : 1;
    for (let step = base; step < total; step += span) cells.set(step, division);
  }
  return cells;
}

export const TRACKS = [
  { id: 'kick', label: 'Kick', shortLabel: 'bd', bank: 'main' },
  { id: 'snare', label: 'Snare', shortLabel: 'sr', bank: 'main' },
  { id: 'hat', label: 'Hi-Hat', shortLabel: 'hh', bank: 'main' },
  { id: 'clap', label: 'Clap', shortLabel: 'cp', bank: 'main' },
  { id: 'openhat', label: 'Open Hat', shortLabel: 'oh', bank: 'extra' },
  { id: 'tom', label: 'Tom', shortLabel: 'tm', bank: 'extra' },
  { id: 'cowbell', label: 'Cowbell', shortLabel: 'cb', bank: 'extra' },
  { id: 'rimshot', label: 'Rimshot', shortLabel: 'rs', bank: 'extra' },
];

/**
 * Fischer TR-808 via the jsDelivr GitHub CDN.
 * The scoped npm URL (`npm/@fluid-music/...`) comes back as HTTP 400: browsers
 * percent-encode `@`, and jsDelivr rejects that. The same files are served from
 * the open-drums repo path, which has no `@` in it.
 */
export const SAMPLE_LIBRARY = {
  name: 'Roland TR-808 sample set 1.0.0 — Michael Fischer / Technopolis, 1994',
  cdn: 'https://cdn.jsdelivr.net/gh/fluid-music/open-drums/tr-808/TR808WAV',
  package: 'https://cdn.jsdelivr.net/npm/@fluid-music/tr-808@0.0.2/README.md',
  notes: 'https://cdn.jsdelivr.net/gh/fluid-music/open-drums/tr-808/TR808WAV/TR808.TXT',
  license:
    'Бесплатный набор без ограничений на использование: Fischer описал его как ABSOLUTELY FREE, пакет @fluid-music/tr-808 фиксирует «no licensing restrictions». Это не лицензия MIT — MIT относится только к коду инструмента.',
};

const SAMPLE_CDN = SAMPLE_LIBRARY.cdn;

export const SAMPLE_URLS = {
  kick: `${SAMPLE_CDN}/BD/BD0025.WAV`,
  snare: `${SAMPLE_CDN}/SD/SD2575.WAV`,
  hat: `${SAMPLE_CDN}/CH/CH.WAV`,
  openhat: `${SAMPLE_CDN}/OH/OH75.WAV`,
  tom: `${SAMPLE_CDN}/MT/MT25.WAV`,
  cowbell: `${SAMPLE_CDN}/CB/CB.WAV`,
  clap: `${SAMPLE_CDN}/CP/CP.WAV`,
  rimshot: `${SAMPLE_CDN}/RS/RS.WAV`,
};

/**
 * Per-voice gain so the normalised 808 hits sit with the synth, under the
 * limiter. Balanced against the rendered peak/RMS of each WAV (see
 * scripts/balance): kick is the anchor, snare/clap/tom sit just under it,
 * hats and cowbell a step lower.
 */
const SAMPLE_GAIN = {
  kick: 1,
  snare: 0.78,
  hat: 0.68,
  openhat: 0.3,
  tom: 0.78,
  cowbell: 0.62,
  clap: 0.45,
  rimshot: 0.58,
};

/**
 * Playback rate per sample voice. The SD2575 snare sits above the old snare
 * pitch; 0.87 brings it into register and softens the snap. The clap speeds
 * up slightly: tighter tail and a bit more brightness.
 */
const SAMPLE_RATE = { snare: 0.87, clap: 1.15 };

/**
 * The 808 clap sample carries a long reverb tail; cap playback so the hit
 * reads tight. Other voices ring out naturally.
 */
const SAMPLE_DURATION = { clap: 0.24 };

/**
 * The 808 clap starts with a quiet flam and the loud burst arrives later.
 * Start playback 3 ms before that burst so the hit sits on the grid.
 * A file whose peak is already at the start is left alone.
 */
export function clapTrimStart(channel, sampleRate) {
  const window = Math.min(channel.length, Math.floor(sampleRate * 0.08));
  if (window < 32) return 0;
  let peakAt = 0;
  let peak = 0;
  for (let i = 0; i < window; i += 1) {
    const value = Math.abs(channel[i]);
    if (value > peak) {
      peak = value;
      peakAt = i;
    }
  }
  if (peak < 0.08) return 0;
  const lead = Math.floor(sampleRate * 0.003);
  const start = peakAt - lead;
  if (start < 16) return 0;
  return start;
}

function trimClap(tone, toneBuffer) {
  const audio = toneBuffer.get?.();
  if (!audio) return { buffer: toneBuffer, skipped: 0 };
  const skipped = clapTrimStart(audio.getChannelData(0), audio.sampleRate);
  if (skipped < 16) return { buffer: toneBuffer, skipped: 0 };
  const length = audio.length - skipped;
  const trimmed = new AudioBuffer({
    length,
    numberOfChannels: audio.numberOfChannels,
    sampleRate: audio.sampleRate,
  });
  for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
    trimmed.copyToChannel(audio.getChannelData(channel).subarray(skipped), channel);
  }
  const wrapped = new tone.ToneAudioBuffer();
  wrapped.set(trimmed);
  return { buffer: wrapped, skipped };
}

const POOL_SIZE = 4;
const LOAD_TIMEOUT_MS = 4000;

export const DRUM_PRESETS = {
  four: {
    id: 'four',
    label: 'Four',
    pattern: { kick: [0, 4, 8, 12], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], clap: [], openhat: [], tom: [], cowbell: [] },
  },
  break: {
    id: 'break',
    label: 'Break',
    pattern: { kick: [0, 3, 10], snare: [4, 12], hat: [2, 6, 8, 10, 14], clap: [4], openhat: [], tom: [], cowbell: [] },
  },
  offbeat: {
    id: 'offbeat',
    label: 'Offbeat',
    pattern: { kick: [0, 8], snare: [4, 12], hat: [2, 6, 10, 14], clap: [12], openhat: [6, 14], tom: [10], cowbell: [] },
  },
  drill: {
    id: 'drill',
    label: 'Drill',
    span: 32,
    repeat: 2,
    pattern: {
      // UK drill: hats run the tresillo 3+3+2 (0,3,6 | 8,11,14 per bar)
      // with a triplet roll closing each bar. The snare sits on beat 3
      // with a pickup on the back half of bar two, kicks stagger around
      // the backbeat, rimshot ticks answer the snare.
      kick: [0, 6, 10, 16, 22, 27],
      snare: [8, 24, 30],
      hat: [
        0, 3, 6, 8, 11, 14, { s: 15, d: 3 },
        16, 19, 22, 24, 27, 30, { s: 31, d: 3 },
      ],
      clap: [],
      openhat: [14, 26],
      tom: [],
      cowbell: [],
      rimshot: [3, 19, 28],
    },
  },
  dnb: {
    id: 'dnb',
    label: 'DnB',
    title: 'Drum & Bass',
    pattern: {
      // One bar: kick only on the 1, backbeat snare on 2 and again on the
      // 'and' after 3, ghost notes ride the clap voice in the 16th pockets
      // (the grid has no velocity, so the ghost lane borrows the clap),
      // hats on 8ths.
      kick: [0],
      snare: [4, 10],
      hat: [0, 2, 4, 6, 8, 10, 12, 14],
      clap: [7, 9, 13, 15],
      openhat: [],
      tom: [],
      cowbell: [],
      rimshot: [],
    },
  },
  jersey: {
    id: 'jersey',
    label: 'Jersey',
    title: 'Jersey Club',
    span: 32,
    repeat: 2,
    pattern: { kick: [0, 4, 8, 11, 16, 20, 24, 27, 30], snare: [], hat: [], clap: [], openhat: [], tom: [], cowbell: [] },
  },
  trap: {
    id: 'trap',
    label: 'Trap',
    span: 32,
    repeat: 2,
    pattern: {
      kick: [0, 10, 16, 26, 30],
      snare: [8, 24],
      // First bar rides eighths; the second runs sixteenths. { s, d: 3 } cells
      // are the closed-hat rolls — three hits squeezed into one step.
      hat: [
        0, 2, 4, 6, { s: 7, d: 3 }, 8, 10, 12, 14, { s: 15, d: 3 },
        16, 17, 18, 19, 20, 21, { s: 22, d: 3 }, 23, 24, 25, 26, 27, 28, 29, 30, { s: 31, d: 3 },
      ],
      clap: [],
      openhat: [4, 20],
      tom: [],
      cowbell: [],
    },
  },
  clear: {
    id: 'clear',
    label: 'Empty',
    pattern: { kick: [], snare: [], hat: [], clap: [], openhat: [], tom: [], cowbell: [] },
  },
};

/**
 * Repeat mode ("Off" / 1 bar / 2 bars) copies the first bars over the rest of
 * the loop. The span is only real when it is shorter than the grid — a 2-bar
 * repeat on a 2-bar loop changes nothing until the loop grows to 4 bars.
 */
export function repeatSpanSteps(mode, length) {
  const bars = Number(mode) || 0;
  const span = bars * PRESET_STEPS;
  return span > 0 && span < length ? span : 0;
}

/** Every step a write lands on while repeat is on: the whole mod-span class. */
export function repeatTargets(mode, length, step) {
  const span = repeatSpanSteps(mode, length);
  if (!span) return [step];
  const targets = [];
  for (let s = step % span; s < length; s += span) targets.push(s);
  return targets;
}

const DEFAULT_PATTERN = DRUM_PRESETS.break.pattern;

function cell(on = false, division = 1) {
  return { on: Boolean(on), division: division === 3 ? 3 : 1 };
}

function emptyGrid() {
  return Object.fromEntries(TRACKS.map(({ id }) => [id, Array.from({ length: STEPS }, () => cell())]));
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class DrumMachine {
  #tone;
  #voices = {};
  #pools = {};
  #cursors = {};
  #sampleGains = {};
  #snareShape;
  #snareAir;
  #clapShape;
  #clapLead = 0;
  #sequence = null;
  #output;
  /** Semitone offset shared by every voice, −12…+12. Sampled voices get it through playbackRate. */
  #pitch = 0;
  #grid = emptyGrid();
  #length = STEPS;
  #running = false;
  #onStep = null;
  #currentStep = -1;
  #paintTimers = new Set();
  #paintFrame = null;
  #sampleState = {
    mode: 'synth',
    usingSamples: false,
    fallback: true,
    tracks: Object.fromEntries(TRACKS.map(({ id }) => [id, 'synth'])),
    source: SAMPLE_LIBRARY.cdn,
    license: SAMPLE_LIBRARY.license,
  };

  constructor(engine, { pattern = DEFAULT_PATTERN } = {}) {
    this.#tone = engine.tone;
    this.#output = new this.#tone.Gain(1.35);

    this.#voices.kick = new this.#tone.MembraneSynth({
      pitchDecay: 0.03,
      octaves: 6,
      envelope: { attack: 0.001, decay: 0.34, sustain: 0 },
      volume: -4,
    }).connect(this.#output);

    // One shaper chain for both snare paths (sample pool and synth
    // fallback): pull down the low/mid body a touch so it stops pressing on
    // the ears, keep the snap's top smooth.
    this.#snareShape = new this.#tone.Filter({ type: 'lowshelf', frequency: 550, gain: -3, Q: 0.7 });
    this.#snareAir = new this.#tone.Filter({ type: 'highshelf', frequency: 3000, gain: -3, Q: 0.7 }).connect(this.#output);
    this.#snareShape.connect(this.#snareAir);

    this.#voices.snare = new this.#tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.16, sustain: 0 },
      volume: -5,
    }).connect(this.#snareShape);

    this.#voices.hat = new this.#tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.06, release: 0.01 },
      harmonicity: 5.1,
      resonance: 4000,
      octaves: 1.2,
      volume: -17,
    }).connect(this.#output);

    // Clap gets its own air shelf on both paths so the hit reads brighter
    // without raising the low body.
    this.#clapShape = new this.#tone.Filter({ type: 'highshelf', frequency: 2200, gain: 3.5, Q: 0.7 }).connect(this.#output);

    this.#voices.clap = new this.#tone.NoiseSynth({
      noise: { type: 'pink' },
      envelope: { attack: 0.002, decay: 0.16, sustain: 0 },
      volume: -3,
    }).connect(this.#clapShape);

    /**
     * The 808 open hat is the same metallic ping as the closed one with the
     * decay opened up — ~0.35 s of ring instead of a 60 ms tick. The pitch
     * drop is shallower so the hit reads 'held open'; modulationIndex is
     * pulled down because a long sustain turns the full FM clang harsh.
     */
    this.#voices.openhat = new this.#tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.35, release: 0.1 },
      harmonicity: 5.1,
      modulationIndex: 20,
      resonance: 3000,
      octaves: 0.6,
      volume: -18,
    }).connect(this.#output);

    /**
     * Mid-tom, not a floor sub: triggered around B2 (~124 Hz) with a two-
     * octave drop over 45 ms — the classic 808 'doom' — and a short body.
     */
    this.#voices.tom = new this.#tone.MembraneSynth({
      pitchDecay: 0.045,
      octaves: 2,
      envelope: { attack: 0.001, decay: 0.32, sustain: 0 },
      volume: -6,
    }).connect(this.#output);

    this.#voices.cowbell = new this.#tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.12, release: 0.02 },
      harmonicity: 12,
      resonance: 800,
      octaves: 0.4,
      volume: -20,
    }).connect(this.#output);

    /**
     * Rimshot: a hard woody tick, not a ring — the shortest MetalSynth
     * decay in the kit, tuned high with a small octave drop so it reads
     * as a stick on the rim instead of a bell.
     */
    this.#voices.rimshot = new this.#tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.035, release: 0.005 },
      harmonicity: 6.4,
      modulationIndex: 28,
      resonance: 1800,
      octaves: 0.5,
      volume: -14,
    }).connect(this.#output);

    for (const [track, steps] of Object.entries(pattern)) {
      for (const step of steps) this.setStep(track, step, true);
    }

    this.#sequence = new this.#tone.Sequence(
      (time, step) => this.#tick(time, step),
      Array.from({ length: STEPS }, (_, i) => i),
      '16n',
    );
  }

  /** Node to feed into the drum FX bus. */
  get output() {
    return this.#output;
  }

  get grid() {
    return this.#grid;
  }

  get length() {
    return this.#length;
  }

  /** Extend or shrink the drum loop without building a new voice. */
  setLength(length) {
    const next = normalizeLoopSteps(length);
    if (next === this.#length) return next;
    for (const row of Object.values(this.#grid)) {
      while (row.length < next) row.push(cell());
      if (row.length > next) row.length = next;
    }
    const wasRunning = this.#running;
    try {
      this.#sequence?.stop();
    } catch {
      // The sequence had not been started.
    }
    this.#sequence?.dispose();
    this.#length = next;
    this.#sequence = new this.#tone.Sequence(
      (time, step) => this.#tick(time, step),
      Array.from({ length: next }, (_, i) => i),
      '16n',
    );
    if (wasRunning) this.#sequence.start();
    return next;
  }

  get currentStep() {
    return this.#currentStep;
  }

  /** Which voices are samples and which fell back to synthesis. */
  /** How many leading samples were cut from the clap so the hit is not late. */
  get clapLead() {
    return this.#clapLead;
  }

  get sampleState() {
    return {
      ...this.#sampleState,
      tracks: { ...this.#sampleState.tracks },
    };
  }

  onStep(callback) {
    this.#onStep = callback;
  }

  setStep(track, step, on, division = 1) {
    const row = this.#grid[track];
    if (!row || step < 0 || step >= this.#length) return null;
    row[step] = cell(on, division);
    return { ...row[step] };
  }

  /**
   * Off → one hit → triplet inside this cell only → off.
   * The triplet is three notes fitted into this step, so the next cell stays put.
   */
  cycleStep(track, step) {
    const current = this.#grid[track]?.[step];
    if (!current) return null;
    if (!current.on) return this.setStep(track, step, true, 1);
    if (current.division !== 3) return this.setStep(track, step, true, 3);
    return this.setStep(track, step, false, 1);
  }

  toggleStep(track, step) {
    const current = this.#grid[track]?.[step];
    return this.setStep(track, step, !current?.on, current?.division === 3 ? 3 : 1);
  }

  clear() {
    this.#grid = emptyGrid();
  }

  get running() {
    return this.#running;
  }

  get pitch() {
    return this.#pitch;
  }

  /**
   * Retune every drum voice by semitones. Sample pools take it as a
   * playbackRate multiplier; the pitched synth voices transpose their trigger
   * note. The noise voices (snare, clap) have no pitch to move on the synth
   * path — their samples still shift when loaded.
   */
  setPitch(semitones) {
    const next = Math.min(12, Math.max(-12, Math.round(Number(semitones) || 0)));
    if (next === this.#pitch) return this.#pitch;
    this.#pitch = next;
    const rate = Math.pow(2, next / 12);
    for (const [track, pool] of Object.entries(this.#pools)) {
      for (const player of pool) player.playbackRate = (SAMPLE_RATE[track] ?? 1) * rate;
    }
    return this.#pitch;
  }

  #pitched(note) {
    if (!this.#pitch) return note;
    return this.#tone.Frequency(note).transpose(this.#pitch).toNote();
  }

  start() {
    try {
      this.#sequence.stop();
    } catch {
      // The sequence had not been started.
    }
    this.#running = true;
    this.#sequence.start(0);
  }

  /** Stop ringing samples and synth drums without touching the pattern. */
  silence() {
    const when = Math.max(0, this.#tone.now());
    for (const pool of Object.values(this.#pools)) {
      for (const player of pool) {
        try {
          player.stop(when);
        } catch {
          // That player was already idle.
        }
      }
    }
    for (const voice of Object.values(this.#voices)) {
      try {
        voice.triggerRelease(when);
      } catch {
        // The fallback voice was already quiet.
      }
    }
  }

  stop() {
    this.#running = false;
    try {
      this.#sequence.stop();
    } catch {
      // Stopping before the transport clock has moved can ask the context for a
      // time a fraction of a sample below zero. The sequence is still halted.
    }
    this.#currentStep = -1;
    this.#cancelPaints();
    this.#onStep?.(-1);
  }

  /**
   * One frame per sounding step instead of a polling loop: the audio callback
   * runs ahead of time, so the repaint waits out the lookahead and then asks
   * for a single animation frame.
   */
  #schedulePaint(step, time) {
    if (!this.#onStep) return;
    const lead = (time - this.#tone.getContext().currentTime) * 1000;
    const timer = setTimeout(() => {
      this.#paintTimers.delete(timer);
      if (this.#paintFrame) cancelAnimationFrame(this.#paintFrame);
      this.#paintFrame = requestAnimationFrame(() => {
        this.#paintFrame = null;
        this.#onStep?.(step);
      });
    }, Math.max(0, lead));
    this.#paintTimers.add(timer);
  }

  #cancelPaints() {
    for (const timer of this.#paintTimers) clearTimeout(timer);
    this.#paintTimers.clear();
    if (this.#paintFrame) cancelAnimationFrame(this.#paintFrame);
    this.#paintFrame = null;
  }

  /**
   * Replace synthesised voices with a small pool of Players sharing one buffer.
   * The pool is allocated once; each hit only calls `start` on the next player.
   * A track that fails to load keeps its synthesised voice.
   */
  async loadSamples(urlsByTrack = SAMPLE_URLS) {
    const tracks = { ...this.#sampleState.tracks };
    await Promise.all(
      TRACKS.map(async ({ id }) => {
        const url = urlsByTrack[id];
        if (!url) {
          tracks[id] = 'synth';
          return;
        }
        try {
          const buffer = new this.#tone.ToneAudioBuffer();
          await withTimeout(buffer.load(url), LOAD_TIMEOUT_MS);
          if (!buffer.loaded || !(buffer.duration > 0)) throw new Error('empty buffer');
          let playBuffer = buffer;
          if (id === 'clap') {
            const trimmed = trimClap(this.#tone, buffer);
            playBuffer = trimmed.buffer;
            this.#clapLead = trimmed.skipped;
          }
          const gain = new this.#tone.Gain(SAMPLE_GAIN[id] ?? 0.7).connect(
            id === 'snare' ? this.#snareShape : id === 'clap' ? this.#clapShape : this.#output,
          );
          const pool = Array.from({ length: POOL_SIZE }, () => {
            const player = new this.#tone.Player();
            player.buffer = playBuffer;
            player.fadeOut = 0.008;
            player.playbackRate = SAMPLE_RATE[id] ?? 1;
            player.connect(gain);
            return player;
          });
          this.#pools[id] = pool;
          this.#cursors[id] = 0;
          this.#sampleGains[id] = gain;
          this.#voices[id]?.disconnect();
          this.#voices[id]?.dispose();
          delete this.#voices[id];
          tracks[id] = 'sample';
        } catch {
          tracks[id] = 'synth';
        }
      }),
    );

    const usingSamples = TRACKS.every(({ id }) => tracks[id] === 'sample');
    const anySample = TRACKS.some(({ id }) => tracks[id] === 'sample');
    this.#sampleState = {
      mode: usingSamples ? 'samples' : anySample ? 'mixed' : 'synth',
      usingSamples,
      fallback: !usingSamples,
      tracks,
      source: SAMPLE_LIBRARY.cdn,
      license: SAMPLE_LIBRARY.license,
    };
    return this.sampleState;
  }

  /**
   * One voice, one sound. Stop every player of this drum at the new hit,
   * then start a player from the pool that already exists. A triplet cannot
   * stack tails, and no Player is constructed here.
   */
  #triggerSample(track, time) {
    const pool = this.#pools[track];
    if (!pool?.length) return false;
    const when = Math.max(0, Number.isFinite(time) ? time : this.#tone.now());
    const index = this.#cursors[track] % pool.length;
    this.#cursors[track] += 1;
    const next = pool[index];
    for (const player of pool) {
      if (player === next) continue;
      try {
        player.stop(when);
      } catch {
        // That player is already silent.
      }
    }
    try {
      next.stop(Math.max(0, when - 0.001));
    } catch {
      // This player was idle, so the start below is its first hit.
    }
    const duration = SAMPLE_DURATION[track];
    if (duration) next.start(when, 0, duration);
    else next.start(when);
    return true;
  }

  /** Cut the synth fallback of this drum, then attack again on the same node. */
  #retriggerSynth(voice, time, attack) {
    if (!voice) return;
    const when = Math.max(0, Number.isFinite(time) ? time : 0);
    try {
      voice.triggerRelease(when);
    } catch {
      // The voice was silent. The attack below is the first hit.
    }
    attack();
  }

  #hit(track, time) {
    if (this.#triggerSample(track, time)) return;
    const voice = this.#voices[track];
    if (track === 'kick') this.#retriggerSynth(voice, time, () => voice.triggerAttack(this.#pitched('C1'), time));
    else if (track === 'snare') this.#retriggerSynth(voice, time, () => voice.triggerAttack(time));
    else if (track === 'hat') this.#retriggerSynth(voice, time, () => voice.triggerAttack(this.#pitched('G5'), time));
    else if (track === 'openhat') this.#retriggerSynth(voice, time, () => voice.triggerAttack(this.#pitched('A5'), time));
    else if (track === 'tom') this.#retriggerSynth(voice, time, () => voice.triggerAttack(this.#pitched('B2'), time));
    else if (track === 'cowbell') this.#retriggerSynth(voice, time, () => voice.triggerAttack(this.#pitched('G5'), time));
    else if (track === 'clap') this.#retriggerSynth(voice, time, () => voice.triggerAttack(time));
    else if (track === 'rimshot') this.#retriggerSynth(voice, time, () => voice.triggerAttack(this.#pitched('G6'), time));
  }

  #tick(time, step) {
    this.#currentStep = step;
    // One 16th in seconds without allocating a Tone.Time per tick.
    const slice = 15 / (this.#tone.getTransport().bpm.value || 120);
    for (const { id } of TRACKS) {
      const slot = this.#grid[id][step];
      if (!slot?.on) continue;
      const hits = slot.division === 3 ? 3 : 1;
      for (let i = 0; i < hits; i += 1) this.#hit(id, time + (slice * i) / hits);
    }
    this.#schedulePaint(step, time);
  }

  dispose() {
    this.stop();
    this.#sequence?.dispose();
    for (const voice of Object.values(this.#voices)) voice.dispose();
    for (const pool of Object.values(this.#pools)) for (const player of pool) player.dispose();
    for (const gain of Object.values(this.#sampleGains)) gain.dispose();
    this.#snareShape?.dispose();
    this.#snareAir?.dispose();
    this.#clapShape?.dispose();
    this.#output.dispose();
  }
}
