// Smoke test: touch-device flow against the local server.
// Verifies the role-screen buttons work on touch, and that a guest can
// rejoin a NEW room after the host left — without a page reload.
import puppeteer from 'puppeteer-core';

const URL = 'http://127.0.0.1:43117';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const POLL = { polling: 100 }; // interval polling: rAF is throttled in background tabs

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 30000,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});

async function mobilePage() {
  const page = await browser.newPage();
  await page.emulate({
    viewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  return page;
}

function fail(msg) {
  console.log('FAIL:', msg);
  process.exitCode = 1;
}

async function hostCode(page) {
  return page.$eval('#host-code', (el) => el.textContent);
}

async function waitHostCode(page, timeout = 10000, ...notIn) {
  await page.waitForFunction(
    (skip) => {
      const text = document.getElementById('host-code')?.textContent || '';
      return /^[A-Z2-9]{4}$/.test(text) && !skip.includes(text);
    },
    { timeout, ...POLL },
    notIn,
  );
}

try {
  // --- 1. Phone taps "Open host" ---
  const host = await mobilePage();
  await host.goto(URL, { waitUntil: 'networkidle2' });
  await host.tap('#btn-role-host');
  await waitHostCode(host);
  const code1 = await hostCode(host);
  console.log('PASS: phone opened host, code', code1);

  // --- 2. Guest phone joins via the Join button (touch tap) ---
  const guest = await mobilePage();
  await guest.goto(URL, { waitUntil: 'networkidle2' });
  await guest.type('#join-code', code1);
  await guest.tap('#join-form button[type="submit"]');
  await guest.waitForFunction(
    () => document.getElementById('controller-status')?.dataset.state === 'online',
    { timeout: 10000, ...POLL },
  );
  console.log('PASS: guest joined via Join button tap');

  // --- 3. Host goes back to the start screen and opens a NEW room ---
  await host.bringToFront();
  await host.tap('#host-screen [data-action="back"]');
  await host.waitForFunction(() => document.body.dataset.view === 'role', { timeout: 5000, ...POLL });
  await host.tap('#btn-role-host');
  await waitHostCode(host, 10000, code1);
  const code2 = await hostCode(host);
  console.log('PASS: host opened a new room, code', code2);

  // --- 4. Guest goes back and joins the NEW code — no reload ---
  await guest.bringToFront();
  await guest.tap('#controller-screen [data-action="back"]');
  await guest.waitForFunction(() => document.body.dataset.view === 'role', { timeout: 5000, ...POLL });
  await guest.$eval('#join-code', (el) => (el.value = ''));
  await guest.type('#join-code', code2);
  await guest.tap('#join-form button[type="submit"]');
  await guest.waitForFunction(
    () => document.getElementById('controller-status')?.dataset.state === 'online',
    { timeout: 10000, ...POLL },
  );
  console.log('PASS: guest rejoined the new room without reload');

  // --- 5. And a third round on the host, to catch re-entry regressions ---
  await host.bringToFront();
  await host.tap('#host-screen [data-action="back"]');
  await host.waitForFunction(() => document.body.dataset.view === 'role', { timeout: 5000, ...POLL });
  await host.tap('#btn-role-host');
  await waitHostCode(host, 10000, code1, code2);
  const code3 = await hostCode(host);
  console.log('PASS: third hosting round works too, code', code3);
} catch (error) {
  fail(error.message);
} finally {
  await browser.close();
}
console.log(process.exitCode ? 'DONE (failures)' : 'DONE (all passed)');
