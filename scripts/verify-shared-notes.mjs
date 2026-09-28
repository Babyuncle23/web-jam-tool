/**
 * Shared-notes check: a note a guest places in its roll must render in the
 * host's roll and in another guest's roll, be editable from anywhere, and
 * clr all must wipe every player's loop (drums aside) with an undo path.
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:43117';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function watch(page, name) {
  page.on('pageerror', (error) => errors.push(`${name} pageerror: ${error.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`${name} console: ${msg.text()}`);
  });
}

async function pollExpr(page, expression, { timeout = 20000, interval = 250 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await page.evaluate(expression);
    if (last?.ok) return last;
    await sleep(interval);
  }
  throw new Error(`timeout ${timeout}ms: ${JSON.stringify(last)}`);
}

async function clickSelector(page, selector) {
  const point = await page.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  if (!point) throw new Error(`missing ${selector}`);
  await page.mouse.click(point.x, point.y);
}

/** Tap an empty in-scale cell of an open roll to place a note. */
async function placeNote(page, tapeSelector, step = 4) {
  const tap = await page.evaluate(`(() => {
    const tape = document.querySelector(${JSON.stringify(tapeSelector)});
    const grid = tape.querySelector('.roll__grid');
    const midis = tape.__midis;
    const row = midis.findIndex((m) => m % 12 === 0);
    tape.scrollTop = 26 + row * 28 - tape.clientHeight / 2;
    tape.scrollLeft = 0;
    const rect = grid.getBoundingClientRect();
    return { x: rect.left + ${step} * tape.__stepPx + tape.__stepPx / 2, y: rect.top + row * 28 + 14, midi: midis[row] };
  })()`);
  await page.mouse.click(tap.x, tap.y);
  return tap.midi;
}

/** Tap the first note strip of an open roll (deletes it). */
async function tapFirstStrip(page, tapeSelector) {
  const point = await page.evaluate(`(() => {
    const strip = document.querySelector(${JSON.stringify(tapeSelector)} + ' .roll__note');
    if (!strip) return null;
    strip.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = strip.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  if (!point) return false;
  await page.mouse.click(point.x, point.y);
  return true;
}

const loopTotal = `(() => {
  const loops = window.__jam.audio?.loops;
  if (!loops) return 0;
  let total = 0;
  for (const recorder of loops.values()) total += recorder.notes().length;
  return total;
})()`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 30000,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});

try {
  const host = await browser.newPage();
  watch(host, 'host');
  await host.setViewport({ width: 1360, height: 860 });
  await host.goto(`${BASE}/?role=host`, { waitUntil: 'domcontentloaded' });
  // Wait for the host view to finish entering — resetScreen swaps the splash node during entry.
  await pollExpr(host, '({ ok: document.body.dataset.view === "host" && Boolean(globalThis.__jam) })');
  await host.click('#splash-start');
  const boot = await pollExpr(host, `(() => {
    const splash = document.getElementById('audio-splash');
    const phase = splash ? splash.dataset.phase : '';
    return { ok: (splash && splash.hidden) || phase === 'error' || phase === 'warn', phase };
  })()`, { timeout: 25000 });
  if (boot.phase === 'error') throw new Error('host audio failed');
  if (boot.phase === 'warn') await clickSelector(host, '#splash-continue');

  const code = await host.evaluate('window.__jam.code');

  const guestA = await browser.newPage();
  watch(guestA, 'guestA');
  await guestA.setViewport({ width: 390, height: 844 });
  await guestA.goto(`${BASE}/?role=controller&code=${code}`, { waitUntil: 'domcontentloaded' });
  await pollExpr(guestA, '({ ok: document.getElementById("controller-splash").hidden })');

  const guestB = await browser.newPage();
  watch(guestB, 'guestB');
  await guestB.setViewport({ width: 390, height: 844 });
  await guestB.goto(`${BASE}/?role=controller&code=${code}`, { waitUntil: 'domcontentloaded' });
  await pollExpr(guestB, '({ ok: document.getElementById("controller-splash").hidden })');

  // Guest A places a note; host and guest B must see it.
  await clickSelector(guestA, '#controller-notes');
  await pollExpr(guestA, '({ ok: Boolean(document.getElementById("controller-note-tape")?.__midis?.length) })');
  const midi = await placeNote(guestA, '#controller-note-tape');
  await pollExpr(host, `(() => ({ ok: ${loopTotal} >= 1, total: ${loopTotal} }))()`);

  await clickSelector(host, '#btn-notes');
  const hostSees = await pollExpr(host, `(() => ({
    ok: document.querySelectorAll('#host-note-tape .roll__note').length >= 1,
    all: document.querySelectorAll('#host-note-tape .roll__note').length,
  }))()`);

  await clickSelector(guestB, '#controller-notes');
  const guestBSees = await pollExpr(guestB, `(() => ({
    ok: document.querySelectorAll('#controller-note-tape .roll__note').length >= 1,
    all: document.querySelectorAll('#controller-note-tape .roll__note').length,
  }))()`);

  // The carousel switches what guest B edits: pad → bass, roll follows, back to pad.
  await clickSelector(guestB, '#controller-inst-next');
  await pollExpr(guestB, `(() => ({
    ok: document.querySelector('#controller-inst-name .chip-label')?.textContent.trim() === 'Bass'
      && document.getElementById('controller-note-tape').__instrument === 'bass'
      && document.querySelector('#controller-instruments [data-instrument="bass"]')?.classList.contains('is-on'),
  }))()`);
  await clickSelector(guestB, '#controller-inst-prev');
  await pollExpr(guestB, `(() => ({
    ok: document.querySelector('#controller-inst-name .chip-label')?.textContent.trim() === 'Pad'
      && document.getElementById('controller-note-tape').__instrument === 'pad',
  }))()`);

  // Guest B edits guest A's note: a tap deletes it.
  if (!(await tapFirstStrip(guestB, '#controller-note-tape'))) throw new Error('guest B found no strip to tap');
  await pollExpr(host, `(() => ({ ok: ${loopTotal} === 0, total: ${loopTotal} }))()`);

  // The host's Undo all brings it back on every screen.
  await clickSelector(host, '#host-undo-all');
  await pollExpr(host, `(() => ({ ok: ${loopTotal} >= 1, total: ${loopTotal} }))()`);
  await pollExpr(guestA, `(() => ({
    ok: document.querySelectorAll('#controller-note-tape .roll__note').length >= 1,
  }))()`);

  // Host also places a note. A tap on guest B's clr clears only B's own
  // (empty) loop — nobody else's notes move. Holding it clears every loop.
  await placeNote(host, '#host-note-tape', 8);
  await pollExpr(host, `(() => ({ ok: ${loopTotal} >= 2, total: ${loopTotal} }))()`);
  await clickSelector(guestB, '#controller-notes-close');
  await guestB.evaluate(() => {
    const btn = document.getElementById('controller-loop-clear');
    btn.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true }));
  });
  await sleep(80);
  await guestB.evaluate(() => {
    const btn = document.getElementById('controller-loop-clear');
    btn.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
  });
  await sleep(400);
  await pollExpr(host, `(() => ({ ok: ${loopTotal} >= 2, total: ${loopTotal} }))()`);

  await guestB.evaluate(() => {
    const btn = document.getElementById('controller-loop-clear');
    btn.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true }));
  });
  await sleep(700);
  await guestB.evaluate(() => {
    const btn = document.getElementById('controller-loop-clear');
    btn.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
  });
  await pollExpr(host, `(() => ({ ok: ${loopTotal} === 0, total: ${loopTotal} }))()`);
  await pollExpr(guestA, `(() => ({
    ok: document.querySelectorAll('#controller-note-tape .roll__note').length === 0,
  }))()`);

  // The held clear-all lands in the shared history: the guest's own undo
  // arrow restores it.
  await clickSelector(guestB, '#controller-loop-undo');
  await pollExpr(host, `(() => ({ ok: ${loopTotal} >= 2, total: ${loopTotal} }))()`);

  const serious = errors.filter((line) => /pageerror|TypeError|ReferenceError|is not a function/i.test(line));
  if (serious.length) throw new Error(serious.join('\n'));

  console.log(JSON.stringify({ ok: true, code, midi, hostSees, guestBSees, errors }, null, 2));
} finally {
  await browser.close();
}
