/**
 * Loop export. MIDI is the layout. WAV is an offline mix of the same
 * instrument, drum, and master chain, including the limiter. Not a recording
 * of the live speakers.
 */

import { DrumMachine, TRACKS } from './drums.js';
import { createDrumBus, createInstrumentBus, createMasterFx } from './effects.js';
import { PerformanceRecorder, TouchSynth, normalizeInstrument, resolveGesture } from './synth.js';

export const REPEAT_GUARD = 128;
const PPQ = 480;
const DRUM_NOTES = {
  kick: 36,
  snare: 38,
  hat: 42,
  clap: 39,
  openhat: 46,
  tom: 45,
  cowbell: 56,
};
const INSTRUMENT_CHANNEL = {
  pad: 0,
  bass: 1,
  organ: 2,
  kalimba: 3,
  synth: 4,
};

export function loopSeconds(bpm, steps) {
  const tempo = Math.min(200, Math.max(40, Number(bpm) || 96));
  const length = Math.max(1, Math.round(Number(steps) || 1));
  return (length / 4) * (60 / tempo);
}

export function readRepeats(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > REPEAT_GUARD) return null;
  return number;
}

function encodeVarLen(value) {
  let rest = Math.max(0, value);
  const bytes = [rest & 0x7f];
  rest >>= 7;
  while (rest > 0) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>= 7;
  }
  return bytes.reverse();
}

function pushBytes(target, bytes) {
  for (const byte of bytes) target.push(byte & 0xff);
}

function chunk(type, body) {
  const out = [...type.split('').map((char) => char.charCodeAt(0))];
  const size = body.length;
  out.push((size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff);
  out.push(...body);
  return out;
}

function noteMidis(note, { root, scale, octaves }) {
  const exact = Number(note.midi);
  if (Number.isFinite(exact)) return [Math.round(exact)];
  const instrument = normalizeInstrument(note.instrument);
  const gesture = resolveGesture({
    x: note.x,
    y: note.y,
    mode: note.mode,
    instrument,
    degree: note.degree,
    root,
    scale,
    octave: octaves?.[instrument],
  });
  return (gesture.soundingMidis || []).filter((midi) => Number.isFinite(midi)).map((midi) => Math.round(midi));
}

function stepSpan(start, end, steps) {
  let duration = end - start;
  if (!(duration > 0)) duration = steps - start;
  return Math.max(1, Math.min(steps, duration));
}

/**
 * One SMF of the loop, repeated `repeats` times.
 * Notes of every instrument, plus drum steps on channel 10.
 */
export function buildLoopMidi({
  bpm = 96,
  steps = 32,
  repeats = 1,
  notes = [],
  drums = {},
  root = 'C',
  scale = 'major',
  octaves = {},
} = {}) {
  const times = readRepeats(repeats) ?? 1;
  const length = Math.max(1, Math.round(steps));
  const ticksPerStep = PPQ / 4;
  const loopTicks = length * ticksPerStep;
  const tempo = Math.min(200, Math.max(40, Number(bpm) || 96));
  const events = [];
  const add = (tick, bytes) => events.push({ tick: Math.max(0, tick), bytes });

  for (let copy = 0; copy < times; copy += 1) {
    const origin = copy * loopTicks;
    for (const note of notes) {
      const start = Math.max(0, Math.min(length - 1, Math.round(Number(note.step) || 0)));
      const end = Number.isFinite(Number(note.endStep)) ? Math.round(Number(note.endStep)) : start + 1;
      const span = stepSpan(start, end, length);
      const channel = INSTRUMENT_CHANNEL[normalizeInstrument(note.instrument)] ?? 0;
      for (const midi of noteMidis(note, { root, scale, octaves })) {
        const pitch = Math.max(0, Math.min(127, midi));
        add(origin + start * ticksPerStep, [0x90 | channel, pitch, 96]);
        add(origin + (start + span) * ticksPerStep, [0x80 | channel, pitch, 0]);
      }
    }
    for (const track of TRACKS) {
      const row = drums[track.id] || [];
      const pitch = DRUM_NOTES[track.id];
      if (pitch == null) continue;
      for (let step = 0; step < length; step += 1) {
        const slot = row[step];
        if (!slot?.on) continue;
        const hits = slot.division === 3 ? 3 : 1;
        for (let hit = 0; hit < hits; hit += 1) {
          const tick = origin + step * ticksPerStep + Math.floor((hit * ticksPerStep) / hits);
          add(tick, [0x99, pitch, 110]);
          add(tick + Math.max(1, Math.floor(ticksPerStep / (hits * 2))), [0x89, pitch, 0]);
        }
      }
    }
  }

  events.sort((a, b) => a.tick - b.tick);
  const track = [];
  const micros = Math.round(60000000 / tempo);
  pushBytes(track, [0x00, 0xff, 0x51, 0x03, (micros >>> 16) & 0xff, (micros >>> 8) & 0xff, micros & 0xff]);
  let cursor = 0;
  for (const event of events) {
    pushBytes(track, encodeVarLen(event.tick - cursor));
    pushBytes(track, event.bytes);
    cursor = event.tick;
  }
  pushBytes(track, encodeVarLen(Math.max(0, times * loopTicks - cursor)));
  pushBytes(track, [0xff, 0x2f, 0x00]);
  const header = chunk('MThd', [0x00, 0x00, 0x00, 0x01, (PPQ >>> 8) & 0xff, PPQ & 0xff]);
  return new Uint8Array([...header, ...chunk('MTrk', track)]);
}

function wavBytes(audioBuffer) {
  const raw = typeof audioBuffer.get === 'function' ? audioBuffer.get() : audioBuffer;
  const channels = raw.numberOfChannels;
  const rate = raw.sampleRate;
  const frames = raw.length;
  const bytesPerSample = 2;
  const block = channels * bytesPerSample;
  const dataSize = frames * block;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * block, true);
  view.setUint16(32, block, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataSize, true);
  const data = [];
  for (let channel = 0; channel < channels; channel += 1) data.push(raw.getChannelData(channel));
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, data[channel][frame] || 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return buffer;
}

/**
 * Offline render of `repeats` loops. Same bus order as the live host:
 * instruments and drums into the master gain, compressor, stutter/cutoff/8-bit/wah, limiter.
 */
export async function renderLoopWav(tone, spec) {
  const times = readRepeats(spec.repeats);
  if (!times) throw new Error('Repeats must be a whole number from 1 to 128.');
  const seconds = loopSeconds(spec.bpm, spec.steps) * times;
  const rendered = await tone.Offline(async () => {
    const context = tone.getContext();
    if (Number(context.lookAhead) > 0) context.lookAhead = 0;
    tone.getTransport().bpm.value = Math.min(200, Math.max(40, Number(spec.bpm) || 96));
    const limiter = new tone.Limiter(-2).toDestination();
    const compressor = new tone.Compressor({
      threshold: -16,
      ratio: 2.2,
      attack: 0.012,
      release: 0.22,
      knee: 8,
    });
    const masterFx = createMasterFx(tone, spec.bpm);
    masterFx.setDivision(spec.masterFx?.division || '16n');
    masterFx.setCutoff(spec.masterFx?.cutoff || 0);
    masterFx.setCrush(spec.masterFx?.grit || 0);
    masterFx.setWah(spec.masterFx?.wah || 0);
    compressor.connect(masterFx.input);
    masterFx.output.connect(limiter);
    const master = new tone.Gain(0.78).connect(compressor);
    const engine = { tone };
    const bus = createInstrumentBus(tone);
    const drumsFx = createDrumBus(tone);
    await Promise.all([bus.ready, drumsFx.ready]);
    const synth = new TouchSynth(engine, bus, { root: spec.root, scale: spec.scale });
    for (const [id, octave] of Object.entries(spec.octaves || {})) synth.setInstrumentOctave(id, octave);
    const drums = new DrumMachine(engine);
    drums.setLength(spec.steps);
    drums.output.connect(drumsFx.input);
    drumsFx.output.connect(master);
    bus.mix.connect(master);
    for (const [instrument, levels] of Object.entries(spec.effects || {})) {
      if (instrument === 'drums') {
        for (const [id, level] of Object.entries(levels)) drumsFx.setEffect(id, level);
      } else {
        for (const [id, level] of Object.entries(levels)) bus.setEffect(instrument, id, level);
      }
    }
    for (const [instrument, level] of Object.entries(spec.levels || {})) bus.setLevel(instrument, level);
    const voices = ['pad', 'bass', 'organ', 'kalimba', 'synth', 'drums'];
    const anySolo = voices.some((id) => spec.solo?.[id]);
    for (const id of voices) {
      const heard = !spec.mute?.[id] && (!anySolo || spec.solo?.[id]);
      if (id === 'drums') drumsFx.setAudible(heard);
      else bus.setAudible(id, heard);
    }
    for (const track of TRACKS) {
      const row = spec.drums?.[track.id] || [];
      for (let step = 0; step < spec.steps; step += 1) {
        const slot = row[step];
        drums.setStep(track.id, step, Boolean(slot?.on), slot?.division === 3 ? 3 : 1);
      }
    }
    const players = new Map();
    for (const bundle of spec.players || []) {
      const recorder = new PerformanceRecorder(engine, synth, {
        playerId: bundle.playerId,
        loopSteps: spec.steps,
      });
      recorder.restoreEvents(bundle.events || []);
      players.set(bundle.playerId, recorder);
    }
    tone.getTransport().bpm.value = spec.bpm;
    drums.start();
    tone.getTransport().start(0);
    return { drums, synth, bus, drumsFx, masterFx, limiter, compressor, master, players };
  }, seconds, 2, 44100);
  return wavBytes(rendered);
}

export function saveBlob(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return blob;
}
