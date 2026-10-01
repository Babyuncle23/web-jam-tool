/**
 * Editor gestures smoke: pinch zoom + one-finger pan on the note roll and
 * the drum grid, Ctrl+wheel zoom, and the landscape play-bar/chevron fixes.
 * Real touch events go through CDP so the pointer pipeline sees them.
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:43117';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fails = [];
const ok = (cond, name) => {
  console.log(cond ? `ok   ${name}` : `FAIL ${name}`);
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 30000,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});

async function openPage(width, height) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  pageerror:', e.message));
  await page.setViewport({ width, height, hasTouch: true, isMobile: width < 900 });
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  return page;
}

async function openHost(width, height) {
  const page = await openPage(width, height);
  await page.goto(`${BASE}/?role=host`, { waitUntil: 'domcontentloaded' });
  await sleep(600);
  await page.evaluate(() => document.getElementById('splash-start')?.click());
  await sleep(800);
  return page;
}

async function hostCode(page) {
  for (let i = 0; i < 40; i++) {
    const code = await page.evaluate(() => document.getElementById('host-code')?.textContent ?? '');
    if (code.length === 4) return code;
    await sleep(250);
  }
  return '';
}

async function openGuest(code, width, height) {
  const page = await openPage(width, height);
  await page.goto(`${BASE}/?role=controller&code=${code}`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 40; i++) {
    const ready = await page.evaluate(() => {
      const splash = document.getElementById('controller-splash');
      const notes = document.getElementById('controller-notes');
      return Boolean(splash?.hidden) && Boolean(notes && !notes.disabled);
    });
    if (ready) return page;
    await sleep(250);
  }
  return page;
}

/* One-finger drag from `from` to `to` in steps, then release. */
async function drag(page, from, to, steps = 8) {
  const finger = await page.touchscreen.touchStart(from[0], from[1]);
  for (let i = 1; i <= steps; i++) {
    await finger.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
  }
  await finger.end();
}

/* Stationary one-finger tap. */
async function tap(page, at) {
  const finger = await page.touchscreen.touchStart(at[0], at[1]);
  await finger.end();
}

/* Two-finger pinch around `mid`: starts at half-spread `d0`, ends at `d1`. */
async function pinch(page, mid, d0, d1, steps = 6) {
  const a = await page.touchscreen.touchStart(mid[0] - d0, mid[1]);
  const b = await page.touchscreen.touchStart(mid[0] + d0, mid[1]);
  for (let i = 1; i <= steps; i++) {
    const d = d0 + ((d1 - d0) * i) / steps;
    await a.move(mid[0] - d, mid[1]);
    await b.move(mid[0] + d, mid[1]);
  }
  await a.end();
  await b.end();
}

/* ---------- Host portrait: notes sheet ---------- */
{
  const page = await openHost(390, 844);
  await page.evaluate(() => document.getElementById('btn-notes')?.click());
  await sleep(500);
  const sheet = await page.evaluate(() => {
    const sheet = document.getElementById('host-notes-sheet');
    const roll = document.getElementById('host-note-tape');
    return {
      hidden: sheet.hidden,
      h2: sheet.querySelectorAll('h2').length,
      zoomRow: sheet.querySelectorAll('.zoom-row').length,
      hasRoll: Boolean(roll?.querySelector('.roll__sheet')),
      rollH: roll?.clientHeight ?? 0,
      stepPx: roll?.__stepPx ?? 0,
    };
  });
  ok(!sheet.hidden, 'host notes sheet open');
  ok(sheet.h2 === 0, 'no Notes h2');
  ok(sheet.zoomRow === 0, 'no zoom sliders in notes sheet');
  ok(sheet.hasRoll, 'roll rendered');
  ok(sheet.rollH > 240, `roll has real height (${sheet.rollH}px)`);
  const step0 = sheet.stepPx;

  const box = await page.evaluate(() => {
    const r = document.getElementById('host-note-tape').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const cx = box.x + box.w * 0.6;
  const cy = box.y + box.h * 0.55;

  // two-finger pinch IN (spread) — stepPx should grow, content overflows
  await pinch(page, [cx, cy], 40, 150);
  await sleep(250);
  const step1 = await page.evaluate(() => document.getElementById('host-note-tape').__stepPx);
  ok(step1 > step0 + 1, `pinch-in zooms roll (${step0} → ${step1})`);

  // one-finger pan: drag up-left, scroll should move, no note placed
  await drag(page, [cx, cy], [cx - 120, cy - 56]);
  await sleep(150);
  const panned = await page.evaluate(() => {
    const roll = document.getElementById('host-note-tape');
    return { left: roll.scrollLeft, top: roll.scrollTop, notes: roll.querySelectorAll('.roll__note').length };
  });
  ok(panned.left > 30, `one-finger drag pans roll horizontally (${panned.left})`);
  ok(panned.top > 10, `one-finger drag pans roll vertically (${panned.top})`);
  ok(panned.notes === 0, 'pan did not place a note');

  // pinch OUT — back down
  await pinch(page, [cx, cy], 90, 30);
  await sleep(250);
  const step2 = await page.evaluate(() => document.getElementById('host-note-tape').__stepPx);
  ok(step2 < step1 - 1, `pinch-out shrinks roll (${step1} → ${step2})`);

  // stationary tap still places a note — wait out the post-pinch tap guard,
  // and aim at a visible in-scale row (blocked rows refuse writes by design)
  await sleep(450);
  const notesBefore = await page.evaluate(() => document.getElementById('host-note-tape').querySelectorAll('.roll__note').length);
  const noteSpot = await page.evaluate(() => {
    const roll = document.getElementById('host-note-tape');
    const rollRect = roll.getBoundingClientRect();
    const keys = [...roll.querySelectorAll('.roll__key:not(.is-blocked)')];
    for (const key of keys) {
      const r = key.getBoundingClientRect();
      if (r.top > rollRect.top + 60 && r.bottom < rollRect.bottom - 20) {
        return { x: rollRect.left + rollRect.width * 0.55, y: (r.top + r.bottom) / 2 };
      }
    }
    return null;
  });
  ok(Boolean(noteSpot), 'found an in-scale row to tap');
  if (noteSpot) {
    await tap(page, [noteSpot.x, noteSpot.y]);
    await sleep(200);
    const placed = await page.evaluate(() => document.getElementById('host-note-tape').querySelectorAll('.roll__note').length);
    ok(placed > notesBefore, `tap places a note (${notesBefore} → ${placed})`);
  }

  // Ctrl+wheel zoom (desktop path)
  await page.mouse.move(cx, cy);
  await page.keyboard.down('Control');
  await page.mouse.wheel({ deltaY: -300 });
  await page.keyboard.up('Control');
  await sleep(250);
  const step3 = await page.evaluate(() => document.getElementById('host-note-tape').__stepPx);
  ok(step3 > step2, `ctrl+wheel zooms roll (${step2} → ${step3})`);

  // mouse drag on empty space pans too
  const before = await page.evaluate(() => document.getElementById('host-note-tape').scrollLeft);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy, { steps: 5 });
  await page.mouse.up();
  await sleep(150);
  const after = await page.evaluate(() => document.getElementById('host-note-tape').scrollLeft);
  ok(after < before - 20, `mouse drag pans roll (${before} → ${after})`);

  await page.close();
}

/* ---------- Host: drum sheet ---------- */
{
  const page = await openHost(390, 844);
  await page.evaluate(() => document.getElementById('btn-drums')?.click());
  await sleep(500);
  const info = await page.evaluate(() => {
    const sheet = document.getElementById('host-drums-sheet');
    const tape = document.querySelector('#sequencer .seq-tape');
    const cell = document.querySelector('#sequencer .step');
    return {
      hidden: sheet.hidden,
      hasTape: Boolean(tape),
      cellW: cell?.getBoundingClientRect().width ?? 0,
      zoomRows: sheet.querySelectorAll('.zoom-row').length,
      cellsOn: document.querySelectorAll('#sequencer .step.is-on').length,
    };
  });
  ok(!info.hidden, 'host drums sheet open');
  ok(info.hasTape, 'drum tape rendered');
  ok(info.zoomRows === 0, 'no zoom slider in drums sheet');
  const cell0 = info.cellW;

  const box = await page.evaluate(() => {
    const r = document.querySelector('#sequencer .seq-tape').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const cx = box.x + box.w * 0.7;
  const cy = box.y + box.h * 0.6;

  // one-finger pan
  await drag(page, [cx, cy], [cx - 112, cy]);
  await sleep(150);
  const panned = await page.evaluate(() => ({
    left: document.querySelector('#sequencer .seq-tape').scrollLeft,
    on: document.querySelectorAll('#sequencer .step.is-on').length,
  }));
  ok(panned.left > 20, `drum drag pans tape (${panned.left})`);
  ok(panned.on === info.cellsOn, `pan wrote no cells (${info.cellsOn} → ${panned.on})`);

  // pinch in
  await pinch(page, [cx, cy], 40, 130);
  await sleep(250);
  const afterPinch = await page.evaluate(() => ({
    w: document.querySelector('#sequencer .step')?.getBoundingClientRect().width ?? 0,
    on: document.querySelectorAll('#sequencer .step.is-on').length,
  }));
  ok(afterPinch.w > cell0 + 2, `pinch-in zooms drum cells (${cell0} → ${afterPinch.w})`);
  ok(afterPinch.on === panned.on, `pinch wrote no cells (${panned.on} → ${afterPinch.on})`);

  // tap still writes a cell — wait out the post-pinch click guard, and pick
  // a cell clear of the sticky label column (it overlays the first steps)
  await sleep(450);
  const tapTarget = await page.evaluate(() => {
    const tape = document.querySelector('#sequencer .seq-tape');
    const label = document.querySelector('#sequencer .seq-row__label');
    const labelRight = label ? label.getBoundingClientRect().right : 0;
    const tapeRect = tape.getBoundingClientRect();
    for (const cell of tape.querySelectorAll('.step')) {
      const r = cell.getBoundingClientRect();
      if (r.left > labelRight + 4 && r.right < tapeRect.right - 4 && r.top > tapeRect.top + 30) {
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, on: cell.classList.contains('is-on'), track: cell.dataset.track, step: cell.dataset.step };
      }
    }
    return null;
  });
  ok(Boolean(tapTarget), 'drum cell found for tap');
  if (tapTarget) {
    await tap(page, [tapTarget.x, tapTarget.y]);
    await sleep(200);
    const tapWrote = await page.evaluate(
      ({ track, step, on }) => document.querySelector(`#sequencer .step[data-track="${track}"][data-step="${step}"]`)?.classList.contains('is-on') !== on,
      tapTarget,
    );
    ok(tapWrote, `tap toggles a drum cell (${tapTarget.track}:${tapTarget.step})`);
  }

  await page.close();
}

/* ---------- Guest portrait: notes + drum sheets ---------- */
{
  const hostPage = await openHost(390, 844);
  const code = await hostCode(hostPage);
  ok(code.length === 4, `guest session code (${code})`);

  const page = await openGuest(code, 390, 844);
  await page.evaluate(() => document.getElementById('controller-notes')?.click());
  await sleep(500);
  const sheet = await page.evaluate(() => {
    const sheet = document.getElementById('controller-notes-sheet');
    const roll = document.getElementById('controller-note-tape');
    return {
      hidden: sheet.hidden,
      zoomRow: sheet.querySelectorAll('.zoom-row').length,
      hasRoll: Boolean(roll?.querySelector('.roll__sheet')),
      stepPx: roll?.__stepPx ?? 0,
    };
  });
  ok(!sheet.hidden, 'guest notes sheet open');
  ok(sheet.zoomRow === 0, 'no zoom sliders in guest notes sheet');
  ok(sheet.hasRoll, 'guest roll rendered');
  const gStep0 = sheet.stepPx;

  const box = await page.evaluate(() => {
    const r = document.getElementById('controller-note-tape').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const gcx = box.x + box.w * 0.6;
  const gcy = box.y + box.h * 0.55;

  await pinch(page, [gcx, gcy], 40, 150);
  await sleep(250);
  const gStep1 = await page.evaluate(() => document.getElementById('controller-note-tape').__stepPx);
  ok(gStep1 > gStep0 + 1, `guest pinch-in zooms roll (${gStep0} → ${gStep1})`);

  await drag(page, [gcx, gcy], [gcx - 120, gcy - 56]);
  await sleep(150);
  const gPanned = await page.evaluate(() => {
    const roll = document.getElementById('controller-note-tape');
    return { left: roll.scrollLeft, top: roll.scrollTop };
  });
  ok(gPanned.left > 30, `guest drag pans roll horizontally (${gPanned.left})`);
  ok(gPanned.top > 10, `guest drag pans roll vertically (${gPanned.top})`);

  await page.evaluate(() => document.getElementById('controller-notes-close')?.click());
  await sleep(300);

  // guest drums sheet
  await page.evaluate(() => {
    const btn = document.getElementById('controller-drums');
    btn?.scrollIntoView({ block: 'center' });
    btn?.click();
  });
  await sleep(500);
  const gdrums = await page.evaluate(() => {
    const sheet = document.getElementById('controller-drums-sheet');
    const tape = document.querySelector('#controller-sequencer .seq-tape');
    const cell = document.querySelector('#controller-sequencer .step');
    return {
      hidden: sheet.hidden,
      zoomRows: sheet.querySelectorAll('.zoom-row').length,
      hasTape: Boolean(tape),
      cellW: cell?.getBoundingClientRect().width ?? 0,
    };
  });
  ok(!gdrums.hidden, 'guest drums sheet open');
  ok(gdrums.hasTape, 'guest drum tape rendered');
  ok(gdrums.zoomRows === 0, 'no zoom slider in guest drums sheet');
  const gCell0 = gdrums.cellW;

  const gbox = await page.evaluate(() => {
    const r = document.querySelector('#controller-sequencer .seq-tape').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const dcx = gbox.x + gbox.w * 0.7;
  const dcy = gbox.y + gbox.h * 0.6;

  await drag(page, [dcx, dcy], [dcx - 112, dcy]);
  await sleep(150);
  const gPanLeft = await page.evaluate(() => document.querySelector('#controller-sequencer .seq-tape').scrollLeft);
  ok(gPanLeft > 20, `guest drum drag pans tape (${gPanLeft})`);

  await pinch(page, [dcx, dcy], 40, 130);
  await sleep(250);
  const gCell1 = await page.evaluate(
    () => document.querySelector('#controller-sequencer .step')?.getBoundingClientRect().width ?? 0,
  );
  ok(gCell1 > gCell0 + 2, `guest pinch-in zooms drum cells (${gCell0} → ${gCell1})`);

  // Ctrl+wheel zoom on the guest roll (desktop parity)
  await page.evaluate(() => document.getElementById('controller-drums-close')?.click());
  await sleep(200);
  await page.evaluate(() => document.getElementById('controller-notes')?.click());
  await sleep(400);
  await page.mouse.move(gcx, gcy);
  await page.keyboard.down('Control');
  await page.mouse.wheel({ deltaY: -300 });
  await page.keyboard.up('Control');
  await sleep(250);
  const gStep2 = await page.evaluate(() => document.getElementById('controller-note-tape').__stepPx);
  ok(gStep2 > 0 && gStep2 !== gStep1, `guest ctrl+wheel zooms roll (${gStep1} → ${gStep2})`);

  await page.close();
  await hostPage.close();
}

/* ---------- Host landscape: play-bar fits + chevron + carousel arrow ---------- */
{
  const page = await openHost(844, 390);
  await sleep(500);
  const land = await page.evaluate(() => {
    const bar = document.getElementById('play-bar');
    if (!bar) return { missing: true };
    const barRect = bar.getBoundingClientRect();
    const clipped = [...bar.children].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.right > barRect.right + 2;
    }).length;
    const chev = document.querySelector('.host-tools .tool-sec__chev');
    const chevR = chev?.getBoundingClientRect();
    const sec = chev?.closest('.tool-sec')?.getBoundingClientRect();
    const arrow = document.querySelector('.host-tools [data-inst-cycle]')?.querySelector('.ico');
    const arrowR = arrow?.getBoundingClientRect();
    const arrowBox = arrow?.closest('button, [role="button"]')?.getBoundingClientRect();
    return {
      mq: matchMedia('(orientation: landscape) and (max-height: 560px) and (pointer: coarse)').matches,
      coarse: matchMedia('(pointer: coarse)').matches,
      items: bar.children.length,
      clipped,
      barW: Math.round(barRect.width),
      chevVisible: Boolean(chevR && chevR.width > 0 && sec && chevR.right <= sec.right + 1 && chevR.left >= sec.left - 1),
      chevW: chevR?.width ?? 0,
      arrowW: arrowR?.width ?? 0,
      arrowBoxW: arrowBox?.width ?? 0,
      playInBar: bar.contains(document.getElementById('btn-transport')),
      backInBar: bar.contains(document.querySelector('[data-action="back"]')),
    };
  });
  if (land.missing) ok(false, 'landscape play-bar present');
  ok(land.clipped === 0, `landscape play-bar fits (${land.items} items in ${land.barW}px)`);
  ok(land.playInBar && land.backInBar, 'play + back live in the landscape play-bar');
  ok(land.chevVisible, `instrument section chevron visible in landscape (w=${land.chevW})`);
  ok(land.arrowW > 0, `carousel arrow icon visible in landscape (w=${land.arrowW})`);
  await page.close();
}

await browser.close();
if (fails.length) {
  console.log(`\n${fails.length} FAIL: ${fails.join(', ')}`);
  process.exit(1);
}
console.log('\nEDITOR GESTURES OK');
