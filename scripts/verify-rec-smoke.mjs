/**
 * Smoke: Rec pip turns red while recording; pad defaults to chords at entry;
 * an instrument switch keeps the take rolling and the mode pick, while the
 * SMP pad still stops an open take.
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

function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) errors.push(name);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 30000,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});

try {
  const host = await browser.newPage();
  host.on('pageerror', (e) => errors.push(`host pageerror: ${e.message}`));
  await host.setViewport({ width: 1360, height: 900 });
  await host.goto(`${BASE}/?role=host`, { waitUntil: 'domcontentloaded' });
  await pollExpr(host, '({ ok: document.body.dataset.view === "host" && Boolean(globalThis.__jam) })');
  await host.click('#splash-start');
  await pollExpr(host, `(() => {
    const jam = globalThis.__jam;
    return { ok: Boolean(jam && jam.audio && document.getElementById('host-code').textContent.length === 4) };
  })()`);
  const code = await host.evaluate(`document.getElementById('host-code').textContent`);

  // Default: chords on host
  check('host starts in chords', await host.evaluate(
    `document.querySelector('#mode-row [data-mode="chords"]')?.classList.contains('is-on')`));

  // Rec pip exists + turns red
  check('host rec pip exists', await host.evaluate(`Boolean(document.querySelector('#btn-loop .rec-dot'))`));
  await clickSelector(host, '#btn-loop');
  await pollExpr(host, `({ ok: document.getElementById('btn-loop').classList.contains('is-on') })`);
  const hostDot = await host.evaluate(`getComputedStyle(document.querySelector('#btn-loop .rec-dot')).fill`);
  check(`host rec pip is --danger while recording (${hostDot})`, hostDot === await host.evaluate(
    `getComputedStyle(document.body.appendChild(Object.assign(document.createElement('i'), { style: 'color:var(--danger)' }))).color`));

  // Instrument switch keeps the take rolling on host — and the
  // Notes/Chords pick stays where the user left it.
  await clickSelector(host, '#instrument-row [data-instrument="organ"]');
  await sleep(300);
  check('host instrument switch keeps recording', await host.evaluate(
    `document.getElementById('btn-loop').classList.contains('is-on')`));
  check('host instrument switch keeps the mode pick', await host.evaluate(
    `document.querySelector('#mode-row [data-mode="chords"]')?.classList.contains('is-on')`));
  await clickSelector(host, '#btn-loop'); // rec off for the SMP check
  await pollExpr(host, `({ ok: !document.getElementById('btn-loop').classList.contains('is-on') })`);

  // SMP pad stops recording on host
  await clickSelector(host, '#instrument-row [data-instrument="pad"]');
  await clickSelector(host, '#btn-loop');
  await pollExpr(host, `({ ok: document.getElementById('btn-loop').classList.contains('is-on') })`);
  await clickSelector(host, '#host-pad-mode [data-padmode="sampler"]');
  await sleep(300);
  check('host SMP pad stops recording', await host.evaluate(
    `!document.getElementById('btn-loop').classList.contains('is-on')`));
  await clickSelector(host, '#host-pad-mode [data-padmode="notes"]');

  // Guest
  const guest = await browser.newPage();
  guest.on('pageerror', (e) => errors.push(`guest pageerror: ${e.message}`));
  await guest.setViewport({ width: 390, height: 844 });
  await guest.goto(`${BASE}/?role=controller&code=${code}`, { waitUntil: 'domcontentloaded' });
  await pollExpr(guest, '({ ok: document.getElementById("controller-splash").hidden })');
  await pollExpr(guest, `({ ok: !document.getElementById('controller-loop').disabled })`);

  check('guest starts in chords', await guest.evaluate(
    `document.querySelector('#controller-screen [data-mode="chords"]')?.classList.contains('is-on')`));
  check('guest rec pip exists', await guest.evaluate(`Boolean(document.querySelector('#controller-loop .rec-dot'))`));

  await clickSelector(guest, '#controller-loop');
  await pollExpr(guest, `({ ok: document.getElementById('controller-loop').classList.contains('is-on') })`);
  const guestDot = await guest.evaluate(`getComputedStyle(document.querySelector('#controller-loop .rec-dot')).fill`);
  check(`guest rec pip is --danger while recording (${guestDot})`, guestDot === await guest.evaluate(
    `getComputedStyle(document.body.appendChild(Object.assign(document.createElement('i'), { style: 'color:var(--danger)' }))).color`));

  await clickSelector(guest, '#controller-instruments [data-instrument="organ"]');
  await sleep(300);
  check('guest instrument switch keeps recording', await guest.evaluate(
    `document.getElementById('controller-loop').classList.contains('is-on')`));
  check('guest instrument switch keeps the mode pick', await guest.evaluate(
    `document.querySelector('#controller-screen [data-mode="chords"]')?.classList.contains('is-on')`));

  // Switching back to pad keeps the same mode too
  await clickSelector(guest, '#controller-instruments [data-instrument="pad"]');
  await sleep(200);
  check('guest back on pad keeps chords', await guest.evaluate(
    `document.querySelector('#controller-screen [data-mode="chords"]')?.classList.contains('is-on')`));

  // The take is still rolling — the SMP pad stops it.
  await clickSelector(guest, '#controller-pad-mode [data-padmode="sampler"]');
  await sleep(300);
  check('guest SMP pad stops recording', await guest.evaluate(
    `!document.getElementById('controller-loop').classList.contains('is-on')`));
} finally {
  await browser.close();
}

if (errors.length) {
  console.log('FAILURES:', errors);
  process.exit(1);
}
console.log('all good');
