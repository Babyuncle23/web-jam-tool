// E2E: host + guest pages. Guest switches pad to FX and drags; host engine
// must show stutter hold + cutoff via the existing controller:control channel.
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

// --- host ---
const host = await browser.newPage();
host.on('pageerror', (e) => console.log('[host pageerror]', e.message));
await host.setViewport({ width: 1366, height: 800 });
await host.goto(`${URL}?role=host`, { waitUntil: 'networkidle2' });
await host.waitForFunction(() => /^[A-Z2-9]{4}$/.test(document.getElementById('host-code')?.textContent || ''), { timeout: 10000 });
const code = await host.evaluate(() => document.getElementById('host-code').textContent);
await host.click('#splash-start');
await host.waitForFunction(() => document.getElementById('audio-splash')?.hidden === true, { timeout: 30000 });
await host.click('#btn-master'); // render sheet sliders once so sync has targets
await new Promise((r) => setTimeout(r, 200));
await host.click('#host-master-close');
console.log('host ready, code', code);

// --- guest ---
const guest = await browser.newPage();
guest.on('pageerror', (e) => console.log('[guest pageerror]', e.message));
await guest.setViewport({ width: 390, height: 844 });
await guest.goto(`${URL}?role=controller&code=${code}`, { waitUntil: 'networkidle2' });
await guest.waitForFunction(() => !document.getElementById('pad')?.classList.contains('is-locked'), { timeout: 15000 });
await new Promise((r) => setTimeout(r, 800));
await guest.screenshot({ path: `${OUT}/fx-guest-notes.png` });

// Guest: switch to FX mode
await guest.click('#controller-pad-mode [data-padmode="fx"]');
await new Promise((r) => setTimeout(r, 300));
await guest.screenshot({ path: `${OUT}/fx-guest-fxmode.png` });
const gChip = await guest.evaluate(() => document.querySelector('#controller-pad-mode .chip.is-on')?.dataset.padmode);
console.log('guest chip:', gChip);

// Guest drag in FX → host engine should hold stutter and close filter
const gbox = await (await guest.$('#pad')).boundingBox();
const gpx = (fx, fy) => [gbox.x + gbox.width * fx, gbox.y + gbox.height * (1 - fy)];
await guest.mouse.move(...gpx(0.9, 0.7));
await guest.mouse.down();
await guest.mouse.move(...gpx(0.55, 0.35), { steps: 4 });
await new Promise((r) => setTimeout(r, 400));
const hostHeld = await host.evaluate(() => {
  const fx = globalThis.__jam?.audio?.engine?.masterFx;
  return { holding: fx?.holding?.(), repeat: fx?.repeatGain?.(), division: fx?.sliceSeconds?.() > 0 };
});
console.log('host while guest holds:', JSON.stringify(hostHeld));
await guest.screenshot({ path: `${OUT}/fx-guest-held.png` });
await guest.mouse.up();
await new Promise((r) => setTimeout(r, 400));
const hostReleased = await host.evaluate(() => {
  const fx = globalThis.__jam?.audio?.engine?.masterFx;
  return { holding: fx?.holding?.(), repeat: fx?.repeatGain?.(), live: fx?.liveGain?.() };
});
console.log('host after guest release:', JSON.stringify(hostReleased));

// Guest wah lives only in the master sheet now (inside Advanced): wah + volume → host
await guest.click('#controller-advanced');
await new Promise((r) => setTimeout(r, 300));
await guest.click('#controller-master');
await new Promise((r) => setTimeout(r, 300));
await guest.evaluate(() => {
  const input = document.querySelector('#controller-master-sliders [data-master="wah"]');
  input.value = '70';
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 300));
const hostWah = await host.evaluate(() =>
  [...document.querySelectorAll('#host-master-sliders [data-master="wah"]')].map((i) => i.value),
);
console.log('host wah slider after guest wah:', JSON.stringify(hostWah));
await guest.evaluate(() => {
  const input = document.querySelector('#controller-master-sliders [data-master="volume"]');
  input.value = '40';
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 300));
const hostGain = await host.evaluate(() => globalThis.__jam?.audio?.engine?.masterGain?.());
console.log('host masterGain after guest volume:', hostGain);
await guest.screenshot({ path: `${OUT}/fx-guest-master-sheet.png` });

// Guest back to notes
await guest.click('#controller-pad-mode [data-padmode="notes"]');
await new Promise((r) => setTimeout(r, 300));
await browser.close();
console.log('done');
