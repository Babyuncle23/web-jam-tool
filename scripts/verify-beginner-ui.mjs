/**
 * Beginner-UI smoke: guest sections + MORE sheet, drum advanced gating, drum
 * pitch sync, personal undo/redo arrows next to clr all, pad zone highlight markup.
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:43117';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
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
  // Wait for the host view to finish entering — resetScreen swaps the splash node during entry.
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

  // 1. Foreground: pad, mode chips, instrument cards, Rec, undo/redo/clr.
  //    FX controls live behind each card's MORE sheet; Master FX sits at the
  //    end of the foot column.
  const foreground = await guest.evaluate(`(() => ({
    pad: !document.getElementById('pad').hidden,
    modes: document.querySelectorAll('#controller-screen [data-mode]').length === 2,
    inst: Boolean(document.getElementById('controller-instruments')),
    cards: document.querySelectorAll('#controller-instruments .inst-card').length === 5,
    moreButtons: document.querySelectorAll('#controller-instruments [data-more]').length === 5,
    rec: Boolean(document.getElementById('controller-loop')),
    undo: Boolean(document.getElementById('controller-loop-undo')),
    redo: Boolean(document.getElementById('controller-loop-redo')),
    clr: Boolean(document.getElementById('controller-loop-clear')),
    fxSheetHidden: document.getElementById('controller-fx-sheet').hidden,
    masterInFoot: Boolean(document.querySelector('.controller-foot')?.contains(document.getElementById('controller-master'))),
    oldAdvancedGone: !document.getElementById('controller-advanced') && !document.getElementById('controller-advanced-sheet'),
    keyReadout: Boolean(document.getElementById('controller-key')),
    guestScalePicker: Boolean(document.querySelector('#controller-screen [data-scale], #controller-screen [data-root]')),
  }))()`);
  console.log('foreground:', JSON.stringify(foreground));
  if (!foreground.pad || !foreground.modes || !foreground.inst || !foreground.cards || !foreground.rec)
    throw new Error('foreground control missing');
  if (!foreground.undo || !foreground.redo || !foreground.clr) throw new Error('undo/redo/clr missing');
  if (!foreground.fxSheetHidden || !foreground.moreButtons || !foreground.masterInFoot || !foreground.oldAdvancedGone)
    throw new Error('sections/MORE/master layout wrong');
  if (foreground.guestScalePicker) throw new Error('guest must not pick key/scale');
  const clrLabel = await guest.evaluate(`document.getElementById('controller-loop-clear').textContent.trim()`);
  if (clrLabel) throw new Error(`clr all should be icon-only, got "${clrLabel}"`);

  // 2. Instrument card MORE opens the FX sheet for that card; section heads
  //    collapse/expand their bodies. Narrow screens start the instruments
  //    section on the carousel — expand it before tapping a card's MORE.
  const instOpened = await guest.evaluate(`(() => {
    const sec = document.getElementById('sec-guest-instruments');
    if (sec.classList.contains('is-open')) return true;
    sec.querySelector('.tool-sec__head').click();
    return sec.classList.contains('is-open');
  })()`);
  if (!instOpened) throw new Error('instruments section did not expand');
  await clickSelector(guest, '#controller-instruments [data-more="bass"]');
  await pollExpr(guest, `({ ok: !document.getElementById('controller-fx-sheet').hidden })`);
  const fxTitle = await guest.evaluate(`document.getElementById('controller-fx-title').textContent`);
  if (!/bass/i.test(fxTitle)) throw new Error(`fx sheet title should name bass, got "${fxTitle}"`);
  await clickSelector(guest, '#controller-fx-close');
  await pollExpr(guest, `({ ok: document.getElementById('controller-fx-sheet').hidden })`);
  // Section collapse: tapping the head hides the body, chevron state flips.
  await clickSelector(guest, '#sec-guest-drums .tool-sec__head');
  const secState = await guest.evaluate(`(() => ({
    open: document.getElementById('sec-guest-drums').classList.contains('is-open'),
    aria: document.querySelector('#sec-guest-drums .tool-sec__head').getAttribute('aria-expanded'),
  }))()`);
  if (secState.open || secState.aria !== 'false') throw new Error('section did not collapse');
  await clickSelector(guest, '#sec-guest-drums .tool-sec__head');
  console.log('more sheet + section toggles ok');

  // 3. Guest drum sheet: adv panel hidden until checkbox; pitch slider syncs to host.
  await clickSelector(guest, '#controller-drums');
  await pollExpr(guest, `({ ok: !document.getElementById('controller-drums-sheet').hidden })`);
  const drumGate = await guest.evaluate(`(() => ({
    advHidden: document.getElementById('controller-drum-adv').hidden,
    writeVisible: !document.getElementById('controller-drum-write').closest('[hidden]'),
  }))()`);
  if (!drumGate.advHidden) throw new Error('guest drum adv panel should start hidden');
  await clickSelector(guest, '#controller-drum-adv-check');
  await pollExpr(guest, `({ ok: !document.getElementById('controller-drum-adv').hidden })`);
  await guest.evaluate(`(() => {
    const s = document.getElementById('controller-drum-pitch');
    s.value = '7'; s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(300);
  const hostPitch = await pollExpr(host, `(() => ({
    ok: Math.abs(Number(document.getElementById('host-drum-pitch').value) - 7) < 0.01,
    v: document.getElementById('host-drum-pitch').value,
    label: document.getElementById('host-drum-pitch-label').textContent,
  }))()`);
  console.log('host pitch after guest slider:', JSON.stringify(hostPitch));

  // 4. Host drum adv gating: adv rows hidden until checked; length chips cycle steps.
  await clickSelector(host, '#btn-drums');
  await pollExpr(host, `({ ok: !document.getElementById('host-drums-sheet').hidden })`);
  const hostGate = await host.evaluate(`(() => ({
    advHidden: document.getElementById('host-drum-adv').hidden,
  }))()`);
  if (!hostGate.advHidden) throw new Error('host drum adv panel should start hidden');
  await clickSelector(host, '#host-drum-adv-check');
  await pollExpr(host, `({ ok: !document.getElementById('host-drum-adv').hidden })`);
  await clickSelector(host, '#host-drum-length [data-steps="16"]');
  await sleep(200);
  const guestLen = await pollExpr(guest, `(() => ({
    ok: document.querySelector('#controller-drum-length [data-steps].is-picked')?.dataset.steps === '16',
    picked: document.querySelector('#controller-drum-length [data-steps].is-picked')?.dataset.steps,
  }))()`);
  console.log('guest sees host length pick:', JSON.stringify(guestLen));
  await clickSelector(host, '#host-drum-length [data-steps="32"]');
  await sleep(200);
  // Sheets are full-screen overlays — close them before clicking below.
  await clickSelector(guest, '#controller-drums-close');
  await pollExpr(guest, `({ ok: document.getElementById('controller-drums-sheet').hidden })`);

  // 5. Pad zone markup + renderer classes.
  const zones = await guest.evaluate(`(() => ({
    zoneLabels: [...document.querySelectorAll('#controller-y-zones span')].map((z) => z.textContent.trim()),
    highlightHook: Boolean(document.getElementById('pad-canvas')),
  }))()`);
  console.log('zones:', JSON.stringify(zones));
  if (zones.zoneLabels.length < 4 || !zones.highlightHook) throw new Error('zone labels missing');

  // 6. Personal undo/redo: guest places a note in the shared roll, then the
  //    play-bar arrows revert only their own edit. Drum cells are not history.
  const enabled = (id) => `document.getElementById('${id}').getAttribute('aria-disabled') !== 'true'`;
  await pollExpr(guest, `({ ok: ${enabled('controller-notes')} })`);
  await clickSelector(guest, '#controller-notes');
  await pollExpr(guest, `({ ok: !document.getElementById('controller-notes-sheet').hidden })`);
  await sleep(300);
  const tap = await guest.evaluate(`(() => {
    const tape = document.getElementById('controller-note-tape');
    const grid = tape?.querySelector('.roll__grid');
    if (!tape || !grid) return null;
    const tapeRect = tape.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    let rowRect = null;
    for (const row of grid.querySelectorAll('.roll__row:not(.is-blocked)')) {
      const r = row.getBoundingClientRect();
      if (r.top >= tapeRect.top + 2 && r.bottom <= tapeRect.bottom - 2) { rowRect = r; break; }
    }
    if (!rowRect) return { none: true, tapeTop: tapeRect.top, tapeBottom: tapeRect.bottom };
    const x = Math.min(
      Math.min(gridRect.right, tapeRect.right) - 8,
      Math.max(gridRect.left + 8, tapeRect.left + tapeRect.width * 0.6),
    );
    return { x, y: rowRect.top + rowRect.height / 2, gridLeft: gridRect.left, gridW: gridRect.width };
  })()`);
  if (!tap) throw new Error('no in-scale roll row');
  console.log('roll tap at', JSON.stringify(tap));
  await guest.mouse.click(tap.x, tap.y);
  await pollExpr(guest, `(() => ({
    ok: document.querySelectorAll('#controller-note-tape .roll__note').length > 0
      && ${enabled('controller-loop-undo')},
    notes: document.querySelectorAll('#controller-note-tape .roll__note').length,
  }))()`);
  console.log('guest note placed, own undo armed');
  const hostNotes = `(() => {
    const jam = globalThis.__jam;
    const n = jam ? [...jam.audio.loops.values()].reduce((acc, r) => acc + r.notes().length, 0) : -1;
    return { notes: n };
  })()`;
  // The arrows live under the full-screen sheet — close it to reach them.
  await clickSelector(guest, '#controller-notes-close');
  await pollExpr(guest, `({ ok: document.getElementById('controller-notes-sheet').hidden })`);
  await clickSelector(guest, '#controller-loop-undo');
  await pollExpr(host, `(() => { const s = ${hostNotes}; return { ok: s.notes === 0, ...s }; })()`);
  console.log('undo removed the guest note');
  // Redo enables only after the host broadcasts canRedo back to this guest.
  await pollExpr(guest, `({ ok: ${enabled('controller-loop-redo')} })`);
  await clickSelector(guest, '#controller-loop-redo');
  await pollExpr(host, `(() => { const s = ${hostNotes}; return { ok: s.notes === 1, ...s }; })()`);
  console.log('redo restored the guest note');

  if (errors.length) throw new Error(errors.join('\n'));
  console.log('BEGINNER UI SMOKE OK');
} finally {
  await browser.close();
}
