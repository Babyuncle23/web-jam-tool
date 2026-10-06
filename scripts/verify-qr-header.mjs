// Verify: header QR loading state, phone header fit, zoom badge, invite sheet.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const URL = 'http://127.0.0.1:43117';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = 'C:/Users/nikit/Desktop/coding and game dev/collaborative music/scripts/shots';
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 30000,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});

async function shot(page, name, delay = 600) {
  await new Promise((r) => setTimeout(r, delay));
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('shot:', name);
}

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';

// --- phone host: loading flash, then settled header ---
let page = await browser.newPage();
await page.emulate({
  viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  userAgent: UA,
});
await page.goto(URL + '?role=host', { waitUntil: 'domcontentloaded' });
await shot(page, 'qr-phone-loading', 120); // catch the pending state early
await page.waitForFunction(
  () => /^[A-Z2-9]{4}$/.test(document.getElementById('host-code')?.textContent || ''),
  { timeout: 15000, polling: 100 },
);
await page.waitForFunction(
  () => !!document.querySelector('#host-qr img'),
  { timeout: 20000, polling: 100 },
);
await shot(page, 'qr-phone-settled');
// Measure whether the header row fits: is anything clipped?
const fit = await page.evaluate(() => {
  const card = document.querySelector('.qr-card').getBoundingClientRect();
  const actions = document.querySelector('.topbar__actions').getBoundingClientRect();
  const invite = document.querySelector('.qr-card__invite').getBoundingClientRect();
  const stamp = document.getElementById('host-qr').getBoundingClientRect();
  const badge = document.querySelector('.qr-card__zoom').getBoundingClientRect();
  return {
    viewport: innerWidth,
    cardRight: card.right,
    actionsRight: actions.right,
    inviteWidth: invite.width,
    inviteClipped: invite.width === 0 ? 'hidden' : invite.right > card.right,
    stampW: stamp.width,
    stampH: stamp.height,
    badgeVisible: badge.width > 0,
    badgeX: badge.x,
    badgeY: badge.y,
  };
});
console.log('phone header:', JSON.stringify(fit));
// invite sheet
await page.tap('.qr-card');
await page.waitForFunction(() => !document.getElementById('host-share-sheet').hidden, { timeout: 5000 });
await shot(page, 'qr-phone-invite');
const sheet = await page.evaluate(() => {
  const card = document.querySelector('.share-sheet').getBoundingClientRect();
  const qr = document.getElementById('host-qr-big').getBoundingClientRect();
  const done = document.getElementById('host-share-close').getBoundingClientRect();
  return {
    cardW: card.width, qrW: qr.width, qrH: qr.height,
    qrOverflowX: qr.right > card.right || qr.left < card.left,
    doneVisible: done.bottom <= innerHeight,
    scrollX: document.querySelector('.share-sheet').scrollWidth > document.querySelector('.share-sheet').clientWidth,
  };
});
console.log('invite sheet:', JSON.stringify(sheet));
await page.close();

// --- narrow phone (360px) ---
page = await browser.newPage();
await page.emulate({
  viewport: { width: 360, height: 740, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  userAgent: UA,
});
await page.goto(URL + '?role=host', { waitUntil: 'networkidle2' });
await page.waitForFunction(
  () => !!document.querySelector('#host-qr img'),
  { timeout: 20000, polling: 100 },
);
await shot(page, 'qr-360-settled');
const fit360 = await page.evaluate(() => {
  const card = document.querySelector('.qr-card').getBoundingClientRect();
  const actions = document.querySelector('.topbar__actions').getBoundingClientRect();
  const invite = document.querySelector('.qr-card__invite').getBoundingClientRect();
  const topbar = document.querySelector('.topbar').getBoundingClientRect();
  return {
    viewport: innerWidth,
    cardRight: card.right, actionsRight: actions.right, topbarRight: topbar.right,
    inviteRight: invite.right, inviteW: invite.width,
    overflowing: actions.right > innerWidth || card.right > actions.left,
  };
});
console.log('360 header:', JSON.stringify(fit360));
await page.close();

// --- desktop ---
page = await browser.newPage();
await page.setViewport({ width: 1366, height: 800 });
await page.goto(URL + '?role=host', { waitUntil: 'networkidle2' });
await page.waitForFunction(
  () => !!document.querySelector('#host-qr img'),
  { timeout: 20000, polling: 100 },
);
await shot(page, 'qr-desktop');
await page.close();

await browser.close();
console.log('done');
