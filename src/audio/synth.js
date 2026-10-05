/**
 * Polyphonic touch synth — HOST only.
 * Guests import the pure helpers (resolveGesture, names, scales) so the chord
 * label is computed by the same function that chooses the sounding notes.
 * Audio nodes are built once in the constructor and reused for every touch.
 */
import { sampleMode } from './sampler.js';


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

/**
 * Velocity multipliers per instrument per play mode. Pad chords duck under
 * the mix while a lone pad note rides above; a single kalimba pluck reads
 * thin without the lift, and organ chords stack several voices into a loud
 * block so they get trimmed.
 */
const MODE_VELOCITY = {
  pad: { chords: 0.57, single: 1.18 },
  kalimba: { single: 1.3 },
  organ: { chords: 0.7 },
};

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
  sampler: '#7c53b8',
};

export const INSTRUMENT_IDS = INSTRUMENTS.map((item) => item.id);

/** The Notes sheet can browse sampler hits as a lane instrument of its own. */
export const SAMPLER_INSTRUMENT = 'sampler';

export const DEFAULT_OCTAVE = 3;

/** Bass sits two octaves under the organ; pad, kalimba and synth sit one above. The slider can move them later. */
export function defaultOctaves() {
  return {
    pad: DEFAULT_OCTAVE + 1,
    bass: DEFAULT_OCTAVE - 2,
    organ: DEFAULT_OCTAVE,
    kalimba: DEFAULT_OCTAVE + 1,
    synth: DEFAULT_OCTAVE + 1,
  };
}

/** Root of the octave this instrument usually sounds in. Bass defaults to C1, organ to C3, the others to C4. */
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
 * The pad renderer draws these same edges, so they are exported.
 */
export const CHORD_ZONE_EDGES = [0.25, 0.375, 0.5, 0.75];

export function extensionFromY(y) {
  const clamped = clamp01(y);
  if (clamped < CHORD_ZONE_EDGES[0]) return 'triad';
  if (clamped < CHORD_ZONE_EDGES[1]) return 'sus2';
  if (clamped < CHORD_ZONE_EDGES[2]) return 'sus4';
  if (clamped < CHORD_ZONE_EDGES[3]) return 'seventh';
  return 'ninth';
}

export function normalizeInstrument(instrument) {
  if (instrument === 'piano') return 'synth';
  return INSTRUMENT_IDS.includes(instrument) ? instrument : 'pad';
}

/**
 * Loop events keep 'sampler' verbatim — hits are not playable pad voices, but
 * they are stored and cleared as their own instrument. normalizeInstrument()
 * would alias them to 'pad' and clear/history calls would confuse the two.
 */
export function storedInstrument(instrument) {
  return instrument === SAMPLER_INSTRUMENT ? SAMPLER_INSTRUMENT : normalizeInstrument(instrument);
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
 * which defaults two octaves below the other instruments.
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
    : defaultOctaves()[safeInstrument];
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

const MARK_RADIUS = 10;

/**
 * Loop notes → dots on the touch pad: one dot per scale column the pad can
 * voice, ignoring octave. The dot takes the selected instrument's colour
 * when that instrument owns a note there, else stays grey. `ranges` keeps
 * each note's { s, e } step span so the renderer can halo the dot while it
 * sounds.
 */
export function padNoteMarks(notes, instrument, { columns = 12 } = {}) {
  const target = normalizeInstrument(instrument);
  const marks = [];
  const byDegree = new Map();
  for (const note of notes || []) {
    const degree = storedDegree(note.degree);
    if (degree == null || degree < 0 || degree >= columns) continue;
    let mark = byDegree.get(degree);
    if (!mark) {
      mark = {
        x: (degree + 0.5) / columns,
        y: 0.5,
        degree,
        own: false,
        ranges: [],
      };
      byDegree.set(degree, mark);
      marks.push(mark);
    }
    if (normalizeInstrument(note.instrument) === target) mark.own = true;
    const start = Math.max(0, Math.round(Number(note.step) || 0));
    const end = Math.max(0, Math.round(Number(note.endStep) || 0));
    mark.ranges.push({ s: start, e: end === start ? start + 1 : end });
  }
  const ownColor = INSTRUMENT_COLORS[target] || '#e2b43a';
  for (const mark of marks) {
    mark.radius = MARK_RADIUS;
    mark.color = mark.own ? ownColor : 'rgba(151, 141, 109, 0.55)';
  }
  return marks;
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

/**
 * A release that lands before the attack it is meant to end can never find
 * the note — and a parked attack then rings forever. Clamp every time to now
 * so a release can never outrun its attack.
 */
function capNow(tone, time) {
  const now = tone.now();
  return Number.isFinite(time) ? Math.min(time, now) : now;
}

/**
 * One bass voice for the whole instrument. A new pitch always retriggers.
 * TouchSynth decides when a covered note comes back; this node does not glide.
 */
function createMonoVoice(tone, options, destination) {
  const synth = new tone.Synth(options).connect(destination);
  let on = false;
  /** Source.start asserts strictly increasing start times — nudge same-tick retriggers. */
  let lastAttack = 0;
  return {
    kind: 'mono',
    trigger(frequencies, time, velocity) {
      const when = capNow(tone, time);
      const frequency = frequencies.find((value) => value > 0);
      if (!(frequency > 0)) return;
      lastAttack = Math.max(when, lastAttack + 0.0001);
      synth.triggerAttack(frequency, lastAttack, velocity);
      on = true;
    },
    release(_frequencies, time) {
      if (!on) return;
      synth.triggerRelease(capNow(tone, time));
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
 * One voice per held finger note. A new pitch retriggers that finger, and a
 * slot is free the moment it is released — not when its tail ends — so a
 * slide can never outrun the pool the way a Tone.PolySynth does (its voices
 * stay checked out until the release finishes, then extra notes are dropped).
 * When the pool is truly exhausted, the newest attack steals a voice instead
 * of going silent. Voices are allocated once, never on instrument change.
 */
function createPooledVoice(tone, SynthClass, options, destination, polyphony) {
  const free = [];
  const pool = Array.from({ length: polyphony }, () => {
    const synth = new SynthClass(options).connect(destination);
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

  /** Pool empty: cut the top note of the longest-held finger so this one sounds. */
  function stealSlot(when) {
    for (const slots of held.values()) {
      const slot = slots.pop();
      if (!slot) continue;
      releaseSlot(slot, when);
      return free.pop();
    }
    return null;
  }

  return {
    kind: 'sustain',
    trigger(frequencies, time, velocity, { id = 'default' } = {}) {
      const when = capNow(tone, time);
      let slots = held.get(id);
      if (slots) {
        for (const slot of slots) releaseSlot(slot, when);
      }
      slots = [];
      held.set(id, slots);
      frequencies.forEach((frequency) => {
        const slot = free.pop() ?? stealSlot(when);
        if (!slot || !(frequency > 0)) return;
        // Source.start asserts each start is strictly later than the last;
        // the audio clock stays flat across a tick, so a same-tick retrigger
        // needs a nudge or the throw kills the rest of the chord.
        const at = Math.max(when, (slot.at ?? 0) + 0.0001);
        slot.at = at;
        slot.synth.triggerAttack(frequency, at, velocity);
        slot.on = true;
        slots.push(slot);
      });
    },
    release(_frequencies, time, id = 'default') {
      const when = capNow(tone, time);
      const slots = held.get(id);
      if (!slots) return;
      for (const slot of slots) releaseSlot(slot, when);
      held.delete(id);
    },
    choke(_frequencies, time, id = 'default') {
      const when = capNow(tone, time);
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
  /** @type {Map<string, { instrument: string, frequencies: number[], direction: string, y: number }>} */
  #active = new Map();
  /** Bass notes that are still held. A shorter note can cover a longer one; the longer one stays here. */
  #bassNotes = new Map();
  /** Id of the bass note currently driving the mono oscillator. */
  #bassLead = null;
  #bassSerial = 0;
  /** Chord fingers already cut by a newer chord. A slide inside that same chord must not restart it. */
  #chopped = new Map();

  constructor(engine, bus, { root = 'C', octave = DEFAULT_OCTAVE, scale = 'major', mode = 'single', lite } = {}) {
    this.#tone = engine.tone;
    this.#output = bus.mix;
    const inputs = bus.inputs;
    /** Lite halves the voice pools; the smallest one still fits a 9th chord. */
    const poly = lite?.lowPolyphony
      ? { pad: 8, organ: 8, kalimba: 5, synth: 6 }
      : { pad: 16, organ: 16, kalimba: 8, synth: 12 };
    /** Lite runs one oscillator per note instead of a detuned fat stack. */
    const fat = lite?.singleFat ? 1 : 0;
    /** Lite cuts the pad tail: a released voice still burns an oscillator. */
    const padRelease = lite?.shortTails ? 1.4 : 2.2;
    this.#voices = {
      pad: createPooledVoice(
        this.#tone,
        this.#tone.Synth,
        {
          oscillator: { type: 'fatsine', count: fat || 3, spread: 12 },
          envelope: { attack: 0.42, decay: 0.5, sustain: 0.72, release: padRelease },
          volume: -4,
        },
        inputs.pad,
        poly.pad,
      ),
      bass: createMonoVoice(
        this.#tone,
        {
          oscillator: { type: 'fatsawtooth', count: fat || 2, spread: 12 },
          envelope: { attack: 0.01, decay: 0.18, sustain: 0.75, release: 0.28 },
          volume: -1,
        },
        inputs.bass,
      ),
      organ: createPooledVoice(
        this.#tone,
        this.#tone.Synth,
        {
          oscillator: { type: 'sine4' },
          envelope: { attack: 0.012, decay: 0.08, sustain: 0.9, release: 0.16 },
          volume: -12,
        },
        inputs.organ,
        poly.organ,
      ),
      kalimba: createPooledVoice(
        this.#tone,
        this.#tone.FMSynth,
        {
          harmonicity: 8,
          modulationIndex: 1.4,
          oscillator: { type: 'sine' },
          envelope: { attack: 0.001, decay: 0.32, sustain: 0, release: 0.18 },
          modulation: { type: 'triangle' },
          modulationEnvelope: { attack: 0.001, decay: 0.14, sustain: 0, release: 0.1 },
          volume: 2.5,
        },
        inputs.kalimba,
        poly.kalimba,
      ),
      synth: createPooledVoice(
        this.#tone,
        this.#tone.Synth,
        {
          oscillator: { type: 'triangle' },
          envelope: { attack: 0.005, decay: 0.4, sustain: 0.55, release: 0.5 },
          volume: -6.5,
        },
        inputs.synth,
        poly.synth,
      ),
    };
    this.#root = root;
    this.#octave = octave;
    this.#octaves = defaultOctaves();
    if (octave !== DEFAULT_OCTAVE) {
      const shift = octave - DEFAULT_OCTAVE;
      const home = defaultOctaves();
      for (const id of Object.keys(this.#octaves)) {
        this.#octaves[id] = Math.min(6, Math.max(1, home[id] + shift));
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

  /**
   * Per-mode loudness shaping on top of the base velocity. Pad chords sit
   * under the mix while a single pad note rides above; a lone kalimba pluck
   * reads thin, and organ chords stack several voices into a loud block.
   */
  #velocity(gesture, y) {
    const mode = gesture.mode === 'chords' ? 'chords' : 'single';
    const shape = MODE_VELOCITY[gesture.instrument]?.[mode] ?? 1;
    const base = gesture.mode === 'chords' ? 0.82 : 0.35 + clamp01(y) * 0.55;
    return Math.min(1, base * shape);
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
      voice.trigger(gesture.frequencies, when, this.#velocity(gesture, touch.y), { id });
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
    voice.trigger(gesture.frequencies, when, this.#velocity(gesture, touch.y), { id });
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
 * 16th-note grid and played by a single scheduleRepeat('16n') tick that reads
 * the #byStep index, so the layer stays locked to the drum machine without
 * setTimeout. Edits rewrite the index — the transport timeline is never
 * touched. Each new take stacks; clear wipes only this player.
 */
export class PerformanceRecorder {
  #synth;
  #sampler;
  #tone;
  #playerId;
  #events = [];
  #byKey = new Map();
  /** step → event[] in #events order — the armed grid tick performs through this. */
  #byStep = new Map();
  /** voiceId → { ons, up, seq } — per-voice lookups skip the O(n) #events scan. */
  #byVoice = new Map();
  /** Insertion order per voiceId — the numeric notes() tie-break (was localeCompare). */
  #voiceSeq = 0;
  /** Last built notes() rows; null marks them stale after any #events change. */
  #notesCache = null;
  #takes = new Map();
  #attackStep = new Map();
  #chordTakes = new Map();
  #chordGen = new Map();
  /** Finger take → the note strip currently being held. A new pitch starts a new strip. */
  #line = new Map();
  #recording = false;
  /** 0 or 1 ids: the loop's single grid tick (armed iff #events is non-empty). */
  #scheduled = [];

  #loopSteps = LOOP_STEPS;
  #placed = 0;
  /** Unique voice ids for recorded sample hits (`hit:player:n`). */
  #hitSeq = 0;
  /** Unique voice ids for hold-grown copies (`dup:player:n`). */
  #dupSeq = 0;
  /** Gate pads still held: sampleId → [{ voiceId, onAbs, on }] — the 'up' is written on release. */
  #openHits = new Map();
  /** Events a loop shrink cut off the grid — a regrow restores them verbatim. */
  #dropped = [];
  /** Take base → loop snapshot at its first note-on, for per-take undo. */
  #takePre = new Map();
  /** Takes that closed while others were still open: { base, events }. */
  #closedLog = [];
  /** Called with the pre-take event list each time a take completes. */
  #onTake;

  constructor(engine, synth, { playerId = 'host', loopSteps = LOOP_STEPS, onTake, sampler } = {}) {
    this.#tone = engine.tone;
    this.#synth = synth;
    this.#sampler = sampler || null;
    this.#playerId = playerId;
    this.#loopSteps = normalizeLoopSteps(loopSteps);
    this.#onTake = typeof onTake === 'function' ? onTake : null;
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
    return 15 / (this.#tone.getTransport().bpm.value || 120);
  }

  get loopSteps() {
    return this.#loopSteps;
  }

  /**
   * Grow or set the note loop. Existing notes stay on their steps and the
   * repeat becomes the new length, so a longer loop does not retrigger them
   * every old bar. `duplicate` is the held-press grow: the old bars are
   * stamped into the added span instead of recalling the stash.
   */
  setLoopSteps(steps, { duplicate = false } = {}) {
    const next = normalizeLoopSteps(steps);
    const previous = this.#loopSteps;
    if (next === previous) return previous;
    this.#loopSteps = next;
    const sounding = new Set();
    for (const event of this.#events) {
      if (event.type === 'on' && event.step < next) sounding.add(event.voiceId);
    }
    // Shrinking must not strand a note-on without its note-off: an 'up' that
    // fell beyond the new end wraps back into the loop instead of dropping.
    // What the shrink cuts is stashed, not lost — a later regrow (2→4→2→4
    // bars) puts the clipped bars back exactly as they were.
    this.#events = this.#events.filter((event) => {
      if (event.type === 'on' ? event.step < next : sounding.has(event.voiceId)) {
        if (event.type === 'up' && event.step >= next) {
          const starts = (this.#byVoice.get(event.voiceId)?.ons ?? [])
            .filter((item) => item.step < next)
            .map((item) => item.step);
          const start = Math.min(...starts);
          event.step = event.step % next;
          if (event.step === start) event.step = (start + 1) % next;
        }
        return true;
      }
      this.#dropped.push(event);
      return false;
    });
    if (next > previous) {
      // An 'up' that fires before its voice's last 'on' wrapped the old
      // seam: in the longer loop the same span ends at previous + step —
      // a chord that stopped on the loop edge must not ring across the
      // added bars. (up === on is a degenerate one-step strip: leave it.)
      const lastOn = new Map();
      for (const event of this.#events) {
        if (event.type === 'on') lastOn.set(event.voiceId, event.step);
      }
      for (const event of this.#events) {
        if (event.type === 'up' && event.step < (lastOn.get(event.voiceId) ?? -1)) event.step += previous;
      }
    }
    this.#byKey = new Map(this.#events.map((event) => [`${event.voiceId}:${event.step}:${event.type}`, event]));
    this.#byVoice.clear();
    for (const event of this.#events) this.#indexEvent(event);
    this.#rebuildStepIndex();
    this.#notesCache = null;
    // Chord takes key #attackStep by the finger id, which never appears as an
    // event voiceId — keep steps for every take that is still open.
    const openTakes = new Set([...this.#line.keys(), ...this.#line.values(), ...this.#chordTakes.keys()]);
    for (const voiceId of [...this.#attackStep.keys()]) {
      if (!sounding.has(voiceId) && !openTakes.has(voiceId)) this.#attackStep.delete(voiceId);
    }
    for (const [finger, members] of this.#chordTakes) {
      const kept = members.filter((id) => this.#byVoice.has(id));
      if (kept.length) this.#chordTakes.set(finger, kept);
      else this.#chordTakes.delete(finger);
    }
    // A regrow returns stashed voices whole: one comes back only when every
    // one of its events fits the new length, so a partial regrow never
    // resurrects a strip cut in half. A held grow stamps copies over the new
    // span instead — and the stash is dropped: its voices sit on the same
    // steps the copies now own and would double up on the next regrow.
    if (next > previous && duplicate) {
      this.#dropped = [];
      this.#stampLoopCopies(previous, next);
    } else if (next > previous && this.#dropped.length) {
      const byVoice = new Map();
      for (const event of this.#dropped) {
        const list = byVoice.get(event.voiceId) || [];
        list.push(event);
        byVoice.set(event.voiceId, list);
      }
      const rest = [];
      for (const events of byVoice.values()) {
        if (events.every((event) => event.step < next)) {
          for (const event of events) this.#put(event);
        } else rest.push(...events);
      }
      this.#dropped = rest;
    }
    this.#syncTick();
    // Dropped or moved events can no longer stop a voice that is still
    // sounding, so cut every loop voice — kept notes re-attack on their next
    // step anyway.
    this.#synth.releaseMatching(`loop:${this.#playerId}:`);
    this.#sampler?.releaseMatching(`loop:${this.#playerId}:`);
    return this.#loopSteps;
  }

  /**
   * The held grow: stamp every finished voice once per extra old-length
   * block (2→4 bars copies once, 1→4 stamps three times). Copies get fresh
   * voice ids — and each chord member a fresh shared group — so they edit,
   * move and chop independently of the originals. Voices with no 'up' are
   * open takes (a finger still down): a copy could never get its note-off,
   * so it would sit as a mute strip forever — skip those.
   */
  #stampLoopCopies(from, to) {
    const entries = [...this.#byVoice.values()];
    const groups = new Map();
    const members = new Map();
    for (const entry of entries) {
      if (!entry.up) continue;
      const events = [...entry.ons, entry.up];
      const sourceGroup = events.find((event) => event.group)?.group;
      for (let offset = from; offset < to; offset += from) {
        let group;
        let voiceId;
        if (sourceGroup) {
          const key = `${sourceGroup}+${offset}`;
          group = groups.get(key);
          if (!group) {
            group = `dup:${this.#playerId}:${this.#dupSeq}`;
            this.#dupSeq += 1;
            groups.set(key, group);
          }
          const index = members.get(group) ?? 0;
          members.set(group, index + 1);
          voiceId = `${group}~${index}`;
        } else {
          voiceId = `dup:${this.#playerId}:${this.#dupSeq}`;
          this.#dupSeq += 1;
        }
        for (const event of events) {
          this.#put({ ...event, voiceId, group, step: (event.step + offset) % to });
        }
      }
    }
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
    if (this.#recording) this.#closeOpenTakes();
    this.#recording = false;
  }

  /**
   * A finger still down when recording stops leaves an 'on' with no 'up', and
   * the loop would replay that note forever. End every open take now.
   */
  #closeOpenTakes() {
    const transport = this.#tone.getTransport();
    const ticksPerStep = (transport.PPQ || 192) / 4;
    let step = Math.round(transport.ticks / ticksPerStep) % this.#loopSteps;
    if (step < 0) step += this.#loopSteps;
    for (const voiceId of [...this.#line.keys()]) {
      const segment = this.#line.get(voiceId) ?? voiceId;
      const last = this.#byVoice.get(segment)?.ons.at(-1);
      if (last && this.#closeSingleTake(voiceId, step, last)) this.#commitTake(voiceId);
      else this.#takePre.delete(voiceId);
    }
    this.#line.clear();
    for (const voiceId of [...this.#chordTakes.keys()]) {
      const member = this.#chordTakes.get(voiceId)?.[0];
      const on = member && this.#byVoice.get(member)?.ons[0];
      if (on && this.#closeChordTake(voiceId, step, on)) this.#commitTake(voiceId);
      else {
        this.#chordTakes.delete(voiceId);
        this.#takePre.delete(voiceId);
      }
    }
    this.#chordTakes.clear();
    for (const sample of [...this.#openHits.keys()]) this.captureRelease(sample);
  }

  /**
   * A sampler pad tap. One hit = one one-step strip (on + up) so it reads in
   * the roll and loops forever. Each hit is its own undo step; while a finger
   * take is still open the hit joins the closed-log so that take's undo keeps
   * it. Never writes pitch data — `sample` says which pad sounded.
   */
  captureHit(sample) {
    if (!this.#recording || !sample) return false;
    const transport = this.#tone.getTransport();
    const ticksPerStep = (transport.PPQ || 192) / 4;
    const pos = transport.ticks / ticksPerStep;
    let step = Math.floor(pos) % this.#loopSteps;
    if (step < 0) step += this.#loopSteps;
    const voiceId = `hit:${this.#playerId}:${this.#hitSeq}`;
    this.#hitSeq += 1;
    const pre = this.exportEvents();
    const event = {
      voiceId,
      step,
      type: 'on',
      x: 0.5,
      y: 0.5,
      mode: 'single',
      instrument: SAMPLER_INSTRUMENT,
      direction: 'down',
      sample: String(sample),
    };
    this.#put(event);
    if (sampleMode(sample) === 'gate') {
      // Gate pads quantize only the START: the 'up' is written by
      // captureRelease at the real release position, kept as step + frac.
      let opens = this.#openHits.get(String(sample));
      if (!opens) this.#openHits.set(String(sample), (opens = []));
      opens.push({ voiceId, onAbs: Math.floor(pos), on: event });
    } else {
      this.#put({ ...event, step: (step + 1) % this.#loopSteps, type: 'up' });
    }
    if (this.#takePre.size) this.#closedLog.push({ base: voiceId, events: this.#takeEvents(voiceId) });
    this.#onTake?.(pre);
    return 'note';
  }

  /**
   * Finger lifted off a gate pad while recording: close every open hit of
   * that sample at the unquantized position — the step the release fell in
   * carries `frac` (0..1 of a step), so playback cuts exactly where the
   * finger let go. One-shots never reach this.
   */
  captureRelease(sample) {
    const opens = this.#openHits.get(String(sample));
    if (!opens?.length) return false;
    this.#openHits.delete(String(sample));
    const transport = this.#tone.getTransport();
    const ticksPerStep = (transport.PPQ || 192) / 4;
    const pos = transport.ticks / ticksPerStep;
    for (const hit of opens) {
      // A tap shorter than the rounding gap still needs a real 'up'.
      let span = Math.max(0.02, pos - hit.onAbs);
      span = Math.min(span, this.#loopSteps - 0.02);
      const absUp = hit.onAbs + span;
      const upStep = ((Math.floor(absUp) % this.#loopSteps) + this.#loopSteps) % this.#loopSteps;
      const frac = absUp - Math.floor(absUp);
      this.#put({ ...hit.on, step: upStep, type: 'up', frac });
      // The take's loop voice dies with the finger — same rule as
      // #silenceTake for notes; waiting for the recorded 'up' step would
      // leave a gate pad ringing (and lit) almost a whole extra cycle.
      this.#sampler?.release(`loop:${this.#playerId}:${hit.voiceId}`);
    }
    return 'note';
  }

  /**
   * Keep one note-on per voice per grid step (the last finger position in that
   * step wins). The event joins the loop on the next bar and repeats every bar.
   */
  capture(event) {
    if (!this.#recording) return false;
    const transport = this.#tone.getTransport();
    const ticksPerStep = (transport.PPQ || 192) / 4;
    const pos = transport.ticks / ticksPerStep;
    // A press lands on the displayed step (floor — the bar readout floors
    // too); a release snaps to the nearest boundary to keep the held length.
    let step = (event.type === 'up' ? Math.round(pos) : Math.floor(pos)) % this.#loopSteps;
    if (step < 0) step += this.#loopSteps;

    if (event.type === 'down') {
      this.#takes.set(event.id, (this.#takes.get(event.id) ?? 0) + 1);
    }
    const take = this.#takes.get(event.id) ?? 1;
    const voiceId = `${event.id}#${take}`;
    if (event.type === 'down' && !this.#takePre.has(voiceId)) {
      this.#takePre.set(voiceId, { events: this.exportEvents(), index: this.#closedLog.length });
    }

    const heard = typeof this.#synth.describe === 'function' ? this.#synth.describe(event) : null;
    const degree = heard?.degree ?? event.degree;
    const pitched = { ...event, degree };

    // A re-press whose previous note-off never arrived must not orphan it.
    if (event.type === 'down' && take > 1) {
      const stale = `${event.id}#${take - 1}`;
      if (this.#chordTakes.has(stale) && this.#closeChordTake(stale, step, pitched)) this.#commitTake(stale);
      if (this.#line.has(stale) && this.#closeSingleTake(stale, step, pitched)) this.#commitTake(stale);
    }

    // The 'up' closes whichever kind of take is open — its own mode may
    // differ after a Notes/Chords flip while the finger is held.
    if (event.type === 'up') {
      const closed = this.#chordTakes.has(voiceId)
        ? this.#closeChordTake(voiceId, step, pitched)
        : this.#closeSingleTake(voiceId, step, pitched);
      if (closed) this.#commitTake(voiceId);
      // A restore wiped this take's events: nothing to close and the finger
      // is gone, so its stashed undo target is dead weight.
      else this.#takePre.delete(voiceId);
      return closed;
    }

    const chord = this.#chordDegrees(event);
    if (chord) {
      if (this.#line.has(voiceId)) this.#closeSingleTake(voiceId, step, pitched);
      return this.#captureChord(event, step, voiceId, chord);
    }
    if (this.#chordTakes.has(voiceId)) this.#closeChordTake(voiceId, step, pitched);

    const segment = this.#line.get(voiceId) ?? voiceId;
    const ons = this.#byVoice.get(segment)?.ons ?? [];
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
      instrument: storedInstrument(event.instrument),
      direction: event.direction === 'up' ? 'up' : 'down',
      degree: storedDegree(event.degree),
    };
  }

  /**
   * Events one finger's take wrote: its base voice, `~` slide segments and
   * `@` chord members all share the `${id}#${take}` prefix. Other takes —
   * including one from a later `down` of the same finger — never match.
   */
  #takeEvents(base) {
    // Rows come back grouped per voice: undo restores through the keyed merge
    // in #commitTake, so cross-voice order is irrelevant — per-voice order holds.
    const events = [];
    for (const [voiceId, entry] of this.#byVoice) {
      if (voiceId !== base && !voiceId.startsWith(`${base}~`) && !voiceId.startsWith(`${base}@`)) continue;
      events.push(...entry.ons);
      if (entry.up) events.push(entry.up);
    }
    return events.map((event) => ({ ...event }));
  }

  /**
   * A take completed: hand its undo target to the view. The pre-state is the
   * snapshot from the take's first note-on plus everything takes that closed
   * while it was open wrote — so undoing this take keeps those notes and
   * drops only this finger's own events.
   */
  #commitTake(base) {
    const stash = this.#takePre.get(base);
    this.#takePre.delete(base);
    if (stash) {
      const merged = new Map(stash.events.map((event) => [`${event.voiceId}:${event.step}:${event.type}`, event]));
      for (const closed of this.#closedLog.slice(stash.index)) {
        for (const event of closed.events) {
          merged.set(`${event.voiceId}:${event.step}:${event.type}`, event);
        }
      }
      this.#onTake?.([...merged.values()]);
    }
    this.#closedLog.push({ base, events: this.#takeEvents(base) });
    if (!this.#takePre.size) this.#closedLog.length = 0;
  }

  /**
   * A wipe or an undo replaces the loop wholesale while fingers stay down.
   * Rebase every open take's undo target to the new world — its old snapshot
   * would otherwise resurrect events the restore just removed.
   */
  #rebaseTakeStashes() {
    if (!this.#takePre.size) return;
    const events = this.exportEvents();
    this.#closedLog.length = 0;
    for (const stash of this.#takePre.values()) {
      stash.events = events;
      stash.index = 0;
    }
  }

  /**
   * Write the note-off for whatever strip this finger's take is playing. `pitched`
   * describes where the note ended, so a release pitch differing from the last
   * recorded position is stored as its own tiny segment — same as the old 'up' path.
   */
  #closeSingleTake(voiceId, step, pitched) {
    this.#silenceTake(voiceId);
    const segment = this.#line.get(voiceId) ?? voiceId;
    const ons = this.#byVoice.get(segment)?.ons ?? [];
    const last = ons[ons.length - 1];
    // A restore mid-take wipes the take's events: a stranded 'up' must not
    // write a note-off for a note that is not there.
    if (!last) {
      this.#line.delete(voiceId);
      return false;
    }
    // Fallback to the recorded on-step: a zero-length on/up pair would ring
    // almost forever — every cycle the 'up' fires just before the 'on'.
    const attackStep = this.#attackStep.get(segment) ?? this.#attackStep.get(voiceId) ?? last?.step;
    let upStep = step;
    if (attackStep !== undefined && upStep === attackStep) upStep = (attackStep + 1) % this.#loopSteps;
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

  #closeChordTake(voiceId, step, event) {
    this.#silenceTake(voiceId);
    const members = this.#chordTakes.get(voiceId) || [];
    // After a mid-take restore only members whose 'on' is still there can
    // take a note-off; a wiped take leaves nothing to close.
    const sounding = members.filter((member) => this.#byVoice.get(member)?.ons.length);
    if (!sounding.length) {
      this.#chordTakes.delete(voiceId);
      return false;
    }
    const memberStarts = sounding
      .map((member) => this.#byVoice.get(member)?.ons[0]?.step)
      .filter((item) => item !== undefined);
    const attackStep = this.#attackStep.get(voiceId) ?? (memberStarts.length ? Math.min(...memberStarts) : undefined);
    let upStep = step;
    if (attackStep !== undefined && upStep === attackStep) upStep = (attackStep + 1) % this.#loopSteps;
    const instrument = normalizeInstrument(event.instrument);
    for (const member of sounding) {
      const on = this.#byVoice.get(member)?.ons[0];
      this.#put({
        voiceId: member,
        step: upStep,
        type: 'up',
        x: event.x,
        y: event.y,
        mode: 'single',
        instrument: on?.instrument ?? instrument,
        direction: event.direction === 'up' ? 'up' : 'down',
        degree: on?.degree,
        group: on?.group,
      });
    }
    this.#chordTakes.delete(voiceId);
    return 'chord';
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
    if (event.type === 'up') return this.#closeChordTake(voiceId, step, event);
    const instrument = normalizeInstrument(event.instrument);
    const current = this.#chordTakes.get(voiceId) || [];
    const currentDegrees = [];
    for (const id of current) {
      const on = this.#byVoice.get(id)?.ons[0];
      if (on?.degree != null) currentDegrees.push(on.degree);
    }
    if (current.length && sameDegreeSet(currentDegrees, degrees)) return false;
    // The chord shape changed mid-hold: give the previous members their
    // note-offs before this take starts tracking the new set.
    if (current.length) this.#closeChordTake(voiceId, step, event);
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
    for (const entry of this.#byVoice.values()) {
      // Only the first chord 'on' per voice counts — later ones share its span.
      const event = entry.ons.find((item) => item.group
        && normalizeInstrument(item.instrument) === instrument);
      if (!event) continue;
      const active = event.step === step || this.#soundsAt(event.step, entry.up ? entry.up.step : null, step);
      if (!active || event.degree == null) continue;
      degrees.push(event.degree);
    }
    return degrees;
  }

  /** End still-sounding chord notes of this instrument where the new chord attacks. */
  #chopChords(instrument, step) {
    const voices = [];
    for (const [voiceId, entry] of this.#byVoice) {
      if (entry.ons.some((event) => event.group
        && normalizeInstrument(event.instrument) === instrument)) voices.push(voiceId);
    }
    for (const voiceId of voices) {
      const entry = this.#byVoice.get(voiceId);
      const on = entry?.ons[0];
      if (!on) continue;
      const up = entry.up;
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

  /** Cut the single grid tick — the timeline keeps nothing for an empty loop. */
  #disarmLoop() {
    if (!this.#scheduled.length) return;
    this.#tone.getTransport().clear(this.#scheduled[0]);
    this.#scheduled = [];
  }

  #setReleaseStep(voiceId, step) {
    const entry = this.#byVoice.get(voiceId);
    const ons = entry?.ons ?? [];
    if (!ons.length) return;
    const start = Math.min(...ons.map((event) => event.step));
    if (start === step) {
      this.#forgetVoice(voiceId);
      return;
    }
    const up = entry.up;
    if (up?.step === step) return;
    if (up) {
      this.#moveEventStep(up, step);
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
      sample: template.sample,
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

  /** Track an event under its voiceId — mirrors #events for O(1) voice lookups. */
  #indexEvent(event) {
    let entry = this.#byVoice.get(event.voiceId);
    if (!entry) {
      entry = { ons: [], up: null, seq: this.#voiceSeq++ };
      this.#byVoice.set(event.voiceId, entry);
    }
    if (event.type === 'on') entry.ons.push(event);
    else entry.up = event;
  }

  /** Drop a single event from its step bucket (voice-removal paths). */
  #unindexEvent(event) {
    const bucket = this.#byStep.get(event.step);
    if (!bucket) return;
    const index = bucket.indexOf(event);
    if (index >= 0) bucket.splice(index, 1);
    if (!bucket.length) this.#byStep.delete(event.step);
  }

  /**
   * Re-point an event at another step in place — #byKey and #byStep follow;
   * #events order is untouched so undo snapshots and export stay stable.
   */
  #moveEventStep(event, step) {
    if (event.step === step) return;
    this.#unindexEvent(event);
    this.#byKey.delete(`${event.voiceId}:${event.step}:${event.type}`);
    event.step = step;
    this.#byKey.set(`${event.voiceId}:${step}:${event.type}`, event);
    const bucket = this.#byStep.get(step);
    if (bucket) bucket.push(event);
    else this.#byStep.set(step, [event]);
    this.#notesCache = null;
  }

  /** Rebuild the step index after bulk step rewrites (setLoopSteps). */
  #rebuildStepIndex() {
    this.#byStep.clear();
    for (const event of this.#events) {
      const bucket = this.#byStep.get(event.step);
      if (bucket) bucket.push(event);
      else this.#byStep.set(event.step, [event]);
    }
  }

  #put(event) {
    this.#notesCache = null;
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
      if (event.sample !== undefined) existing.sample = event.sample;
      if (event.frac !== undefined) existing.frac = event.frac;
      return;
    }
    this.#byKey.set(key, event);
    this.#indexEvent(event);
    this.#events.push(event);
    const bucket = this.#byStep.get(event.step);
    if (bucket) bucket.push(event);
    else this.#byStep.set(event.step, [event]);
    this.#armLoop();
  }

  /**
   * The loop's only transport event: a 16th-note tick anchored at tick 0.
   * Tone re-syncs a repeat on every transport start/seek, and the index is
   * keyed by absolute step — a dense loop keeps one live timeline entry while
   * notes come and go freely.
   */
  #armLoop() {
    if (this.#scheduled.length) return;
    const eventId = this.#tone.getTransport().scheduleRepeat((time) => this.#tick(time), '16n', 0);
    this.#scheduled.push(eventId);
  }

  /** Armed iff the loop holds events: scheduledCount is 0 or 1, never 2×events. */
  #syncTick() {
    if (this.#events.length) this.#armLoop();
    else this.#disarmLoop();
  }

  /**
   * Grid tick → perform every event on this step. The step comes from the
   * event's audio time, not transport.ticks — inside the look-ahead window
   * the clock still reports the previous tick.
   */
  #tick(time) {
    const transport = this.#tone.getTransport();
    const ticksPerStep = (transport.PPQ || 192) / 4;
    let step = Math.round(transport.getTicksAtTime(time) / ticksPerStep) % this.#loopSteps;
    if (step < 0) step += this.#loopSteps;
    const events = this.#byStep.get(step);
    if (!events) return;
    for (const event of events) this.#perform(event, time);
  }

  /** Schedule the loop again after the audio clock was parked. */
  rearm() {
    this.#rearmAll();
  }

  #rearmAll() {
    this.#disarmLoop();
    this.#syncTick();
  }

  /** Audio-clock time when this bass strip ends, matching the roll length. */
  #bassUntil(event, time) {
    if (normalizeInstrument(event.instrument) !== 'bass') return undefined;
    const up = this.#byVoice.get(event.voiceId)?.up;
    let span = 1;
    if (up && up.step !== event.step) {
      span = up.step - event.step;
      if (span <= 0) span += this.#loopSteps;
    }
    span = Math.max(1, Math.min(this.#loopSteps, span));
    return time + span * this.stepSeconds;
  }

  /** A note-on only sounds once its note-off exists; an open take has none yet. */
  #hasUp(voiceId) {
    return this.#byVoice.get(voiceId)?.up != null;
  }

  /** Finger up: the take's loop voices die now, not when the recorded 'up' step comes around. */
  #silenceTake(voiceId) {
    this.#synth.release(`loop:${this.#playerId}:${voiceId}`);
    this.#synth.releaseMatching(`loop:${this.#playerId}:${voiceId}~`);
    this.#synth.releaseMatching(`loop:${this.#playerId}:${voiceId}@`);
  }

  #perform(event, time) {
    const id = `loop:${this.#playerId}:${event.voiceId}`;
    if (event.instrument === SAMPLER_INSTRUMENT) {
      // 'up' with a frac cuts inside the step — gate hits keep their real
      // recorded length; only the start was quantized.
      if (event.type === 'up') this.#sampler?.release(id, time + (event.frac || 0) * this.stepSeconds);
      // Beat-locked pads replay at the hit's own loop position — a bar-3
      // trigger continues the loop's third bar, wherever it was tapped.
      else
        this.#sampler?.trigger(event.sample, {
          time,
          id,
          phase: event.step * this.stepSeconds,
          cycle: this.#loopSteps * this.stepSeconds,
        });
      return;
    }
    if (event.type === 'up') {
      const at = time + (event.frac || 0) * this.stepSeconds;
      if (this.#cutByNewChord(event)) this.#synth.choke(id, at);
      else this.#synth.release(id, at);
      return;
    }
    // A note with no 'up' yet — the finger is still down or the off was lost —
    // would ring the whole cycle, so the live take does not preview.
    if (!this.#hasUp(event.voiceId)) return;
    this.#synth.attack({
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
  }

  /**
   * One strip per pitch. A bass or pad slide used to keep every step on the
   * first note, so a later C disappeared behind the opening D#.
   */
  notes() {
    if (this.#notesCache) return this.#notesCache.slice();
    const rows = [];
    for (const [voiceId, group] of this.#byVoice) {
      const segments = [];
      for (const on of group.ons) {
        const key = storedPitchKey(on);
        const previous = segments[segments.length - 1];
        if (previous?.key === key) continue;
        if (previous) previous.end = on.step;
        segments.push({ on, key, end: null });
      }
      if (!segments.length) continue;
      // The 'up' may carry a sub-step frac — gate hits end off-grid.
      segments[segments.length - 1].end = group.up ? group.up.step + (group.up.frac || 0) : null;
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
          sample: segment.on.sample,
          step,
          endStep,
          seq: group.seq,
        });
      }
    }
    // Numeric creation order breaks step ties — localeCompare profiled hot here.
    rows.sort((a, b) => a.step - b.step || a.seq - b.seq);
    this.#notesCache = rows.map(({ seq, ...note }) => note);
    return this.#notesCache.slice();
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
      sample: event.sample,
      frac: event.frac,
    }));
  }

  restoreEvents(events) {
    // Voices mid-note right now keep playing if the restore brings them back
    // unchanged — an undo must not silence notes it did not touch.
    const sounding = this.#soundingVoices();
    this.#disarmLoop();
    this.#events = [];
    this.#byKey.clear();
    this.#byStep.clear();
    this.#byVoice.clear();
    this.#notesCache = null;
    this.#attackStep.clear();
    this.#chordTakes.clear();
    this.#chordGen.clear();
    this.#line.clear();
    this.#openHits.clear();
    for (const event of events || []) {
      const original = Math.round(Number(event.step) || 0);
      const step = Math.max(0, Math.min(this.#loopSteps - 1, original));
      const next = {
        voiceId: String(event.voiceId),
        type: event.type === 'up' ? 'up' : 'on',
        x: event.x,
        y: event.y,
        mode: event.mode,
        instrument: event.instrument,
        direction: event.direction === 'up' ? 'up' : 'down',
        degree: storedDegree(event.degree),
        midi: storedMidi(event.midi),
        group: event.group || undefined,
        sample: event.sample,
        frac: Number.isFinite(Number(event.frac)) ? Number(event.frac) : undefined,
      };
      // Steps past the live loop end (a snapshot taken at a longer length)
      // park in the stash — a regrow puts them back, no collapse onto the
      // last step.
      if (original >= this.#loopSteps) {
        this.#dropped.push({ ...next, step: original });
        continue;
      }
      this.#put({ ...next, step });
    }
    this.#rebaseTakeStashes();
    for (const [voiceId, sig] of sounding) {
      const entry = this.#byVoice.get(voiceId);
      if (entry && this.#voiceSig(entry) === sig) continue;
      this.#synth.release(`loop:${this.#playerId}:${voiceId}`);
      this.#synth.releaseMatching(`loop:${this.#playerId}:${voiceId}~`);
      this.#synth.releaseMatching(`loop:${this.#playerId}:${voiceId}@`);
      this.#sampler?.release(`loop:${this.#playerId}:${voiceId}`);
    }
  }

  /** voiceId → signature for voices sounding on the current loop step. */
  #soundingVoices() {
    const transport = this.#tone.getTransport();
    const ticksPerStep = (transport.PPQ || 192) / 4;
    let step = Math.round(transport.ticks / ticksPerStep) % this.#loopSteps;
    if (step < 0) step += this.#loopSteps;
    const map = new Map();
    for (const [voiceId, entry] of this.#byVoice) {
      if (!entry.ons.length || !entry.up) continue;
      const start = Math.min(...entry.ons.map((event) => event.step));
      if (!this.#soundsAt(start, entry.up.step, step)) continue;
      map.set(voiceId, this.#voiceSig(entry));
    }
    return map;
  }

  /** Everything that decides what a sounding voice does next — and how it rings. */
  #voiceSig(entry) {
    const ons = entry.ons
      .map((event) => `${event.step}~${event.degree ?? ''}~${event.midi ?? ''}~${event.sample ?? ''}~${event.x ?? ''}`)
      .sort();
    return `${ons.join('|')}→${entry.up ? `${entry.up.step}~${entry.up.frac ?? ''}` : ''}`;
  }

  /**
   * A note that was not recorded. One step long, written into the step index
   * like every other loop event. Pass `duration` for longer strips.
   */
  addNote({ step, x, y, instrument, mode = 'single', direction = 'down', degree, midi, sample, duration } = {}) {
    const voiceId = `placed:${this.#playerId}:${this.#placed}`;
    this.#placed += 1;
    const start = Math.max(0, Math.min(this.#loopSteps - 1, Math.round(Number(step) || 0)));
    const span = Math.max(1, Math.min(this.#loopSteps - 1, Math.round(Number(duration) || 1)));
    const end = (start + span) % this.#loopSteps;
    const next = {
      x,
      y: Number.isFinite(Number(y)) ? Number(y) : 0.55,
      mode: mode === 'chords' ? 'chords' : 'single',
      instrument: storedInstrument(instrument),
      direction: direction === 'up' ? 'up' : 'down',
      degree: storedDegree(degree),
      midi: storedMidi(midi),
      sample,
    };
    this.#put({ voiceId, step: start, type: 'on', ...next });
    this.#put({ voiceId, step: end, type: 'up', ...next });
    return voiceId;
  }

  /** Slide one recorded note in time and pitch. Pass `duration` to resize it, `sample` to re-lane a hit. */
  moveNote(voiceId, change = {}) {
    const segment = segmentVoice(voiceId);
    if (segment) return this.#moveSegment(segment, change);
    const { step, x, degree, midi, duration: durationArg, sample } = change;
    const entry = this.#byVoice.get(voiceId);
    const ons = entry?.ons ?? [];
    if (!ons.length) return false;
    const start = Math.min(...ons.map((event) => event.step));
    const up = entry?.up;
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
    const nextSample = sample === undefined ? template.sample : String(sample);
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
      sample: nextSample,
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
      sample: nextSample,
    });
    return true;
  }

  #forgetVoice(voiceId) {
    const entry = this.#byVoice.get(voiceId);
    const removed = entry ? [...entry.ons] : [];
    if (entry?.up) removed.push(entry.up);
    this.#events = this.#events.filter((event) => event.voiceId !== voiceId);
    this.#byVoice.delete(voiceId);
    this.#notesCache = null;
    for (const event of removed) {
      this.#byKey.delete(`${event.voiceId}:${event.step}:${event.type}`);
      this.#unindexEvent(event);
    }
    this.#attackStep.delete(voiceId);
    this.#syncTick();
    this.#synth.release(`loop:${this.#playerId}:${voiceId}`);
  }

  #moveSegment({ base, step: fromStep }, { step, x, degree, midi, duration: durationArg, sample } = {}) {
    const entry = this.#byVoice.get(base);
    const ons = entry?.ons ?? [];
    const index = ons.findIndex((event) => event.step === fromStep);
    if (index < 0) return false;
    this.#notesCache = null;
    const target = ons[index];
    const next = ons[index + 1];
    const up = entry.up;
    const start = Math.max(0, Math.min(this.#loopSteps - 1, Math.round(Number(step) ?? fromStep)));
    this.#retarget(target, start);
    if (x != null) target.x = Number(x);
    if (degree !== undefined) target.degree = storedDegree(degree);
    if (midi !== undefined) target.midi = storedMidi(midi);
    if (sample !== undefined) target.sample = String(sample);
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
    this.#moveEventStep(event, step);
  }

  /** Drop one recorded note and its note-off. The rest of the loop stays. */
  removeNote(voiceId) {
    this.#notesCache = null;
    const segment = segmentVoice(voiceId);
    // A deliberate delete must not come back on a later regrow.
    this.#dropped = this.#dropped.filter((event) => event.voiceId !== (segment?.base ?? voiceId));
    if (segment) {
      const removed = [];
      this.#events = this.#events.filter((event) => {
        if (event.voiceId !== segment.base || event.type !== 'on' || event.step !== segment.step) return true;
        removed.push(event);
        return false;
      });
      const entry = this.#byVoice.get(segment.base);
      if (entry) entry.ons = entry.ons.filter((event) => event.step !== segment.step);
      for (const event of removed) {
        this.#byKey.delete(`${event.voiceId}:${event.step}:${event.type}`);
        this.#unindexEvent(event);
      }
      const still = Boolean(entry?.ons.length);
      if (!still) {
        const ups = [];
        this.#events = this.#events.filter((event) => {
          if (event.voiceId !== segment.base || event.type !== 'up') return true;
          ups.push(event);
          return false;
        });
        if (entry) entry.up = null;
        for (const event of ups) {
          this.#byKey.delete(`${event.voiceId}:${event.step}:${event.type}`);
          this.#unindexEvent(event);
        }
      }
      if (entry && !entry.ons.length && !entry.up) this.#byVoice.delete(segment.base);
      if (removed.length) this.#synth.release(`loop:${this.#playerId}:${segment.base}`);
      this.#syncTick();
      return removed.length > 0;
    }
    const removed = [];
    this.#events = this.#events.filter((event) => {
      if (event.voiceId !== voiceId) return true;
      removed.push(event);
      return false;
    });
    this.#byVoice.delete(voiceId);
    for (const event of removed) {
      this.#byKey.delete(`${event.voiceId}:${event.step}:${event.type}`);
      this.#unindexEvent(event);
    }
    this.#attackStep.delete(voiceId);
    this.#syncTick();
    this.#synth.release(`loop:${this.#playerId}:${voiceId}`);
    this.#sampler?.release(`loop:${this.#playerId}:${voiceId}`);
    return removed.length > 0;
  }

  /** Drop every note of one instrument. Other instruments and the drum grid stay. */
  clearInstrument(instrument) {
    const id = storedInstrument(instrument);
    this.#dropped = this.#dropped.filter((event) => storedInstrument(event.instrument) !== id);
    const voiceIds = new Set(
      this.#events.filter((event) => storedInstrument(event.instrument) === id).map((event) => event.voiceId),
    );
    if (!voiceIds.size) return 0;
    for (const voiceId of voiceIds) this.removeNote(voiceId);
    return voiceIds.size;
  }

  /** Drop every recorded hit of one sampler pad — the erase mode of the grid. */
  clearSample(sample) {
    const id = String(sample ?? '');
    // Erasing mid-hold: forget the open gate too, or the release would
    // write an 'up' for events that no longer exist.
    this.#openHits.delete(id);
    this.#dropped = this.#dropped.filter(
      (event) => !(storedInstrument(event.instrument) === SAMPLER_INSTRUMENT && event.sample === id),
    );
    const voiceIds = new Set(
      this.#events
        .filter((event) => storedInstrument(event.instrument) === SAMPLER_INSTRUMENT && event.sample === id)
        .map((event) => event.voiceId),
    );
    if (!voiceIds.size) return 0;
    for (const voiceId of voiceIds) this.removeNote(voiceId);
    return voiceIds.size;
  }

  clear() {
    this.#disarmLoop();
    this.#events = [];
    this.#byKey.clear();
    this.#byStep.clear();
    this.#byVoice.clear();
    this.#notesCache = null;
    this.#takes.clear();
    this.#attackStep.clear();
    this.#chordTakes.clear();
    this.#chordGen.clear();
    this.#line.clear();
    this.#openHits.clear();
    this.#dropped = [];
    this.#synth.releaseMatching(`loop:${this.#playerId}:`);
    this.#sampler?.releaseMatching(`loop:${this.#playerId}:`);
    this.#rebaseTakeStashes();
  }
}
