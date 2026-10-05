/**
 * Dropped-note probe: slides a finger across the pad in chords mode and
 * counts how many requested chord tones never reach a voice.
 *
 * Counts two layers:
 *  - `requested`: frequencies TouchSynth asked the instrument voice to play
 *    (sums gesture.frequencies on every attack).
 *  - `sounded`: monophonic voices that actually got triggerAttack.
 *  - PolySynth pools report every "max polyphony" drop via _getNextAvailableVoice.
 *
 * Usage: node scripts/drop-note-probe.mjs [--url http://127.0.0.1:43117]
 */

import puppeteer from 'puppeteer-core';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .matchAll(/--([\w-]+)[= ]([^\s]+)/g)
    .map((match) => [match[1], match[2]]),
);

const BASE_URL = args.url ?? 'http://127.0.0.1:43117';
const CHROME = args.chrome ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const QUERY = args.query ?? '?role=host';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function instrument() {
  const Tone = globalThis.Tone;
  window.__stats = { requested: 0, sounded: 0, polyDropped: 0 };
  // Count every frequency TouchSynth asks a voice to play.
  const synth = globalThis.__jam?.audio?.synth;
  if (synth) {
    for (const name of ['attack', 'move']) {
      const orig = synth[name].bind(synth);
      synth[name] = (...rest) => {
        const gesture = orig(...rest);
        if (gesture?.frequencies?.length && name === 'attack') {
          window.__stats.requested += gesture.frequencies.length;
        }
        return gesture;
      };
    }
  }
  // Count voices that really attacked (Synth + FMSynth cover every pool).
  for (const Ctor of [Tone.Synth, Tone.FMSynth]) {
    const proto = Ctor.prototype;
    const orig = proto.triggerAttack;
    proto.triggerAttack = function patched(note, ...rest) {
      // Count only a call that did not throw — a thrown assert means silence.
      const out = orig.call(this, note, ...rest);
      window.__stats.sounded += 1;
      return out;
    };
  }
  // PolySynth drops notes silently — catch the failed allocation.
  const poly = Tone.PolySynth.prototype;
  const origNext = poly._getNextAvailableVoice;
  poly._getNextAvailableVoice = function (...rest) {
    const voice = origNext.apply(this, rest);
    if (!voice) window.__stats.polyDropped += 1;
    return voice;
  };
}

function resetStats() {
  window.__stats = { requested: 0, sounded: 0, polyDropped: 0 };
}

function firePointer(type, pointerId, x, y) {
  const pad = document.getElementById('host-pad');
  const rect = pad.getBoundingClientRect();
  pad.dispatchEvent(
    new PointerEvent(type, {
      pointerId,
      clientX: rect.left + rect.width * x,
      clientY: rect.top + rect.height * (1 - y),
      bubbles: true,
      pointerType: 'touch',
      isPrimary: pointerId === 1,
      pressure: 0.5,
    }),
  );
}

async function launch() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: [
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--mute-audio',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) console.log(`  [page ${message.type()}] ${message.text()}`);
  });
  page.on('pageerror', (error) => console.log(`  [pageerror] ${error.message}`));
  await page.goto(`${BASE_URL}/${QUERY}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#splash-start');
  await page.evaluate(() => document.getElementById('splash-start').click());
  await page.waitForFunction(() => document.getElementById('host-audio-status').dataset.state === 'online', {
    timeout: 60000,
  });
  await page.evaluate(instrument);
  return { browser, page };
}

const { browser, page } = await launch();

await page.evaluate(() => {
  document.querySelector('#mode-row [data-mode="chords"]')?.click();
});

const results = [];
for (const instrument of ['pad', 'organ', 'kalimba', 'synth']) {
  await page.evaluate((id) => {
    document.querySelector(`#instrument-row [data-instrument="${id}"]`)?.click();
  }, instrument);
  await sleep(150);
  await page.evaluate(resetStats);
  // Sweep back and forth across all 12 columns for ~3s at ~30 Hz, like a
  // finger glissando. Chord changes land on every column crossing. A second
  // finger adds a counter-sweep so overlapping chords stress the pools.
  const fingers = Number(args.fingers ?? 1);
  await page.evaluate(firePointer, 'pointerdown', 1, 0.05, 0.85);
  if (fingers > 1) await page.evaluate(firePointer, 'pointerdown', 2, 0.95, 0.6);
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < 3000) {
    const phase = (Date.now() - t0) / 3000;
    const x = phase < 0.5 ? 0.05 + phase * 1.8 : 0.95 - (phase - 0.5) * 1.8;
    await page.evaluate(firePointer, 'pointermove', 1, Math.min(0.98, Math.max(0.02, x)), 0.85);
    if (fingers > 1) {
      await page.evaluate(firePointer, 'pointermove', 2, Math.min(0.98, Math.max(0.02, 1 - x)), 0.6);
    }
    i += 1;
    await sleep(30);
  }
  await page.evaluate(firePointer, 'pointerup', 1, 0.05, 0.85);
  if (fingers > 1) await page.evaluate(firePointer, 'pointerup', 2, 0.05, 0.6);
  await sleep(400);
  const stats = await page.evaluate(() => ({ ...window.__stats }));
  stats.moves = i;
  stats.missing = stats.requested - stats.sounded;
  results.push({ instrument, ...stats });
  console.log(`${instrument.padEnd(8)} moves=${i} requested=${stats.requested} sounded=${stats.sounded} droppedByPool=${stats.polyDropped}`);
}

const bad = results.filter((r) => r.missing > 0 || r.polyDropped > 0);
console.log(`\nsummary: ${bad.length} of ${results.length} instruments dropped notes`);
await browser.close();
process.exit(bad.length ? 1 : 0);
