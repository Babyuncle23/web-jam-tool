/**
 * Loop grow regression: a strip ending on the loop seam (or wrapping it)
 * keeps its span when the loop grows 2→4 bars — it must not ring across
 * the added bars. Shrinking back restores the wrapped form.
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:43117';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fails = [];
const ok = (cond, name) => {
  console.log(cond ? `ok   ${name}` : `FAIL ${name}`);
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 30000,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});

const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true });
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
if (spot) {
  const t = await page.touchscreen.touchStart(spot.x, spot.y);
  await t.end();
  await sleep(300);
}
ok(await page.evaluate(() => Boolean(globalThis.__jam?.loopFor('host'))), 'host recorder exists');

const out = await page.evaluate(() => {
  const rec = globalThis.__jam.loopFor('host');
  rec.clear();
  // Bar-2 strip ending on the seam: on@16, up@0 (wrapped).
  rec.addNote({ step: 16, duration: 16, x: 0.5, y: 0.5, instrument: 'pad', degree: 0 });
  // A deliberately seam-crossing strip: on@24, up@8 (16 steps).
  rec.addNote({ step: 24, duration: 16, x: 0.5, y: 0.5, instrument: 'pad', degree: 2 });
  // A plain mid-loop strip: on@4, up@8.
  rec.addNote({ step: 4, duration: 4, x: 0.5, y: 0.5, instrument: 'pad', degree: 4 });
  const grab = () => rec.notes().map((n) => `${n.step}>${n.endStep}`).sort().join(',');
  const before = grab();
  rec.setLoopSteps(64);
  const grown = grab();
  rec.setLoopSteps(32);
  const shrunk = grab();
  return { before, grown, shrunk };
});
console.log('  2 bars:', out.before);
console.log('  4 bars:', out.grown);
console.log('  back  :', out.shrunk);
ok(out.before === '16>0,24>8,4>8', `2-bar seam strips stored wrapped (${out.before})`);
ok(out.grown === '16>32,24>40,4>8', `grown strips keep their span (${out.grown})`);
ok(out.shrunk === out.before, `shrink restores the wrapped form (${out.shrunk})`);

await browser.close();
if (fails.length) {
  console.log(`\n${fails.length} FAIL: ${fails.join(', ')}`);
  process.exit(1);
}
console.log('\nLOOP GROW OK');
