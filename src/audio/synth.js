/**
 * Polyphonic touch synth — HOST only.
 * Guests import the pure helpers (resolveGesture, names, scales) so the chord
 * label is computed by the same function that chooses the sounding notes.
 * Audio nodes are built once in the constructor and reused for every touch.
 */

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
};

export const SCALE_LABELS = {
  major: 'Major',
  minor: 'Minor',
  pentatonic: 'Pentatonic',
};

export const PLAY_MODES = ['single', 'chords'];

export const INSTRUMENTS = [
  { id: 'pad', label: 'Pad' },
  { id: 'bass', label: 'Bass' },
  { id: 'organ', label: 'Organ' },
  { id: 'kalimba', label: 'Kalimba' },
  { id: 'synth', label: 'Synth' },
];

export const INSTRUMENT_COLORS = {
  pad: '#2f8f55',
  bass: '#c4512c',
  organ: '#3d6f9a',
  kalimba: '#e0a12e',
  synth: '#6b4423',
};

export const INSTRUMENT_IDS = INSTRUMENTS.map((item) => item.id);

export const DEFAULT_OCTAVE = 3;

/** Bass sits one octave under the other instruments. The slider can move it later. */
export function defaultOctaves() {
  return {
    pad: DEFAULT_OCTAVE,
    bass: DEFAULT_OCTAVE - 1,
    organ: DEFAULT_OCTAVE,
    kalimba: DEFAULT_OCTAVE,
    synth: DEFAULT_OCTAVE,
  };
}

/** Root of the octave this instrument usually sounds in. Bass defaults to C2, the others to C3. */
export function instrumentHomeMidi(root, octave) {
  const name = NOTE_NAMES.includes(root) ? root : 'C';
  const register = Math.min(6, Math.max(1, Math.round(Number(octave)) || DEFAULT_OCTAVE));
  return noteNameToMidi(name, register);
}
/** One bar is 16 sixteenths. Loops are only 1, 2 or 4 bars, and they start at 2. */
export const LOOP_STEPS = 32;
export const LOOP_STEPS_MAX = 64;
const LOOP_CYCLE = [32, 64, 16];

export function normalizeLoopSteps(steps) {
  const bars = Math.round((Number(steps) || LOOP_STEPS) / 16);
  if (bars >= 3) return 64;
  if (bars <= 1) return 16;
  return 32;
}

/** 2 bars → 4 → 1 → 2. The button shows the length before the tap. */
export function nextLoopSteps(steps) {
  const current = normalizeLoopSteps(steps);
  const index = LOOP_CYCLE.indexOf(current);
  return LOOP_CYCLE[(index < 0 ? 0 : index + 1) % LOOP_CYCLE.length];
}

export function barCountLabel(steps) {
  const bars = normalizeLoopSteps(steps) / 16;
  return bars === 1 ? '1 bar' : `${bars} bars`;
}

/**
 * When a loop note should fire. Transport bar 0 is bar 1 of the loop, so a
 * strip at the start of the grid sounds on the first pass. `nowTicks` only
 * pushes a missed step to the next cycle; it does not shift the phase.
 */
export function loopEventTicks(step, loopSteps, nowTicks = 0, ppq = 192) {
  const bars = Math.max(1, Math.round(normalizeLoopSteps(loopSteps) / 16));
  const ticksPerBar = ppq * 4;
  const safeStep = Math.max(0, Math.round(Number(step) || 0));
  const barOffset = Math.floor(safeStep / 16) % bars;
  const local = safeStep % 16;
  const loopTicks = bars * ticksPerBar;
  let startTicks = barOffset * ticksPerBar + local * (ppq / 4);
  const now = Math.max(0, Number(nowTicks) || 0);
  if (startTicks < now) {
    startTicks += (Math.floor((now - startTicks) / loopTicks) + 1) * loopTicks;
  }
  return {
    startTicks,
    bars,
    beat: Math.floor(local / 4),
    sixteenth: local % 4,
  };
}

const A4_MIDI = 69;
const A4_HZ = 440;

/** Scale degrees stacked on the chord root. Every step stays inside the host scale. */
const EXTENSION_DEGREES = {
  triad: [0, 2, 4],
  sus2: [0, 1, 4],
  sus4: [0, 3, 4],
  seventh: [0, 2, 4, 6],
  ninth: [0, 2, 4, 6, 8],
};

const CHORD_SYMBOLS = {
  '0,4,7': (root) => `${root} Maj`,
  '0,3,7': (root) => `${root}m`,
  '0,3,6': (root) => `${root}dim`,
  '0,4,8': (root) => `${root}aug`,
  '0,2,7': (root) => `${root} sus2`,
  '0,5,7': (root) => `${root} sus4`,
  '0,7': (root) => `${root}5`,
  '0,4,7,11': (root) => `${root}maj7`,
  '0,3,7,10': (root) => `${root}m7`,
  '0,4,7,10': (root) => `${root}7`,
  '0,3,6,10': (root) => `${root}m7b5`,
  '0,4,7,9': (root) => `${root}6`,
  '0,3,7,9': (root) => `${root}m6`,
  '0,2,4,7,11': (root) => `${root}maj9`,
  '0,2,3,7,10': (root) => `${root}m9`,
  '0,2,4,7,10': (root) => `${root}9`,
  '0,2,3,6,10': (root) => `${root}m9b5`,
  '0,2,4,7': (root) => `${root} add9`,
  '0,2,3,7': (root) => `${root}m add9`,
};

/** Equal temperament, exact: f = 440 · 2^((m − 69) / 12). */
export function midiToFrequency(midi) {
  return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
}

export function noteNameToMidi(name, octave) {
  const index = NOTE_NAMES.indexOf(name);
  if (index < 0) throw new RangeError(`Unknown note name: ${name}`);
  return (octave + 1) * 12 + index;
}

export function midiToName(midi) {
  const rounded = Math.round(midi);
  const pc = mod12(rounded);
  const octave = Math.floor(rounded / 12) - 1;
  return `${NOTE_NAMES[pc]}${octave}`;
}

function mod12(value) {
  return ((value % 12) + 12) % 12;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

/** Degree → midi, wrapping octaves so the scale keeps climbing past its last step. */
export function scaleDegreeToMidi(rootMidi, scale, degree) {
  const steps = SCALES[scale] ?? SCALES.major;
  const octave = Math.floor(degree / steps.length);
  const index = ((degree % steps.length) + steps.length) % steps.length;
  return rootMidi + steps[index] + octave * 12;
}

export function scalePitchClasses(root, scale) {
  const rootPc = NOTE_NAMES.indexOf(root);
  const steps = SCALES[scale] ?? SCALES.major;
  return new Set(steps.map((step) => mod12(rootPc + step)));
}

export function midiInScale(midi, root, scale) {
  const pc = mod12(Math.round(Number(midi)));
  return scalePitchClasses(root, scale).has(pc);
}

/**
 * Chords mode, bottom → top: triad, sus2, sus4, seventh, ninth.
 * The split inside the sus band is how both suspensions stay reachable.
 */
export function extensionFromY(y) {
  const clamped = clamp01(y);
  if (clamped < 0.25) return 'triad';
  if (clamped < 0.375) return 'sus2';
  if (clamped < 0.5) return 'sus4';
  if (clamped < 0.75) return 'seventh';
  return 'ninth';
}

export function normalizeInstrument(instrument) {
  if (instrument === 'piano') return 'synth';
  return INSTRUMENT_IDS.includes(instrument) ? instrument : 'pad';
}

/**
 * Letter name of whatever will actually sound. `rootMidi` is the scale-degree
 * root (an inversion stays Am7, not a new chord).
 */
export function chordLabel(rootMidi, midis) {
  const rootName = NOTE_NAMES[mod12(rootMidi)];
  const intervals = [...new Set(midis.map((midi) => mod12(midi - rootMidi)))].sort((a, b) => a - b);
  const named = CHORD_SYMBOLS[intervals.join(',')];
  if (named) return named(rootName);
  const heard = [];
  const seen = new Set();
  const push = (name) => {
    if (!seen.has(name)) {
      seen.add(name);
      heard.push(name);
    }
  };
  if (midis.some((midi) => mod12(midi) === mod12(rootMidi))) push(rootName);
  for (const midi of midis) push(NOTE_NAMES[mod12(midi)]);
  return heard.join(' ');
}

/**
 * The one mapping from a finger to a label and to the notes that will sound.
 * Host playback and the guest caption both call this.
 * Bass is always one scale degree. Its register is the octave passed in,
 * which defaults an octave below the other instruments.
 */
function storedDegree(degree) {
  if (degree == null || degree === '') return undefined;
  const number = Number(degree);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(48, Math.max(-24, Math.round(number)));
}

/** Exact piano-roll pitch. Scale degree is not a substitute for C versus D#. */
function storedMidi(midi) {
  if (midi == null || midi === '') return undefined;
  const number = Number(midi);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(127, Math.max(0, Math.round(number)));
}

export function resolveGesture({
  x = 0.5,
  y = 0.5,
  mode = 'single',
  root = 'C',
  scale = 'major',
  octave,
  range = 12,
  instrument = 'pad',
  direction = 'down',
  degree,
  midi,
} = {}) {
  const safeInstrument = normalizeInstrument(instrument);
  const exactMidi = storedMidi(midi);
  if (exactMidi != null) {
    const frequency = midiToFrequency(exactMidi);
    return {
      label: midiToName(exactMidi),
      extension: null,
      degree: storedDegree(degree) ?? 0,
      mode: 'single',
      instrument: safeInstrument,
      direction: direction === 'up' ? 'up' : 'down',
      stringed: false,
      harmonicRoot: exactMidi,
      harmonicMidis: [exactMidi],
      soundingMidis: [exactMidi],
      notes: [{ frequency }],
      frequencies: [frequency],
    };
  }
  const safeMode = mode === 'chords' ? 'chords' : 'single';
  const register = Number.isFinite(Number(octave))
    ? Number(octave)
    : safeInstrument === 'bass'
      ? DEFAULT_OCTAVE - 1
      : DEFAULT_OCTAVE;
  const rootMidi = noteNameToMidi(root, register);
  const explicitDegree = storedDegree(degree);
  const resolvedDegree = explicitDegree == null
    ? Math.min(range - 1, Math.max(0, Math.floor(clamp01(x) * range)))
    : explicitDegree;
  const degreeValue = resolvedDegree;
  const extension = safeMode === 'chords' ? extensionFromY(y) : null;
  const harmonicRoot = scaleDegreeToMidi(rootMidi, scale, degreeValue);
  const harmonicMidis =
    safeMode === 'chords'
      ? EXTENSION_DEGREES[extension].map((offset) => scaleDegreeToMidi(rootMidi, scale, degreeValue + offset))
      : [harmonicRoot];

  const bass = safeInstrument === 'bass';
  const placements = bass ? [{ midi: harmonicRoot }] : harmonicMidis.map((midi) => ({ midi }));

  const soundingMidis = placements.map((note) => note.midi);
  const label = !bass && safeMode === 'chords' ? chordLabel(harmonicRoot, soundingMidis) : midiToName(soundingMidis[0]);

  return {
    label,
    extension: bass ? null : extension,
    degree: degreeValue,
    mode: safeMode,
    instrument: safeInstrument,
    direction: direction === 'up' ? 'up' : 'down',
    stringed: false,
    harmonicRoot,
    harmonicMidis: bass ? [harmonicRoot] : harmonicMidis,
    soundingMidis,
    notes: placements.map((note) => ({
      index: note.index,
      frequency: midiToFrequency(note.midi),
    })),
    frequencies: placements.map((note) => midiToFrequency(note.midi)),
  };
}

/** Scale degrees of a chord, root first. Bass and single notes stay one degree. */
export function chordToneDegrees(gesture) {
  if (!gesture || gesture.instrument === 'bass' || gesture.mode !== 'chords') {
    return [gesture?.degree ?? 0];
  }
  const offsets = EXTENSION_DEGREES[gesture.extension] ?? EXTENSION_DEGREES.triad;
  return offsets.map((offset) => gesture.degree + offset);
}

/**
 * Scale degree whose sounding pitch is closest to `targetMidi`.
 * A tie keeps the degree in the drag direction, so G4 can move to A4 or F4.
 * Live pad touches omit degree and stay inside the 12-column range.
 */
export function pitchChoice(targetMidi, { root, scale, octave, instrument, mode, y, prefer } = {}) {
  const wanted = Math.round(Number(targetMidi));
  const lean = prefer === 'up' || prefer === 'down' ? prefer : null;
  let best = null;
  for (let degree = -12; degree <= 36; degree += 1) {
    const gesture = resolveGesture({
      x: 0.5,
      y,
      mode,
      root,
      scale,
      octave,
      instrument,
      degree,
    });
    const sounding = gesture.soundingMidis?.[0];
    if (!Number.isFinite(sounding)) continue;
    const distance = Math.abs(sounding - wanted);
    const higherTie = distance === best?.distance && distance > 0 && lean === 'up' && degree > best.degree;
    const lowerTie = distance === best?.distance && distance > 0 && lean === 'down' && degree < best.degree;
    if (!best || distance < best.distance || higherTie || lowerTie) {
      best = {
        degree,
        x: Math.min(0.96, Math.max(0.04, (Math.max(0, degree) + 0.04) / 12)),
        sounding,
        distance,
      };
    }
  }
  return best ?? { degree: 0, x: 0.04, sounding: wanted, distance: Infinity };
}

function samePitchSet(left, right) {
  if (!left || left.length !== right.length) return false;
  const a = [...left].sort((x, y) => x - y);
  const b = [...right].sort((x, y) => x - y);
  return a.every((frequency, index) => Math.abs(frequency - b[index]) < 0.5);
}

/** Short enough that a new chord does not sit under the previous pad tail. */
const CHOKE_RELEASE = 0.04;
/** Ignore a bass end that is only a scheduling hair past `now`. One 16th is longer than this. */
const BASS_END_SLACK = 0.02;

/**
 * Which held bass note should sound after the current one stops.
 * Notes whose end is already past are skipped. The latest remaining end wins.
 * A finger that is still down has `until: Infinity`.
 */
export function bassResumeId(notes, now) {
  let bestId = null;
  let bestUntil = -Infinity;
  let bestSeq = -1;
  const cutoff = (Number.isFinite(Number(now)) ? Number(now) : 0) + BASS_END_SLACK;
  for (const note of notes) {
    const until = note?.until;
    if (!(until > cutoff)) continue;
    const seq = note.seq ?? 0;
    if (until > bestUntil || (until === bestUntil && seq >= bestSeq)) {
      bestId = note.id;
      bestUntil = until;
      bestSeq = seq;
    }
  }
  return bestId;
}

function sameDegreeSet(left, right) {
  if (!left?.length || left.length !== right.length) return false;
  const a = [...left].sort((x, y) => x - y);
  const b = [...right].sort((x, y) => x - y);
  return a.every((degree, index) => degree === b[index]);
}

/** Column or stored degree. Two finger positions in one column are the same note. */
function storedPitchKey(event) {
  if (event?.degree != null && event.degree !== '' && Number.isFinite(Number(event.degree))) {
    return `d:${Math.round(Number(event.degree))}`;
  }
  const x = Math.min(1, Math.max(0, Number(event?.x) || 0));
  return `x:${Math.floor(x * 12)}:${normalizeInstrument(event?.instrument)}`;
}

function segmentVoice(voiceId) {
  const marker = '@@';
  const at = String(voiceId).lastIndexOf(marker);
  if (at < 0) return null;
  const step = Number(voiceId.slice(at + marker.length));
  if (!Number.isFinite(step)) return null;
  return { base: voiceId.slice(0, at), step };
}

function createSustainedVoice(tone, SynthClass, options, destination, polyphony) {
  const synth = new tone.PolySynth(SynthClass, options).connect(destination);
  synth.maxPolyphony = polyphony;
  const releaseTime = options.envelope?.release ?? 0.2;
  return {
    kind: 'sustain',
    trigger(frequencies, time, velocity, strumSeconds) {
      frequencies.forEach((frequency, index) => {
        synth.triggerAttack(frequency, time + index * strumSeconds, velocity);
      });
    },
    release(frequencies, time) {
      if (frequencies?.length) synth.triggerRelease(frequencies, time ?? tone.now());
    },
    choke(frequencies, time) {
      if (!frequencies?.length) return;
      const when = Number.isFinite(time) ? time : tone.now();
      synth.set({ envelope: { release: CHOKE_RELEASE } });
      synth.triggerRelease(frequencies, when);
      synth.set({ envelope: { release: releaseTime } });
    },
    silence() {
      try {
        synth.releaseAll();
      } catch {
        // The voice was already quiet.
      }
    },
    warmUp() {},
    dispose() {
      synth.releaseAll();
      synth.dispose();
    },
  };
}

/**
 * One bass voice for the whole instrument. A new pitch always retriggers.
 * TouchSynth decides when a covered note comes back; this node does not glide.
 */
function createMonoVoice(tone, options, destination) {
  const synth = new tone.Synth(options).connect(destination);
  let on = false;
  return {
    kind: 'mono',
    trigger(frequencies, time, velocity) {
      const when = Number.isFinite(time) ? time : tone.now();
      const frequency = frequencies.find((value) => value > 0);
      if (!(frequency > 0)) return;
      synth.triggerAttack(frequency, when, velocity);
      on = true;
    },
    release(_frequencies, time) {
      if (!on) return;
      synth.triggerRelease(Number.isFinite(time) ? time : tone.now());
      on = false;
    },
    silence() {
      if (!on) return;
      try {
        synth.triggerRelease(tone.now());
      } catch {
        // The oscillator had already stopped.
      }
      on = false;
    },
    warmUp() {},
    dispose() {
      synth.dispose();
    },
  };
}

/**
 * One oscillator per held finger. A new pitch retriggers that finger.
 * Voices are allocated once, never on instrument change.
 */
function createGlideVoice(tone, options, destination, polyphony) {
  const free = [];
  const pool = Array.from({ length: polyphony }, () => {
    const synth = new tone.Synth(options).connect(destination);
    const slot = { synth, on: false };
    free.push(slot);
    return slot;
  });
  const held = new Map();

  function releaseSlot(slot, when) {
    if (!slot?.on) return;
    slot.synth.triggerRelease(when);
    slot.on = false;
    free.push(slot);
  }

  function chokeSlot(slot, when) {
    if (!slot?.on) return;
    const envelope = slot.synth.envelope;
    const previous = envelope.release;
    envelope.release = CHOKE_RELEASE;
    slot.synth.triggerRelease(when);
    envelope.release = previous;
    slot.on = false;
    free.push(slot);
  }

  return {
    kind: 'sustain',
    trigger(frequencies, time, velocity, _strum, { id = 'default' } = {}) {
      const when = Number.isFinite(time) ? time : tone.now();
      let slots = held.get(id);
      if (slots) {
        for (const slot of slots) releaseSlot(slot, when);
      }
      slots = [];
      held.set(id, slots);
      frequencies.forEach((frequency) => {
        const slot = free.pop();
        if (!slot || !(frequency > 0)) return;
        slot.synth.triggerAttack(frequency, when, velocity);
        slot.on = true;
        slots.push(slot);
      });
    },
    release(_frequencies, time, id = 'default') {
      const when = Number.isFinite(time) ? time : tone.now();
      const slots = held.get(id);
      if (!slots) return;
      for (const slot of slots) releaseSlot(slot, when);
      held.delete(id);
    },
    choke(_frequencies, time, id = 'default') {
      const when = Number.isFinite(time) ? time : tone.now();
      const slots = held.get(id);
      if (!slots) return;
      for (const slot of slots) chokeSlot(slot, when);
      held.delete(id);
    },
    silence() {
      const when = tone.now();
      for (const slots of held.values()) {
        for (const slot of slots) releaseSlot(slot, when);
      }
      held.clear();
    },
    warmUp() {},
    dispose() {
      for (const slot of pool) slot.synth.dispose();
    },
  };
}

export class TouchSynth {
  #tone;
  #voices;
  #output;
  #root = 'C';
  #octave = DEFAULT_OCTAVE;
  #octaves = defaultOctaves();
  #scale = 'major';
  #mode = 'single';
  #range = 12;
  #strumMs = 28;
  /** @type {Map<string, { instrument: string, frequencies: number[], direction: string, y: number }>} */
  #active = new Map();
  /** Bass notes that are still held. A shorter note can cover a longer one; the longer one stays here. */
  #bassNotes = new Map();
  /** Id of the bass note currently driving the mono oscillator. */
  #bassLead = null;
  #bassSerial = 0;
  /** Chord fingers already cut by a newer chord. A slide inside that same chord must not restart it. */
  #chopped = new Map();

  constructor(engine, bus, { root = 'C', octave = DEFAULT_OCTAVE, scale = 'major', mode = 'single' } = {}) {
    this.#tone = engine.tone;
    this.#output = bus.mix;
    const inputs = bus.inputs;
    this.#voices = {
      pad: createGlideVoice(
        this.#tone,
        {
          oscillator: { type: 'fatsine', count: 3, spread: 18 },
          envelope: { attack: 0.42, decay: 0.5, sustain: 0.72, release: 2.2 },
          volume: -7,
        },
        inputs.pad,
        16,
      ),
      bass: createMonoVoice(
        this.#tone,
        {
          oscillator: { type: 'fatsawtooth', count: 2, spread: 12 },
          envelope: { attack: 0.01, decay: 0.18, sustain: 0.75, release: 0.28 },
          volume: -6,
        },
        inputs.bass,
      ),
      organ: createSustainedVoice(
        this.#tone,
        this.#tone.Synth,
        {
          oscillator: { type: 'sine4' },
          envelope: { attack: 0.012, decay: 0.08, sustain: 0.9, release: 0.16 },
          volume: -12,
        },
        inputs.organ,
        16,
      ),
      kalimba: createSustainedVoice(
        this.#tone,
        this.#tone.FMSynth,
        {
          harmonicity: 8,
          modulationIndex: 1.4,
          oscillator: { type: 'sine' },
          envelope: { attack: 0.001, decay: 0.32, sustain: 0, release: 0.18 },
          modulation: { type: 'triangle' },
          modulationEnvelope: { attack: 0.001, decay: 0.14, sustain: 0, release: 0.1 },
          volume: 1,
        },
        inputs.kalimba,
        8,
      ),
      synth: createGlideVoice(
        this.#tone,
        {
          oscillator: { type: 'triangle' },
          envelope: { attack: 0.005, decay: 0.4, sustain: 0.55, release: 0.5 },
          volume: -1,
        },
        inputs.synth,
        12,
      ),
    };
    this.#root = root;
    this.#octave = octave;
    this.#octaves = defaultOctaves();
    if (octave !== DEFAULT_OCTAVE) {
      for (const id of Object.keys(this.#octaves)) {
        this.#octaves[id] = id === 'bass' ? Math.max(1, octave - 1) : octave;
      }
    }
    this.#scale = scale;
    this.#mode = mode;
  }

  get output() {
    return this.#output;
  }

  get settings() {
    return {
      root: this.#root,
      octave: this.#octave,
      scale: this.#scale,
      mode: this.#mode,
      strumMs: this.#strumMs,
      range: this.#range,
    };
  }

  setRoot(note) {
    if (NOTE_NAMES.includes(note)) this.#root = note;
    return this.#root;
  }

  setOctave(octave) {
    this.#octave = Math.min(6, Math.max(1, Number(octave) || DEFAULT_OCTAVE));
    return this.#octave;
  }

  setInstrumentOctave(instrument, octave) {
    const id = normalizeInstrument(instrument);
    const next = Math.min(6, Math.max(1, Math.round(Number(octave) || DEFAULT_OCTAVE)));
    this.#octaves[id] = next;
    return next;
  }

  get octaves() {
    return { ...this.#octaves };
  }

  setScale(scale) {
    if (SCALES[scale]) this.#scale = scale;
    return this.#scale;
  }

  setMode(mode) {
    if (PLAY_MODES.includes(mode)) this.#mode = mode;
    return this.#mode;
  }

  setStrum(ms) {
    this.#strumMs = Math.min(200, Math.max(0, Number(ms) || 0));
    return this.#strumMs;
  }

  /** X (0…1) → frequencies for the current harmony. Chord tones come from the scale. */
  frequenciesForX(x, mode = this.#mode) {
    return resolveGesture({
      x,
      y: 0,
      mode,
      root: this.#root,
      scale: this.#scale,
      octave: this.#octave,
      range: this.#range,
    }).frequencies;
  }

  describe(touch) {
    return this.#resolve(touch);
  }

  #resolve(touch) {
    const instrument = normalizeInstrument(touch.instrument);
    return resolveGesture({
      x: touch.x,
      y: touch.y,
      mode: touch.mode ?? this.#mode,
      root: this.#root,
      scale: this.#scale,
      octave: this.#octaves[instrument] ?? this.#octave,
      range: this.#range,
      instrument: touch.instrument,
      direction: touch.direction,
      degree: touch.degree,
      midi: touch.midi,
    });
  }

  /** Pad chords sit a little under the mix. A single pad note sits a little above. */
  #velocity(gesture, y) {
    const base = gesture.mode === 'chords' ? 0.82 : 0.35 + clamp01(y) * 0.55;
    if (gesture.instrument !== 'pad') return base;
    const shaped = gesture.mode === 'chords' ? base * 0.72 : base * 1.18;
    return Math.min(1, shaped);
  }

  /**
   * Nodes already exist. This does not play a chord or a pluck: a test note
   * here is what barked when audio started or when a string voice was built.
   */
  warmUp() {
    for (const voice of Object.values(this.#voices)) voice.warmUp();
    return Object.keys(this.#voices).length;
  }

  #isChord(gesture) {
    return gesture?.mode === 'chords' && gesture.instrument !== 'bass' && gesture.frequencies?.length > 1;
  }

  #bassList() {
    const notes = [];
    for (const [id, note] of this.#bassNotes) notes.push({ id, ...note });
    return notes;
  }

  /** Take the mono bass oscillator. Other held bass notes stay in the map. */
  #bassTake(id, frequencies, velocity, until, when) {
    this.#bassSerial += 1;
    const end = Number.isFinite(Number(until)) ? Number(until) : Infinity;
    this.#bassNotes.set(id, { frequencies, velocity, until: end, seq: this.#bassSerial });
    this.#bassLead = id;
    this.#voices.bass.trigger(frequencies, when, velocity);
  }

  /** After the lead bass note stops, sound the held note that ends latest, or go quiet. */
  #bassFallback(when) {
    const nextId = bassResumeId(this.#bassList(), when);
    if (!nextId) {
      this.#bassLead = null;
      this.#voices.bass.release([], when);
      return;
    }
    const note = this.#bassNotes.get(nextId);
    this.#bassLead = nextId;
    this.#voices.bass.trigger(note.frequencies, when, note.velocity);
  }

  /** Cut one chord voice without its long release tail. */
  #chokeVoice(id, when) {
    const active = this.#active.get(id);
    if (!active?.chordGroup) return false;
    this.#voices[active.instrument]?.choke?.(active.frequencies, when, id);
    this.#chopped.set(id, { instrument: active.instrument, frequencies: active.frequencies });
    this.#active.delete(id);
    return true;
  }

  /** A new live chord cuts other fingers on the same instrument. Loop notes follow the roll. */
  #chokeOthers(instrument, group, when) {
    for (const [otherId, active] of [...this.#active.entries()]) {
      if (active.instrument !== instrument || !active.chordGroup || active.chordGroup === group) continue;
      if (String(otherId).startsWith('loop:')) continue;
      this.#chokeVoice(otherId, when);
    }
  }

  /**
   * @param {{ id?: string, x: number, y: number, mode?: string, instrument?: string, direction?: string, time?: number, chordGroup?: string }} touch
   * @returns {ReturnType<typeof resolveGesture>}
   */
  attack(touch = {}) {
    const id = touch.id ?? 'default';
    const when = touch.time ?? this.#tone.now();
    const gesture = this.#resolve(touch);
    const voice = this.#voices[gesture.instrument];
    if (touch.chordGroup || this.#isChord(gesture)) {
      const group = touch.chordGroup || id;
      if (!touch.chordGroup) this.#chokeOthers(gesture.instrument, group, when);
      const mine = this.#active.get(id);
      if (mine?.chordGroup) this.#chokeVoice(id, when);
      else if (mine) this.release(id, when);
      this.#chopped.delete(id);
      voice.trigger(gesture.frequencies, when, this.#velocity(gesture, touch.y), 0, { id });
      this.#active.set(id, {
        instrument: gesture.instrument,
        frequencies: gesture.frequencies,
        direction: gesture.direction,
        y: clamp01(touch.y),
        chordGroup: group,
      });
      return gesture;
    }
    if (gesture.instrument === 'bass') {
      const mine = this.#active.get(id);
      if (mine && mine.instrument !== 'bass') this.release(id, when);
      const velocity = this.#velocity(gesture, touch.y);
      this.#bassTake(id, gesture.frequencies, velocity, touch.until, when);
      this.#active.set(id, {
        instrument: gesture.instrument,
        frequencies: gesture.frequencies,
        direction: gesture.direction,
        y: clamp01(touch.y),
      });
      return gesture;
    }
    this.release(id, when);
    voice.trigger(gesture.frequencies, when, this.#velocity(gesture, touch.y), 0, { id });
    this.#active.set(id, {
      instrument: gesture.instrument,
      frequencies: gesture.frequencies,
      direction: gesture.direction,
      y: clamp01(touch.y),
    });
    return gesture;
  }

  /** Re-pitches a held touch when the finger slides to another note or chord. */
  move(touch = {}) {
    const id = touch.id ?? 'default';
    const gesture = this.#resolve(touch);
    const chopped = this.#chopped.get(id);
    if (chopped) {
      if (chopped.instrument === gesture.instrument && samePitchSet(chopped.frequencies, gesture.frequencies)) return gesture;
      this.#chopped.delete(id);
      return this.attack(touch);
    }
    const current = this.#active.get(id);
    if (!current) return this.attack(touch);
    const sameNotes = current.instrument === gesture.instrument && samePitchSet(current.frequencies, gesture.frequencies);
    if (sameNotes) return gesture;
    if (gesture.instrument === 'bass' && current.instrument === 'bass' && this.#bassNotes.has(id)) {
      const when = touch.time ?? this.#tone.now();
      const velocity = this.#velocity(gesture, touch.y);
      const held = this.#bassNotes.get(id);
      held.frequencies = gesture.frequencies;
      held.velocity = velocity;
      this.#active.set(id, {
        instrument: 'bass',
        frequencies: gesture.frequencies,
        direction: gesture.direction,
        y: clamp01(touch.y),
      });
      if (this.#bassLead === id) this.#voices.bass.trigger(gesture.frequencies, when, velocity);
      return gesture;
    }
    return this.attack(touch);
  }

  /** Drop a chord voice immediately. Used when a newer chord of the same instrument starts. */
  choke(id = 'default', time) {
    const active = this.#active.get(id);
    this.#chopped.delete(id);
    if (!active) return false;
    if (active.instrument === 'bass') return this.release(id, time);
    const when = time ?? this.#tone.now();
    const voice = this.#voices[active.instrument];
    if (voice?.choke) voice.choke(active.frequencies, when, id);
    else voice?.release(active.frequencies, when, id);
    this.#active.delete(id);
    return true;
  }

  release(id = 'default', time) {
    this.#chopped.delete(id);
    const active = this.#active.get(id);
    if (!active) {
      this.#bassNotes.delete(id);
      return false;
    }
    const when = time ?? this.#tone.now();
    if (active.instrument === 'bass') {
      this.#active.delete(id);
      this.#bassNotes.delete(id);
      if (this.#bassLead === id) this.#bassFallback(when);
      return true;
    }
    this.#voices[active.instrument]?.release(active.frequencies, when, id);
    this.#active.delete(id);
    return true;
  }

  /** Drop every voice whose id starts with `prefix` (a guest disconnecting, for example). */
  releaseMatching(prefix, time) {
    const when = time ?? this.#tone.now();
    let bassLeadCleared = false;
    for (const id of [...this.#active.keys()]) {
      if (!String(id).startsWith(prefix)) continue;
      const active = this.#active.get(id);
      this.#active.delete(id);
      this.#chopped.delete(id);
      if (active?.instrument === 'bass') {
        this.#bassNotes.delete(id);
        if (this.#bassLead === id) {
          this.#bassLead = null;
          bassLeadCleared = true;
        }
        continue;
      }
      this.#voices[active.instrument]?.release(active.frequencies, when, id);
    }
    if (bassLeadCleared) this.#bassFallback(when);
  }

  releaseAll() {
    for (const id of [...this.#active.keys()]) this.release(id);
    for (const voice of Object.values(this.#voices)) {
      if (voice.kind === 'sustain') voice.release([], this.#tone.now());
    }
  }

  /** Drop every oscillator, including ones the finger map no longer knows about. */
  silence() {
    this.#active.clear();
    this.#bassNotes.clear();
    this.#bassLead = null;
    this.#chopped.clear();
    for (const voice of Object.values(this.#voices)) voice.silence?.();
  }

  dispose() {
    this.releaseAll();
    for (const voice of Object.values(this.#voices)) voice.dispose();
  }
}

/** Snap a transport time onto the nearest step boundary. */
export function quantizeToStep(seconds, stepSeconds) {
  if (!(stepSeconds > 0)) return 0;
  return Math.round(seconds / stepSeconds) * stepSeconds;
}

/**
 * One player's live loop. Events are quantised onto the Tone.Transport
 * 16th-note grid and armed with scheduleRepeat, so the layer stays locked to
 * the drum machine without setTimeout. Each new take stacks; clear wipes only
 * this player.
 */
export class PerformanceRecorder {
  #synth;
  #tone;
  #playerId;
  #onPlayback;
  #events = [];
  #byKey = new Map();
  #takes = new Map();
  #attackStep = new Map();
  #chordTakes = new Map();
  #chordGen = new Map();
  /** Finger take → the note strip currently being held. A new pitch starts a new strip. */
  #line = new Map();
  #recording = false;
  #scheduled = [];

  #loopSteps = LOOP_STEPS;
  #placed = 0;

  constructor(engine, synth, { playerId = 'host', onPlayback, loopSteps = LOOP_STEPS } = {}) {
    this.#tone = engine.tone;
    this.#synth = synth;
    this.#playerId = playerId;
    this.#onPlayback = onPlayback;
    this.#loopSteps = normalizeLoopSteps(loopSteps);
  }

  get playerId() {
    return this.#playerId;
  }

  get isRecording() {
    return this.#recording;
  }

  get length() {
    return this.#events.length;
  }

  get scheduledCount() {
    return this.#scheduled.length;
  }

  /** Length of one 16th note at the current tempo, in seconds. */
  get stepSeconds() {
    return this.#tone.Time('16n').toSeconds();
  }

  get loopSteps() {
    return this.#loopSteps;
  }

  /**
   * Grow or set the note loop. Existing notes stay on their steps and the
   * repeat becomes the new length, so a longer loop does not retrigger them
   * every old bar.
   */
  setLoopSteps(steps) {
    const next = normalizeLoopSteps(steps);
    if (next === this.#loopSteps) return this.#loopSteps;
    this.#loopSteps = next;
    const sounding = new Set();
    for (const event of this.#events) {
      if (event.type === 'on' && event.step < next) sounding.add(event.voiceId);
    }
    this.#events = this.#events.filter(
      (event) => event.step < next && (event.type === 'on' || sounding.has(event.voiceId)),
    );
    this.#byKey = new Map(this.#events.map((event) => [`${event.voiceId}:${event.step}:${event.type}`, event]));
    for (const voiceId of [...this.#attackStep.keys()]) {
      if (!sounding.has(voiceId)) this.#attackStep.delete(voiceId);
    }
    for (const [finger, members] of this.#chordTakes) {
      const kept = members.filter((id) => this.#events.some((event) => event.voiceId === id));
      if (kept.length) this.#chordTakes.set(finger, kept);
      else this.#chordTakes.delete(finger);
    }
    this.#rearmAll();
    return this.#loopSteps;
  }

  get events() {
    const step = this.stepSeconds;
    return this.#events.map((event) => ({
      ...event,
      at: event.step * step,
    }));
  }

  start() {
    this.#recording = true;
  }

  stop() {
    this.#recording = false;
  }

  /**
   * Keep one note-on per voice per grid step (the last finger position in that
   * step wins). The event joins the loop on the next bar and repeats every bar.
   */
  capture(event) {
    if (!this.#recording) return false;
    const transport = this.#tone.getTransport();
    const ticksPerStep = (transport.PPQ || 192) / 4;
    let step = Math.round(transport.ticks / ticksPerStep) % this.#loopSteps;
    if (step < 0) step += this.#loopSteps;

    if (event.type === 'down') {
      this.#takes.set(event.id, (this.#takes.get(event.id) ?? 0) + 1);
    }
    const take = this.#takes.get(event.id) ?? 1;
    const voiceId = `${event.id}#${take}`;
    const chord = this.#chordDegrees(event);
    if (chord) return this.#captureChord(event, step, voiceId, chord);

    const heard = typeof this.#synth.describe === 'function' ? this.#synth.describe(event) : null;
    const degree = heard?.degree ?? event.degree;
    const pitched = { ...event, degree };
    if (event.type === 'up') {
      const segment = this.#line.get(voiceId) ?? voiceId;
      const attackStep = this.#attackStep.get(segment) ?? this.#attackStep.get(voiceId);
      let upStep = step;
      if (attackStep !== undefined && upStep === attackStep) upStep = (attackStep + 1) % this.#loopSteps;
      const ons = this.#events.filter((item) => item.voiceId === segment && item.type === 'on');
      const last = ons[ons.length - 1];
      if (last && storedPitchKey(last) !== storedPitchKey(pitched) && last.step !== upStep) {
        this.#put(this.#noteEvent(segment, upStep, 'up', last));
        const next = `${voiceId}~n${upStep}`;
        this.#line.set(voiceId, next);
        this.#attackStep.set(next, upStep);
        this.#put(this.#noteEvent(next, upStep, 'on', pitched));
        this.#put(this.#noteEvent(next, (upStep + 1) % this.#loopSteps, 'up', pitched));
        this.#line.delete(voiceId);
        return 'note';
      }
      if (last && storedPitchKey(last) !== storedPitchKey(pitched)) {
        this.#put(this.#noteEvent(segment, last.step, 'on', pitched));
      }
      this.#put(this.#noteEvent(segment, upStep, 'up', pitched));
      this.#line.delete(voiceId);
      return 'note';
    }

    const segment = this.#line.get(voiceId) ?? voiceId;
    const ons = this.#events.filter((item) => item.voiceId === segment && item.type === 'on');
    const last = ons[ons.length - 1];
    if (last && storedPitchKey(last) === storedPitchKey(pitched)) {
      if (last.step === step) this.#put(this.#noteEvent(segment, step, 'on', pitched));
      return false;
    }
    if (last && last.step !== step) {
      this.#put(this.#noteEvent(segment, step, 'up', last));
      const next = `${voiceId}~n${step}`;
      this.#line.set(voiceId, next);
      this.#attackStep.set(next, step);
      this.#put(this.#noteEvent(next, step, 'on', pitched));
      return 'note';
    }
    if (!this.#attackStep.has(segment)) this.#attackStep.set(segment, step);
    this.#line.set(voiceId, segment);
    this.#put(this.#noteEvent(segment, step, 'on', pitched));
    return 'note';
  }

  #noteEvent(voiceId, step, type, event) {
    return {
      voiceId,
      step,
      type,
      x: event.x,
      y: event.y,
      mode: 'single',
      instrument: normalizeInstrument(event.instrument),
      direction: event.direction === 'up' ? 'up' : 'down',
      degree: storedDegree(event.degree),
    };
  }

  #chordDegrees(event) {
    if (event.mode !== 'chords' || normalizeInstrument(event.instrument) === 'bass') return null;
    if (typeof this.#synth.describe !== 'function') return null;
    const gesture = this.#synth.describe(event);
    if (!gesture || gesture.mode !== 'chords' || gesture.instrument === 'bass') return null;
    const degrees = chordToneDegrees(gesture);
    return degrees.length > 1 ? degrees : null;
  }

  #captureChord(event, step, voiceId, degrees) {
    const instrument = normalizeInstrument(event.instrument);
    if (event.type === 'up') {
      const members = this.#chordTakes.get(voiceId) || [];
      if (!members.length) return false;
      const attackStep = this.#attackStep.get(voiceId);
      let upStep = step;
      if (attackStep !== undefined && upStep === attackStep) upStep = (attackStep + 1) % this.#loopSteps;
      for (const member of members) {
        const on = this.#events.find((item) => item.voiceId === member && item.type === 'on');
        this.#put({
          voiceId: member,
          step: upStep,
          type: 'up',
          x: event.x,
          y: event.y,
          mode: 'single',
          instrument,
          direction: event.direction === 'up' ? 'up' : 'down',
          degree: on?.degree,
          group: on?.group,
        });
      }
      this.#chordTakes.delete(voiceId);
      return 'chord';
    }
    const current = this.#chordTakes.get(voiceId) || [];
    const currentDegrees = [];
    for (const id of current) {
      const on = this.#events.find((item) => item.voiceId === id && item.type === 'on');
      if (on?.degree != null) currentDegrees.push(on.degree);
    }
    if (current.length && sameDegreeSet(currentDegrees, degrees)) return false;
    const sounding = this.#degreesCovering(instrument, step);
    if (!sameDegreeSet(sounding, degrees)) this.#chopChords(instrument, step);
    const generation = (this.#chordGen.get(voiceId) ?? 0) + 1;
    this.#chordGen.set(voiceId, generation);
    const group = `${voiceId}@${generation}`;
    const members = degrees.map((degree, index) => {
      const id = `${group}~${index}`;
      this.#put({
        voiceId: id,
        step,
        type: 'on',
        x: event.x,
        y: event.y,
        mode: 'single',
        instrument,
        direction: event.direction === 'up' ? 'up' : 'down',
        degree,
        group,
      });
      return id;
    });
    this.#chordTakes.set(voiceId, members);
    this.#attackStep.set(voiceId, step);
    return 'chord';
  }

  /** True when `step` falls inside a note that is still sounding. The end step itself is free. */
  #soundsAt(start, end, step) {
    if (end == null) return true;
    if (end === start) return false;
    if (end > start) return step > start && step < end;
    return step > start || step < end;
  }

  #degreesCovering(instrument, step) {
    const degrees = [];
    const seen = new Set();
    for (const event of this.#events) {
      if (event.type !== 'on' || !event.group) continue;
      if (normalizeInstrument(event.instrument) !== instrument) continue;
      if (seen.has(event.voiceId)) continue;
      seen.add(event.voiceId);
      const up = this.#events.find((item) => item.voiceId === event.voiceId && item.type === 'up');
      const active = event.step === step || this.#soundsAt(event.step, up ? up.step : null, step);
      if (!active || event.degree == null) continue;
      degrees.push(event.degree);
    }
    return degrees;
  }

  /** End still-sounding chord notes of this instrument where the new chord attacks. */
  #chopChords(instrument, step) {
    const voices = [];
    const seen = new Set();
    for (const event of this.#events) {
      if (!event.group || event.type !== 'on') continue;
      if (normalizeInstrument(event.instrument) !== instrument) continue;
      if (seen.has(event.voiceId)) continue;
      seen.add(event.voiceId);
      voices.push(event.voiceId);
    }
    for (const voiceId of voices) {
      const on = this.#events.find((event) => event.voiceId === voiceId && event.type === 'on');
      if (!on) continue;
      const up = this.#events.find((event) => event.voiceId === voiceId && event.type === 'up');
      const loopId = `loop:${this.#playerId}:${voiceId}`;
      if (on.step === step) {
        this.#synth.choke(loopId);
        this.#forgetVoice(voiceId);
        continue;
      }
      if (!this.#soundsAt(on.step, up ? up.step : null, step)) continue;
      this.#synth.choke(loopId);
      this.#setReleaseStep(voiceId, step);
    }
  }

  #disarm(event) {
    if (event.eventId == null) return;
    const transport = this.#tone.getTransport();
    transport.clear(event.eventId);
    const index = this.#scheduled.indexOf(event.eventId);
    if (index >= 0) this.#scheduled.splice(index, 1);
    event.eventId = null;
  }

  #setReleaseStep(voiceId, step) {
    const ons = this.#events.filter((event) => event.voiceId === voiceId && event.type === 'on');
    if (!ons.length) return;
    const start = Math.min(...ons.map((event) => event.step));
    if (start === step) {
      this.#forgetVoice(voiceId);
      return;
    }
    const up = this.#events.find((event) => event.voiceId === voiceId && event.type === 'up');
    if (up?.step === step) return;
    if (up) {
      this.#disarm(up);
      this.#byKey.delete(`${voiceId}:${up.step}:up`);
      up.step = step;
      this.#byKey.set(`${voiceId}:${step}:up`, up);
      this.#arm(up);
      return;
    }
    const template = ons[0];
    this.#put({
      voiceId,
      step,
      type: 'up',
      x: template.x,
      y: template.y,
      mode: template.mode,
      instrument: template.instrument,
      direction: template.direction,
      degree: template.degree,
      group: template.group,
    });
  }

  #cutByNewChord(event) {
    if (!event.group) return false;
    const instrument = normalizeInstrument(event.instrument);
    return this.#events.some((other) =>
      other.type === 'on'
      && other.group
      && other.group !== event.group
      && other.step === event.step
      && normalizeInstrument(other.instrument) === instrument,
    );
  }

  #put(event) {
    const key = `${event.voiceId}:${event.step}:${event.type}`;
    const existing = this.#byKey.get(key);
    if (existing) {
      existing.x = event.x;
      existing.y = event.y;
      existing.mode = event.mode;
      existing.instrument = event.instrument;
      existing.direction = event.direction;
      existing.degree = event.degree;
      existing.group = event.group;
      if (event.midi !== undefined) existing.midi = storedMidi(event.midi);
      return;
    }
    this.#byKey.set(key, event);
    this.#events.push(event);
    this.#arm(event);
  }

  #arm(event) {
    const transport = this.#tone.getTransport();
    const ppq = transport.PPQ || 192;
    const placed = loopEventTicks(event.step, this.#loopSteps, transport.ticks, ppq);
    const bar = Math.floor(placed.startTicks / (ppq * 4));
    const when = `${bar}:${placed.beat}:${placed.sixteenth}`;
    const eventId = transport.scheduleRepeat((time) => this.#perform(event, time), `${placed.bars}m`, when);
    event.eventId = eventId;
    this.#scheduled.push(eventId);
  }

  /** Schedule the loop again after the audio clock was parked. */
  rearm() {
    this.#rearmAll();
  }

  #rearmAll() {
    const transport = this.#tone.getTransport();
    for (const eventId of this.#scheduled) transport.clear(eventId);
    this.#scheduled = [];
    for (const event of this.#events) {
      event.eventId = null;
      this.#arm(event);
    }
  }

  /** Audio-clock time when this bass strip ends, matching the roll length. */
  #bassUntil(event, time) {
    if (normalizeInstrument(event.instrument) !== 'bass') return undefined;
    const up = this.#events.find((item) => item.voiceId === event.voiceId && item.type === 'up');
    let span = 1;
    if (up && up.step !== event.step) {
      span = up.step - event.step;
      if (span <= 0) span += this.#loopSteps;
    }
    span = Math.max(1, Math.min(this.#loopSteps, span));
    return time + span * this.stepSeconds;
  }

  #perform(event, time) {
    const id = `loop:${this.#playerId}:${event.voiceId}`;
    if (event.type === 'up') {
      if (this.#cutByNewChord(event)) this.#synth.choke(id, time);
      else this.#synth.release(id, time);
      this.#onPlayback?.({ ...event, type: 'up' }, null);
      return;
    }
    const gesture = this.#synth.attack({
      id,
      x: event.x,
      y: event.y,
      mode: event.mode,
      instrument: event.instrument,
      direction: event.direction,
      degree: event.degree,
      midi: event.midi,
      time,
      until: this.#bassUntil(event, time),
      chordGroup: event.group || undefined,
    });
    this.#onPlayback?.(event, gesture);
  }

  /**
   * One strip per pitch. A bass or pad slide used to keep every step on the
   * first note, so a later C disappeared behind the opening D#.
   */
  notes() {
    const groups = new Map();
    for (const event of this.#events) {
      let group = groups.get(event.voiceId);
      if (!group) {
        group = { ons: [], up: null };
        groups.set(event.voiceId, group);
      }
      if (event.type === 'on') group.ons.push(event);
      else group.up = event;
    }
    const rows = [];
    for (const [voiceId, group] of groups) {
      const segments = [];
      for (const on of group.ons) {
        const key = storedPitchKey(on);
        const previous = segments[segments.length - 1];
        if (previous?.key === key) continue;
        if (previous) previous.end = on.step;
        segments.push({ on, key, end: null });
      }
      if (!segments.length) continue;
      segments[segments.length - 1].end = group.up?.step ?? null;
      const split = segments.length > 1;
      for (const segment of segments) {
        const step = segment.on.step;
        let endStep = segment.end;
        if (endStep == null || endStep === step) endStep = (step + 1) % this.#loopSteps;
        rows.push({
          voiceId: split ? `${voiceId}@@${step}` : voiceId,
          x: segment.on.x,
          y: segment.on.y,
          instrument: segment.on.instrument,
          mode: segment.on.mode,
          degree: segment.on.degree,
          midi: segment.on.midi,
          step,
          endStep,
        });
      }
    }
    return rows.sort((a, b) => a.step - b.step || String(a.voiceId).localeCompare(String(b.voiceId)));
  }

  /** Plain note events for undo. No audio nodes and no buffers. */
  exportEvents() {
    return this.#events.map((event) => ({
      voiceId: event.voiceId,
      step: event.step,
      type: event.type,
      x: event.x,
      y: event.y,
      mode: event.mode,
      instrument: event.instrument,
      direction: event.direction,
      degree: event.degree,
      midi: event.midi,
      group: event.group,
    }));
  }

  restoreEvents(events) {
    const transport = this.#tone.getTransport();
    for (const eventId of this.#scheduled) transport.clear(eventId);
    this.#scheduled = [];
    this.#events = [];
    this.#byKey.clear();
    this.#attackStep.clear();
    this.#chordTakes.clear();
    this.#chordGen.clear();
    this.#line.clear();
    this.#synth.releaseMatching(`loop:${this.#playerId}:`);
    for (const event of events || []) {
      const step = Math.max(0, Math.min(this.#loopSteps - 1, Math.round(Number(event.step) || 0)));
      this.#put({
        voiceId: String(event.voiceId),
        step,
        type: event.type === 'up' ? 'up' : 'on',
        x: event.x,
        y: event.y,
        mode: event.mode,
        instrument: event.instrument,
        direction: event.direction === 'up' ? 'up' : 'down',
        degree: storedDegree(event.degree),
        midi: storedMidi(event.midi),
        group: event.group || undefined,
      });
    }
  }

  /**
   * A note that was not recorded. One step long, armed on the transport
   * like every other loop event.
   */
  addNote({ step, x, y, instrument, mode = 'single', direction = 'down', degree, midi } = {}) {
    const voiceId = `placed:${this.#playerId}:${this.#placed}`;
    this.#placed += 1;
    const start = Math.max(0, Math.min(this.#loopSteps - 1, Math.round(Number(step) || 0)));
    const end = (start + 1) % this.#loopSteps;
    const next = {
      x,
      y: Number.isFinite(Number(y)) ? Number(y) : 0.55,
      mode: mode === 'chords' ? 'chords' : 'single',
      instrument: normalizeInstrument(instrument),
      direction: direction === 'up' ? 'up' : 'down',
      degree: storedDegree(degree),
      midi: storedMidi(midi),
    };
    this.#put({ voiceId, step: start, type: 'on', ...next });
    this.#put({ voiceId, step: end, type: 'up', ...next });
    return voiceId;
  }

  /** Slide one recorded note in time and pitch. Pass `duration` to resize it. */
  moveNote(voiceId, change = {}) {
    const segment = segmentVoice(voiceId);
    if (segment) return this.#moveSegment(segment, change);
    const { step, x, degree, midi, duration: durationArg } = change;
    const mine = this.#events.filter((event) => event.voiceId === voiceId);
    const ons = mine.filter((event) => event.type === 'on');
    if (!ons.length) return false;
    const start = Math.min(...ons.map((event) => event.step));
    const up = mine.find((event) => event.type === 'up');
    let duration = (up?.step ?? start + 1) - start;
    if (duration <= 0) duration += this.#loopSteps;
    duration = Math.max(1, Math.min(this.#loopSteps - 1, duration));
    if (Number.isFinite(Number(durationArg))) {
      duration = Math.max(1, Math.min(this.#loopSteps - 1, Math.round(Number(durationArg))));
    }
    const template = ons[0];
    const nextStart = Math.max(0, Math.min(this.#loopSteps - 1, Math.round(Number(step) || 0)));
    const nextEnd = (nextStart + duration) % this.#loopSteps;
    const nextX = Number.isFinite(Number(x)) ? Number(x) : template.x;
    const nextDegree = degree === undefined ? template.degree : storedDegree(degree);
    const nextMidi = midi === undefined ? template.midi : storedMidi(midi);
    this.#forgetVoice(voiceId);
    this.#put({
      voiceId,
      step: nextStart,
      type: 'on',
      x: nextX,
      y: template.y,
      mode: template.mode,
      instrument: template.instrument,
      direction: template.direction,
      degree: nextDegree,
      midi: nextMidi,
      group: template.group,
    });
    this.#put({
      voiceId,
      step: nextEnd === nextStart ? (nextStart + 1) % this.#loopSteps : nextEnd,
      type: 'up',
      x: nextX,
      y: template.y,
      mode: template.mode,
      instrument: template.instrument,
      direction: template.direction,
      degree: nextDegree,
      midi: nextMidi,
      group: template.group,
    });
    return true;
  }

  #forgetVoice(voiceId) {
    const transport = this.#tone.getTransport();
    const removed = this.#events.filter((event) => event.voiceId === voiceId);
    this.#events = this.#events.filter((event) => event.voiceId !== voiceId);
    for (const event of removed) {
      this.#byKey.delete(`${event.voiceId}:${event.step}:${event.type}`);
      if (event.eventId != null) {
        transport.clear(event.eventId);
        const index = this.#scheduled.indexOf(event.eventId);
        if (index >= 0) this.#scheduled.splice(index, 1);
      }
    }
    this.#attackStep.delete(voiceId);
    this.#synth.release(`loop:${this.#playerId}:${voiceId}`);
  }

  #moveSegment({ base, step: fromStep }, { step, x, degree, midi, duration: durationArg } = {}) {
    const ons = this.#events.filter((event) => event.voiceId === base && event.type === 'on');
    const index = ons.findIndex((event) => event.step === fromStep);
    if (index < 0) return false;
    const target = ons[index];
    const next = ons[index + 1];
    const up = this.#events.find((event) => event.voiceId === base && event.type === 'up');
    const start = Math.max(0, Math.min(this.#loopSteps - 1, Math.round(Number(step) ?? fromStep)));
    this.#retarget(target, start);
    if (x != null) target.x = Number(x);
    if (degree !== undefined) target.degree = storedDegree(degree);
    if (midi !== undefined) target.midi = storedMidi(midi);
    if (!Number.isFinite(Number(durationArg))) return true;
    const duration = Math.max(1, Math.min(this.#loopSteps - 1, Math.round(Number(durationArg))));
    const end = (start + duration) % this.#loopSteps;
    if (next) this.#retarget(next, end === start ? (start + 1) % this.#loopSteps : end);
    else if (up) this.#retarget(up, end === start ? (start + 1) % this.#loopSteps : end);
    return true;
  }

  #retarget(event, step) {
    if (!event || event.step === step) return;
    const key = `${event.voiceId}:${step}:${event.type}`;
    const occupied = this.#byKey.get(key);
    if (occupied && occupied !== event) return;
    this.#disarm(event);
    this.#byKey.delete(`${event.voiceId}:${event.step}:${event.type}`);
    event.step = step;
    this.#byKey.set(key, event);
    this.#arm(event);
  }

  /** Drop one recorded note and its note-off. The rest of the loop stays. */
  removeNote(voiceId) {
    const segment = segmentVoice(voiceId);
    if (segment) {
      const removed = [];
      this.#events = this.#events.filter((event) => {
        if (event.voiceId !== segment.base || event.type !== 'on' || event.step !== segment.step) return true;
        removed.push(event);
        return false;
      });
      for (const event of removed) {
        this.#byKey.delete(`${event.voiceId}:${event.step}:${event.type}`);
        this.#disarm(event);
      }
      const still = this.#events.some((event) => event.voiceId === segment.base && event.type === 'on');
      if (!still) {
        const ups = this.#events.filter((event) => event.voiceId === segment.base && event.type === 'up');
        this.#events = this.#events.filter((event) => event.voiceId !== segment.base || event.type !== 'up');
        for (const event of ups) {
          this.#byKey.delete(`${event.voiceId}:${event.step}:${event.type}`);
          this.#disarm(event);
        }
      }
      if (removed.length) this.#synth.release(`loop:${this.#playerId}:${segment.base}`);
      return removed.length > 0;
    }
    const transport = this.#tone.getTransport();
    const removed = [];
    this.#events = this.#events.filter((event) => {
      if (event.voiceId !== voiceId) return true;
      removed.push(event);
      return false;
    });
    for (const event of removed) {
      this.#byKey.delete(`${event.voiceId}:${event.step}:${event.type}`);
      if (event.eventId != null) {
        transport.clear(event.eventId);
        const index = this.#scheduled.indexOf(event.eventId);
        if (index >= 0) this.#scheduled.splice(index, 1);
      }
    }
    this.#attackStep.delete(voiceId);
    this.#synth.release(`loop:${this.#playerId}:${voiceId}`);
    return removed.length > 0;
  }

  /** Drop every note of one instrument. Other instruments and the drum grid stay. */
  clearInstrument(instrument) {
    const id = normalizeInstrument(instrument);
    const voiceIds = new Set(
      this.#events.filter((event) => normalizeInstrument(event.instrument) === id).map((event) => event.voiceId),
    );
    if (!voiceIds.size) return 0;
    for (const voiceId of voiceIds) this.removeNote(voiceId);
    return voiceIds.size;
  }

  clear() {
    const transport = this.#tone.getTransport();
    for (const eventId of this.#scheduled) transport.clear(eventId);
    this.#scheduled = [];
    this.#events = [];
    this.#byKey.clear();
    this.#takes.clear();
    this.#attackStep.clear();
    this.#chordTakes.clear();
    this.#chordGen.clear();
    this.#line.clear();
    this.#synth.releaseMatching(`loop:${this.#playerId}:`);
  }
}
