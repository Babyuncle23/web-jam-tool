// FX pad mode check: start host audio, switch pad to FX, drag a finger,
// confirm stutter hold + bipolar filter on the engine and no stuck notes.
import puppeteer from 'puppeteer-core';

const URL = 'http://127.0.0.1:43117';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = 'C:/Users/nikit/Desktop/coding and game dev/collaborative music/scripts/shots';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 30000,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});

const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.setViewport({ width: 1366, height: 800 });
await page.goto(URL + '?role=host', { waitUntil: 'networkidle2' });
await page.waitForFunction(() => /^[A-Z2-9]{4}$/.test(document.getElementById('host-code')?.textContent || ''), { timeout: 10000 });

await page.click('#splash-start');
await page.waitForFunction(() => document.getElementById('audio-splash')?.hidden === true, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 400));

// Spy on the master fx setters
await page.evaluate(() => {
  const fx = globalThis.__jam.audio.engine.masterFx;
  globalThis.__fxlog = { cutoff: null, hipass: null, hold: null, division: null };
  for (const key of ['setCutoff', 'setHipass', 'setHold', 'setDivision']) {
    const orig = fx[key].bind(fx);
    fx[key] = (v) => {
      globalThis.__fxlog[key.replace('set', '').toLowerCase()] = v;
      return orig(v);
    };
  }
});

await page.click('#host-pad-mode [data-padmode="fx"]');
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: `${OUT}/fx-host-fxmode.png` });
const padMode = await page.evaluate(() => ({
  activeChip: document.querySelector('#host-pad-mode .chip.is-on')?.dataset.padmode,
  hint: document.getElementById('host-pad-hint')?.textContent,
}));
console.log('padMode:', JSON.stringify(padMode));

const box = await (await page.$('#host-pad')).boundingBox();
const px = (fx, fy) => [box.x + box.width * fx, box.y + box.height * (1 - fy)];
const log = () => page.evaluate(() => ({ ...globalThis.__fxlog, holding: globalThis.__jam.audio.engine.masterFx.holding() }));

// 1) Bottom-right: stutter zone + lowpass
await page.mouse.move(...px(0.9, 0.2));
await page.mouse.down();
await page.mouse.move(...px(0.85, 0.15), { steps: 4 });
await new Promise((r) => setTimeout(r, 300));
console.log('zone 1/32 + LP:', JSON.stringify(await log()));
await page.screenshot({ path: `${OUT}/fx-host-held.png` });

// 2) Top-left: filter-only zone + highpass → stutter must drop
await page.mouse.move(...px(0.1, 0.9), { steps: 4 });
await new Promise((r) => setTimeout(r, 300));
console.log('zone — + HP:', JSON.stringify(await log()));

// 3) Middle Y: filters off (dead band)
await page.mouse.move(...px(0.5, 0.5), { steps: 3 });
await new Promise((r) => setTimeout(r, 300));
console.log('middle → open:', JSON.stringify(await log()));

await page.mouse.up();
await new Promise((r) => setTimeout(r, 300));
console.log('after release:', JSON.stringify(await log()));

// Bass: mode chips hide but Rec stays; FX hides the whole play-bar
await page.evaluate(() => document.querySelector('#host-pad-mode [data-padmode="notes"]')?.click());
await page.evaluate(() => document.querySelector('#instrument-row [data-instrument="bass"]')?.click());
await new Promise((r) => setTimeout(r, 300));
const bassChrome = await page.evaluate(() => ({
  playBarHidden: document.getElementById('play-bar')?.hidden,
  modeRowHidden: document.getElementById('mode-row')?.hidden,
  recVisible: !document.getElementById('btn-loop')?.closest('#play-bar')?.hidden,
}));
console.log('bass chrome:', JSON.stringify(bassChrome));
await page.screenshot({ path: `${OUT}/fx-host-bass.png` });
await page.evaluate(() => document.querySelector('#instrument-row [data-instrument="pad"]')?.click());
await page.click('#host-pad-mode [data-padmode="fx"]');
await new Promise((r) => setTimeout(r, 200));
const fxChrome = await page.evaluate(() => ({
  playBarHidden: document.getElementById('play-bar')?.hidden,
}));
console.log('fx chrome:', JSON.stringify(fxChrome));
await page.click('#host-pad-mode [data-padmode="notes"]');

// Master sheet: 8-bit, wah, volume
await page.click('#btn-master');
await new Promise((r) => setTimeout(r, 300));
const sliders = await page.evaluate(() =>
  [...document.querySelectorAll('#host-master-sliders [data-master]')].map((i) => i.dataset.master),
);
console.log('master sheet sliders:', JSON.stringify(sliders));
await page.screenshot({ path: `${OUT}/fx-host-master-sheet.png` });

await browser.close();
console.log('done');
