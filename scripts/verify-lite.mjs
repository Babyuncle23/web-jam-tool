/**
 * Lite-mode smoke: the role-screen toggle, ?lite= override, trimmed FX chips
 * on host and guest, and the lite flag in host:state.
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

async function openHost(browser, url) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`host pageerror: ${e.message}`));
  await page.setViewport({ width: 1360, height: 900 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await pollExpr(page, '({ ok: document.body.dataset.view === "host" && Boolean(globalThis.__jam) })');
  await page.click('#splash-start');
  await pollExpr(page, '({ ok: Boolean(globalThis.__jam && globalThis.__jam.audio) })');
  return page;
}

const hostFx = (page, inst) =>
  page.evaluate(`(async () => {
    document.querySelector('#instrument-row [data-instrument="${inst}"]')?.click();
    await new Promise((r) => setTimeout(r, 80));
    return [...document.querySelectorAll('#instrument-fx .fx-chip')].map((b) => b.dataset.fx);
  })()`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 30000,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});

try {
  // Role screen: the toggle exists and carries the ?lite= hint.
  const role = await browser.newPage();
  await role.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const roleUi = await role.evaluate(`({
    check: Boolean(document.getElementById('role-lite')),
    label: document.getElementById('btn-role-host')?.textContent,
    checked: document.getElementById('role-lite')?.checked,
  })`);
  console.log('role screen:', JSON.stringify(roleUi));
  if (!roleUi.check) errors.push('role screen: no #role-lite checkbox');
  await role.close();

  // Full host: full chip sets, no lite pill.
  const full = await openHost(browser, `${BASE}/?role=host&lite=0`);
  const fullUi = await full.evaluate(`({
    pillHidden: document.getElementById('host-lite-pill')?.hidden,
    instFx: [...document.querySelectorAll('#instrument-fx .fx-chip')].map((b) => b.dataset.fx),
    drumFx: [...document.querySelectorAll('#drum-fx .fx-chip')].map((b) => b.dataset.fx),
    qr: Boolean(document.querySelector('#host-qr img')),
    code: document.getElementById('host-code')?.textContent,
  })`);
  console.log('full host:', JSON.stringify(fullUi));
  if (fullUi.pillHidden !== true) errors.push('full host: lite pill visible');
  if (fullUi.instFx.length !== 3) errors.push(`full host: expected 3 instrument chips, got ${fullUi.instFx.length}`);
  if (fullUi.drumFx.length !== 3) errors.push(`full host: expected 3 drum chips, got ${fullUi.drumFx.length}`);
  if (!fullUi.qr) errors.push('full host: QR image was never painted');
  if (!/^[A-Z2-9]{4}$/.test(fullUi.code || '')) errors.push(`full host: bad session code "${fullUi.code}"`);
  await full.close();

  // Lite host: instruments run dry (bass cutoff is the only surviving node)
  // and the UI shows no FX controls — both chip rows stay empty and hidden.
  const lite = await openHost(browser, `${BASE}/?role=host&lite=1`);
  const liteUi = await lite.evaluate(`({
    pillHidden: document.getElementById('host-lite-pill')?.hidden,
    instFx: [...document.querySelectorAll('#instrument-fx .fx-chip')].map((b) => b.dataset.fx),
    drumFx: [...document.querySelectorAll('#drum-fx .fx-chip')].map((b) => b.dataset.fx),
    instFxHidden: document.getElementById('instrument-fx')?.hidden,
    drumFxHidden: document.getElementById('drum-fx')?.hidden,
  })`);
  console.log('lite host:', JSON.stringify(liteUi));
  if (liteUi.pillHidden !== false) errors.push('lite host: lite pill hidden');
  if (liteUi.instFx.length !== 0 || liteUi.instFxHidden !== true) {
    errors.push(`lite host: expected no instrument chips, got ${JSON.stringify(liteUi.instFx)}`);
  }
  if (liteUi.drumFx.length !== 0 || liteUi.drumFxHidden !== true) {
    errors.push(`lite host: expected no drum chips, got ${JSON.stringify(liteUi.drumFx)}`);
  }
  // Kalimba must lose the ScriptProcessor reverse entirely.
  const kalimbaFx = await hostFx(lite, 'kalimba');
  console.log('lite kalimba chips:', JSON.stringify(kalimbaFx));
  if (kalimbaFx.includes('reverse')) errors.push('lite host: kalimba still shows reverse');

  // The deeper cuts: 24 kHz context, wide lookAhead. The drums are the
  // tradeoff — lite loads the full 808 kit just like the full rig.
  const liteAudio = await lite.evaluate(`({
    rate: globalThis.__jam?.audio?.engine?.sampleRate,
    lookAhead: globalThis.__jam?.audio?.engine?.tone?.getContext?.().lookAhead,
    usingSamples: globalThis.__jam?.audio?.drums?.sampleState?.usingSamples,
    openhat: globalThis.__jam?.audio?.drums?.sampleState?.tracks?.openhat,
    kick: globalThis.__jam?.audio?.drums?.sampleState?.tracks?.kick,
  })`);
  console.log('lite audio:', JSON.stringify(liteAudio));
  if (!(liteAudio.rate > 0 && liteAudio.rate <= 24000)) errors.push(`lite host: sampleRate ${liteAudio.rate}, expected ≤24000`);
  if (!(liteAudio.lookAhead >= 0.04)) errors.push(`lite host: lookAhead ${liteAudio.lookAhead}, expected ≥0.04`);
  if (liteAudio.usingSamples !== true) errors.push('lite host: drum samples did not load');
  if (liteAudio.openhat !== 'sample') errors.push('lite host: the 808 open-hat sample did not load');
  if (liteAudio.kick !== 'sample') errors.push('lite host: kick should play the 808 sample');

  // Guest on the lite host sees no chips either — lite exposes no FX
  // controls at all.
  const code = await lite.evaluate(`document.getElementById('host-code').textContent`);
  const guest = await browser.newPage();
  guest.on('pageerror', (e) => errors.push(`guest pageerror: ${e.message}`));
  await guest.setViewport({ width: 390, height: 844 });
  await guest.goto(`${BASE}/?role=controller&code=${code}`, { waitUntil: 'domcontentloaded' });
  await pollExpr(guest, '({ ok: document.getElementById("controller-splash").hidden })');
  // The chips live behind the Advanced sheet on the guest.
  await guest.evaluate(`document.getElementById('controller-advanced')?.click()`);
  await sleep(400);
  const guestFx = await guest.evaluate(
    `[...document.querySelectorAll('#controller-fx .fx-chip')].map((b) => b.dataset.fx)`,
  );
  console.log('guest on lite host:', JSON.stringify(guestFx));
  if (guestFx.length !== 0) {
    errors.push(`guest on lite host: expected no chips, got ${JSON.stringify(guestFx)}`);
  }
  await guest.close();
  await lite.close();
} finally {
  await browser.close();
}

if (errors.length) {
  console.error('FAIL:', errors.join('; '));
  process.exit(1);
}
console.log('verify-lite: OK');
