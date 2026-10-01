/**
 * Lite-mode smoke: the role-screen toggle, ?lite= override, trimmed FX
 * sliders in the More sheets on host and guest, and the lite flag in
 * host:state.
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

/** Selects the instrument, opens its More sheet, and reads the FX sliders. */
const hostFx = (page, inst) =>
  page.evaluate(`(async () => {
    document.querySelector('#instrument-row [data-instrument="${inst}"]')?.click();
    await new Promise((r) => setTimeout(r, 80));
    document.querySelector('#instrument-row [data-more="${inst}"]')?.click();
    await new Promise((r) => setTimeout(r, 60));
    const ids = [...document.querySelectorAll('#host-fx-sliders [data-fx]')].map((i) => i.dataset.fx);
    document.getElementById('host-fx-sheet').hidden = true;
    return ids;
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

  // Full host: full slider sets in the More sheet, no lite pill.
  const full = await openHost(browser, `${BASE}/?role=host&lite=0`);
  const fullUi = await full.evaluate(`({
    pillHidden: document.getElementById('host-lite-pill')?.hidden,
    drumFx: [...document.querySelectorAll('#host-drum-fx .fx-slider')].length,
    moreButtons: document.querySelectorAll('#instrument-row .inst-card__more').length,
    qr: Boolean(document.querySelector('#host-qr img')),
    code: document.getElementById('host-code')?.textContent,
  })`);
  const fullInstFx = await hostFx(full, 'pad');
  console.log('full host:', JSON.stringify({ ...fullUi, instFx: fullInstFx }));
  if (fullUi.pillHidden !== true) errors.push('full host: lite pill visible');
  if (fullInstFx.length !== 3) errors.push(`full host: expected 3 pad fx sliders, got ${JSON.stringify(fullInstFx)}`);
  if (fullUi.drumFx !== 3) errors.push(`full host: expected 3 drum fx sliders, got ${fullUi.drumFx}`);
  if (!fullUi.qr) errors.push('full host: QR image was never painted');
  if (!/^[A-Z2-9]{4}$/.test(fullUi.code || '')) errors.push(`full host: bad session code "${fullUi.code}"`);
  await full.close();

  // Lite host: instruments run dry (bass cutoff is the only surviving node)
  // and the UI shows no FX controls — the More buttons hide entirely.
  const lite = await openHost(browser, `${BASE}/?role=host&lite=1`);
  const liteUi = await lite.evaluate(`({
    pillHidden: document.getElementById('host-lite-pill')?.hidden,
    isLite: document.getElementById('host-screen')?.classList.contains('is-lite'),
    drumFx: [...document.querySelectorAll('#host-drum-fx .fx-slider')].length,
    moreVisible: [...document.querySelectorAll('#instrument-row .inst-card__more')]
      .filter((b) => getComputedStyle(b).display !== 'none').length,
  })`);
  console.log('lite host:', JSON.stringify(liteUi));
  if (liteUi.pillHidden !== false) errors.push('lite host: lite pill hidden');
  if (!liteUi.isLite) errors.push('lite host: #host-screen missing .is-lite');
  const liteInstFx = await hostFx(lite, 'pad');
  if (liteInstFx.length !== 0) {
    errors.push(`lite host: expected no instrument fx sliders, got ${JSON.stringify(liteInstFx)}`);
  }
  if (liteUi.drumFx !== 0) {
    errors.push(`lite host: expected no drum fx sliders, got ${liteUi.drumFx}`);
  }
  if (liteUi.moreVisible !== 0) errors.push('lite host: MORE buttons must hide in lite mode');
  // Kalimba must lose the ScriptProcessor reverse entirely.
  const kalimbaFx = await hostFx(lite, 'kalimba');
  console.log('lite kalimba fx sliders:', JSON.stringify(kalimbaFx));
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

  // Guest on the lite host sees no FX sliders either — lite exposes no FX
  // controls at all.
  const code = await lite.evaluate(`document.getElementById('host-code').textContent`);
  const guest = await browser.newPage();
  guest.on('pageerror', (e) => errors.push(`guest pageerror: ${e.message}`));
  await guest.setViewport({ width: 390, height: 844 });
  await guest.goto(`${BASE}/?role=controller&code=${code}`, { waitUntil: 'domcontentloaded' });
  await pollExpr(guest, '({ ok: document.getElementById("controller-splash").hidden })');
  await sleep(400);
  const guestFx = await guest.evaluate(`(async () => {
    document.querySelector('#controller-instruments [data-more="pad"]')?.click();
    await new Promise((r) => setTimeout(r, 60));
    const fx = [...document.querySelectorAll('#controller-fx-sliders [data-fx]')].map((i) => i.dataset.fx);
    document.getElementById('controller-fx-sheet').hidden = true;
    return {
      fx,
      isLite: document.getElementById('controller-screen')?.classList.contains('is-lite'),
      moreVisible: [...document.querySelectorAll('#controller-instruments .inst-card__more')]
        .filter((b) => getComputedStyle(b).display !== 'none').length,
    };
  })()`);
  console.log('guest on lite host:', JSON.stringify(guestFx));
  if (guestFx.fx.length !== 0) {
    errors.push(`guest on lite host: expected no fx sliders, got ${JSON.stringify(guestFx.fx)}`);
  }
  if (guestFx.isLite !== true) errors.push('guest on lite host: missing .is-lite');
  if (guestFx.moreVisible !== 0) errors.push('guest on lite host: MORE buttons must hide');
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
