/**
 * Probe: can the rimshot row be edited? Hit-test the cell, real click,
 * then a DOM click for comparison.
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:43117';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 30000,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});

try {
  const host = await browser.newPage();
  host.on('pageerror', (e) => console.log('host pageerror:', e.message));
  await host.setViewport({ width: 1360, height: 900 });
  await host.goto(`${BASE}/?role=host`, { waitUntil: 'domcontentloaded' });
  await pollExpr(host, '({ ok: document.body.dataset.view === "host" && Boolean(globalThis.__jam) })');
  await host.click('#splash-start');
  await pollExpr(host, `(() => {
    const jam = globalThis.__jam;
    return { ok: Boolean(jam && jam.audio && document.getElementById('host-code').textContent.length === 4) };
  })()`);

  await host.evaluate(`document.getElementById('btn-drums').click()`);
  await pollExpr(host, `({ ok: !document.getElementById('host-drums-sheet').hidden })`);

  const info = await host.evaluate(`(() => {
    const cell = document.querySelector('#sequencer .step[data-track="rimshot"][data-step="0"]');
    if (!cell) return { ok: false, reason: 'no rimshot cell in DOM' };
    cell.scrollIntoView({ block: 'center' });
    const rect = cell.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    const row = cell.closest('.seq-row');
    const cs = getComputedStyle(cell);
    return {
      ok: true,
      hit: top ? top.className + '|' + (top.dataset?.track || '') : 'nothing',
      isCell: top === cell,
      rect: { x: Math.round(x), y: Math.round(y), w: rect.width, h: rect.height },
      bg: cs.backgroundColor,
      visible: rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
      label: row?.querySelector('.seq-row__name')?.textContent,
    };
  })()`);
  console.log('rimshot cell probe:', JSON.stringify(info, null, 2));

  // Real mouse click at the cell center.
  if (info.rect) {
    await host.mouse.click(info.rect.x, info.rect.y);
    await sleep(300);
    const afterClick = await host.evaluate(`document.querySelector('#sequencer .step[data-track="rimshot"][data-step="0"]').classList.contains('is-on')`);
    console.log('after real click is-on:', afterClick);
  }
} finally {
  await browser.close();
}
