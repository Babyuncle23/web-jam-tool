// Screenshots: host on desktop, host on phone, controller on phone,
// host inside an installed-PWA-style standalone viewport.
import puppeteer from 'puppeteer-core';

const URL = 'http://127.0.0.1:43117';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = 'C:/Users/nikit/Desktop/coding and game dev/collaborative music/scripts/shots';
const POLL = { polling: 100 };

import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 30000,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});

async function shot(page, name) {
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('shot:', name);
}

// --- host on desktop ---
let page = await browser.newPage();
await page.setViewport({ width: 1366, height: 800 });
await page.goto(URL + '?role=host', { waitUntil: 'networkidle2' });
await page.waitForFunction(
  () => /^[A-Z2-9]{4}$/.test(document.getElementById('host-code')?.textContent || ''),
  { timeout: 10000, ...POLL },
);
await shot(page, 'host-desktop');
await page.close();

// --- host on phone ---
page = await browser.newPage();
await page.emulate({
  viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
});
await page.goto(URL + '?role=host', { waitUntil: 'networkidle2' });
await page.waitForFunction(
  () => /^[A-Z2-9]{4}$/.test(document.getElementById('host-code')?.textContent || ''),
  { timeout: 10000, ...POLL },
);
await shot(page, 'host-phone');
// scroll down to see the tools section
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await shot(page, 'host-phone-scrolled');
// back to the top, then open the invite sheet via the header QR card
await page.evaluate(() => window.scrollTo(0, 0));
await page.tap('.qr-card');
await shot(page, 'host-phone-invite');

await page.close();

// --- host on phone, landscape ---
page = await browser.newPage();
await page.emulate({
  viewport: { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
});
await page.goto(URL + '?role=host', { waitUntil: 'networkidle2' });
await page.waitForFunction(
  () => /^[A-Z2-9]{4}$/.test(document.getElementById('host-code')?.textContent || ''),
  { timeout: 10000, ...POLL },
);
await shot(page, 'host-landscape');
// In landscape the audio splash covers the whole screen — start sound first.
await page.tap('#splash-start');
await page.waitForFunction(
  () => !document.getElementById('host-pad')?.classList.contains('is-locked'),
  { timeout: 30000, ...POLL },
);
await shot(page, 'host-landscape-running');
await page.tap('.qr-card');
await shot(page, 'host-landscape-invite');
await page.close();

// --- PWA standalone emulation on phone (matchMedia stub: CDP has no display-mode) ---
page = await browser.newPage();
await page.emulate({
  viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
});
await page.evaluateOnNewDocument(() => {
  const original = window.matchMedia.bind(window);
  window.matchMedia = (query) =>
    query.includes('display-mode') || query.includes('display_mode')
      ? { matches: query.includes('standalone'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }
      : original(query);
});
await page.goto(URL + '?role=host', { waitUntil: 'networkidle2' });
await page.waitForFunction(
  () => /^[A-Z2-9]{4}$/.test(document.getElementById('host-code')?.textContent || ''),
  { timeout: 10000, ...POLL },
);
await shot(page, 'host-phone-pwa');
await page.close();

// --- role screen on phone ---
page = await browser.newPage();
await page.emulate({
  viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
});
await page.goto(URL, { waitUntil: 'networkidle2' });
await shot(page, 'role-phone');
await page.close();

// --- controller on phone (needs a live session) ---
const host = await browser.newPage();
await host.setViewport({ width: 1366, height: 800 });
await host.goto(URL + '?role=host', { waitUntil: 'networkidle2' });
await host.waitForFunction(
  () => /^[A-Z2-9]{4}$/.test(document.getElementById('host-code')?.textContent || ''),
  { timeout: 10000, ...POLL },
);
const code = await host.$eval('#host-code', (el) => el.textContent);
page = await browser.newPage();
await page.emulate({
  viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
});
await page.goto(`${URL}?role=controller&code=${code}`, { waitUntil: 'networkidle2' });
await page.waitForFunction(
  () => document.getElementById('controller-status')?.dataset.state === 'online',
  { timeout: 10000, ...POLL },
);
await shot(page, 'controller-phone');

await browser.close();
console.log('done');
