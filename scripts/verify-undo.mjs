/**
 * Undo-history probe: after one undo, recording a fresh take from the pad
 * must leave the undo arrow armed for the new take — the history entry is
 * consumed from BOTH the per-editor and the shared stack, so nothing stale
 * is left to eat a later undo. Also: clr all is undone by the same arrow,
 * redo puts a consumed entry back on both stacks, and an undo landing inside
 * an open take does not stop the recording.
 *
 * Usage: node scripts/verify-undo.mjs
 */
import puppeteer from 'puppeteer-core';

const BASE_URL = 'http://127.0.0.1:43117';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const loopTotal = `(() => {
  const loops = window.__jam.audio?.loops;
  if (!loops) return 0;
  let total = 0;
  for (const recorder of loops.values()) total += recorder.notes().length;
  return total;
})()`;

const undoEnabled = `(() => {
  const button = document.getElementById('btn-loop-undo');
  return button && button.getAttribute('aria-disabled') !== 'true' && !button.disabled;
})()`;

const redoEnabled = `(() => {
  const button = document.getElementById('btn-loop-redo');
  return button && button.getAttribute('aria-disabled') !== 'true' && !button.disabled;
})()`;

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

async function recordTap(page) {
  await page.evaluate(() => document.getElementById('btn-loop').click()); // rec on
  await sleep(150);
  await page.evaluate(firePointer, 'pointerdown', 1, 0.4, 0.6);
  await sleep(350);
  await page.evaluate(firePointer, 'pointerup', 1, 0.4, 0.6);
  await page.evaluate(() => document.getElementById('btn-loop').click()); // rec off
  await sleep(150);
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
await page.waitForSelector('#splash-start');
await page.evaluate(() => document.getElementById('splash-start').click());
await page.waitForFunction(() => document.getElementById('host-audio-status').dataset.state === 'online', {
  timeout: 20000,
});

const results = [];
const check = (name, actual, want) => {
  const ok = actual === want;
  results.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${actual} (want ${want})`);
};

// Take 1 → undo → the arrow must disarm and the loop must empty.
await recordTap(page);
check('take 1 recorded', await page.evaluate(loopTotal) >= 1, true);
await page.evaluate(() => document.getElementById('btn-loop-undo').click());
await sleep(200);
check('take 1 undone', await page.evaluate(loopTotal), 0);
check('undo disarmed after consuming the entry', await page.evaluate(undoEnabled), false);

// The reported bug: undo again after a fresh take from the pad.
await recordTap(page);
check('take 2 recorded after an undo', await page.evaluate(loopTotal) >= 1, true);
check('undo re-armed for take 2', await page.evaluate(undoEnabled), true);
await page.evaluate(() => document.getElementById('btn-loop-undo').click());
await sleep(200);
check('take 2 undone', await page.evaluate(loopTotal), 0);

// Redo brings the take back; undo must work once more afterwards.
await page.evaluate(() => document.getElementById('btn-loop-redo').click());
await sleep(200);
check('take 2 redone', await page.evaluate(loopTotal) >= 1, true);
await page.evaluate(() => document.getElementById('btn-loop-undo').click());
await sleep(200);
check('take 2 undone again after redo', await page.evaluate(loopTotal), 0);

// A tap on clr clears only your own loop and is reverted by the undo arrow;
// holding the button clears everyone's loops instead.
const pressClear = (ms) => page.evaluate(async (holdMs) => {
  const btn = document.getElementById('btn-loop-clear');
  btn.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  btn.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
}, ms);

await recordTap(page);
await pressClear(60); // quick tap — own loop only
await sleep(200);
check('tap clr emptied the loop', await page.evaluate(loopTotal), 0);
await page.evaluate(() => document.getElementById('btn-loop-undo').click());
await sleep(200);
check('tap clr undone by the undo arrow', await page.evaluate(loopTotal) >= 1, true);
check('redo armed', await page.evaluate(redoEnabled), true);

await recordTap(page);
await pressClear(700); // hold — clear every player's loop
await sleep(200);
check('hold clr emptied the loop', await page.evaluate(loopTotal), 0);
await page.evaluate(() => document.getElementById('btn-loop-undo').click());
await sleep(200);
check('hold clr undone by the undo arrow', await page.evaluate(loopTotal) >= 1, true);

// Undo landing inside an open take no longer ends it: the recorder keeps
// writing, and the still-held finger simply starts a fresh note on its next
// move — closed by its own 'up'. With per-take history the undo pops the
// last completed take, so the loop drops that take's notes, then the held
// finger's fresh take lands as its own entry.
const beforeTake = await page.evaluate(loopTotal);
await page.evaluate(() => document.getElementById('btn-loop').click()); // rec on
await sleep(150);
await page.evaluate(firePointer, 'pointerdown', 1, 0.6, 0.4);
await sleep(250);
await page.evaluate(() => document.getElementById('btn-loop-undo').click());
await sleep(150);
check('undo mid-take keeps recording', await page.evaluate(`window.__jam.loopFor('host').isRecording`), true);
check('mid-take undo removed the last take', await page.evaluate(loopTotal), beforeTake - 1);
await page.evaluate(firePointer, 'pointermove', 1, 0.7, 0.5);
await page.evaluate(firePointer, 'pointerup', 1, 0.7, 0.5);
await sleep(150);
check('held finger writes one fresh note after undo', await page.evaluate(loopTotal), beforeTake);
check('undo re-armed for the fresh take', await page.evaluate(undoEnabled), true);
await page.evaluate(() => document.getElementById('btn-loop').click()); // rec off

await browser.close();
const pass = results.every(Boolean);
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
