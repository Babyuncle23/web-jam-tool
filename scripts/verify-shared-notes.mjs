/**
 * Shared-notes check: a note a guest places in its roll must render in the
 * host's roll and in another guest's roll, marked read-only (is-remote).
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
  await pollExpr(host, '({ ok: Boolean(document.getElementById("splash-start")) })');
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

  // Guest A opens the notes sheet and taps one in-scale cell (a C row).
  await clickSelector(guestA, '#controller-notes');
  await pollExpr(guestA, `(() => {
    const tape = document.getElementById('controller-note-tape');
    return { ok: Boolean(tape?.__midis?.length), rows: tape?.__midis?.length || 0 };
  })()`);
  const tap = await guestA.evaluate(`(() => {
    const tape = document.getElementById('controller-note-tape');
    const grid = tape.querySelector('.roll__grid');
    const midis = tape.__midis;
    const row = midis.findIndex((m) => m % 12 === 0);
    tape.scrollTop = 26 + row * 28 - tape.clientHeight / 2;
    tape.scrollLeft = 0;
    const rect = grid.getBoundingClientRect();
    return {
      x: rect.left + 4 * tape.__stepPx + tape.__stepPx / 2,
      y: rect.top + row * 28 + 14,
      midi: midis[row],
    };
  })()`);
  await guestA.mouse.click(tap.x, tap.y);

  // Host sees the guest note in its recorder and in the open roll.
  await pollExpr(host, `(() => {
    const loops = window.__jam.audio?.loops;
    if (!loops) return { ok: false };
    let total = 0;
    for (const recorder of loops.values()) total += recorder.notes().length;
    return { ok: total >= 1, total };
  })()`);

  await clickSelector(host, '#btn-notes');
  const hostRoll = await pollExpr(host, `(() => {
    const all = document.querySelectorAll('#host-note-tape .roll__note');
    const remote = document.querySelectorAll('#host-note-tape .roll__note.is-remote');
    return { ok: all.length >= 1 && remote.length >= 1, all: all.length, remote: remote.length };
  })()`);

  // Guest B sees the same strip in its own roll, read-only.
  await clickSelector(guestB, '#controller-notes');
  const guestBRoll = await pollExpr(guestB, `(() => {
    const all = document.querySelectorAll('#controller-note-tape .roll__note');
    const remote = document.querySelectorAll('#controller-note-tape .roll__note.is-remote');
    return { ok: all.length >= 1 && remote.length === all.length, all: all.length, remote: remote.length };
  })()`);

  // Guest A sees it as its own (editable, not remote).
  const guestARoll = await pollExpr(guestA, `(() => {
    const all = document.querySelectorAll('#controller-note-tape .roll__note');
    const remote = document.querySelectorAll('#controller-note-tape .roll__note.is-remote');
    return { ok: all.length >= 1 && remote.length === 0, all: all.length, remote: remote.length };
  })()`);

  const serious = errors.filter((line) => /pageerror|TypeError|ReferenceError|is not a function/i.test(line));
  if (serious.length) throw new Error(serious.join('\n'));

  console.log(JSON.stringify({ ok: true, code, midi: tap.midi, hostRoll, guestARoll, guestBRoll, errors }, null, 2));
} finally {
  await browser.close();
}
