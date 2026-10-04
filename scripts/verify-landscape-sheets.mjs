/**
 * Probe: landscape phone stage sheets — the editor must own the left column
 * at near-full height, controls stack in a right rail, everything visible.
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
await page.setViewport({ width: 844, height: 390, hasTouch: true, isMobile: true });
const cdp = await page.createCDPSession();
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await page.goto(`${BASE}/?role=host`, { waitUntil: 'domcontentloaded' });
await sleep(600);
await page.evaluate(() => document.getElementById('splash-start')?.click());
await sleep(1000);

console.log('mq:', await page.evaluate(() => matchMedia('(orientation: landscape) and (max-height: 560px) and (pointer: coarse)').matches));

/* ---------- Notes sheet ---------- */
await page.evaluate(() => document.getElementById('btn-notes')?.click());
await sleep(600);
const notes = await page.evaluate(() => {
  const card = document.querySelector('#host-notes-sheet .fx-sheet__card');
  const roll = document.getElementById('host-note-tape');
  const carousel = document.querySelector('#host-notes-sheet .inst-carousel');
  const bar = document.querySelector('#host-notes-sheet .stage-bar');
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
  const clips = [...card.querySelectorAll('.stage-bar .btn')].map((b) => ({ label: b.textContent.trim().slice(0, 10), clipped: b.scrollWidth > b.clientWidth + 2 }));
  return { card: r(card), roll: r(roll), carousel: r(carousel), bar: r(bar), clips, vh: innerHeight, vw: innerWidth };
});
console.log(JSON.stringify(notes, null, 1));
ok(notes.roll.h >= notes.vh - 30, `notes roll ~full height (${notes.roll.h} of ${notes.vh})`);
ok(notes.roll.w >= notes.vw * 0.55, `notes roll owns the wide column (${notes.roll.w} of ${notes.vw})`);
ok(notes.carousel.x > notes.roll.x + notes.roll.w - 4, 'carousel sits in the right rail');
ok(notes.bar.x > notes.roll.x + notes.roll.w - 4, 'stage-bar sits in the right rail');
ok(notes.clips.every((c) => !c.clipped), `no clipped stage-bar labels (${JSON.stringify(notes.clips)})`);
await page.screenshot({ path: 'scripts/shots/landscape-notes.png' });
await page.evaluate(() => document.getElementById('host-notes-close')?.click());
await sleep(400);

/* ---------- Drums sheet ---------- */
await page.evaluate(() => document.getElementById('btn-drums')?.click());
await sleep(700);
const drums = await page.evaluate(() => {
  const card = document.querySelector('#host-drums-sheet .fx-sheet__card');
  const seq = document.getElementById('sequencer');
  const tape = seq.querySelector('.seq-tape');
  const head = card.querySelector('.stage-head');
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
  const rows = tape.querySelectorAll('.seq-row').length;
  const visibleRows = [...tape.querySelectorAll('.seq-row')].filter((row) => {
    const b = row.getBoundingClientRect();
    const t = tape.getBoundingClientRect();
    return b.bottom > t.top + 4 && b.top < t.bottom - 4;
  }).length;
  const overflow = [...card.children].filter((el) => {
    const b = el.getBoundingClientRect();
    return b.right > card.getBoundingClientRect().right + 2 || b.left < card.getBoundingClientRect().left - 2;
  }).map((el) => el.id || el.className);
  return { card: r(card), seq: r(seq), tape: r(tape), head: r(head), rows, visibleRows, overflow };
});
console.log(JSON.stringify(drums, null, 1));
ok(drums.seq.h >= 390 - 30, `sequencer ~full height (${drums.seq.h})`);
ok(drums.seq.w >= 844 * 0.55, `sequencer owns the wide column (${drums.seq.w})`);
ok(drums.head.x > drums.seq.x + drums.seq.w - 4, 'drum controls in the right rail');
ok(drums.visibleRows >= 6, `most drum rows visible (${drums.visibleRows}/${drums.rows})`);
ok(drums.overflow.length === 0, `no card children clipped horizontally (${drums.overflow})`);
await page.screenshot({ path: 'scripts/shots/landscape-drums.png' });

// Open Advanced — the rail should scroll while the tape stays pinned.
await page.evaluate(() => document.getElementById('host-drum-adv-check')?.click());
await sleep(500);
const adv = await page.evaluate(() => {
  const card = document.querySelector('#host-drums-sheet .fx-sheet__card');
  const seq = document.getElementById('sequencer');
  const before = seq.getBoundingClientRect().top;
  card.scrollTop = 260;
  return { before, after: seq.getBoundingClientRect().top, cardTop: card.scrollTop };
});
console.log('adv scroll pin:', adv);
ok(adv.cardTop > 100, `card rail scrolls with Advanced open (${adv.cardTop})`);
ok(Math.abs(adv.after - adv.before) < 20, `sequencer stays pinned while rail scrolls (${adv.before} → ${adv.after})`);
await page.screenshot({ path: 'scripts/shots/landscape-drums-adv.png' });

await browser.close();
if (fails.length) {
  console.log(`\n${fails.length} FAIL: ${fails.join(', ')}`);
  process.exit(1);
}
console.log('\nLANDSCAPE SHEETS OK');
