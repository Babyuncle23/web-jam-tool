/**
 * Two regressions around the sampler + FX pad:
 *
 * 1. A guest's sample hit must not knock the host's held stutter/filter off —
 *    the pad modes are exclusive, so a held FX finger can only belong to
 *    another device and is still physically down when the hit lands. The
 *    "guest" here is a raw second socket.io client inside the host page: a
 *    second browser tab would park the host (visibilitychange drops held
 *    fingers on purpose), which is not what a real guest phone does.
 *
 * 2. A recorded gate hit (BEAT pad) whose 'on' already looped while the
 *    finger was still held must stop when the finger lifts — the live take's
 *    loop voice dies with the finger instead of ringing to the recorded 'up'
 *    step on the next cycle.
 *
 * Usage: node scripts/verify-sample-fx.mjs
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

const host = await browser.newPage();
host.on('pageerror', (e) => console.log('[host pageerror]', e.message));
await host.setViewport({ width: 1366, height: 800 });
await host.goto(`${BASE_URL}?role=host`, { waitUntil: 'networkidle2' });
await host.waitForFunction(() => /^[A-Z2-9]{4}$/.test(document.getElementById('host-code')?.textContent || ''), { timeout: 10000 });
const code = await host.evaluate(() => document.getElementById('host-code').textContent);
await host.click('#splash-start');
await host.waitForFunction(() => document.getElementById('audio-splash')?.hidden === true, { timeout: 30000 });

// A raw socket.io client joins the room as a controller — the server stamps
// its socket id as peerId, same as a phone would.
const guestReady = await host.evaluate(
  (sessionCode) =>
    new Promise((resolve, reject) => {
      const sock = globalThis.io(globalThis.location.origin);
      window.__guestSock = sock;
      sock.on('connect_error', reject);
      sock.emit('controller:join', { code: sessionCode, name: 'probe-guest' }, (resp) => {
        if (resp?.ok) resolve(resp.peerId);
        else reject(new Error(resp?.error || 'join failed'));
      });
    }),
  code,
);
check('probe guest joined the room', Boolean(guestReady), String(guestReady));

// Host holds the FX stutter (right zone).
await host.click('#host-pad-mode [data-padmode="fx"]');
await sleep(200);
const padBox = await (await host.$('#host-pad')).boundingBox();
const hpx = (fx, fy) => [padBox.x + padBox.width * fx, padBox.y + padBox.height * (1 - fy)];
await host.mouse.move(...hpx(0.9, 0.5));
await host.mouse.down();
await sleep(350);
const heldBefore = await host.evaluate(() => globalThis.__jam?.audio?.engine?.masterFx?.holding?.());
check('host stutter held before the guest hit', heldBefore === true, String(heldBefore));

// Guest taps a sample pad while the host keeps holding.
await host.evaluate(() => window.__guestSock.emit('controller:control', { sampleHit: 'fah' }));
await sleep(400);
const heldAfter = await host.evaluate(() => ({
  holding: globalThis.__jam?.audio?.engine?.masterFx?.holding?.(),
  hold: globalThis.__jam?.masterFx?.hold,
  triggered: globalThis.__jam?.audio?.sampler?.sounding !== undefined,
}));
check('host stutter survives the guest hit', heldAfter.holding === true && heldAfter.hold === true, JSON.stringify(heldAfter));
await host.mouse.up();
await host.evaluate(() => window.__guestSock.disconnect());

// --- recorded gate hit releases with the finger ---
// Host: rec on, hold BEAT across one full loop so the recorded 'on' has
// replayed as a loop voice while the finger is still down, then let go.
await host.click('#host-pad-mode [data-padmode="sampler"]');
await sleep(300);
await host.click('#btn-loop');
await sleep(150);
const beatPad = await (await host.$('#host-sampler .sampler-pad[data-sample="boombap"]')).boundingBox();
await host.mouse.move(beatPad.x + beatPad.width / 2, beatPad.y + beatPad.height / 2);
await host.mouse.down();
await sleep(4600); // a 32-step loop at ~96bpm is ~5s — cover the 'on' recurrence
await host.mouse.up();
await sleep(250);
const afterRelease = await host.evaluate(() => ({
  sounding: globalThis.__jam?.audio?.sampler?.sounding,
  notes: globalThis.__jam?.loopFor?.('host')?.notes?.().filter((n) => n.sample === 'boombap').length ?? 0,
}));
check('gate hit silenced right after release', afterRelease.sounding === false, JSON.stringify(afterRelease));
check('the hold still landed in the loop', afterRelease.notes >= 1, `notes=${afterRelease.notes}`);

await browser.close();
console.log(results.every(Boolean) ? 'PASS' : 'FAIL');
process.exit(results.every(Boolean) ? 0 : 1);
