/**
 * Back-button protection + recording glow probe:
 * - one tap on Back must NOT leave the session (it only arms the button);
 *   a second tap inside the window leaves, and so does a 700 ms hold
 * - while a take is open the pad carries `is-recording` and the center
 *   pulse renders red-pink; stopping the take clears both
 *
 * Usage: node scripts/verify-back-glow.mjs
 */
import puppeteer from 'puppeteer-core';

const BASE_URL = 'http://127.0.0.1:43117';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 60000,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});

const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.setViewport({ width: 1366, height: 800 });
await page.goto(`${BASE_URL}?role=host`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => /^[A-Z2-9]{4}$/.test(document.getElementById('host-code')?.textContent || ''), { timeout: 10000 });
await page.click('#splash-start');
await page.waitForFunction(() => document.getElementById('audio-splash')?.hidden === true, { timeout: 30000 });

const screenIs = async (name) =>
  page.evaluate((n) => document.body.dataset.view === n || !document.getElementById(`${n}-screen`)?.hidden, name);
const onHost = async () => page.evaluate(() => !document.getElementById('host-screen')?.hidden);

// --- Back protection ---
await page.click('[data-action="back"]');
await sleep(150);
check('single tap on Back stays in the session', await onHost());
const armed = await page.evaluate(() => document.querySelector('[data-action="back"]')?.classList.contains('is-arming'));
check('the tap arms the button (is-arming)', armed === true);
await sleep(2000); // the arming window lapses
await page.click('[data-action="back"]');
await sleep(150);
check('tap after the window re-arms, still inside', await onHost());
await page.click('[data-action="back"]'); // second tap inside the window
await sleep(300);
check('a second tap leaves for the role picker', (await onHost()) === false);

// Back in: hold-to-leave must also work. Reload instead of clicking through —
// the role/host DOM is re-cloned on entry, and stale element handles flake.
await page.goto(`${BASE_URL}?role=host`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => /^[A-Z2-9]{4}$/.test(document.getElementById('host-code')?.textContent || ''), { timeout: 10000 });
await page.click('#splash-start');
await page.waitForFunction(() => document.getElementById('audio-splash')?.hidden === true, { timeout: 30000 });
const backBox = await (await page.$('[data-action="back"]')).boundingBox();
await page.mouse.move(backBox.x + backBox.width / 2, backBox.y + backBox.height / 2);
await page.mouse.down();
await sleep(850);
await page.mouse.up();
await sleep(300);
check('a 700 ms hold leaves for the role picker', (await onHost()) === false);

// --- Recording glow ---
await page.goto(`${BASE_URL}?role=host`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => /^[A-Z2-9]{4}$/.test(document.getElementById('host-code')?.textContent || ''), { timeout: 10000 });
await page.click('#splash-start');
await page.waitForFunction(() => document.getElementById('audio-splash')?.hidden === true, { timeout: 30000 });

const glowState = async () =>
  page.evaluate(() => {
    const pad = document.getElementById('host-pad');
    const pulse = pad?.querySelector('.pad__pulse');
    const bg = pulse ? getComputedStyle(pulse).backgroundImage : '';
    return {
      cls: pad?.classList.contains('is-recording'),
      animating: pulse ? getComputedStyle(pulse).animationName : 'none',
      pink: /rgba?\(255, (105|64),/.test(bg),
      bg,
    };
  });

const off = await glowState();
check('pad has no recording glow before rec', off.cls === false, JSON.stringify(off));
await page.click('#btn-loop');
await sleep(250);
const on = await glowState();
check('pad glows while recording', on.cls === true && on.animating === 'pad-beat', JSON.stringify(on));
check('the glow is red-pink', on.pink === true, on.bg.slice(0, 80));
await page.click('#btn-loop');
await sleep(250);
const stopped = await glowState();
check('the glow clears when the take stops', stopped.cls === false, JSON.stringify(stopped));

await browser.close();
console.log(results.every(Boolean) ? 'PASS' : 'FAIL');
process.exit(results.every(Boolean) ? 0 : 1);
