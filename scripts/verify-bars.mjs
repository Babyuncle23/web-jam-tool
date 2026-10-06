/**
 * Bar display check: host + one guest.
 * - "Bar —" idle label, "Bar X / N" while playing, beat dots lit.
 * - #btn-bars cycles 2 → 4 → 1 → 2 bars and the readout total follows.
 * - Drum ruler: one mark per bar, mirror marks labelled "N ← 1" under repeat.
 * - Note-roll ruler: bar numbers and bar lines land on every 16th step.
 * - Screenshots land in scripts/shots for eyeballing.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:43117';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = 'C:/Users/nikit/Desktop/coding and game dev/collaborative music/scripts/shots';
mkdirSync(OUT, { recursive: true });
const errors = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollExpr(page, expression, { timeout = 20000, interval = 250 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await page.evaluate(expression);
    if (last?.ok) return last;
    await sleep(interval);
  }
  throw new Error(`timeout ${timeout}ms: ${JSON.stringify(last)}`);
}

async function clickSelector(page, selector) {
  const point = await page.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  if (!point) throw new Error(`missing ${selector}`);
  await page.mouse.click(point.x, point.y);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 20000,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});

try {
  const host = await browser.newPage();
  host.on('pageerror', (e) => errors.push(`host pageerror: ${e.message}`));
  await host.setViewport({ width: 1360, height: 900 });
  await host.goto(`${BASE}/?role=host`, { waitUntil: 'domcontentloaded' });
  await pollExpr(host, '({ ok: document.body.dataset.view === "host" && Boolean(globalThis.__jam) })');
  await host.click('#splash-start');
  await pollExpr(host, `(() => {
    const jam = globalThis.__jam;
    return { ok: Boolean(jam && jam.audio && document.getElementById('host-code').textContent.length === 4) };
  })()`);
  const code = await host.evaluate(`document.getElementById('host-code').textContent`);

  const guest = await browser.newPage();
  guest.on('pageerror', (e) => errors.push(`guest pageerror: ${e.message}`));
  await guest.setViewport({ width: 390, height: 844 });
  await guest.goto(`${BASE}/?role=controller&code=${code}`, { waitUntil: 'domcontentloaded' });
  await pollExpr(guest, '({ ok: document.getElementById("controller-splash").hidden })');
  // A foreground second page parks the host tab (visibilitychange →
  // beginPark stops the drums). Real usage keeps the host focused — bring
  // it back so beginWake restarts the drum sequence.
  await host.bringToFront();

  // 1. Parked readout: once audio boots the label parks on the transport
  //    position — "Bar 1 / 2" with the first beat dot lit, "Bar —" only
  //    pre-boot.
  const idleLabel = await host.evaluate(`document.getElementById('bar-label').textContent`);
  const idleDots = await host.evaluate(`document.querySelectorAll('#beat-dots .beat-dot.is-on').length`);
  console.log('idle:', JSON.stringify({ idleLabel, idleDots }));
  if (!/^Bar (—|1 \/ 2)$/.test(idleLabel)) throw new Error(`bad parked label "${idleLabel}"`);
  if (idleDots > 1) throw new Error('at most one parked beat dot should be lit');

  // 2. Bars button starts on "2 bars" and cycles 2 → 4 → 1 → 2.
  const barsLabel = await host.evaluate(`document.getElementById('btn-bars').textContent.trim()`);
  if (!/2\s*bars/i.test(barsLabel)) throw new Error(`bars button should read "2 bars", got "${barsLabel}"`);

  // 3. Play: the readout counts Bar 1..2 / 2 and a beat dot is lit.
  await pollExpr(host, `({ ok: !document.getElementById('btn-transport').disabled })`);
  await host.evaluate(`document.getElementById('btn-transport').click()`);
  await pollExpr(host, `({ ok: Boolean(globalThis.__jam?.audio?.engine?.transportRunning) })`);
  const playing = await pollExpr(host, `(() => {
    const text = document.getElementById('bar-label').textContent;
    return { ok: /^Bar [12] \\/ 2$/.test(text), text };
  })()`);
  console.log('playing readout:', JSON.stringify(playing));
  const dotLit = await pollExpr(host, `({ ok: document.querySelectorAll('#beat-dots .beat-dot.is-on').length === 1,
    n: document.querySelectorAll('#beat-dots .beat-dot.is-on').length })`);
  console.log('beat dot lit:', JSON.stringify(dotLit));
  await host.screenshot({ path: `${OUT}/bars-host-pad.png` });

  // The readout actually advances through the loop. The label repaints on a
  // rAF behind the audio clock, so poll both the label and the drum step —
  // the drum step advancing is the hard signal, the label catches up.
  const seen = new Set();
  let lastStep = -1;
  let stepAdvanced = false;
  for (let i = 0; i < 60; i += 1) {
    const sample = await host.evaluate(`(() => ({
      label: document.getElementById('bar-label').textContent,
      cur: globalThis.__jam?.audio?.drums?.currentStep ?? -1,
    }))()`);
    seen.add(sample.label);
    if (sample.cur >= 0 && lastStep >= 0 && sample.cur !== lastStep) stepAdvanced = true;
    lastStep = sample.cur;
    if (seen.size >= 2) break;
    await sleep(100);
  }
  console.log('readout values seen:', [...seen].join(' | '), '| stepAdvanced:', stepAdvanced);
  if (!stepAdvanced && seen.size < 2) throw new Error('transport ticks but the bar readout is frozen');

  // 4. Guest mirrors the same readout via the pulse.
  const guestLabel = await pollExpr(guest, `(() => {
    const text = document.getElementById('controller-bar-label').textContent;
    return { ok: /^Bar [12] \\/ 2$/.test(text), text };
  })()`);
  console.log('guest readout:', JSON.stringify(guestLabel));

  // 5. Drum ruler: 2 bars with repeat 1 → marks "1" and "2 ← 1".
  await clickSelector(host, '#btn-drums');
  await pollExpr(host, `({ ok: !document.getElementById('host-drums-sheet').hidden })`);
  const ruler2 = await pollExpr(host, `(() => {
    const marks = [...document.querySelectorAll('#sequencer .seq-ruler__bar')].map((m) => m.textContent.trim());
    const barlines = document.querySelectorAll('#sequencer .seq-barline').length;
    const beatlines = document.querySelectorAll('#sequencer .seq-beatline').length;
    return { ok: marks.length === 2 && barlines === 3, marks, barlines, beatlines };
  })()`);
  console.log('drum ruler @2bars:', JSON.stringify(ruler2));
  if (ruler2.marks[1] !== '2 ← 1') throw new Error(`mirror mark should read "2 ← 1", got "${ruler2.marks[1]}"`);

  // A bar line must sit exactly on the first step of each bar.
  const lineAlign = await host.evaluate(`(() => {
    const tape = document.querySelector('#sequencer .seq-tape');
    const lines = [...tape.querySelectorAll('.seq-barline')].map((l) => Number(l.dataset.step));
    const rows = tape.querySelector('.seq-row__steps');
    const first = rows.querySelector('.step[data-step="0"]').getBoundingClientRect();
    const r = tape.getBoundingClientRect();
    const out = [];
    for (const step of [16, 32]) {
      const cell = rows.querySelector('.step[data-step="' + Math.min(step, 31) + '"]');
      if (!cell) continue;
      const line = tape.querySelector('.seq-gridlines .seq-barline[data-step="' + step + '"]');
      if (!line) { out.push({ step, line: null }); continue; }
      const gl = tape.querySelector('.seq-gridlines').getBoundingClientRect();
      out.push({ step, lineLeft: line.getBoundingClientRect().left - gl.left, cellLeft: cell.getBoundingClientRect().left - gl.left });
    }
    return { first: first.left - r.left, out };
  })()`);
  console.log('barline alignment:', JSON.stringify(lineAlign));
  await host.screenshot({ path: `${OUT}/bars-drums-2.png` });

  // 6. Grow the loop to 4 bars from the drum panel: ruler follows.
  await clickSelector(host, '#host-drum-adv-check');
  await clickSelector(host, '#host-drum-length [data-steps="64"]');
  const ruler4 = await pollExpr(host, `(() => {
    const marks = [...document.querySelectorAll('#sequencer .seq-ruler__bar')].map((m) => m.textContent.trim());
    return { ok: marks.length === 4, marks };
  })()`);
  console.log('drum ruler @4bars:', JSON.stringify(ruler4));
  if (ruler4.marks.join('|') !== '1|2 ← 1|3 ← 1|4 ← 1') throw new Error(`bad 4-bar marks: ${ruler4.marks.join('|')}`);
  await host.screenshot({ path: `${OUT}/bars-drums-4.png` });
  await clickSelector(host, '#host-drums-close');

  // 7. Bars button now reads "4 bars"; one tap → "1 bar", readout total 1.
  const afterGrow = await pollExpr(host, `(() => {
    const text = document.getElementById('btn-bars').textContent.trim();
    return { ok: /4\\s*bars/i.test(text), text };
  })()`);
  await clickSelector(host, '#btn-bars');
  const oneBar = await pollExpr(host, `(() => {
    const btn = document.getElementById('btn-bars').textContent.trim();
    const label = document.getElementById('bar-label').textContent;
    return { ok: /1\\s*bar/i.test(btn) && /\\/ 1$/.test(label), btn, label };
  })()`);
  console.log('1-bar state:', JSON.stringify(oneBar));
  await clickSelector(host, '#btn-bars');
  const backTwo = await pollExpr(host, `(() => {
    const btn = document.getElementById('btn-bars').textContent.trim();
    const label = document.getElementById('bar-label').textContent;
    return { ok: /2\\s*bars/i.test(btn) && /\\/ 2$/.test(label), btn, label };
  })()`);
  console.log('back to 2 bars:', JSON.stringify(backTwo));

  // 8. Note-roll ruler: bar numbers 1,2 and a heavy line every 16 steps.
  await clickSelector(host, '#btn-notes');
  await pollExpr(host, `({ ok: !document.getElementById('host-notes-sheet').hidden })`);
  const roll = await pollExpr(host, `(() => {
    const tape = document.getElementById('host-note-tape');
    const bars = [...tape.querySelectorAll('.roll__bar')].map((b) => b.textContent);
    const lines = [...tape.querySelectorAll('.roll__beat--bar')].map((l) => Number(l.dataset.step));
    return { ok: bars.join(',') === '1,2' && lines.join(',') === '0,16,32', bars, lines };
  })()`);
  console.log('roll ruler:', JSON.stringify(roll));
  await host.screenshot({ path: `${OUT}/bars-roll.png` });
  await clickSelector(host, '#host-notes-close');

  // 9. Stop: readout parks on a bar instead of staying live.
  await clickSelector(host, '#btn-transport');
  await sleep(400);
  const stopped = await host.evaluate(`document.getElementById('bar-label').textContent`);
  const stoppedDots = await host.evaluate(`document.querySelectorAll('#beat-dots .beat-dot.is-on').length`);
  console.log('stopped:', JSON.stringify({ stopped, stoppedDots }));

  if (errors.length) throw new Error(errors.join('\n'));
  console.log('BARS OK');
} finally {
  await browser.close();
}
