/**
 * Lite↔full context swap on a single tab: entering lite installs the 24 kHz
 * context, entering full afterwards must restore a device-rate context, and
 * re-entering lite must reuse it — contexts must not multiply.
 * Run: node scripts/verify-context-swap.mjs [baseUrl]
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

async function waitForAudio(page) {
  await page.click('#splash-start');
  await pollExpr(page, '({ ok: Boolean(globalThis.__jam && globalThis.__jam.audio) })');
}

async function audioInfo(page) {
  return page.evaluate(`({
    rate: globalThis.__jam.audio?.engine?.sampleRate ?? 0,
    contexts: (globalThis.__ctxs ?? []).map((c) => c.state),
  })`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.evaluateOnNewDocument(`(() => {
    const Ctor = globalThis.AudioContext;
    globalThis.__ctxs = [];
    globalThis.AudioContext = class extends Ctor {
      constructor(...args) { super(...args); globalThis.__ctxs.push(this); }
    };
  })()`);
  await page.setViewport({ width: 1360, height: 900 });

  // 1) lite first — engine swaps Tone onto the 24 kHz context.
  await page.goto(`${BASE}?role=host&lite=1`, { waitUntil: 'domcontentloaded' });
  await pollExpr(page, '({ ok: document.body.dataset.view === "host" })');
  await waitForAudio(page);
  const lite1 = await audioInfo(page);
  if (lite1.rate !== 24000) throw new Error(`lite rate ${lite1.rate}, expected 24000`);
  console.log('lite #1:', JSON.stringify(lite1));

  // 2) back → full: the lite context must be replaced by a device-rate one.
  await page.click('[data-action="back"]');
  await pollExpr(page, '({ ok: document.body.dataset.view === "role" })');
  await page.evaluate(`(document.getElementById('role-lite').checked = false)`);
  await page.click('#btn-role-host');
  await pollExpr(page, '({ ok: document.body.dataset.view === "host" })');
  await waitForAudio(page);
  const full = await audioInfo(page);
  if (full.rate === 24000) throw new Error('full session still on the lite 24kHz context');
  console.log('full after lite:', JSON.stringify(full));

  // 3) back → lite again: reuse the cached lite context — no growth.
  await page.click('[data-action="back"]');
  await pollExpr(page, '({ ok: document.body.dataset.view === "role" })');
  await page.evaluate(`(document.getElementById('role-lite').checked = true)`);
  await page.click('#btn-role-host');
  await pollExpr(page, '({ ok: document.body.dataset.view === "host" })');
  await waitForAudio(page);
  const lite2 = await audioInfo(page);
  if (lite2.rate !== 24000) throw new Error(`lite re-entry rate ${lite2.rate}, expected 24000`);
  if (lite2.contexts.length !== full.contexts.length) {
    throw new Error(`contexts grew: ${full.contexts.length} → ${lite2.contexts.length}`);
  }
  console.log('lite #2:', JSON.stringify(lite2));

  const running = lite2.contexts.filter((s) => s === 'running').length;
  console.log(`contexts total: ${lite2.contexts.length}, running: ${running}`);
  if (running > 2) throw new Error(`${running} contexts still running`);

  if (errors.length) throw new Error(errors.join(' | '));
  console.log('verify-context-swap: OK');
} finally {
  await browser.close();
}
