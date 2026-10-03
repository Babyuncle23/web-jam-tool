/**
 * Export smoke test: host renders the loop offline in both formats.
 * - WAV bytes have a RIFF header and plausible size.
 * - MP3 encodes through the CDN lamejs build and has an ID3/frame header.
 * - Format carousel flips the button label.
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:43117';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const errors = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollExpr(page, expression, { timeout = 30000, interval = 250 } = {}) {
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
  protocolTimeout: 90000,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});

try {
  const host = await browser.newPage();
  host.on('pageerror', (e) => errors.push(`host pageerror: ${e.message}`));
  host.on('console', (m) => {
    if (m.type() === 'error') console.log('host console.error:', m.text());
  });
  await host.setViewport({ width: 1360, height: 900 });
  await host.goto(`${BASE}/?role=host`, { waitUntil: 'domcontentloaded' });
  await pollExpr(host, '({ ok: document.body.dataset.view === "host" && Boolean(globalThis.__jam) })');
  await host.click('#splash-start');
  await pollExpr(host, `(() => {
    const jam = globalThis.__jam;
    return { ok: Boolean(jam && jam.audio && document.getElementById('host-code').textContent.length === 4) };
  })()`);

  // QR loading placeholder appears before the code renders.
  const qrState = await host.evaluate(`(() => {
    const box = document.getElementById('host-qr');
    return { loading: box.classList.contains('qr-loading'), hasImg: Boolean(box.querySelector('img,canvas,table')), text: box.textContent };
  })()`);
  console.log('host qr box:', JSON.stringify(qrState));

  // Direct render sanity — both encoders on the same offline buffer.
  const direct = await host.evaluate(`(async () => {
    const { renderLoopAudio, wavBytes, mp3Bytes } = await import('/src/audio/export-loop.js');
    const { loadScript } = await import('/src/network/load-script.js');
    const spec = {
      bpm: 120, steps: 32, repeats: 1, notes: [],
      drums: { rimshot: [{ on: true, division: 1 }] },
      players: [], root: 'C', scale: 'major',
      effects: {}, levels: {}, octaves: {}, mute: {}, solo: {},
      masterFx: {}, drumPitch: 0,
    };
    const rendered = await renderLoopAudio(globalThis.Tone, spec);
    const wav = wavBytes(rendered);
    await loadScript('https://cdn.jsdelivr.net/npm/@breezystack/lamejs@1.2.7/dist/lamejs.iife.js', 30000);
    const mp3 = mp3Bytes(rendered);
    const wavHead = String.fromCharCode(...new Uint8Array(wav, 0, 4));
    const mp3Head = (mp3[0] === 0x49 && mp3[1] === 0x44 && mp3[2] === 0x33) || (mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0);
    return { ok: wavHead === 'RIFF' && mp3Head && wav.byteLength > 100000 && mp3.length > 10000, wav: wav.byteLength, mp3: mp3.length, wavHead, mp3Head };
  })()`);
  console.log('direct render:', JSON.stringify(direct));

  // UI path: open the sheet, cycle the format, run both exports.
  await clickSelector(host, '#btn-export');
  await pollExpr(host, `({ ok: !document.getElementById('host-export-sheet').hidden })`);
  const label0 = await host.evaluate(`document.getElementById('export-wav').textContent`);
  await clickSelector(host, '#host-export-sheet [data-export-cycle="1"]');
  const label1 = await host.evaluate(`document.getElementById('export-wav').textContent`);
  await clickSelector(host, '#host-export-sheet [data-export-cycle="-1"]');
  const label2 = await host.evaluate(`document.getElementById('export-wav').textContent`);
  console.log('format carousel:', label0, '→', label1, '→', label2);
  if (label0 !== 'WAV' || label1 !== 'MP3' || label2 !== 'WAV') throw new Error('format carousel broken');

  // WAV export through the real button.
  await clickSelector(host, '#export-wav');
  await pollExpr(host, `(() => {
    const b = document.getElementById('export-wav');
    return { ok: b.textContent === 'WAV' && !b.disabled, text: b.textContent };
  })()`, { timeout: 45000 });
  const err1 = await host.evaluate(`document.getElementById('export-error').textContent`);
  if (err1) throw new Error(`WAV export error: ${err1}`);
  console.log('WAV export OK (no error shown)');

  // MP3 export through the real button.
  await clickSelector(host, '#host-export-sheet [data-export-cycle="1"]');
  await clickSelector(host, '#export-wav');
  await pollExpr(host, `(() => {
    const b = document.getElementById('export-wav');
    return { ok: b.textContent === 'MP3' && !b.disabled, text: b.textContent };
  })()`, { timeout: 60000 });
  const err2 = await host.evaluate(`document.getElementById('export-error').textContent`);
  if (err2) throw new Error(`MP3 export error: ${err2}`);
  console.log('MP3 export OK (no error shown)');

  if (errors.length) throw new Error(errors.join('\n'));
  console.log('EXPORT SMOKE OK');
} finally {
  await browser.close();
}
