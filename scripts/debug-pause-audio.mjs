// Repro: record a loop while the transport is deep into the session, pause,
// resume — the loop note must come back inside the first cycle.
// Before the fix the strip was anchored at absolute bar N, so after a restart
// it stayed silent for N bars.
import puppeteer from 'puppeteer-core';

const URL = 'http://127.0.0.1:43117';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const POLL = { polling: 100 };

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 30000,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1366, height: 800 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(URL + '?role=host', { waitUntil: 'networkidle2' });
await page.waitForFunction(
  () => /^[A-Z2-9]{4}$/.test(document.getElementById('host-code')?.textContent || ''),
  { timeout: 10000, ...POLL },
);
await page.click('#splash-start');
await page.waitForFunction(
  () => document.getElementById('host-audio-status')?.dataset.state === 'online',
  { timeout: 30000, ...POLL },
);
console.log('audio ready');

await page.evaluate(() => {
  const Tone = window.__jam.audio.engine.tone;
  window.__meter = new Tone.Meter({ smoothing: 0.2 });
  Tone.getDestination().connect(window.__meter);
});

// fast bpm, drums muted (they would mask the check), clock pushed deep
await page.evaluate(() => {
  const j = window.__jam;
  j.audio.engine.setBpm(200);
  j.audio.engine.tone.getTransport().ticks = 768 * 12; // bar 12
});
// mute the drum voice through the UI flag
await page.click('#host-screen .fx-panel .mix-flag[data-mix="mute"][data-voice="drums"]');

await page.click('#btn-transport'); // play
await page.click('#btn-loop'); // Rec on
await new Promise((r) => setTimeout(r, 300));
const pad = await page.$('#host-pad');
const box = await pad.boundingBox();
const cx = box.x + box.width * 0.5;
const cy = box.y + box.height * 0.5;
await page.mouse.move(cx, cy);
await page.mouse.down();
await new Promise((r) => setTimeout(r, 400));
await page.mouse.up();
await page.click('#btn-loop'); // Rec off
await new Promise((r) => setTimeout(r, 200));

const armed = await page.evaluate(() => {
  const j = window.__jam;
  const t = j.audio.engine.tone.getTransport();
  return { ticks: t.ticks, loops: [...j.audio.loops.values()].map((l) => ({ ev: l.length, sch: l.scheduledCount })) };
});
console.log('armed at ticks', armed.ticks, JSON.stringify(armed.loops));

// pause via the drums sheet, then resume
await page.click('#btn-drums');
await new Promise((r) => setTimeout(r, 200));
await page.click('#host-drums-transport');
await new Promise((r) => setTimeout(r, 200));
await page.click('#host-drums-transport');
await new Promise((r) => setTimeout(r, 100));

// 2 bars at 200bpm = 2.4s; sample for 3.5s — a correctly anchored loop must sound
const start = Date.now();
let firstSoundAt = null;
while (Date.now() - start < 3500) {
  const v = Number(await page.evaluate(() => window.__meter.getValue()));
  if (v > -40 && firstSoundAt === null) firstSoundAt = Date.now() - start;
  await new Promise((r) => setTimeout(r, 60));
}
console.log('first sound after resume at', firstSoundAt, 'ms');
console.log(firstSoundAt !== null ? 'PASS: loop came back in the first cycle' : 'FAIL: loop silent after resume');
await browser.close();
