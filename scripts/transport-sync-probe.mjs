/**
 * Guest transport-button sync probe: opens a host and a controller page,
 * toggles Play/Stop from both sides, and dumps the state of the guest's
 * transport buttons after each step.
 *
 * Usage: node scripts/transport-sync-probe.mjs [--url http://127.0.0.1:43117]
 */

import puppeteer from 'puppeteer-core';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .matchAll(/--([\w-]+)[= ]([^\s]+)/g)
    .map((match) => [match[1], match[2]]),
);

const BASE_URL = args.url ?? 'http://127.0.0.1:43117';
const CHROME = args.chrome ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: [
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--mute-audio',
  ],
});

async function openHost() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', (error) => console.log(`[host pageerror] ${error.message}`));
  await page.goto(`${BASE_URL}/?role=host`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#splash-start');
  await page.evaluate(() => document.getElementById('splash-start').click());
  await page.waitForFunction(() => document.getElementById('host-audio-status').dataset.state === 'online', {
    timeout: 20000,
  });
  return page;
}

function guestState() {
  const btn = document.getElementById('controller-transport');
  const drum = document.getElementById('controller-drums-transport');
  return {
    transport: {
      disabled: btn.disabled,
      isOn: btn.classList.contains('is-on'),
      ariaPressed: btn.getAttribute('aria-pressed'),
      hasIcon: btn.childElementCount > 0,
    },
    drumTransport: {
      text: drum?.textContent,
      isOn: drum?.classList.contains('is-on'),
      ariaPressed: drum?.getAttribute('aria-pressed'),
    },
    stateRunning: window.__probeRunning ?? 'n/a',
  };
}

async function openGuest(code) {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 800 });
  page.on('pageerror', (error) => console.log(`[guest pageerror] ${error.message}`));
  await page.goto(`${BASE_URL}/?role=controller`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#join-code');
  await page.evaluate((sessionCode) => {
    document.getElementById('join-code').value = sessionCode;
    document.getElementById('join-form').requestSubmit();
  }, code);
  await page.waitForFunction(
    () => document.getElementById('controller-transport')?.disabled === false,
    { timeout: 20000 },
  );
  return page;
}

const host = await openHost();
const code = await host.evaluate(() => document.getElementById('host-code').textContent.trim());
console.log('session code:', code);
const guest = await openGuest(code);
await sleep(500);

console.log('guest initial:', JSON.stringify(await guest.evaluate(guestState)));

// Host presses Play.
await host.evaluate(() => document.getElementById('btn-transport').click());
await sleep(700);
console.log('after host play :', JSON.stringify(await guest.evaluate(guestState)));

// Guest presses Stop via the top-bar button.
await guest.evaluate(() => document.getElementById('controller-transport').click());
await sleep(700);
console.log('after guest stop:', JSON.stringify(await guest.evaluate(guestState)));

// Guest presses Play via the top-bar button again.
await guest.evaluate(() => document.getElementById('controller-transport').click());
await sleep(700);
console.log('after guest play:', JSON.stringify(await guest.evaluate(guestState)));

// Open the guest drums sheet and stop from there.
await guest.evaluate(() => document.getElementById('controller-drums').click());
await sleep(300);
await guest.evaluate(() => document.getElementById('controller-drums-transport').click());
await sleep(700);
console.log('after drums stop:', JSON.stringify(await guest.evaluate(guestState)));

// Host presses Play once more — both guest buttons should light.
await host.evaluate(() => document.getElementById('btn-transport').click());
await sleep(700);
console.log('host play again :', JSON.stringify(await guest.evaluate(guestState)));

await browser.close();
