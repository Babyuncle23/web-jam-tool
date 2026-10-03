// Quick check: gate pads (BEAT, SCR 105, OMG) and SOLO carry a HOLD pill,
// one-shots and empty cells don't.
import puppeteer from 'puppeteer-core';

const URL = 'http://127.0.0.1:43117';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = 'C:/Users/nikit/Desktop/coding and game dev/collaborative music/scripts/shots';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 30000,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});

const host = await browser.newPage();
host.on('pageerror', (e) => console.log('[host pageerror]', e.message));
await host.setViewport({ width: 430, height: 900 });
await host.goto(URL + '?role=host', { waitUntil: 'networkidle2' });
await host.waitForFunction(
  () => /^[A-Z2-9]{4}$/.test(document.getElementById('host-code')?.textContent || ''),
  { timeout: 10000 },
);
await host.click('#splash-start');
await host.waitForFunction(() => document.getElementById('audio-splash')?.hidden === true, {
  timeout: 30000,
});
await host.click('#host-pad-mode [data-padmode="sampler"]');
await new Promise((r) => setTimeout(r, 300));

const result = await host.evaluate(() => {
  const pills = [...document.querySelectorAll('#host-sampler .sampler-pad')].map((pad) => ({
    sample: pad.dataset.sample || pad.dataset.action || 'empty',
    hold: pad.querySelector('.sampler-pad__hold')?.textContent || null,
    holdVisible:
      pad.querySelector('.sampler-pad__hold') &&
      getComputedStyle(pad.querySelector('.sampler-pad__hold')).display !== 'none',
  }));
  return pills;
});
console.log(JSON.stringify(result, null, 2));

const expected = { boombap: true, scratch105: true, omg: true, solo: true };
const ok = result.every(
  (p) => (p.hold === 'HOLD' && p.holdVisible) === Boolean(expected[p.sample]),
);
console.log(ok ? 'PASS: HOLD pills on gate pads only' : 'FAIL: pill placement wrong');

await host.screenshot({ path: `${OUT}/hold-pill.png` });
await browser.close();
process.exit(ok ? 0 : 1);
