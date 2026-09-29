/**
 * CPU probe for the host and controller pages.
 *
 * Drives a real Chrome renderer through CDP, plays the session for a fixed
 * window and reports the renderer task time each page burns while idle and
 * while a finger is dragging across the pad.
 *
 * Usage: node scripts/perf-probe.mjs --url http://127.0.0.1:43117 --label after
 */

import { writeFileSync } from 'node:fs';

import puppeteer from 'puppeteer-core';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .matchAll(/--([\w-]+)[= ]([^\s]+)/g)
    .map((match) => [match[1], match[2]]),
);

const BASE_URL = args.url ?? 'http://127.0.0.1:43117';
const LABEL = args.label ?? 'run';
/** Host entry URL after the origin — '?role=host&lite=1' probes the lite rig. */
const HOST_QUERY = args.hostquery ?? '?role=host';
const CHROME =
  args.chrome ??
  (process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : '/opt/google/chrome/chrome');
const PHASE_MS = Number(args.phase ?? 10000);
const DRAG_HZ = Number(args.dragHz ?? 120);
const OUT = args.out ?? `/tmp/perf-${LABEL}.json`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Counts the work the page itself asks for, independent of CPU noise. */
function instrument() {
  window.__probe = { raf: 0, wsSend: 0, wsRecv: 0, audioNodes: 0 };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) =>
    raf((time) => {
      window.__probe.raf += 1;
      callback(time);
    });
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function patchedSend(...rest) {
    window.__probe.wsSend += 1;
    return send.apply(this, rest);
  };
  const addEventListener = WebSocket.prototype.addEventListener;
  WebSocket.prototype.addEventListener = function patchedAdd(type, listener, ...rest) {
    if (type === 'message' && typeof listener === 'function') {
      return addEventListener.call(
        this,
        type,
        (event) => {
          window.__probe.wsRecv += 1;
          return listener(event);
        },
        ...rest,
      );
    }
    return addEventListener.call(this, type, listener, ...rest);
  };
  const onmessage = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
  Object.defineProperty(WebSocket.prototype, 'onmessage', {
    configurable: true,
    get() {
      return onmessage.get.call(this);
    },
    set(listener) {
      onmessage.set.call(
        this,
        typeof listener === 'function'
          ? (event) => {
              window.__probe.wsRecv += 1;
              return listener(event);
            }
          : listener,
      );
    },
  });

  // Anything allocating an audio node mid-performance shows up here.
  for (const name of [
    'GainNode',
    'OscillatorNode',
    'BiquadFilterNode',
    'DelayNode',
    'ConvolverNode',
    'WaveShaperNode',
    'AudioBufferSourceNode',
    'ConstantSourceNode',
    'DynamicsCompressorNode',
  ]) {
    const Ctor = window[name];
    if (!Ctor) continue;
    window[name] = new Proxy(Ctor, {
      construct(target, ctorArgs) {
        window.__probe.audioNodes += 1;
        return Reflect.construct(target, ctorArgs);
      },
    });
  }
  const proto = window.BaseAudioContext?.prototype;
  for (const name of [
    'createGain',
    'createOscillator',
    'createBiquadFilter',
    'createDelay',
    'createConvolver',
    'createWaveShaper',
    'createBufferSource',
    'createConstantSource',
    'createDynamicsCompressor',
  ]) {
    const original = proto?.[name];
    if (!original) continue;
    proto[name] = function counted(...rest) {
      window.__probe.audioNodes += 1;
      return original.apply(this, rest);
    };
  }
}

async function metrics(page) {
  const list = await page.client.send('Performance.getMetrics');
  const byName = Object.fromEntries(list.metrics.map(({ name, value }) => [name, value]));
  const probe = await page.evaluate(() => ({ ...window.__probe }));
  return { ...byName, ...probe, wall: Date.now() };
}

function diff(before, after, name) {
  const seconds = (after.wall - before.wall) / 1000;
  return {
    phase: name,
    from: before.wall,
    to: after.wall,
    seconds: Number(seconds.toFixed(2)),
    cpuPercent: Number((((after.TaskDuration - before.TaskDuration) / seconds) * 100).toFixed(1)),
    scriptPercent: Number((((after.ScriptDuration - before.ScriptDuration) / seconds) * 100).toFixed(1)),
    layoutPercent: Number((((after.LayoutDuration - before.LayoutDuration) / seconds) * 100).toFixed(1)),
    stylePercent: Number((((after.RecalcStyleDuration - before.RecalcStyleDuration) / seconds) * 100).toFixed(1)),
    rafPerSecond: Number(((after.raf - before.raf) / seconds).toFixed(1)),
    wsSendPerSecond: Number(((after.wsSend - before.wsSend) / seconds).toFixed(1)),
    wsRecvPerSecond: Number(((after.wsRecv - before.wsRecv) / seconds).toFixed(1)),
    audioNodesCreated: after.audioNodes - before.audioNodes,
    domNodes: after.Nodes,
  };
}

/** One browser per page: a backgrounded tab gets its rAF throttled to zero. */
async function launch() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
  });
}

async function openPage(browser, url) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.evaluateOnNewDocument(instrument);
  page.client = await page.createCDPSession();
  await page.client.send('Performance.enable');
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) console.log(`  [${url} ${message.type()}] ${message.text()}`);
  });
  await page.goto(url, { waitUntil: 'networkidle2' });
  return page;
}

async function drag(page, ms, hz) {
  const box = await page.evaluate(() => {
    const rect = document.getElementById('pad').getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const started = Date.now();
  const step = 1000 / hz;
  let i = 0;
  while (Date.now() - started < ms) {
    const t = (Date.now() - started) / 1000;
    const x = cx + Math.sin(t * 2) * (box.width * 0.35);
    const y = cy + Math.cos(t * 1.4) * (box.height * 0.35);
    await page.mouse.move(x, y);
    i += 1;
    const drift = started + i * step - Date.now();
    if (drift > 0) await sleep(drift);
  }
  await page.mouse.up();
  return i;
}

const hostBrowser = await launch();
const controllerBrowser = await launch();

const host = await openPage(hostBrowser, `${BASE_URL}/${HOST_QUERY}`);
await host.waitForSelector('#splash-start');
await host.evaluate(() => document.getElementById('splash-start').click());
await host.waitForFunction(() => document.getElementById('host-audio-status').dataset.state === 'online');
await host.evaluate(() => document.getElementById('btn-transport').click());
const code = await host.$eval('#host-code', (node) => node.textContent.trim());

const controller = await openPage(controllerBrowser, `${BASE_URL}/?role=controller&code=${code}`);
await controller.waitForFunction(() => document.getElementById('controller-status').dataset.state === 'online');
await sleep(1500);

const report = {
  label: LABEL,
  url: BASE_URL,
  code,
  browserPids: { host: hostBrowser.process().pid, controller: controllerBrowser.process().pid },
  phases: { host: [], controller: [] },
};

const idleBefore = { host: await metrics(host), controller: await metrics(controller) };
await sleep(PHASE_MS);
const idleAfter = { host: await metrics(host), controller: await metrics(controller) };
report.phases.host.push(diff(idleBefore.host, idleAfter.host, 'idle'));
report.phases.controller.push(diff(idleBefore.controller, idleAfter.controller, 'idle'));

// Load scenario mirrors jam-scenario: the host notes sheet stays open while
// the guest arms Rec, slides across the pad, then switches the pad to FX.
await host.waitForFunction(() => !document.getElementById('btn-notes').disabled);
await host.evaluate(() => document.getElementById('btn-notes').click());
await host.waitForFunction(() => !document.getElementById('host-notes-sheet').hidden);
await controller.waitForFunction(() => !document.getElementById('controller-loop').disabled);
await controller.evaluate(() => document.getElementById('controller-loop').click());

const recBefore = { host: await metrics(host), controller: await metrics(controller) };
const moves = await drag(controller, PHASE_MS, DRAG_HZ);
const recAfter = { host: await metrics(host), controller: await metrics(controller) };
report.dispatchedMoves = moves;
report.phases.host.push(diff(recBefore.host, recAfter.host, 'rec-drag'));
report.phases.controller.push(diff(recBefore.controller, recAfter.controller, 'rec-drag'));

await controller.evaluate(() => document.querySelector('#controller-pad-mode [data-padmode="fx"]').click());
const fxBefore = { host: await metrics(host), controller: await metrics(controller) };
const fxMoves = await drag(controller, PHASE_MS, DRAG_HZ);
const fxAfter = { host: await metrics(host), controller: await metrics(controller) };
report.dispatchedFxMoves = fxMoves;
report.phases.host.push(diff(fxBefore.host, fxAfter.host, 'fxpad'));
report.phases.controller.push(diff(fxBefore.controller, fxAfter.controller, 'fxpad'));

await controller.evaluate(() => {
  document.querySelector('#controller-pad-mode [data-padmode="notes"]').click();
  document.getElementById('controller-loop').click();
});
await host.evaluate(() => document.getElementById('host-notes-close').click());

report.hostTouchLogEntries = await host.$$eval('#host-log li', (nodes) => nodes.length);

writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await hostBrowser.close();
await controllerBrowser.close();
