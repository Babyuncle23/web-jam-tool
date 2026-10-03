/**
 * Preset smoke: Drill and DnB chips appear and stamp rimshot cells.
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
  host.on('pageerror', (e) => console.log('host pageerror:', e.message));
  await host.setViewport({ width: 1360, height: 900 });
  await host.goto(`${BASE}/?role=host`, { waitUntil: 'domcontentloaded' });
  await pollExpr(host, '({ ok: document.body.dataset.view === "host" && Boolean(globalThis.__jam) })');
  await host.click('#splash-start');
  await pollExpr(host, `(() => {
    const jam = globalThis.__jam;
    return { ok: Boolean(jam && jam.audio && document.getElementById('host-code').textContent.length === 4) };
  })()`);

  await clickSelector(host, '#btn-drums');
  await pollExpr(host, `({ ok: !document.getElementById('host-drums-sheet').hidden })`);

  const chips = await host.evaluate(`[...document.querySelectorAll('#drum-presets .chip, #host-drum-presets .chip')].map((c) => c.dataset.preset)`);
  console.log('preset chips:', JSON.stringify(chips));

  const expected = {
    drill: {
      kick: [0, 6, 10, 16, 22, 27],
      snare: [8, 24, 30],
      rimshot: [3, 19, 28],
      hat: [0, 3, 6, 8, 11, 14, 15, 16, 19, 22, 24, 27, 30, 31],
      clap: [],
      repeat: '2',
    },
    dnb: {
      // 16-step pattern tiles over the 32-step loop.
      kick: [0, 16],
      snare: [4, 10, 20, 26],
      rimshot: [],
      hat: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30],
      clap: [7, 9, 13, 15, 23, 25, 29, 31],
      repeat: '1',
    },
  };

  for (const [id, want] of Object.entries(expected)) {
    await host.evaluate(`[...document.querySelectorAll('#host-drum-presets .chip, #drum-presets .chip')].find((c) => c.dataset.preset === '${id}')?.click()`);
    await sleep(300);
    const state = await host.evaluate(`(() => {
      const row = (t) => [...document.querySelectorAll('#sequencer .step[data-track="'+t+'"].is-on')].map((b) => Number(b.dataset.step));
      const picked = document.querySelector('#host-drum-repeat [data-repeat-bars].is-picked')?.dataset.repeatBars;
      const preset = [...document.querySelectorAll('#host-drum-presets .chip, #drum-presets .chip')].find((c) => c.classList.contains('is-picked'))?.dataset.preset;
      return { kick: row('kick'), snare: row('snare'), rimshot: row('rimshot'), hat: row('hat'), clap: row('clap'), picked, preset };
    })()`);
    console.log(`${id}:`, JSON.stringify(state));
    if (state.preset !== id) throw new Error(`${id} chip not marked`);
    if (state.picked !== want.repeat) throw new Error(`${id} repeat should be ${want.repeat}`);
    for (const track of ['kick', 'snare', 'rimshot', 'hat', 'clap']) {
      if (JSON.stringify(state[track]) !== JSON.stringify(want[track])) {
        throw new Error(`${id} ${track} mismatch: ${JSON.stringify(state[track])} !== ${JSON.stringify(want[track])}`);
      }
    }
  }
  console.log('PRESET SMOKE OK');
} finally {
  await browser.close();
}
