// Sampler mode check: host + guest switch to SMP, pads fire the PadSampler,
// SOLO gates the mix, tune drag retunes, hits record into the loop, and a
// live hit knocks a held FX gesture off.
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

const fails = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
}

const host = await browser.newPage();
host.on('pageerror', (e) => console.log('[host pageerror]', e.message));
await host.setViewport({ width: 1366, height: 800 });
await host.goto(URL + '?role=host', { waitUntil: 'networkidle2' });
await host.waitForFunction(() => /^[A-Z2-9]{4}$/.test(document.getElementById('host-code')?.textContent || ''), { timeout: 10000 });
await host.click('#splash-start');
await host.waitForFunction(() => document.getElementById('audio-splash')?.hidden === true, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 400));

const code = await host.$eval('#host-code', (el) => el.textContent.trim());

// Spy on the sampler + the mix gates.
await host.evaluate(() => {
  const audio = globalThis.__jam.audio;
  globalThis.__spy = { triggers: [], params: {}, busAudible: null, drumsAudible: null };
  const origTrigger = audio.sampler.trigger.bind(audio.sampler);
  audio.sampler.trigger = (id, opts) => {
    globalThis.__spy.triggers.push(id);
    return origTrigger(id, opts);
  };
  const origParams = audio.sampler.setParams.bind(audio.sampler);
  audio.sampler.setParams = (id, p) => {
    globalThis.__spy.params[id] = { ...p };
    return origParams(id, p);
  };
  const origBus = audio.bus.setAudible.bind(audio.bus);
  audio.bus.setAudible = (id, on) => {
    (globalThis.__spy.busAudible ||= {})[id] = on;
    return origBus(id, on);
  };
  const origDrums = audio.drumsFx.setAudible.bind(audio.drumsFx);
  audio.drumsFx.setAudible = (on) => {
    globalThis.__spy.drumsAudible = on;
    return origDrums(on);
  };
  const origAud = audio.sampler.setAudible.bind(audio.sampler);
  audio.sampler.setAudible = (on) => {
    globalThis.__spy.samplerAudible = on;
    return origAud(on);
  };
});

// --- Host: switch to sampler, pads appear, tap fires a one-shot. ---
await host.click('#host-pad-mode [data-padmode="sampler"]');
await new Promise((r) => setTimeout(r, 200));
const hostMode = await host.evaluate(() => ({
  chip: document.querySelector('#host-pad-mode .chip.is-on')?.dataset.padmode,
  gridVisible: !document.getElementById('host-sampler')?.hidden,
  pads: document.querySelectorAll('#host-sampler .sampler-pad').length,
  samples: document.querySelectorAll('#host-sampler .sampler-pad--sample').length,
  tuneBtn: !document.getElementById('host-sample-edit')?.hidden,
  loaded: globalThis.__jam.audio.sampler.loaded,
}));
check('host: sampler mode shows grid', hostMode.chip === 'sampler' && hostMode.gridVisible, JSON.stringify(hostMode));
check('host: 12 cells, 3 sample pads, Tune visible', hostMode.pads === 12 && hostMode.samples === 3 && hostMode.tuneBtn);
check('host: buffers loaded', hostMode.loaded);

const padBox = async (page, sel) => (await page.$(sel)).boundingBox();
const brahSel = '#host-sampler .sampler-pad[data-sample="brah"]';
const fahSel = '#host-sampler .sampler-pad[data-sample="fah"]';
const soloSel = '#host-sampler .sampler-pad[data-action="solo"]';

await host.click(brahSel);
await new Promise((r) => setTimeout(r, 150));
let spy = await host.evaluate(() => globalThis.__spy.triggers.slice());
check('host: pad tap triggers brah', spy.includes('brah'), spy.join(','));

// --- Recording: hits land in the loop. ---
await host.evaluate(() => { globalThis.__spy.triggers = []; });
await host.click('#btn-loop');
await new Promise((r) => setTimeout(r, 250));
await host.click(brahSel);
await new Promise((r) => setTimeout(r, 150));
await host.click(fahSel);
await new Promise((r) => setTimeout(r, 150));
await host.click('#btn-loop');
await new Promise((r) => setTimeout(r, 250));
const recNotes = await host.evaluate(() =>
  globalThis.__jam.loopFor('host').notes().filter((n) => n.instrument === 'sampler').map((n) => ({ s: n.sample, st: n.step })),
);
check('host: recorded two sample hits', recNotes.length === 2 && recNotes.some((n) => n.s === 'brah') && recNotes.some((n) => n.s === 'fah'), JSON.stringify(recNotes));

// --- SOLO gate: hold it, buses mute; release, mix returns. ---
await host.evaluate(() => { globalThis.__spy.busAudible = null; globalThis.__spy.drumsAudible = null; });
const soloBox = await padBox(host, soloSel);
await host.mouse.move(soloBox.x + soloBox.width / 2, soloBox.y + soloBox.height / 2);
await host.mouse.down();
await new Promise((r) => setTimeout(r, 150));
const duringSolo = await host.evaluate(() => ({
  bus: globalThis.__spy.busAudible,
  drums: globalThis.__spy.drumsAudible,
  lit: document.querySelector('#host-sampler .sampler-pad[data-action="solo"]').classList.contains('is-lit'),
}));
const allMuted = duringSolo.bus && Object.values(duringSolo.bus).every((v) => v === false) && duringSolo.drums === false;
check('host: SOLO held mutes every bus', allMuted, JSON.stringify(duringSolo));
check('host: SOLO pad lit while held', duringSolo.lit);

// Simultaneous pad + SOLO: the mouse holds SOLO, a touch tap is finger two.
const brahBox0 = await padBox(host, brahSel);
await host.touchscreen.tap(brahBox0.x + brahBox0.width / 2, brahBox0.y + brahBox0.height / 2);
await new Promise((r) => setTimeout(r, 120));
spy = await host.evaluate(() => globalThis.__spy.triggers.slice(-1));
check('host: pad fires while SOLO held', spy[0] === 'brah', String(spy));

await host.mouse.up();
await new Promise((r) => setTimeout(r, 120));
const afterSolo = await host.evaluate(() => ({
  bus: globalThis.__spy.busAudible,
  drums: globalThis.__spy.drumsAudible,
}));
const allBack = afterSolo.bus && Object.values(afterSolo.bus).every((v) => v === true) && afterSolo.drums === true;
check('host: SOLO release restores the mix', allBack, JSON.stringify(afterSolo));

// --- Instrument solo silences the sampler bus too. ---
await host.evaluate(() => {
  globalThis.__spy.samplerAudible = null;
  document.querySelector('#host-screen [data-mix="solo"][data-voice="drums"]')?.click();
});
await new Promise((r) => setTimeout(r, 120));
let smpAud = await host.evaluate(() => globalThis.__spy.samplerAudible);
check('host: drum solo cuts the sampler', smpAud === false, String(smpAud));
await host.evaluate(() => document.querySelector('#host-screen [data-mix="solo"][data-voice="drums"]')?.click());
await new Promise((r) => setTimeout(r, 120));
smpAud = await host.evaluate(() => globalThis.__spy.samplerAudible);
check('host: unsolo restores the sampler', smpAud === true, String(smpAud));

// --- FX knock: hold the stutter, then a sample hit drops it. ---
await host.click('#host-pad-mode [data-padmode="fx"]');
await new Promise((r) => setTimeout(r, 200));
const padArea = await (await host.$('#host-pad')).boundingBox();
await host.mouse.move(padArea.x + padArea.width * 0.9, padArea.y + padArea.height * 0.8);
await host.mouse.down();
await host.mouse.move(padArea.x + padArea.width * 0.85, padArea.y + padArea.height * 0.75, { steps: 3 });
await new Promise((r) => setTimeout(r, 250));
const holding = await host.evaluate(() => globalThis.__jam.audio.engine.masterFx.holding());
check('host: FX pad holds the stutter', holding === true);
// the FX finger is still down — switch mode and tap via touch, not the mouse
const smpChip = await padBox(host, '#host-pad-mode [data-padmode="sampler"]');
await host.touchscreen.tap(smpChip.x + smpChip.width / 2, smpChip.y + smpChip.height / 2);
await new Promise((r) => setTimeout(r, 150));
const brahBox1 = await padBox(host, brahSel);
await host.touchscreen.tap(brahBox1.x + brahBox1.width / 2, brahBox1.y + brahBox1.height / 2);
await new Promise((r) => setTimeout(r, 150));
const knocked = await host.evaluate(() => globalThis.__jam.audio.engine.masterFx.holding());
check('host: sample hit knocks the FX hold off', knocked === false);
await host.mouse.up();

// --- Ring-out: a sounding one-shot keeps playing past the mode flip. ---
await host.evaluate(() => {
  const s = globalThis.__jam.audio.sampler;
  globalThis.__spy.stopAllCalled = 0;
  const orig = s.stopAll.bind(s);
  s.stopAll = (...a) => { globalThis.__spy.stopAllCalled += 1; return orig(...a); };
  globalThis.__spy.triggers = [];
});
await host.click(brahSel);
const ringing0 = await host.evaluate(() => globalThis.__jam.audio.sampler.sounding);
await host.click('#host-pad-mode [data-padmode="notes"]');
await new Promise((r) => setTimeout(r, 150));
const ringOut = await host.evaluate(() => ({
  sounding: globalThis.__jam.audio.sampler.sounding,
  stopAlls: globalThis.__spy.stopAllCalled,
}));
check('host: hit was sounding before the flip', ringing0 === true);
check('host: leaving SMP keeps the hit ringing', ringOut.sounding === true && ringOut.stopAlls === 0, JSON.stringify(ringOut));

// --- Picking an instrument snaps back to the notes pad, single mode. ---
await host.click('#mode-row [data-mode="chords"]');
await new Promise((r) => setTimeout(r, 80));
await host.click('#host-pad-mode [data-padmode="sampler"]');
await new Promise((r) => setTimeout(r, 120));
await host.click('#instrument-row [data-instrument="organ"]');
await new Promise((r) => setTimeout(r, 150));
const afterPick = await host.evaluate(() => ({
  padMode: document.querySelector('#host-pad-mode .chip.is-on')?.dataset.padmode,
  mode: document.querySelector('#mode-row .chip.is-on')?.dataset.mode,
}));
check('host: instrument pick returns to notes+single', afterPick.padMode === 'notes' && afterPick.mode === 'single', JSON.stringify(afterPick));
await host.click('#host-pad-mode [data-padmode="sampler"]');
await new Promise((r) => setTimeout(r, 150));

// --- Tune drag: hold a pad, drag up → pitch rises; right → stretch grows. ---
await host.click('#host-sample-edit');
await new Promise((r) => setTimeout(r, 150));
const recDim = await host.evaluate(() => document.getElementById('btn-loop')?.classList.contains('is-off'));
check('host: Rec dims while tuning (no recording)', recDim === true);
const brahBox = await padBox(host, brahSel);
await host.mouse.move(brahBox.x + brahBox.width / 2, brahBox.y + brahBox.height / 2);
await host.mouse.down();
await host.mouse.move(brahBox.x + brahBox.width / 2 + 80, brahBox.y + brahBox.height / 2 - 64, { steps: 6 });
await new Promise((r) => setTimeout(r, 150));
await host.mouse.up();
await new Promise((r) => setTimeout(r, 120));
const tuned = await host.evaluate(() => globalThis.__spy.params.brah);
// 64px up / 80px right at the fine-control scale: pitch ≈2, stretch ≈1.26 —
// a pinned ±12 or ×2+ would mean the start-value drift regression is back.
check('host: vertical drag raised pitch', tuned && tuned.pitch > 0 && tuned.pitch <= 6, JSON.stringify(tuned));
check('host: horizontal drag raised stretch', tuned && tuned.stretch > 1 && tuned.stretch < 1.8, JSON.stringify(tuned));
const tunedBadge = await host.evaluate(() => document.querySelector('#host-sampler .sampler-pad[data-sample="brah"] .sampler-pad__badge').textContent);
check('host: badge shows tuning', tunedBadge.includes('+') && tunedBadge.includes('×'), tunedBadge);

// --- Note editor: cycle to Samples → lane rows, no pitch grid. ---
await host.click('#host-sample-edit'); // leave tune mode
await host.click('#btn-notes');
await new Promise((r) => setTimeout(r, 200));
for (let i = 0; i < 6; i += 1) {
  const name = await host.$eval('#host-inst-name', (el) => el.textContent);
  if (/samples/i.test(name)) break;
  await host.click('#host-inst-next');
  await new Promise((r) => setTimeout(r, 120));
}
const rollState = await host.evaluate(() => ({
  name: document.getElementById('host-inst-name')?.textContent?.trim(),
  laneKeys: document.querySelectorAll('#host-note-tape .roll__key--lane').length,
  strips: [...document.querySelectorAll('#host-note-tape .roll__note')].map((s) => s.dataset.instrument),
  sharpRows: document.querySelectorAll('#host-note-tape .roll__row.is-blocked').length,
}));
check('host: roll shows Samples view', /samples/i.test(rollState.name || ''), rollState.name);
check('host: lane rows for each bank pad', rollState.laneKeys === 3, `lanes=${rollState.laneKeys}`);
check('host: recorded hits on lanes', rollState.strips.filter((s) => s === 'sampler').length === 2, JSON.stringify(rollState.strips));
check('host: no pitch grid rows', rollState.sharpRows === 0);
await host.click('#host-notes-close');

// --- Merged edit mode: one click arms tune+erase; the corner ✕ wipes only
// that sample's hits. (The roll carousel's instrument pick already flipped
// the pad back to notes — re-enter SMP first.) ---
await host.click('#host-pad-mode [data-padmode="sampler"]');
await new Promise((r) => setTimeout(r, 150));
await host.click('#host-sample-edit'); // → edit
await new Promise((r) => setTimeout(r, 120));
const eraseUi = await host.evaluate(() => ({
  editing: document.getElementById('host-sampler')?.classList.contains('is-editing'),
  btnOn: document.getElementById('host-sample-edit')?.classList.contains('is-on'),
  crosses: document.querySelectorAll('#host-sampler .sampler-pad__x').length,
  withHits: document.querySelectorAll('#host-sampler .sampler-pad--sample.has-hits').length,
  crossVisible: getComputedStyle(document.querySelector('#host-sampler .sampler-pad[data-sample="brah"] .sampler-pad__x')).display !== 'none',
  scratchCross: getComputedStyle(document.querySelector('#host-sampler .sampler-pad[data-sample="scratch105"] .sampler-pad__x')).display,
  recOff: document.getElementById('btn-loop')?.classList.contains('is-off'),
}));
check('host: Edit click arms tune+erase layer', eraseUi.editing === true && eraseUi.btnOn === true && eraseUi.crosses === 3 && eraseUi.withHits === 2 && eraseUi.crossVisible && eraseUi.scratchCross === 'none' && eraseUi.recOff === true, JSON.stringify(eraseUi));
await host.click('#host-sampler .sampler-pad[data-sample="brah"] .sampler-pad__x');
await new Promise((r) => setTimeout(r, 250));
const afterErase = await host.evaluate(() => ({
  hits: globalThis.__jam.loopFor('host').notes().filter((n) => n.instrument === 'sampler').map((n) => n.sample),
  brahCross: getComputedStyle(document.querySelector('#host-sampler .sampler-pad[data-sample="brah"] .sampler-pad__x')).display,
}));
check('host: corner ✕ wiped brah hits only', !afterErase.hits.includes('brah') && afterErase.hits.includes('fah'), JSON.stringify(afterErase));
check('host: ✕ hides once the pad has no hits', afterErase.brahCross === 'none', afterErase.brahCross);
await host.click('#host-sample-edit'); // edit → off
await new Promise((r) => setTimeout(r, 120));

// --- Armed pad: a tap arms it, then empty grid space is the drag handle. ---
await host.click('#host-sample-edit'); // → edit
await new Promise((r) => setTimeout(r, 120));
await host.click(fahSel); // tap arms fah (no drag = no retune)
await new Promise((r) => setTimeout(r, 150));
const armed = await host.evaluate(() =>
  document.querySelector('#host-sampler .sampler-pad[data-sample="fah"]')?.classList.contains('is-editing'),
);
check('host: tap arms the pad for tuning', armed === true);
const emptyBox = await padBox(host, '#host-sampler .sampler-pad--empty');
await host.mouse.move(emptyBox.x + emptyBox.width / 2, emptyBox.y + emptyBox.height / 2);
await host.mouse.down();
await host.mouse.move(emptyBox.x + emptyBox.width / 2, emptyBox.y + emptyBox.height / 2 - 64, { steps: 4 });
await host.mouse.up();
await new Promise((r) => setTimeout(r, 150));
const armedParams = await host.evaluate(() => globalThis.__spy.params.fah);
check('host: empty-space drag retunes the armed pad', armedParams && armedParams.pitch > 0 && armedParams.pitch <= 6, JSON.stringify(armedParams));
// A ✕ press that lands mid-gesture must be ignored — tuning can't erase.
await host.mouse.down();
await host.mouse.move(emptyBox.x + emptyBox.width / 2, emptyBox.y + emptyBox.height / 2 - 40, { steps: 3 });
const midBox = await padBox(host, '#host-sampler .sampler-pad[data-sample="fah"] .sampler-pad__x');
await host.mouse.move(midBox.x + midBox.width / 2, midBox.y + midBox.height / 2, { steps: 2 });
await host.mouse.up(); // gesture ends over the ✕ — no second pointerdown fires
await new Promise((r) => setTimeout(r, 200));
const stillFah = await host.evaluate(() =>
  globalThis.__jam.loopFor('host').notes().some((n) => n.instrument === 'sampler' && n.sample === 'fah'),
);
check('host: dragging across the ✕ keeps fah hits', stillFah === true);
await host.click('#host-sample-edit'); // edit → off
await new Promise((r) => setTimeout(r, 120));

// --- Tempo-locked pads: stretch is bpm-fitted, gestures can't move it. ---
const lockedParams = await host.evaluate(() => ({
  bpm: globalThis.__jam.audio.engine.bpm,
  s105: globalThis.__jam.audio.sampler.paramsOf('scratch105'),
}));
const fit = (src) => Math.min(2, Math.max(0.5, src / lockedParams.bpm));
check('host: SCR 105 stretch fits the session bpm', lockedParams.s105 && Math.abs(lockedParams.s105.stretch - fit(105)) < 0.01, JSON.stringify(lockedParams));

await host.click('#host-sample-edit'); // → edit
await new Promise((r) => setTimeout(r, 120));
const scrBox = await padBox(host, '#host-sampler .sampler-pad[data-sample="scratch105"]');
await host.mouse.move(scrBox.x + scrBox.width / 2, scrBox.y + scrBox.height / 2);
await host.mouse.down();
await host.mouse.move(scrBox.x + scrBox.width / 2 + 120, scrBox.y + scrBox.height / 2 - 80, { steps: 5 });
await host.mouse.up();
await new Promise((r) => setTimeout(r, 150));
const scrTuned = await host.evaluate(() => ({
  sent: globalThis.__spy.params.scratch105,
  live: globalThis.__jam.audio.sampler.paramsOf('scratch105'),
}));
check('host: scratch drag cannot move the locked stretch', scrTuned.sent && scrTuned.sent.stretch === undefined && Math.abs(scrTuned.live.stretch - fit(105)) < 0.01, JSON.stringify(scrTuned));
check('host: scratch drag still tunes pitch', scrTuned.live.pitch > 0, JSON.stringify(scrTuned.live));
await host.click('#host-sample-edit'); // edit → off
await new Promise((r) => setTimeout(r, 120));

// --- Gate recording: quantized start, unquantized real hold length. ---
// (The loop keeps replaying recorded one-shots — `sounding` can't prove a
// live gate cut, so spy on releasePad instead.)
await host.evaluate(() => {
  const s = globalThis.__jam.audio.sampler;
  globalThis.__spy.releases = 0;
  const orig = s.releasePad.bind(s);
  s.releasePad = (id, t) => { globalThis.__spy.releases += 1; return orig(id, t); };
});
await host.click('#btn-loop');
await new Promise((r) => setTimeout(r, 250));
const scrHit = await padBox(host, '#host-sampler .sampler-pad[data-sample="scratch105"]');
await host.mouse.move(scrHit.x + scrHit.width / 2, scrHit.y + scrHit.height / 2);
await host.mouse.down();
await new Promise((r) => setTimeout(r, 120));
const gateSounding = await host.evaluate(() => globalThis.__jam.audio.sampler.sounding);
await new Promise((r) => setTimeout(r, 280));
await host.mouse.up();
await new Promise((r) => setTimeout(r, 150));
const gateReleased = await host.evaluate(() => globalThis.__spy.releases);
await host.click('#btn-loop');
await new Promise((r) => setTimeout(r, 250));
check('host: gate pad sounds while held, release ends it', gateSounding === true && gateReleased >= 1, `sounding=${gateSounding} releases=${gateReleased}`);
const gateNote = await host.evaluate(() => {
  const loop = globalThis.__jam.loopFor('host');
  const note = loop.notes().find((x) => x.instrument === 'sampler' && x.sample === 'scratch105');
  const up = loop.exportEvents().find((e) => e.sample === 'scratch105' && e.type === 'up');
  return note && { step: note.step, end: note.endStep, frac: up?.frac };
});
// endStep wraps past the loop edge — unwrap before comparing the span.
let gdur = gateNote && gateNote.end - gateNote.step;
if (gateNote && gdur <= 0) gdur += 32;
check('host: gate hit keeps its real off-grid end (frac up)', gateNote && gateNote.frac !== undefined && gdur > 0.2 && gdur < 6, JSON.stringify(gateNote));

// The pad must glow for the whole sounding span — gate voices report
// start/stop through onVoice (loop playback goes through it too). Clear the
// recorded hit first so a loop replay can't hold the pad lit mid-probe.
await host.evaluate(() => { globalThis.__jam.loopFor('host').clearSample('scratch105'); });
await host.evaluate(() => {
  const s = globalThis.__jam.audio.sampler;
  globalThis.__spy.voices = [];
  const prev = s.onVoice;
  s.onVoice = (id, on) => { globalThis.__spy.voices.push([id, on]); prev?.(id, on); };
  s.trigger('scratch105', { id: 'probe:1' });
});
await new Promise((r) => setTimeout(r, 120));
await host.evaluate(() => { globalThis.__jam.audio.sampler.releasePad('scratch105'); });
await new Promise((r) => setTimeout(r, 120));
const voices = await host.evaluate(() => globalThis.__spy.voices);
check('host: gate voice reports sounding on→off (pad stays lit)', voices.some((v) => v[0] === 'scratch105' && v[1] === true) && voices.some((v) => v[0] === 'scratch105' && v[1] === false), JSON.stringify(voices));

// --- Guest: joins, switches to SMP, taps reach the host. ---
const guest = await browser.newPage();
guest.on('pageerror', (e) => console.log('[guest pageerror]', e.message));
await guest.setViewport({ width: 390, height: 800 });
await guest.goto(`${URL}?role=controller&code=${code}`, { waitUntil: 'networkidle2' });
await guest.waitForFunction(() => globalThis.__jam?.socket, { timeout: 10000 });
await guest.waitForFunction(() => !document.getElementById('pad')?.classList.contains('is-locked'), { timeout: 15000 });
await host.evaluate(() => { globalThis.__spy.triggers = []; });

await guest.click('#controller-pad-mode [data-padmode="sampler"]');
await new Promise((r) => setTimeout(r, 200));
const guestMode = await guest.evaluate(() => ({
  chip: document.querySelector('#controller-pad-mode .chip.is-on')?.dataset.padmode,
  gridVisible: !document.getElementById('controller-sampler')?.hidden,
  pads: document.querySelectorAll('#controller-sampler .sampler-pad--sample').length,
}));
check('guest: sampler mode shows grid', guestMode.chip === 'sampler' && guestMode.gridVisible && guestMode.pads === 3, JSON.stringify(guestMode));

await guest.click('#controller-sampler .sampler-pad[data-sample="fah"]');
await new Promise((r) => setTimeout(r, 250));
spy = await host.evaluate(() => globalThis.__spy.triggers.slice(-1));
check('guest: pad tap reaches the host', spy[0] === 'fah', String(spy));

// Guest SOLO: hold → host buses mute.
await host.evaluate(() => { globalThis.__spy.busAudible = null; globalThis.__spy.drumsAudible = null; });
const gSolo = await padBox(guest, '#controller-sampler .sampler-pad[data-action="solo"]');
await guest.mouse.move(gSolo.x + gSolo.width / 2, gSolo.y + gSolo.height / 2);
await guest.mouse.down();
await new Promise((r) => setTimeout(r, 200));
const gSoloMix = await host.evaluate(() => ({
  bus: globalThis.__spy.busAudible,
  drums: globalThis.__spy.drumsAudible,
  remote: document.querySelector('#host-sampler .sampler-pad[data-action="solo"]')?.classList.contains('is-lit'),
}));
check('guest: SOLO mutes host buses', gSoloMix.bus && Object.values(gSoloMix.bus).every((v) => v === false) && gSoloMix.drums === false, JSON.stringify(gSoloMix));
check('guest: SOLO glows on the host grid too', gSoloMix.remote === true);
await guest.mouse.up();

await host.screenshot({ path: `${OUT}/sampler-host.png` });
await guest.screenshot({ path: `${OUT}/sampler-guest.png` });
await browser.close();

console.log(fails.length ? `\n${fails.length} FAILURES` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
