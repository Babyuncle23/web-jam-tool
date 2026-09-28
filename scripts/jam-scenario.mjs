/**
 * Host + guest pass: splash closes, the guest follows the host key, chord
 * captions change with Y, an instrument reaches the host, and that guest's
 * loop records and clears.
 *
 * Reads the page with Runtime.evaluate strings. Passing a function
 * (callFunctionOn) stalls the host tab once Tone is running.
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:43117';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const errors = [];

function watch(page, name) {
  page.on('pageerror', (error) => {
    errors.push(`${name} pageerror: ${error.message}`);
  });
}

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
  watch(host, 'host');
  await host.setViewport({ width: 1360, height: 860 });
  await host.goto(`${BASE}/?role=host`, { waitUntil: 'domcontentloaded' });
  // Wait for the host view to finish entering — resetScreen swaps the splash node during entry.
  await pollExpr(host, '({ ok: document.body.dataset.view === "host" && Boolean(globalThis.__jam) })');
  await host.click('#splash-start');
  const boot = await pollExpr(host, `(() => {
    const splash = document.getElementById('audio-splash');
    const phase = splash ? splash.dataset.phase : '';
    const hidden = Boolean(splash && splash.hidden);
    const error = document.getElementById('splash-error')?.textContent || '';
    return { ok: hidden || phase === 'error' || phase === 'warn', phase, hidden, error };
  })()`, { timeout: 25000 });
  if (boot.phase === 'error') throw new Error(`splash error: ${boot.error}`);
  if (!boot.hidden) {
    await clickSelector(host, '#splash-continue');
    await pollExpr(host, '({ ok: document.getElementById("audio-splash").hidden })');
  }

  const hostReady = await host.evaluate(`(() => {
    const loop = document.getElementById('btn-loop').getBoundingClientRect();
    return {
      harmony: window.__jam.harmony,
      locked: document.getElementById('host-pad').classList.contains('is-locked'),
      loopHeight: loop.height,
      scrollX: document.documentElement.scrollWidth - window.innerWidth,
    };
  })()`);
  if (!hostReady.harmony.audioReady || hostReady.locked) throw new Error(`host not ready ${JSON.stringify(hostReady)}`);
  if (hostReady.loopHeight < 44) throw new Error(`loop button clipped ${JSON.stringify(hostReady)}`);
  if (hostReady.scrollX > 1) throw new Error(`horizontal scroll ${JSON.stringify(hostReady)}`);

  const code = await host.evaluate('window.__jam.code');
  const guest = await browser.newPage();
  watch(guest, 'guest');
  await guest.setViewport({ width: 390, height: 844 });
  await guest.goto(`${BASE}/?role=controller&code=${code}`, { waitUntil: 'domcontentloaded' });
  await pollExpr(guest, '({ ok: document.getElementById("controller-splash").hidden })');

  const controls = await guest.evaluate(`(() => ({
    key: document.getElementById('controller-key').textContent,
    roots: document.querySelectorAll('#controller-screen [data-root]').length,
    scales: document.querySelectorAll('#controller-screen [data-scale]').length,
    padHeight: document.getElementById('pad').getBoundingClientRect().height,
  }))()`);
  if (controls.key !== 'C · Major') throw new Error(`guest key ${controls.key}`);
  if (controls.roots || controls.scales) throw new Error(`guest still has harmony controls ${JSON.stringify(controls)}`);
  if (controls.padHeight < 140) throw new Error(`guest pad too short ${controls.padHeight}`);

  await clickSelector(host, '#harmony-row [data-scale="minor"]');
  await pollExpr(guest, '({ ok: document.getElementById("controller-key").textContent.includes("Minor") })');
  await clickSelector(host, '#harmony-row [data-scale="major"]');
  await pollExpr(guest, '({ ok: document.getElementById("controller-key").textContent === "C · Major" })');

  await clickSelector(guest, '#controller-screen [data-mode="chords"]');
  await pollExpr(guest, '({ ok: !document.getElementById("controller-y-zones").hidden })');

  const box = await guest.evaluate(`(() => {
    const rect = document.getElementById('pad').getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`);

  async function hold(musicalX, musicalY) {
    const x = box.x + box.width * musicalX;
    const y = box.y + box.height * (1 - musicalY);
    await guest.mouse.move(x, y);
    await guest.mouse.down();
    const seen = await pollExpr(
      guest,
      '(() => { const label = document.getElementById("controller-harmony-label").textContent; return { ok: label !== "\\u2014" && label !== "—", label }; })()',
      { timeout: 4000 },
    );
    const expected = JSON.stringify(seen.label);
    await pollExpr(
      host,
      `(() => { const label = window.__jam.label; return { ok: label === ${expected}, label }; })()`,
      { timeout: 4000 },
    );
    await guest.mouse.up();
    return seen.label;
  }

  const low = await hold(0.03, 0.06);
  const high = await hold(0.03, 0.94);
  if (low !== 'C Maj') throw new Error(`low Y label ${low}`);
  if (high !== 'Cmaj9') throw new Error(`high Y label ${high}`);

  await clickSelector(guest, '#controller-instruments [data-instrument="bass"]');
  await pollExpr(
    host,
    '(() => ({ ok: window.__jam.lastRemote?.instrument === "bass", remote: window.__jam.lastRemote }))()',
    { timeout: 5000 },
  );

  // The host mirrors a caption only while its selected instrument matches the
  // guest's (sameInstrument gate in soundTouch), so follow the guest to bass
  // and the label check below stays end-to-end.
  await clickSelector(host, '#instrument-row [data-instrument="bass"]');
  await pollExpr(
    host,
    '({ ok: document.querySelector(\'#instrument-row [data-instrument="bass"]\').classList.contains("is-on") })',
    { timeout: 5000 },
  );

  await clickSelector(guest, '#controller-loop');
  await pollExpr(
    host,
    '(() => ({ ok: window.__jam.lastRemote?.recording === true, remote: window.__jam.lastRemote }))()',
    { timeout: 5000 },
  );
  const peerId = JSON.stringify(await host.evaluate('window.__jam.lastRemote.peerId'));
  await hold(0.2, 0.4);
  const recordedState = await pollExpr(
    host,
    `(() => { const length = window.__jam.loopFor(${peerId})?.length ?? 0; return { ok: length > 0, length }; })()`,
    { timeout: 4000 },
  );
  await clickSelector(guest, '#controller-loop-clear');
  await pollExpr(
    host,
    `(() => { const length = window.__jam.loopFor(${peerId})?.length ?? 0; return { ok: length === 0, length }; })()`,
    { timeout: 4000 },
  );

  const serious = errors.filter((line) => /pageerror|TypeError|ReferenceError|is not a function|NotSupported|InvalidState/i.test(line));
  if (serious.length) throw new Error(serious.join('\n'));

  console.log(JSON.stringify({
    ok: true,
    base: BASE,
    code,
    low,
    high,
    recorded: recordedState.length,
    notes: errors,
  }, null, 2));
} finally {
  await browser.close();
}
