import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'shell',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('requestfailed', (r) => console.log('reqfail', r.url(), r.failure()?.errorText));
await page.goto('http://127.0.0.1:43117/?role=host', { waitUntil: 'networkidle2' });
const info = await page.evaluate(() => ({
  tone: typeof Tone !== 'undefined' ? Tone.version : null,
  synthKeys: typeof Tone !== 'undefined' ? Object.keys(Tone).filter((k) => /Synth|Monophonic|Instrument/.test(k)) : null,
  io: typeof io !== 'undefined',
}));
console.log(JSON.stringify(info, null, 2));
await browser.close();
