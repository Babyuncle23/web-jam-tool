/**
 * Drum machine smoke test: host + one guest.
 * - Guest opens the drum sheet (the button exists and works for guests).
 * - Broadcast grid reaches the guest.
 * - Guest tap writes back to the host (with repeat expansion).
 * - Repeat chips + triplet write mode behave.
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:43117';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const errors = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  protocolTimeout: 20000,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});

try {
  const host = await browser.newPage();
  host.on('pageerror', (e) => errors.push(`host pageerror: ${e.message}`));
  await host.setViewport({ width: 1360, height: 900 });
  await host.goto(`${BASE}/?role=host`, { waitUntil: 'domcontentloaded' });
  await pollExpr(host, '({ ok: Boolean(document.getElementById("splash-start")) })');
  await host.click('#splash-start');
  await pollExpr(host, `(() => {
    const jam = globalThis.__jam;
    return { ok: Boolean(jam && jam.audio && document.getElementById('host-code').textContent.length === 4) };
  })()`);
  const code = await host.evaluate(`document.getElementById('host-code').textContent`);

  const guest = await browser.newPage();
  guest.on('pageerror', (e) => errors.push(`guest pageerror: ${e.message}`));
  await guest.setViewport({ width: 390, height: 844 });
  await guest.goto(`${BASE}/?role=controller&code=${code}`, { waitUntil: 'domcontentloaded' });
  await pollExpr(guest, '({ ok: document.getElementById("controller-splash").hidden })');

  // 1. Guest can open the drum sheet and sees the host's grid.
  await clickSelector(guest, '#controller-drums');
  await pollExpr(guest, `({ ok: !document.getElementById('controller-drums-sheet').hidden })`);
  const guestSees = await pollExpr(guest, `(() => {
    const on = document.querySelectorAll('#controller-sequencer .step.is-on').length;
    const rows = document.querySelectorAll('#controller-sequencer .seq-row[data-track]').length;
    return { ok: on > 5 && rows === 7, on, rows };
  })()`);
  console.log('guest sees host grid:', JSON.stringify(guestSees));

  // 2. Repeat is on by default (1 bar chip picked).
  const repeatState = await guest.evaluate(`(() => ({
    picked: document.querySelector('#controller-drum-repeat [data-repeat-bars].is-picked')?.dataset.repeatBars,
    mirrors: document.querySelectorAll('#controller-sequencer .step.is-mirror').length,
  }))()`);
  console.log('repeat default:', JSON.stringify(repeatState));
  if (repeatState.picked !== '1') throw new Error('repeat default should be 1 bar');
  if (!repeatState.mirrors) throw new Error('mirror cells should be marked');

  // 3. Guest taps an empty cell: kick step 9 (index 8) is off in "break".
  //    With repeat on, it should light step 8 AND 24 locally and on the host.
  const wasOn = await guest.evaluate(`document.querySelector('#controller-sequencer .step[data-track="kick"][data-step="8"]').classList.contains('is-on')`);
  await clickSelector(guest, '#controller-sequencer .step[data-track="kick"][data-step="8"]');
  await sleep(300);
  const localMirror = await guest.evaluate(`({
    a: document.querySelector('#controller-sequencer .step[data-track="kick"][data-step="8"]').classList.contains('is-on'),
    b: document.querySelector('#controller-sequencer .step[data-track="kick"][data-step="24"]').classList.contains('is-on'),
  })`);
  console.log('guest tap wasOn(before):', wasOn, 'after:', JSON.stringify(localMirror));
  const hostMirror = await pollExpr(host, `(() => {
    const on = [8, 9, 24, 25].map((s) => document.querySelector('#sequencer .step[data-track="kick"][data-step="'+s+'"]')?.classList.contains('is-on'));
    // Repeat mirrors onto 8 and 24 only — the cells between must stay untouched.
    const expected = ${JSON.stringify([!wasOn, false, !wasOn, false])};
    return { ok: JSON.stringify(on) === JSON.stringify(expected), on };
  })()`);
  console.log('host mirror write:', JSON.stringify(hostMirror));

  // 4. A drag across cells writes nothing — drags belong to scrolling now.
  const box = await guest.evaluate(`(() => {
    const first = document.querySelector('#controller-sequencer .step[data-track="snare"][data-step="2"]');
    const last = document.querySelector('#controller-sequencer .step[data-track="snare"][data-step="5"]');
    const a = first.getBoundingClientRect();
    const b = last.getBoundingClientRect();
    return { x1: a.x + a.width / 2, y: a.y + a.height / 2, x2: b.x + b.width / 2 };
  })()`);
  const beforeDrag = await guest.evaluate(`[2,3,4,5].map((s) => document.querySelector('#controller-sequencer .step[data-track="snare"][data-step="'+s+'"]').classList.contains('is-on'))`);
  await guest.mouse.move(box.x1, box.y);
  await guest.mouse.down();
  await guest.mouse.move((box.x1 + box.x2) / 2, box.y, { steps: 5 });
  await guest.mouse.move(box.x2, box.y, { steps: 5 });
  await guest.mouse.up();
  await sleep(300);
  const afterDrag = await guest.evaluate(`[2,3,4,5].map((s) => document.querySelector('#controller-sequencer .step[data-track="snare"][data-step="'+s+'"]').classList.contains('is-on'))`);
  console.log('guest drag wrote nothing:', JSON.stringify(beforeDrag), '→', JSON.stringify(afterDrag));
  if (JSON.stringify(beforeDrag) !== JSON.stringify(afterDrag)) throw new Error('a drag changed cells');
  const hostDrag = await pollExpr(host, `(() => {
    const cells = [2, 3, 4, 5].map((s) => document.querySelector('#sequencer .step[data-track="snare"][data-step="'+s+'"]')?.classList.contains('is-on'));
    return { ok: JSON.stringify(cells) === ${JSON.stringify(JSON.stringify(beforeDrag))}, cells };
  })()`);
  console.log('host unchanged after drag:', JSON.stringify(hostDrag));

  // 5. Triplet write mode on the guest — lives in the advanced drum panel.
  await clickSelector(guest, '#controller-drum-adv-check');
  await pollExpr(guest, `({ ok: !document.getElementById('controller-drum-adv').hidden })`);
  await clickSelector(guest, '#controller-drum-write [data-write="triplet"]');
  await clickSelector(guest, '#controller-sequencer .step[data-track="clap"][data-step="0"]');
  await sleep(300);
  const tripletOn = await guest.evaluate(`document.querySelector('#controller-sequencer .step[data-track="clap"][data-step="0"]').classList.contains('is-triplet')`);
  const hostTriplet = await pollExpr(host, `(() => {
    const cell = document.querySelector('#sequencer .step[data-track="clap"][data-step="0"]');
    return { ok: cell?.classList.contains('is-triplet') === ${tripletOn}, on: cell?.classList.contains('is-triplet') };
  })()`);
  console.log('triplet write guest:', tripletOn, 'host:', JSON.stringify(hostTriplet));

  // 6. Repeat off on the host: write stops mirroring, notes stay.
  const hostPage = host;
  await clickSelector(hostPage, '#btn-drums');
  await pollExpr(hostPage, `({ ok: !document.getElementById('host-drums-sheet').hidden })`);
  await clickSelector(hostPage, '#host-drum-adv-check');
  await pollExpr(hostPage, `({ ok: !document.getElementById('host-drum-adv').hidden })`);
  await clickSelector(hostPage, '#host-drum-repeat [data-repeat-bars="off"]');
  await sleep(200);
  const before = await hostPage.evaluate(`(() => ({
    hatOn: [...document.querySelectorAll('#sequencer .step[data-track="hat"]')].map((b) => b.classList.contains('is-on')),
  }))()`);
  await clickSelector(hostPage, '#sequencer .step[data-track="hat"][data-step="1"]');
  await sleep(200);
  const afterOff = await hostPage.evaluate(`(() => ({
    a: document.querySelector('#sequencer .step[data-track="hat"][data-step="1"]').classList.contains('is-on'),
    b: document.querySelector('#sequencer .step[data-track="hat"][data-step="17"]').classList.contains('is-on'),
  }))()`);
  console.log('repeat off: wrote cell', JSON.stringify(afterOff), 'hat row was', before.hatOn.slice(0, 8).join(','));
  if (afterOff.a !== true || afterOff.b !== false) throw new Error('repeat off should write only the tapped cell');
  // turning repeat back on re-tiles
  await clickSelector(hostPage, '#host-drum-repeat [data-repeat-bars="1"]');
  await sleep(200);
  const retiled = await hostPage.evaluate(`(() => ({
    a: document.querySelector('#sequencer .step[data-track="hat"][data-step="1"]').classList.contains('is-on'),
    b: document.querySelector('#sequencer .step[data-track="hat"][data-step="17"]').classList.contains('is-on'),
  }))()`);
  console.log('repeat back on re-tiles:', JSON.stringify(retiled));
  if (retiled.a !== true || retiled.b !== true) throw new Error('repeat re-tile failed');

  // 7. Jersey preset uses 2-bar repeat by default.
  await clickSelector(hostPage, '#drum-presets [data-preset]');
  // pick jersey explicitly
  await hostPage.evaluate(`(() => {
    const chip = [...document.querySelectorAll('#drum-presets .chip')].find((c) => c.dataset.preset === 'jersey');
    chip?.click();
  })()`);
  await sleep(200);
  const jerseyRepeat = await hostPage.evaluate(`document.querySelector('#host-drum-repeat [data-repeat-bars].is-picked')?.dataset.repeatBars`);
  console.log('jersey default repeat:', jerseyRepeat);
  if (jerseyRepeat !== '2') throw new Error('jersey should default to 2 bars');

  if (errors.length) throw new Error(errors.join('\n'));
  console.log('DRUM SMOKE OK');
} finally {
  await browser.close();
}
