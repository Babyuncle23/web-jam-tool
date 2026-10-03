/**
 * Host-entry resilience regression:
 *  1. A blocked Socket.io transport must NOT bounce the page back to the
 *     role screen — the request waits for the backend and the session opens
 *     as soon as the socket connects.
 *  2. Backing out while the session is still opening must discard the late
 *     view — no stray room behind a hidden screen.
 *  3. FX-pad heal: if the engine's stutter hold drops while the mirrored
 *     state still claims it (e.g. a capture that threw mid-schedule), the
 *     next pad move must re-grab instead of silently skipping setHold.
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:43117';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(page, expression, { timeout = 25000, interval = 300 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await page.evaluate(expression);
    if (last?.ok) return last;
    await sleep(interval);
  }
  throw new Error(`timeout ${timeout}ms: ${JSON.stringify(last)}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 30000,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});

try {
  /* ---------- 1. blocked transport: wait instead of bouncing ---------- */
  let page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror p1: ${e.message}`));
  let blocked = true;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (blocked && /\/socket\.io\/\?/.test(req.url())) return req.abort();
    req.continue();
  });
  await page.goto(`${BASE}/?role=host&lite=0`, { waitUntil: 'domcontentloaded' });
  await sleep(11000); // the old 8 s emit timeout would already have bounced
  const during = await page.evaluate(`({
    view: document.body.dataset.view,
    status: document.getElementById('host-socket-status')?.textContent,
  })`);
  console.log('blocked 11 s in:', JSON.stringify(during));
  if (during.view !== 'host') errors.push(`bounced to "${during.view}" while the socket was still dialing`);
  blocked = false;
  await poll(page, '({ ok: /^[A-Z2-9]{4}$/.test(document.getElementById("host-code")?.textContent || "") })');
  const opened = await page.evaluate(`({
    code: document.getElementById('host-code')?.textContent,
    qr: Boolean(document.querySelector('#host-qr img')),
    status: document.getElementById('host-socket-status')?.textContent,
  })`);
  console.log('after unblock:', JSON.stringify(opened));
  if (!opened.qr) errors.push('QR never painted after the socket recovered');
  await page.close();

  /* ---------- 2. back-out while the session is still opening ---------- */
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror p2: ${e.message}`));
  blocked = true;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (blocked && /\/socket\.io\/\?/.test(req.url())) return req.abort();
    req.continue();
  });
  await page.goto(`${BASE}/?role=host&lite=0`, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  // Back needs a hold or a confirming second tap — a bare click only arms it.
  await page.click('[data-action="back"]');
  await page.click('[data-action="back"]');
  const backed = await page.evaluate(`({ view: document.body.dataset.view })`);
  console.log('after back:', JSON.stringify(backed));
  if (backed.view !== 'role') errors.push('back did not return to the role screen');
  blocked = false;
  await sleep(6000); // the socket now connects — the late view must not adopt
  const stale = await page.evaluate(`({
    view: document.body.dataset.view,
    jam: typeof globalThis.__jam,
  })`);
  console.log('late result:', JSON.stringify(stale));
  if (stale.view !== 'role') errors.push('a late host view replaced the role screen');
  if (stale.jam !== 'undefined') errors.push('a late host view stayed alive after back-out');
  // Re-entry after all that still works.
  await page.click('#btn-role-host');
  await poll(page, '({ ok: /^[A-Z2-9]{4}$/.test(document.getElementById("host-code")?.textContent || "") })');
  console.log('re-entry opened a session');
  await page.close();

  /* ---------- 3. FX-pad heals a dead engine hold ---------- */
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror p3: ${e.message}`));
  await page.setViewport({ width: 1360, height: 900 });
  await page.goto(`${BASE}/?role=host&lite=0`, { waitUntil: 'domcontentloaded' });
  await poll(page, '({ ok: Boolean(globalThis.__jam) })');
  await page.click('#splash-start');
  await poll(page, '({ ok: Boolean(globalThis.__jam?.audio) })');
  await page.click('#host-pad-mode [data-padmode="fx"]');
  await sleep(300);
  const pad = await (await page.$('#host-pad')).boundingBox();
  const px = (fx, fy) => [pad.x + pad.width * fx, pad.y + pad.height * (1 - fy)];
  await page.mouse.move(...px(0.9, 0.6));
  await page.mouse.down();
  await sleep(400);
  const held = await page.evaluate(`({ hold: globalThis.__jam.audio.engine.masterFx.holding() })`);
  console.log('stutter held:', JSON.stringify(held));
  if (!held.hold) errors.push('FX pad did not engage the stutter');
  // Simulate the desync: the engine released (a capture threw mid-schedule)
  // but the view still believes it holds — like before the heal.
  await page.evaluate(`globalThis.__jam.audio.engine.masterFx.setHold(false)`);
  const dead = await page.evaluate(`({ hold: globalThis.__jam.audio.engine.masterFx.holding() })`);
  if (dead.hold) errors.push('probe setup failed: stutter still held');
  await page.mouse.move(...px(0.85, 0.5), { steps: 3 });
  await sleep(300);
  const healed = await page.evaluate(`({
    hold: globalThis.__jam.audio.engine.masterFx.holding(),
    state: globalThis.__jam.masterFx.hold,
  })`);
  console.log('after stale-hold move:', JSON.stringify(healed));
  if (!healed.hold) errors.push('stutter stayed dead after the engine hold dropped');
  await page.mouse.up();
  await sleep(300);
  const released = await page.evaluate(`({ hold: globalThis.__jam.audio.engine.masterFx.holding() })`);
  if (released.hold) errors.push('stutter did not release after finger up');
  await page.close();
} finally {
  await browser.close();
}

if (errors.length) {
  console.error('FAIL:', errors.join('; '));
  process.exit(1);
}
console.log('verify-host-entry: OK');
