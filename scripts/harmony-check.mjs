/**
 * Pure checks for the shared gesture function: host key, diatonic chords,
 * Y-axis extensions, synth chords, and a monophonic bass. No browser, no audio context.
 */
import assert from 'node:assert/strict';

import {
  SCALES,
  extensionFromY,
  normalizeInstrument,
  resolveGesture,
  scalePitchClasses,
} from '../src/audio/synth.js';

const zones = [0.05, 0.3, 0.42, 0.62, 0.9];

for (const scale of Object.keys(SCALES)) {
  for (const root of ['C', 'F#', 'A']) {
    const allowed = scalePitchClasses(root, scale);
    for (let degree = 0; degree < 12; degree += 1) {
      for (const y of zones) {
        for (const instrument of ['pad', 'bass', 'synth', 'organ', 'kalimba']) {
          const gesture = resolveGesture({
            x: (degree + 0.01) / 12,
            y,
            mode: 'chords',
            root,
            scale,
            instrument,
          });
          for (const midi of gesture.soundingMidis) {
            const pc = ((midi % 12) + 12) % 12;
            assert.ok(allowed.has(pc), `${instrument} ${root} ${scale} y=${y} played ${pc} outside the scale`);
          }
          assert.ok(gesture.label.length > 0);
          assert.equal(gesture.frequencies.length, gesture.soundingMidis.length);
          if (instrument === 'bass') {
            assert.equal(gesture.soundingMidis.length, 1);
            assert.equal(gesture.extension, null);
          }
        }
      }
    }
  }
}

assert.deepEqual(
  zones.map((y) => extensionFromY(y)),
  ['triad', 'sus2', 'sus4', 'seventh', 'ninth'],
);

const pad = (y) => resolveGesture({ x: 0, y, mode: 'chords', root: 'C', scale: 'major', instrument: 'pad' });
assert.equal(pad(0.05).label, 'C Maj');
assert.equal(pad(0.3).label, 'C sus2');
assert.equal(pad(0.42).label, 'F# sus4'.replace('F#', 'C'));
assert.equal(pad(0.42).label, 'C sus4');
assert.equal(pad(0.62).label, 'Cmaj7');
assert.equal(pad(0.9).label, 'Cmaj9');
assert.notEqual(pad(0.05).label, pad(0.9).label);

assert.equal(
  resolveGesture({ x: 0, y: 0.62, mode: 'chords', root: 'A', scale: 'minor', instrument: 'pad' }).label,
  'Am7',
);
assert.equal(
  resolveGesture({ x: 0, y: 0.42, mode: 'chords', root: 'F#', scale: 'major', instrument: 'organ' }).label,
  'F# sus4',
);
assert.equal(
  resolveGesture({ x: 4 / 12 + 0.001, y: 0.62, mode: 'chords', root: 'C', scale: 'major', instrument: 'pad' }).label,
  'G7',
);

const single = resolveGesture({ x: 0, y: 0.8, mode: 'single', root: 'C', scale: 'major', instrument: 'pad' });
assert.equal(single.frequencies.length, 1);
assert.equal(single.label, 'C3');
assert.equal(single.extension, null);

const synth = resolveGesture({ x: 0, y: 0.9, mode: 'chords', root: 'C', scale: 'major', instrument: 'synth' });
assert.equal(synth.label, pad(0.9).label);
assert.ok(synth.frequencies.length >= 4);
assert.equal(normalizeInstrument('piano'), 'synth');
const synthSingle = resolveGesture({ x: 0, y: 0.2, mode: 'single', root: 'C', scale: 'major', instrument: 'piano' });
assert.equal(synthSingle.frequencies.length, 1);
assert.equal(synthSingle.label, 'C3');
assert.equal(synthSingle.instrument, 'synth');

const bassChord = resolveGesture({ x: 0, y: 0.9, mode: 'chords', root: 'C', scale: 'major', instrument: 'bass' });
assert.equal(bassChord.soundingMidis.length, 1);
assert.equal(bassChord.frequencies.length, 1);
assert.equal(bassChord.label, 'C2');
assert.equal(bassChord.extension, null);
const bassSingle = resolveGesture({ x: 0, y: 0.2, mode: 'single', root: 'C', scale: 'major', instrument: 'bass' });
assert.equal(bassSingle.label, bassChord.label);

console.log('harmony-check ok', {
  cmaj: pad(0.05).label,
  sus4: pad(0.42).label,
  ninth: pad(0.9).label,
  am7: 'Am7',
  synth: synth.label,
  bass: bassChord.label,
});
