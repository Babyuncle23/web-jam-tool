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
    globalThis.__spy.lastOpts = opts;
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
  globalThis.__spy.releases = 0;
  const origRel = audio.sampler.releasePad.bind(audio.sampler);
  audio.sampler.releasePad = (id, t) => {
    globalThis.__spy.releases += 1;
    return origRel(id, t);
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
check('host: 12 cells, 11 sample pads, Tune visible', hostMode.pads === 12 && hostMode.samples === 11 && hostMode.tuneBtn);
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

// --- Picking an instrument keeps the pad/mode selection where the user left it. ---
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
check('host: instrument pick keeps pad+mode selection', afterPick.padMode === 'sampler' && afterPick.mode === 'chords', JSON.stringify(afterPick));
await host.click('#host-pad-mode [data-padmode="sampler"]');
await new Promise((r) => setTimeout(r, 150));

// --- Edit panel: a tap picks the pad, sliders retune pitch/stretch/volume. ---
await host.click('#host-sample-edit');
await new Promise((r) => setTimeout(r, 150));
const recDim = await host.evaluate(() => document.getElementById('btn-loop')?.classList.contains('is-off'));
check('host: Rec dims while tuning (no recording)', recDim === true);
const panelUp = await host.evaluate(() => ({
  panel: !document.querySelector('.sampler-editor')?.hidden,
  sliders: document.querySelectorAll('.sampler-editor input[type="range"]').length,
}));
check('host: edit mode opens the slider panel', panelUp.panel && panelUp.sliders === 3, JSON.stringify(panelUp));
await host.click(brahSel); // tap selects brah (and auditions it)
await new Promise((r) => setTimeout(r, 150));
const picked = await host.evaluate(() => ({
  name: document.querySelector('.sampler-editor__name')?.textContent?.trim(),
  armed: document.querySelector('#host-sampler .sampler-pad[data-sample="brah"]')?.classList.contains('is-editing'),
  triggers: globalThis.__spy.triggers.slice(-1),
}));
check('host: pad tap selects it in the panel + auditions', picked.armed === true && /bruh/i.test(picked.name || '') && picked.triggers[0] === 'brah', JSON.stringify(picked));
// Drive the sliders like a finger would: write + input, release commits.
const setSlider = (page, aria, value) =>
  page.evaluate(
    (label, v) => {
      const input = [...document.querySelectorAll('.sampler-editor input[type="range"]')].find(
        (el) => el.getAttribute('aria-label') === label,
      );
      input.value = String(v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    aria,
    value,
  );
const trigBefore = await host.evaluate(() => globalThis.__spy.triggers.length);
await setSlider(host, 'Pitch', 4);
await setSlider(host, 'Stretch', 66); // pos 66 → ×2^0.32 ≈ 1.25
await setSlider(host, 'Volume', 140);
await new Promise((r) => setTimeout(r, 150));
const trigAfter = await host.evaluate(() => globalThis.__spy.triggers.length);
check('host: slider moves never trigger playback', trigAfter === trigBefore, `${trigBefore} → ${trigAfter}`);
const tuned = await host.evaluate(() => globalThis.__spy.params.brah);
check('host: pitch slider retunes', tuned && tuned.pitch === 4, JSON.stringify(tuned));
check('host: stretch slider retunes', tuned && tuned.stretch > 1.1 && tuned.stretch < 1.5, JSON.stringify(tuned));
check('host: volume slider retunes', tuned && Math.abs(tuned.volume - 1.4) < 0.02, JSON.stringify(tuned));
const tunedBadge = await host.evaluate(() => document.querySelector('#host-sampler .sampler-pad[data-sample="brah"] .sampler-pad__badge').textContent);
check('host: badge shows tuning', tunedBadge.includes('+4') && tunedBadge.includes('×') && tunedBadge.includes('140%'), tunedBadge);

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
check('host: lane rows for each bank pad', rollState.laneKeys === 11, `lanes=${rollState.laneKeys}`);
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
check('host: Edit click arms tune+erase layer', eraseUi.editing === true && eraseUi.btnOn === true && eraseUi.crosses === 11 && eraseUi.withHits === 2 && eraseUi.crossVisible && eraseUi.scratchCross === 'none' && eraseUi.recOff === true, JSON.stringify(eraseUi));
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

// --- The panel carousel re-aims the editor without touching the grid. ---
await host.click('#host-sample-edit'); // → edit
await new Promise((r) => setTimeout(r, 120));
await host.click(fahSel); // tap selects fah
await new Promise((r) => setTimeout(r, 150));
const armed = await host.evaluate(() =>
  document.querySelector('#host-sampler .sampler-pad[data-sample="fah"]')?.classList.contains('is-editing'),
);
check('host: tap selects the pad for editing', armed === true);
await host.click('.sampler-editor__arrow[aria-label="Next sample"]'); // fah → peanut (grid order)
await new Promise((r) => setTimeout(r, 120));
const cycled = await host.evaluate(() => ({
  name: document.querySelector('.sampler-editor__name')?.textContent?.trim(),
  armedPad: document.querySelector('#host-sampler .sampler-pad.is-editing')?.dataset.sample,
}));
check('host: carousel next selects the next sample', /peanut/i.test(cycled.name || '') && cycled.armedPad === 'peanut', JSON.stringify(cycled));
await host.click('.sampler-editor__arrow[aria-label="Previous sample"]'); // back to fah
await new Promise((r) => setTimeout(r, 120));
await setSlider(host, 'Pitch', -3);
await new Promise((r) => setTimeout(r, 120));
const armedParams = await host.evaluate(() => globalThis.__spy.params.fah);
check('host: panel slider retunes the carousel-picked pad', armedParams && armedParams.pitch === -3, JSON.stringify(armedParams));
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
await host.click('#host-sampler .sampler-pad[data-sample="scratch105"]');
await new Promise((r) => setTimeout(r, 120));
const scrUi = await host.evaluate(() => ({
  name: document.querySelector('.sampler-editor__name')?.textContent?.trim(),
  stretchDisabled: [...document.querySelectorAll('.sampler-editor input[type="range"]')].find(
    (el) => el.getAttribute('aria-label') === 'Stretch',
  )?.disabled,
}));
check('host: scratch stretch slider is locked (bpm)', /scr 105/i.test(scrUi.name || '') && scrUi.stretchDisabled === true, JSON.stringify(scrUi));
await setSlider(host, 'Pitch', 2);
await setSlider(host, 'Volume', 60);
await new Promise((r) => setTimeout(r, 150));
const scrTuned = await host.evaluate(() => ({
  sent: globalThis.__spy.params.scratch105,
  live: globalThis.__jam.audio.sampler.paramsOf('scratch105'),
}));
check('host: locked scratch keeps the bpm-fitted stretch', Math.abs(scrTuned.live.stretch - fit(105)) < 0.01, JSON.stringify(scrTuned));
check('host: scratch panel still tunes pitch + volume', scrTuned.live.pitch === 2 && Math.abs(scrTuned.live.volume - 0.6) < 0.02, JSON.stringify(scrTuned.live));
await host.click('.sampler-editor__done'); // Done → edit off, params keep
await new Promise((r) => setTimeout(r, 150));
const afterDone = await host.evaluate(() => ({
  panel: document.querySelector('.sampler-editor')?.hidden,
  editing: document.getElementById('host-sampler')?.classList.contains('is-editing'),
  btnOn: document.getElementById('host-sample-edit')?.classList.contains('is-on'),
  kept: globalThis.__jam.audio.sampler.paramsOf('scratch105')?.pitch,
}));
check('host: Done closes the panel, keeps the tuning', afterDone.panel === true && afterDone.editing === false && afterDone.btnOn === false && afterDone.kept === 2, JSON.stringify(afterDone));

// --- BEAT: 4-bar 90bpm loop pad — gate mode, bpm-locked stretch, and its
// voice loops only the session-cycle slice of the source, phase-shifted so
// a mid-bar tap continues the beat mid-bar instead of restarting it. ---
await host.evaluate(() => globalThis.__jam.loopFor('host').clear()); // leftover hits would keep replaying
const beat = await host.evaluate(() => {
  const s = globalThis.__jam.audio.sampler;
  const one = s.trigger('boombap', { id: 'probe:beat1', phase: 0, cycle: 2 });
  const sync1 = s.syncOf('boombap');
  const params = s.paramsOf('boombap');
  return { one, sync1, stretch: params?.stretch };
});
// Session 120bpm → stretch 90/120 = 0.75 → a 2s session bar covers 2.667s
// of source = exactly one bar of the beat.
const beatBar = 4 * (60 / 90);
check('host: BEAT loops one source bar for a 1-bar session', beat.one === true && Math.abs(beat.sync1.loopEnd - beat.sync1.loopStart - beatBar) < 0.02 && beat.sync1.offset === beat.sync1.loopStart && Math.abs(beat.sync1.pos - beat.sync1.offset) < 0.1, JSON.stringify(beat));
const beatPhase = await host.evaluate(() => {
  const s = globalThis.__jam.audio.sampler;
  // Read immediately — the clock is microseconds past the start, so `pos` is
  // the real buffer offset the player entered at, not the computed one.
  s.trigger('boombap', { id: 'probe:beat2', phase: 1, cycle: 2 });
  return s.syncOf('boombap');
});
// phase 1s into a 2s cycle = halfway → half a beat-bar into the source. `pos`
// must equal `offset` — GrainPlayer.start takes playback-seconds, not buffer
// seconds, so a raw offset would land ×playbackRate too far.
check('host: BEAT enters mid-loop at the session phase', Math.abs(beatPhase.offset - beatPhase.loopStart - beatBar / 2) < 0.05 && Math.abs(beatPhase.pos - beatPhase.offset) < 0.05, JSON.stringify(beatPhase));
const beatHeld = await host.evaluate(() => globalThis.__jam.audio.sampler.soundingIds.includes('boombap'));
await host.evaluate(() => globalThis.__jam.audio.sampler.releasePad('boombap'));
await new Promise((r) => setTimeout(r, 200));
const beatOff = await host.evaluate(() => globalThis.__jam.audio.sampler.soundingIds);
check('host: BEAT is a gate pad — sounds while held, release cuts it', beatHeld === true && !beatOff.includes('boombap'), `${beatHeld} → ${JSON.stringify(beatOff)}`);

// A playing beat replaces the drum machine — the kit ducks under it.
await host.evaluate(() => { globalThis.__spy.drumsAudible = null; });
await host.evaluate(() => globalThis.__jam.audio.sampler.trigger('boombap', { id: 'probe:duck', phase: 0, cycle: 2 }));
await new Promise((r) => setTimeout(r, 200));
const ducked = await host.evaluate(() => globalThis.__spy.drumsAudible);
await host.evaluate(() => globalThis.__jam.audio.sampler.releasePad('boombap'));
await new Promise((r) => setTimeout(r, 250));
const unducked = await host.evaluate(() => globalThis.__spy.drumsAudible);
check('host: BEAT mutes the drum machine while it sounds', ducked === false && unducked === true, `${ducked} → ${unducked}`);

// A live pad tap hands the trigger the transport position — the beat joins
// the running loop mid-bar instead of restarting.
await host.evaluate(() => { globalThis.__spy.lastOpts = null; });
await host.click('#host-pad-mode [data-padmode="sampler"]');
await new Promise((r) => setTimeout(r, 150));
const beatBox = await padBox(host, '#host-sampler .sampler-pad[data-sample="boombap"]');
await host.mouse.move(beatBox.x + beatBox.width / 2, beatBox.y + beatBox.height / 2);
await host.mouse.down();
await new Promise((r) => setTimeout(r, 150));
const liveSync = await host.evaluate(() => globalThis.__spy.lastOpts);
await host.mouse.up();
check('host: live BEAT hit carries the loop phase', liveSync && Number.isFinite(liveSync.phase) && Number.isFinite(liveSync.cycle) && liveSync.phase >= 0 && liveSync.phase < liveSync.cycle, JSON.stringify(liveSync));

// Landscape/desktop: the editor docks into the tools column — the pad must
// keep its full size while editing (the old fixed rail shrank it).
const padBefore = await host.evaluate(() => document.getElementById('host-pad').getBoundingClientRect().height);
await host.click('#host-sample-edit');
await new Promise((r) => setTimeout(r, 200));
const wideLayout = await host.evaluate(() => ({
  inTools: Boolean(document.querySelector('.sampler-editor')?.closest('.host-tools')),
  padHeight: document.getElementById('host-pad').getBoundingClientRect().height,
}));
await host.click('#host-sample-edit');
await new Promise((r) => setTimeout(r, 150));
check('host: wide layout docks the panel in the tools column, pad keeps its height', wideLayout.inTools === true && Math.abs(wideLayout.padHeight - padBefore) < 2, JSON.stringify(wideLayout));

// --- Edit mode + gate pads: a press selects AND auditions gate-style —
// sounding only while held, never a whole-buffer one-shot, and the pad
// unlits once the voice actually ends (the stale-onstop bug used to leave
// it lit forever). ---
await host.click('#host-sample-edit'); // → edit
await new Promise((r) => setTimeout(r, 150));
const omgBox = await padBox(host, '#host-sampler .sampler-pad[data-sample="omg"]');
await host.mouse.move(omgBox.x + omgBox.width / 2, omgBox.y + omgBox.height / 2);
await host.mouse.down();
await new Promise((r) => setTimeout(r, 250));
const editGateHeld = await host.evaluate(() => ({
  lit: document.querySelector('#host-sampler .sampler-pad[data-sample="omg"]').classList.contains('is-lit'),
  picked: document.querySelector('#host-sampler .sampler-pad[data-sample="omg"]').classList.contains('is-editing'),
  sounding: globalThis.__jam.audio.sampler.sounding,
  releases: globalThis.__spy.releases,
}));
await host.mouse.up();
await new Promise((r) => setTimeout(r, 250));
const editGateUp = await host.evaluate(() => ({
  lit: document.querySelector('#host-sampler .sampler-pad[data-sample="omg"]').classList.contains('is-lit'),
  releases: globalThis.__spy.releases,
}));
check(
  'host: edit-mode gate pad auditions only while held',
  editGateHeld.lit === true && editGateHeld.picked === true && editGateHeld.sounding === true && editGateUp.lit === false && editGateUp.releases > editGateHeld.releases,
  JSON.stringify({ editGateHeld, editGateUp }),
);
await host.click('#host-sample-edit'); // edit → off

// A gate voice that rings out on its own must clear its sounding flag —
// the pad follows onVoice, so a stuck flag kept it lit after the buffer
// ended (Tone reports state 'started' inside the natural-end onstop, which
// the restart guard used to swallow).
await host.evaluate(() => { globalThis.__jam.audio.sampler.trigger('scratch105', { id: 'probe:ring' }); });
await new Promise((r) => setTimeout(r, 120));
const ringing = await host.evaluate(() => ({
  sounding: globalThis.__jam.audio.sampler.sounding,
  lit: document.querySelector('#host-sampler .sampler-pad[data-sample="scratch105"]').classList.contains('is-lit'),
}));
const ringDone = await host
  .waitForFunction(() => globalThis.__jam.audio.sampler.sounding === false, { timeout: 20000 })
  .then(() =>
    host.evaluate(() => ({
      sounding: globalThis.__jam.audio.sampler.sounding,
      lit: document.querySelector('#host-sampler .sampler-pad[data-sample="scratch105"]').classList.contains('is-lit'),
    })),
  )
  .catch(() => ({ sounding: true, lit: true, timeout: true }));
check('host: gate voice unlits after the buffer rings out', ringing.sounding === true && ringing.lit === true && ringDone.sounding === false && ringDone.lit === false, JSON.stringify({ ringing, ringDone }));

// --- Gate recording: quantized start, unquantized real hold length. ---
// (The loop keeps replaying recorded one-shots — `sounding` can't prove a
// live gate cut, so spy on releasePad instead. The spy was installed at
// startup; just zero the counter.)
await host.evaluate(() => { globalThis.__spy.releases = 0; });
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

// --- Regression: a slot restarted while its old source still plays must not
// orphan the new voice. 4 rapid omg hits cycle slot 0 while press 1's buffer
// still runs; the stale onstop used to wipe the fresh voice's flags, so
// releasePad missed it and the pad rang to the buffer's end. Probe the real
// output level — a released pad must actually go silent. ---
const leakProbe = await host.evaluate(async () => {
  const s = globalThis.__jam.audio.sampler;
  globalThis.__jam.loopFor('host').clear(); // recorded hits would keep replaying
  const analyser = new globalThis.Tone.Analyser('waveform', 256);
  s.output.connect(analyser);
  const level = () => Math.max(...[...analyser.getValue()].map(Math.abs));
  for (let i = 0; i < 4; i += 1) s.trigger('omg', { id: `leak:${i}` });
  await new Promise((r) => setTimeout(r, 300)); // let any stale onstop land
  const before = { level: level(), sounding: s.sounding };
  s.releasePad('omg');
  await new Promise((r) => setTimeout(r, 400)); // release ramp + margin
  const after = { level: level(), sounding: s.sounding };
  analyser.disconnect();
  analyser.dispose();
  return { before, after };
});
check('host: releasePad silences rapid-retriggered gate voices', leakProbe.after.level < 0.01, JSON.stringify(leakProbe));

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
check('guest: sampler mode shows grid', guestMode.chip === 'sampler' && guestMode.gridVisible && guestMode.pads === 11, JSON.stringify(guestMode));

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

// Portrait phone: the panel must sit in the page flow below the pad — no
// cell is covered and the page still scrolls.
await guest.click('#controller-sample-edit');
await new Promise((r) => setTimeout(r, 250));
const guestPanel = await guest.evaluate(() => {
  const editor = document.querySelector('.sampler-editor');
  const pad = document.querySelector('#controller-sampler .sampler-pad[data-sample="peanut"]');
  if (!editor || editor.hidden || !pad) return { ok: false };
  const e = editor.getBoundingClientRect();
  const p = pad.getBoundingClientRect();
  const wrap = document.querySelector('.pad-wrap').getBoundingClientRect();
  return {
    ok: true,
    inFlow: getComputedStyle(editor).position !== 'fixed',
    belowPad: e.top >= wrap.bottom - 2,
    padVisible: p.bottom <= e.top + 2,
  };
});
check('guest: portrait edit panel sits below the pad, pads uncovered', guestPanel.inFlow === true && guestPanel.belowPad === true && guestPanel.padVisible === true, JSON.stringify(guestPanel));
await guest.click('#controller-sample-edit');

await host.screenshot({ path: `${OUT}/sampler-host.png` });
await guest.screenshot({ path: `${OUT}/sampler-guest.png` });
await browser.close();

console.log(fails.length ? `\n${fails.length} FAILURES` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
