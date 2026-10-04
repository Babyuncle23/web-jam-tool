/**
 * Edge auto-scroll regression: holding a strip drag or a marquee inside the
 * roll's ~28px edge band keeps scrolling the sheet — horizontally AND
 * vertically — so the drop target stays reachable.
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
const cdp = await page.createCDPSession();
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await page.goto(`${BASE}/?role=host`, { waitUntil: 'domcontentloaded' });
await sleep(600);
await page.evaluate(() => document.getElementById('splash-start')?.click());
await sleep(1000);
await page.evaluate(() => document.getElementById('btn-notes')?.click());
await sleep(600);

// Zoom in so the sheet overflows horizontally.
const box = await page.evaluate(() => {
  const r = document.getElementById('host-note-tape').getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});
const cx = box.x + box.w * 0.5;
const cy = box.y + box.h * 0.5;
const a = await page.touchscreen.touchStart(cx - 40, cy);
const b = await page.touchscreen.touchStart(cx + 40, cy);
for (let i = 1; i <= 6; i++) {
  const d = 40 + ((150 - 40) * i) / 6;
  await a.move(cx - d, cy);
  await b.move(cx + d, cy);
}
await a.end();
await b.end();
await sleep(400);

// Tap an in-scale row to place a note.
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
ok(Boolean(spot), 'found an in-scale row to tap');
const t0 = await page.touchscreen.touchStart(spot.x, spot.y);
await t0.end();
await sleep(300);

const strip = await page.evaluate(() => {
  const el = document.getElementById('host-note-tape').querySelector('.roll__note');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
ok(Boolean(strip), 'note strip placed');

const scroll = () => page.evaluate(() => {
  const roll = document.getElementById('host-note-tape');
  return { l: roll.scrollLeft, t: roll.scrollTop };
});

// Drag the strip to the right edge and hold — scrollLeft keeps growing.
const f = await page.touchscreen.touchStart(strip.x, strip.y);
for (let i = 1; i <= 8; i++) {
  await f.move(strip.x + ((box.x + box.w - 12 - strip.x) * i) / 8, strip.y);
}
const h0 = await scroll();
await sleep(700);
const h1 = await scroll();
ok(h1.l > h0.l + 20, `strip drag edge-hold scrolls horizontally (${h0.l} → ${h1.l})`);

// Then to the bottom edge and hold — scrollTop keeps growing.
const pos = await page.evaluate(() => {
  const roll = document.getElementById('host-note-tape');
  const el = roll.querySelector('.roll__note');
  const r = el.getBoundingClientRect();
  const rr = roll.getBoundingClientRect();
  return { x: Math.min(r.left + r.width / 2, rr.right - 30), y: r.top + r.height / 2, bottom: rr.bottom };
});
for (let i = 1; i <= 8; i++) {
  await f.move(pos.x, pos.y + ((pos.bottom - 10 - pos.y) * i) / 8);
}
const v0 = await scroll();
await sleep(700);
const v1 = await scroll();
ok(v1.t > v0.t + 10, `strip drag edge-hold scrolls vertically (${v0.t} → ${v1.t})`);
await f.end();
await sleep(300);

// Select mode: a marquee held at the bottom-right scrolls both axes.
await page.evaluate(() => document.getElementById('host-select-move')?.click());
await sleep(300);
await page.evaluate(() => {
  const roll = document.getElementById('host-note-tape');
  roll.scrollLeft = 0;
  roll.scrollTop = 0;
});
const start = { x: box.x + box.w * 0.35, y: box.y + box.h * 0.4 };
const m = await page.touchscreen.touchStart(start.x, start.y);
for (let i = 1; i <= 8; i++) {
  await m.move(start.x + ((box.x + box.w - 10 - start.x) * i) / 8, start.y + ((box.y + box.h - 10 - start.y) * i) / 8);
}
const s0 = await scroll();
await sleep(700);
const s1 = await scroll();
ok(s1.l > s0.l + 20, `marquee edge-hold scrolls horizontally (${s0.l} → ${s1.l})`);
ok(s1.t > s0.t + 10, `marquee edge-hold scrolls vertically (${s0.t} → ${s1.t})`);
await m.end();

await browser.close();
if (fails.length) {
  console.log(`\n${fails.length} FAIL: ${fails.join(', ')}`);
  process.exit(1);
}
console.log('\nEDGE SCROLL OK');
