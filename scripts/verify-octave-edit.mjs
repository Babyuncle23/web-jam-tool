/**
 * Octave-after-edit probe: a note moved in the note roll must stay
 * scale-relative — an octave change has to reach it like a recorded take.
 *
 * Scenario: record one chord on the pad, then a raw socket.io "guest" sends
 * a moveGroup control shifting the strip down an octave (always in-scale).
 * Afterwards the note must carry `degree` and no `midi` — storing an exact
 * midi freezes the pitch and collapses the chord to a single tone. Then an
 * octave bump must move the heard pitch back up.
 *
 * Usage: node scripts/verify-octave-edit.mjs
 */
import puppeteer from 'puppeteer-core';

const BASE_URL = 'http://127.0.0.1:43117';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const freqToMidi = (f) => Math.round(69 + 12 * Math.log2(f / 440));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${BASE_URL}/?role=host`, { waitUntil: 'networkidle2' });
await page.evaluate(() => {
  window.__freqs = [];
  for (const Ctor of [Tone.Synth, Tone.FMSynth]) {
    const orig = Ctor.prototype.triggerAttack;
    Ctor.prototype.triggerAttack = function (...args) {
      const freq = Number(args[0]);
      if (Number.isFinite(freq)) window.__freqs.push(freq);
      return orig.apply(this, args);
    };
  }
});
await page.evaluate(() => document.getElementById('splash-start').click());
await page.waitForFunction(() => document.getElementById('host-audio-status').dataset.state === 'online', { timeout: 20000 });

// Record one chord take on the pad (host boots into chords mode).
await page.evaluate(() => document.getElementById('btn-loop').click());
await sleep(200);
await page.evaluate(() => {
  const pad = document.getElementById('host-pad');
  const rect = pad.getBoundingClientRect();
  for (const type of ['pointerdown', 'pointerup']) {
    pad.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 1,
        clientX: rect.left + rect.width * 0.5,
        clientY: rect.top + rect.height * 0.5,
        bubbles: true,
        pointerType: 'touch',
        isPrimary: true,
        pressure: 0.5,
      }),
    );
  }
});
await sleep(200);
await page.evaluate(() => document.getElementById('btn-loop').click());
await sleep(300);

const recorded = await page.evaluate(() => {
  const note = globalThis.__jam?.loopFor?.('host')?.notes?.().find((n) => n.instrument === 'pad');
  return note ? { voiceId: note.voiceId, degree: note.degree, midi: note.midi, step: note.step } : null;
});
check('a recorded chord take exists', Boolean(recorded), JSON.stringify(recorded));
check('a recorded note is degree-relative already', recorded && recorded.midi == null && recorded.degree != null, JSON.stringify(recorded));

if (!recorded) {
  await browser.close();
  console.log('FAIL');
  process.exit(1);
}

// One loop pass → the chord's lowest heard pitch is its root.
const cycleMs = await page.evaluate(() => {
  const transport = globalThis.__jam?.audio?.engine?.tone?.getTransport?.();
  const steps = globalThis.__jam?.loopFor?.('host')?.loopSteps || 32;
  return steps * (15000 / (transport?.bpm?.value || 120));
});
const rootMidiOf = async () => {
  await page.evaluate(() => { window.__freqs = []; });
  await sleep(cycleMs + 400);
  const freqs = await page.evaluate(() => window.__freqs);
  return freqs.length ? Math.min(...freqs.map(freqToMidi)) : null;
};
const before = await rootMidiOf();
check('the recorded chord sounds in the loop', before != null, `root midi ${before}`);

// Guest joins over a raw socket and drags the strip down one octave.
await page.evaluate(
  () =>
    new Promise((resolve, reject) => {
      const sock = globalThis.io(globalThis.location.origin);
      window.__guestSock = sock;
      sock.on('connect_error', reject);
      sock.emit('controller:join', { code: document.getElementById('host-code').textContent, name: 'probe' }, (resp) =>
        resp?.ok ? resolve(resp.peerId) : reject(new Error(resp?.error || 'join failed')),
      );
    }),
);
await sleep(200);
await page.evaluate(
  ({ voiceId, step, midi }) =>
    window.__guestSock.emit('controller:control', { moveGroup: [{ voiceId, step, midi }] }),
  { voiceId: recorded.voiceId, step: recorded.step, midi: before - 12 },
);
await sleep(300);
const moved = await page.evaluate(
  (voiceId) => {
    const note = globalThis.__jam?.loopFor?.('host')?.notes?.().find((n) => n.voiceId === voiceId);
    return note ? { degree: note.degree, midi: note.midi } : null;
  },
  recorded.voiceId,
);
check('moved note keeps a scale degree', moved && moved.degree != null, JSON.stringify(moved));
check('moved note drops its exact midi', moved && moved.midi == null, JSON.stringify(moved));

const afterMove = await rootMidiOf();
check('the move pitched the chord down an octave', afterMove === before - 12, `root midi ${afterMove} (want ${before - 12})`);

// Octave bump on the instrument must reach the edited note now.
await page.evaluate(() =>
  window.__guestSock.emit('controller:control', { octave: { instrument: 'pad', value: 5 } }),
);
await sleep(200);
const afterOctave = await rootMidiOf();
check('octave change reaches the edited note', afterOctave === before, `root midi ${afterOctave} (want ${before})`);

await page.evaluate(() => window.__guestSock.disconnect());
await browser.close();
console.log(results.every(Boolean) ? 'PASS' : 'FAIL');
process.exit(results.every(Boolean) ? 0 : 1);
