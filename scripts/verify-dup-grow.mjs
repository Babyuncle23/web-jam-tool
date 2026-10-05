/**
 * Held-grow duplication: setLoopSteps(n, {duplicate:true}) stamps the bars
 * in play over the added span. Plain grows stay untouched and still recall
 * the stash; a duplicate grow drops the stash so old bars cannot double up.
 * Pure Node — the recorder only needs stubbed transport/synth handles.
 *   node scripts/verify-dup-grow.mjs
 */
import { PerformanceRecorder } from '../src/audio/synth.js';

const fails = [];
const ok = (cond, name) => {
  console.log(cond ? `ok   ${name}` : `FAIL ${name}`);
  if (!cond) fails.push(name);
};

const tone = {
  now: () => 0,
  getTransport: () => ({
    bpm: { value: 120 },
    PPQ: 192,
    ticks: 0,
    clear() {},
    scheduleRepeat: () => 1,
    getTicksAtTime: () => 0,
  }),
};
const synth = {
  describe: () => null,
  attack() {},
  release() {},
  releaseMatching() {},
  choke() {},
};
const makeRec = (loopSteps) => new PerformanceRecorder({ tone }, synth, { playerId: 'host', loopSteps });
const grab = (rec) => rec.notes().map((n) => `${n.step}>${n.endStep}`).sort().join(',');

/* ── 2 → 4 bars, held grow ─────────────────────────────────────────── */
{
  const rec = makeRec(32);
  rec.addNote({ step: 4, duration: 4, x: 0.5, y: 0.5, instrument: 'pad', degree: 0 });
  rec.addNote({ step: 20, duration: 8, x: 0.5, y: 0.5, instrument: 'pad', degree: 2 });
  rec.setLoopSteps(64, { duplicate: true });
  const out = grab(rec);
  ok(out === '20>28,36>40,4>8,52>60', `2→4 held grow stamps the old bars into the new half (${out})`);
}

/* ── 1 → 2 bars, held grow ─────────────────────────────────────────── */
{
  const rec = makeRec(16);
  rec.addNote({ step: 4, duration: 4, x: 0.5, y: 0.5, instrument: 'pad', degree: 1 });
  rec.setLoopSteps(32, { duplicate: true });
  const out = grab(rec);
  ok(out === '20>24,4>8', `1→2 held grow copies the bar once (${out})`);
}

/* ── 1 → 4 bars, held grow stamps three times ──────────────────────── */
{
  const rec = makeRec(16);
  rec.addNote({ step: 2, duration: 2, x: 0.5, y: 0.5, instrument: 'pad', degree: 3 });
  rec.setLoopSteps(64, { duplicate: true });
  const out = grab(rec);
  ok(out === '18>20,2>4,34>36,50>52', `1→4 held grow tiles the bar across all three added spans (${out})`);
}

/* ── Plain grow unchanged ──────────────────────────────────────────── */
{
  const rec = makeRec(32);
  rec.addNote({ step: 4, duration: 4, x: 0.5, y: 0.5, instrument: 'pad', degree: 0 });
  rec.setLoopSteps(64);
  const out = grab(rec);
  ok(out === '4>8', `plain grow adds nothing (${out})`);
}

/* ── Seam-wrapping strip mirrors into the new half ─────────────────── */
{
  const rec = makeRec(32);
  // on@24, up@8 wrapped — grows to on@24, up@40; the copy wraps the new seam.
  rec.addNote({ step: 24, duration: 16, x: 0.5, y: 0.5, instrument: 'pad', degree: 0 });
  rec.setLoopSteps(64, { duplicate: true });
  const out = grab(rec);
  ok(out === '24>40,56>8', `wrapped strip copies as a wrapped strip (${out})`);
}

/* ── Stash survives a plain grow, dies on a held grow ──────────────── */
{
  const rec = makeRec(64);
  rec.addNote({ step: 4, duration: 4, x: 0.5, y: 0.5, instrument: 'pad', degree: 0 });
  rec.addNote({ step: 40, duration: 4, x: 0.5, y: 0.5, instrument: 'pad', degree: 1 });
  rec.setLoopSteps(32); // 40>44 clipped into the stash
  rec.setLoopSteps(64); // plain regrow restores it
  ok(grab(rec) === '40>44,4>8', `plain regrow still recalls the stash (${grab(rec)})`);

  rec.setLoopSteps(32); // stash again
  rec.setLoopSteps(64, { duplicate: true }); // held grow ignores it
  const out = grab(rec);
  ok(out === '36>40,4>8', `held grow drops the stash and stamps the live bars (${out})`);
}

/* ── An open take (finger still down, no 'up') is never copied ─────── */
{
  const rec = makeRec(32);
  rec.addNote({ step: 4, duration: 4, x: 0.5, y: 0.5, instrument: 'pad', degree: 0 });
  // Mimic a held finger: an 'on' with no 'up' yet.
  rec.restoreEvents([
    ...rec.exportEvents(),
    { voiceId: 'live:finger', step: 10, type: 'on', x: 0.5, y: 0.5, mode: 'single', instrument: 'pad', direction: 'down', degree: 4 },
  ]);
  rec.setLoopSteps(64, { duplicate: true });
  const rows = rec.notes();
  const open = rows.filter((n) => n.voiceId === 'live:finger');
  ok(rows.length === 3 && open.length === 1, `open take is not stamped (${rows.length} rows)`);
}

/* ── Chord copies get their own group, not the source's ────────────── */
{
  const rec = makeRec(32);
  const chord = [
    { voiceId: 'g:1~0', step: 8, type: 'on', x: 0.5, y: 0.5, mode: 'chords', instrument: 'pad', direction: 'down', degree: 0, group: 'g:1' },
    { voiceId: 'g:1~0', step: 12, type: 'up', x: 0.5, y: 0.5, mode: 'chords', instrument: 'pad', direction: 'down', degree: 0, group: 'g:1' },
    { voiceId: 'g:1~1', step: 8, type: 'on', x: 0.5, y: 0.5, mode: 'chords', instrument: 'pad', direction: 'down', degree: 4, group: 'g:1' },
    { voiceId: 'g:1~1', step: 12, type: 'up', x: 0.5, y: 0.5, mode: 'chords', instrument: 'pad', direction: 'down', degree: 4, group: 'g:1' },
  ];
  rec.restoreEvents(chord);
  rec.setLoopSteps(64, { duplicate: true });
  const events = rec.exportEvents();
  const copyGroups = new Set(events.filter((e) => e.step >= 32).map((e) => e.group));
  ok(copyGroups.size === 1 && ![...copyGroups][0].includes('g:1'), `chord copy shares one fresh group (${[...copyGroups]})`);
  const copyVoices = new Set(events.filter((e) => e.step >= 32).map((e) => e.voiceId));
  ok(copyVoices.size === 2 && [...copyVoices].every((id) => !id.startsWith('g:1')), `chord copy voices are fresh ids (${[...copyVoices].join(',')})`);
}

if (fails.length) {
  console.log(`\n${fails.length} FAIL: ${fails.join(', ')}`);
  process.exit(1);
}
console.log('\nDUP GROW OK');
