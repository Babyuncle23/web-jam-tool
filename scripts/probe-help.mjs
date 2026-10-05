import puppeteer from 'puppeteer-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true });
await page.goto('http://127.0.0.1:43117/?role=host', { waitUntil: 'domcontentloaded' });
await sleep(800);
await page.evaluate(() => document.getElementById('splash-start')?.click());
await sleep(900);
const r = await page.evaluate(() => {
  document.querySelector('[data-action="help"]')?.click();
  const sheet = document.getElementById('help-sheet');
  const body = document.getElementById('help-body');
  return {
    open: sheet && !sheet.hidden,
    sections: body.querySelectorAll('.help-sec').length,
    items: body.querySelectorAll('.help-item').length,
    icons: body.querySelectorAll('.help-item .ico').length,
    firstRow: body.querySelector('.help-item')?.textContent?.trim().slice(0, 80),
  };
});
console.log(JSON.stringify(r, null, 1));
await page.evaluate(() => document.getElementById('help-close').click());
console.log('closed:', await page.evaluate(() => document.getElementById('help-sheet').hidden));
await browser.close();
