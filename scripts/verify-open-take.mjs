/**
 * Open-take probe: while a finger is held during recording, the recorder's
 * armed 'on' must NOT start a loop voice — there is no note-off yet, so it
 * would drone until the 'up' step arrives. Expected: exactly one held organ
 * voice (the live finger) while held across a loop boundary; after the finger
 * lifts, the recorded strip plays on→up and ends.
 *
 * Usage: node scripts/verify-open-take.mjs
 */
import puppeteer from 'puppeteer-core';

const BASE_URL = 'http://127.0.0.1:43117';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function instrumentVoices() {
  const Tone = globalThis.Tone;
  window.__voices = new Set();
  window.__attacks = 0;
  for (const Ctor of [Tone.Synth, Tone.FMSynth]) {
    const proto = Ctor.prototype;
    const origAttack = proto.triggerAttack;
    const origRelease = proto.triggerRelease;
    proto.triggerAttack = function (...args) {
      window.__voices.add(this);
      window.__attacks += 1;
      this.__held = true;
      return origAttack.apply(this, args);
    };
    proto.triggerRelease = function (...args) {
      this.__held = false;
      return origRelease.apply(this, args);
    };
  }
}

function heldCount() {
  let n = 0;
  for (const voice of window.__voices) if (voice.__held) n += 1;
  return n;
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

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on('pageerror', (error) => console.log(`  [pageerror] ${error.message}`));
await page.goto(`${BASE_URL}/?role=host`, { waitUntil: 'networkidle2' });
await page.evaluate(instrumentVoices);
await page.waitForSelector('#splash-start');
await page.evaluate(() => document.getElementById('splash-start').click());
await page.waitForFunction(() => document.getElementById('host-audio-status').dataset.state === 'online', {
  timeout: 20000,
});

// Picking an instrument no longer resets Notes/Chords — ask for single notes
// explicitly so one finger holds exactly one voice.
await page.evaluate(() => document.querySelector('#mode-row [data-mode="single"]')?.click());
await page.evaluate(() => document.querySelector('#instrument-row [data-instrument="organ"]')?.click());
await page.evaluate(() => document.getElementById('btn-loop').click()); // rec on
await sleep(200);
await page.evaluate(firePointer, 'pointerdown', 1, 0.5, 0.5);
await sleep(4600); // past the 2-bar boundary — the armed 'on' has fired at least once
const whileHeld = await page.evaluate(heldCount);
console.log(`held voices while finger down across boundary: ${whileHeld} (want 1 — only the live finger)`);
await page.evaluate(firePointer, 'pointerup', 1, 0.5, 0.5);
await sleep(300);
const justUp = await page.evaluate(heldCount);
console.log(`held voices right after finger up: ${justUp} (want 0 — nothing may keep ringing)`);
// The recorded strip must still play: count attacks across one full loop.
const attacksBefore = await page.evaluate(() => window.__attacks);
await sleep(4600);
const attacksAfter = await page.evaluate(() => window.__attacks);
const loopPlayed = attacksAfter > attacksBefore;
console.log(`loop voices attacked during the pass: ${attacksAfter - attacksBefore} (want > 0 — the recording plays back)`);
const later = await page.evaluate(heldCount);
console.log(`held voices after a full pass: ${later} (want 0 — it ends at its own 'up')`);

await page.evaluate(() => document.getElementById('btn-loop').click());
await page.evaluate(() => document.getElementById('btn-loop-clear').click());
await browser.close();
const pass = whileHeld === 1 && justUp === 0 && loopPlayed && later === 0;
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
