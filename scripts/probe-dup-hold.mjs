/**
 * UI-level probe for the held length grow: taps resize, holds stamp copies.
 * Needs the dev server on :43117. Throws away nothing — prints a verdict.
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:43117';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const ok = (cond, name) => {
  console.log(cond ? `ok   ${name}` : `FAIL ${name}`);
  if (!cond) fails.push(name);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 30000,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`${BASE}/?role=host`, { waitUntil: 'domcontentloaded' });
await sleep(600);
await page.evaluate(() => document.getElementById('splash-start')?.click());
await sleep(1200);
// Opening the notes sheet and tapping once creates the host recorder.
await page.evaluate(() => document.getElementById('btn-notes')?.click());
await sleep(600);
const spot = await page.evaluate(() => {
  const roll = document.getElementById('host-note-tape');
  const rollRect = roll.getBoundingClientRect();
  const keys = [...roll.querySelectorAll('.roll__key:not(.is-blocked)')];
  for (const key of keys) {
    const r = key.getBoundingClientRect();
    if (r.top > rollRect.top + 60 && r.bottom < rollRect.bottom - 20) {
      return { x: rollRect.left + rollRect.width * 0.5, y: (r.top + r.bottom) / 2 };
    }
  }
  return null;
});
if (spot) await page.mouse.click(spot.x, spot.y);
await sleep(300);
await page.evaluate(() => document.getElementById('host-notes-close')?.click());
await sleep(300);
ok(await page.evaluate(() => Boolean(globalThis.__jam?.loopFor('host'))), 'host recorder exists');

// Seed two notes into the host recorder.
await page.evaluate(() => {
  const rec = globalThis.__jam.loopFor('host');
  rec.clear();
  rec.addNote({ step: 4, duration: 4, x: 0.5, y: 0.5, instrument: 'pad', degree: 0 });
});
const grab = () =>
  page.evaluate(() => globalThis.__jam.loopFor('host').notes().map((n) => `${n.step}>${n.endStep}`).sort().join(','));

// Hold the bars button through the 600 ms arm → grow 2→4 with a copy.
const bars = await page.$('#btn-bars');
const box = await bars.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await sleep(150);
ok(
  await page.evaluate(() => document.getElementById('btn-bars').classList.contains('is-arming--dup')),
  'held grow shows the amber arming fill',
);
await sleep(650);
await page.mouse.up();
await sleep(150);
let out = await grab();
ok(out === '36>40,4>8', `held 2→4 stamps the copy (${out})`);

// A plain tap on a chip shrinks with no copies: pick 1 bar in Advanced.
await page.evaluate(() => document.getElementById('btn-drums')?.click());
await sleep(400);
await page.evaluate(() => {
  const check = document.getElementById('host-drum-adv-check');
  if (check && !check.checked) check.click();
});
await sleep(250);
await page.evaluate(() => document.querySelector('#host-drum-length [data-steps="16"]')?.click());
await sleep(200);
out = await grab();
ok(out === '4>8', `tap shrink drops the copied half (${out})`);

// Held chip grow 1→2 stamps the bar again.
const chip = await page.$('#host-drum-length [data-steps="32"]');
const cbox = await chip.boundingBox();
await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2);
await page.mouse.down();
await sleep(700);
await page.mouse.up();
await sleep(150);
out = await grab();
ok(out === '20>24,4>8', `held chip 1→2 stamps the copy (${out})`);

// Drums: held grow to 4 bars tiles every lit cell into the new half —
// the kick count doubles exactly.
const kicksBefore = await page.evaluate(() => globalThis.__jam.drumHits('kick'));
const chip64 = await page.$('#host-drum-length [data-steps="64"]');
const c64box = await chip64.boundingBox();
await page.mouse.move(c64box.x + c64box.width / 2, c64box.y + c64box.height / 2);
await page.mouse.down();
await sleep(700);
await page.mouse.up();
await sleep(200);
const kicksAfter = await page.evaluate(() => globalThis.__jam.drumHits('kick'));
ok(
  kicksBefore > 0 && kicksAfter === kicksBefore * 2,
  `held drum grow 2→4 tiles the pattern (kick ${kicksBefore} → ${kicksAfter})`,
);
// The bars label followed the chip grow.
const label = await page.evaluate(() => document.getElementById('btn-bars').textContent.trim());
ok(/4/.test(label), `bars button reads 4 bars after the held grow (${label})`);

await browser.close();
if (fails.length) {
  console.log(`\n${fails.length} FAIL: ${fails.join(', ')}`);
  process.exit(1);
}
console.log('\nDUP HOLD UI OK');
