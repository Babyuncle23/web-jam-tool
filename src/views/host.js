/**
 * HOST view: owns the audio graph, plays the same XY pad as the guests, and
 * renders every touch — local and remote — through one synth path.
 * Audio only boots on the splash "Start sound" gesture.
 */

import { AudioEngine, DEFAULT_MASTER_GAIN } from '../audio/engine.js';
import { buildLoopMidi, readRepeats, renderLoopWav, saveBlob } from '../audio/export-loop.js';
import { DrumMachine, STEPS, TRACKS, DRUM_PRESETS, tileCells, repeatTargets, repeatSpanSteps } from '../audio/drums.js';
import {
  INSTRUMENT_COLORS,
  INSTRUMENT_IDS,
  INSTRUMENTS,
  NOTE_NAMES,
  SCALE_LABELS,
  LOOP_STEPS,
  PerformanceRecorder,
  barCountLabel,
  nextLoopSteps,
  normalizeLoopSteps,
  TouchSynth,
  defaultOctaves,
  extensionFromY,
  instrumentHomeMidi,
  normalizeInstrument,
  midiInScale,
  padNoteMarks,
  pitchChoice,
  resolveGesture,
  storedInstrument,
  SAMPLER_INSTRUMENT,
} from '../audio/synth.js';
import {
  SAMPLE_BANK,
  PadSampler,
  clampSamplePitch,
  clampSampleStretch,
  clampSampleVolume,
  defaultSampleParams,
  sampleLabel,
} from '../audio/sampler.js';
import {
  FX_COLORS,
  INSTRUMENT_FX,
  clampFx,
  createDrumBus,
  createInstrumentBus,
  defaultFxState,
  defaultLevels,
  drumFxSpecs,
  fxAmountLabel,
  instrumentFxSpecs,
  FX_FULL_LABELS,
  FX_PAD_DIVISIONS,
  masterCutoffHz,
  masterHipassHz,
  REPEAT_ORDER,
} from '../audio/effects.js';
import { TouchPad, TouchPadRenderer } from '../ui/touch-pad.js';
import { paintIconButton, chipIcon, setIconLabel } from '../ui/icons.js';
import { renderPianoRoll, scrollRollToMidi, setRollPlayhead, setRollSelectMode, setRollUndoPreview } from '../ui/piano-roll.js';
import { createSampleGrid } from '../ui/sample-grid.js';
import { createDrumGrid } from '../ui/drum-grid.js';
import { pressable, setControlEnabled } from '../ui/quiet-touch.js';
import { markPageEdges, markScrollEdges } from '../ui/scroll-edges.js';
import { JamSocket, EVENTS, isLocalHostname } from '../network/socket.js';
import { loadScript } from '../network/load-script.js';

const QR_SRC = 'https://cdn.jsdelivr.net/gh/davidshimjs/qrcodejs@master/qrcode.min.js';
const LOG_LIMIT = 6;
const STEP_GAP = 3;

/** Guest link. Localhost and LAN keep the laptop address; a public page keeps its own URL. */
async function guestJoinUrl(code) {
  const url = new URL(location.href);
  url.hash = '';
  url.search = '';
  if (url.pathname.endsWith('/index.html')) url.pathname = url.pathname.slice(0, -'index.html'.length);
  url.searchParams.set('role', 'controller');
  url.searchParams.set('code', code);
  const loopback = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (loopback) {
    try {
      const response = await fetch('/api/lan', { signal: AbortSignal.timeout(2500) });
      const data = response.ok ? await response.json() : null;
      if (data?.host && isLocalHostname(data.host) && !['localhost', '127.0.0.1'].includes(data.host)) {
        url.hostname = data.host;
        if (data.port) url.port = String(data.port);
      }
    } catch {
      // The page address still opens the jam on this machine.
    }
  }
  return url.toString();
}
const DRUM_EDIT_PX = 46;
let drumZoom = 0;
let noteZoom = 0;

function playerIdFromTouch(id) {
  const value = String(id ?? '');
  if (value.startsWith('host:')) return 'host';
  if (value.startsWith('loop:')) return '';
  const split = value.indexOf(':');
  return split === -1 ? value : value.slice(0, split);
}

/** `lite` is the LITE flags object from effects.js, or null for the full rig. */
export async function createHostView({ lite } = {}) {
  const el = {
    code: document.getElementById('host-code'),
    joinUrl: document.getElementById('host-join-url'),
    qr: document.getElementById('host-qr'),
    qrCard: document.querySelector('#host-screen .qr-card'),
    shareSheet: document.getElementById('host-share-sheet'),
    shareQr: document.getElementById('host-qr-big'),
    codeBig: document.getElementById('host-code-big'),
    joinUrlBig: document.getElementById('host-join-url-big'),
    shareClose: document.getElementById('host-share-close'),
    socketStatus: document.getElementById('host-socket-status'),
    audioStatus: document.getElementById('host-audio-status'),
    drumSource: document.getElementById('drum-source'),
    litePill: document.getElementById('host-lite-pill'),
    transport: document.getElementById('btn-transport'),
    drumTransport: document.getElementById('host-drums-transport'),
    sequencer: document.getElementById('sequencer'),
    pad: document.getElementById('host-pad'),
    canvas: document.getElementById('host-pad-canvas'),
    label: document.getElementById('harmony-label'),
    barLabel: document.getElementById('bar-label'),
    beatDots: document.getElementById('beat-dots'),
    zones: document.getElementById('host-y-zones'),
    log: document.getElementById('host-log'),
    peers: document.getElementById('host-peers'),
    rootChips: document.getElementById('root-chips'),
    rootName: document.getElementById('root-name'),
    rootPrev: document.getElementById('root-prev'),
    rootNext: document.getElementById('root-next'),
    drumPresets: document.getElementById('drum-presets'),
    drumPresetsMain: document.getElementById('host-drum-presets'),
    drumFxBox: document.getElementById('host-drum-fx'),
    hostScreen: document.getElementById('host-screen'),
    topbar: document.querySelector('#host-screen .topbar'),
    secHarmonyValue: document.getElementById('sec-harmony-value'),
    secInstValue: document.getElementById('sec-inst-value'),
    secDrumValue: document.getElementById('sec-drums-value'),
    secInstruments: document.getElementById('sec-instruments'),
    instMiniName: document.querySelector('#sec-instruments [data-inst-name]'),
    splash: document.getElementById('audio-splash'),
    splashTitle: document.getElementById('splash-title'),
    splashDetail: document.getElementById('splash-detail'),
    splashError: document.getElementById('splash-error'),
    splashStart: document.getElementById('splash-start'),
    splashContinue: document.getElementById('splash-continue'),
    spinner: document.getElementById('splash-spinner'),
    loop: document.getElementById('btn-loop'),
    loopClear: document.getElementById('btn-loop-clear'),
    loopUndo: document.getElementById('btn-loop-undo'),
    loopRedo: document.getElementById('btn-loop-redo'),
    notes: document.getElementById('btn-notes'),
    notesSheet: document.getElementById('host-notes-sheet'),
    noteTape: document.getElementById('host-note-tape'),
    notesClose: document.getElementById('host-notes-close'),
    noteUndo: document.getElementById('host-undo'),
    noteUndoAll: document.getElementById('host-undo-all'),
    noteRedo: document.getElementById('host-redo'),
    noteClear: document.getElementById('host-note-clear'),
    instPrev: document.getElementById('host-inst-prev'),
    instName: document.getElementById('host-inst-name'),
    instNext: document.getElementById('host-inst-next'),
    bars: document.getElementById('btn-bars'),
    fxSheet: document.getElementById('host-fx-sheet'),
    fxSliders: document.getElementById('host-fx-sliders'),
    fxTitle: document.getElementById('host-fx-title'),
    fxSheetClose: document.getElementById('host-fx-close'),
    master: document.getElementById('btn-master'),
    exportOpen: document.getElementById('btn-export'),
    exportSheet: document.getElementById('host-export-sheet'),
    exportRepeats: document.getElementById('export-repeats'),
    exportMidi: document.getElementById('export-midi'),
    exportWav: document.getElementById('export-wav'),
    exportSamples: document.getElementById('export-samples'),
    exportClose: document.getElementById('export-close'),
    exportError: document.getElementById('export-error'),
    drumsOpen: document.getElementById('btn-drums'),
    drumsSheet: document.getElementById('host-drums-sheet'),
    drumsClose: document.getElementById('host-drums-close'),
    drumWriteRow: document.getElementById('host-drum-write'),
    drumRepeatRow: document.getElementById('host-drum-repeat'),
    drumAdvCheck: document.getElementById('host-drum-adv-check'),
    drumAdvPanel: document.getElementById('host-drum-adv'),
    drumLengthRow: document.getElementById('host-drum-length'),
    drumPitch: document.getElementById('host-drum-pitch'),
    drumPitchLabel: document.getElementById('host-drum-pitch-label'),
    masterSheet: document.getElementById('host-master-sheet'),
    masterSliders: document.getElementById('host-master-sliders'),
    masterClose: document.getElementById('host-master-close'),
    instruments: document.getElementById('instrument-row'),
    hint: document.getElementById('host-pad-hint'),
    padMode: document.getElementById('host-pad-mode'),
    playBar: document.getElementById('play-bar'),
    modeRow: document.getElementById('mode-row'),
    sampler: document.getElementById('host-sampler'),
    sampleEdit: document.getElementById('host-sample-edit'),
  };

  const state = {
    grid: Object.fromEntries(
      TRACKS.map(({ id }) => [id, Array.from({ length: STEPS }, () => ({ on: false, division: 1 }))]),
    ),
    mode: 'chords',
    root: 'C',
    scale: 'major',
    instrument: 'pad',
    // Instrument whose sliders the More sheet shows — follows the card it
    // was opened from, not always the playing instrument.
    fxFor: 'pad',
    bpm: 120,
    peers: new Map(),
    effects: defaultFxState(),
    levels: defaultLevels(),
    octaves: defaultOctaves(),
    mute: { pad: false, bass: false, organ: false, kalimba: false, synth: false, drums: false },
    solo: { pad: false, bass: false, organ: false, kalimba: false, synth: false, drums: false },
    masterFx: { division: '16n', cutoff: 0, hipass: 0, grit: 0, wah: 0, hold: false, volume: DEFAULT_MASTER_GAIN },
    padMode: 'notes',
    // 'sampler' parks the roll on the lane view; anything else follows the
    // pad instrument.
    rollView: null,
    /** '' | 'edit' — the pad grid's tune/erase layer while in SMP mode. */
    samplerEdit: '',
    sampleParams: defaultSampleParams(),
    activeTouches: new Set(),
    audioReady: false,
    audioError: null,
    booting: false,
    lastRemote: null,
    drumSteps: STEPS,
    noteSteps: LOOP_STEPS,
    drumPreset: 'break',
    drumWrite: 'single',
    drumRepeat: DRUM_PRESETS.break.repeat ?? 1,
    drumPitch: 0,
  };
  const initialPreset = DRUM_PRESETS[state.drumPreset];
  for (const track of TRACKS) {
    for (const [step, division] of tileCells(initialPreset.pattern[track.id] ?? [], state.drumSteps, initialPreset.span)) {
      state.grid[track.id][step] = { on: true, division };
    }
  }

  /** @type {{ engine: AudioEngine, drums: DrumMachine, synth: TouchSynth, bus: ReturnType<typeof createInstrumentBus>, drumsFx: ReturnType<typeof createDrumBus>, loops: Map<string, PerformanceRecorder> } | null} */
  let audio = null;

  const renderer = new TouchPadRenderer(el.canvas, { columns: 12, maxRatio: lite?.lowDpi ? 1.5 : 0, lite: lite?.cheapViz });
  const socket = new JamSocket();

  function log(message, accent = '') {
    const item = document.createElement('li');
    if (accent) {
      const tag = document.createElement('b');
      tag.textContent = accent;
      item.append(tag, ` ${message}`);
    } else {
      item.textContent = message;
    }
    el.log.prepend(item);
    while (el.log.children.length > LOG_LIMIT) el.log.lastElementChild.remove();
  }

  function setPeers() {
    el.peers.textContent = `guests: ${state.peers.size}`;
  }

  function setLabel(text) {
    el.label.textContent = text || '—';
  }

  /** Section headers always read out the current value when collapsed. */
  function paintSecValues() {
    if (el.secHarmonyValue) el.secHarmonyValue.textContent = `${state.root} · ${SCALE_LABELS[state.scale] ?? state.scale}`;
    const spec = INSTRUMENTS.find((item) => item.id === state.instrument);
    if (el.secInstValue) el.secInstValue.textContent = spec?.label ?? state.instrument;
    if (el.secDrumValue) el.secDrumValue.textContent = DRUM_PRESETS[state.drumPreset]?.label ?? 'Custom';
  }

  /** The collapsed instrument section is a one-item carousel. */
  function paintInstrumentMini() {
    if (!el.instMiniName) return;
    const spec = INSTRUMENTS.find((item) => item.id === state.instrument);
    el.instMiniName.style.setProperty('--chip', INSTRUMENT_COLORS[state.instrument] || '#e2b43a');
    paintIconButton(el.instMiniName, state.instrument, spec?.label || state.instrument);
  }

  const padFingers = new Map();

  function sameInstrument(instrument) {
    return normalizeInstrument(instrument) === normalizeInstrument(state.instrument);
  }

  function selectedFingerHeld() {
    for (const finger of padFingers.values()) {
      if (sameInstrument(finger.instrument)) return true;
    }
    return false;
  }

  function publishHarmony() {
    socket.broadcastState({
      lite: Boolean(lite),
      root: state.root,
      scale: state.scale,
      audioReady: state.audioReady,
      audioError: state.audioError,
      effects: state.effects,
      levels: state.levels,
      octaves: state.octaves,
      loopBars: state.noteSteps,
      bpm: state.bpm,
      transport: Boolean(audio?.engine.transportRunning),
      masterFx: {
        division: state.masterFx.division,
        cutoff: state.masterFx.cutoff,
        hipass: state.masterFx.hipass,
        grit: state.masterFx.grit,
        wah: state.masterFx.wah,
        hold: Boolean(state.masterFx.hold),
        volume: state.masterFx.volume,
      },
      sampler: {
        params: state.sampleParams,
        solo: soloHolders.size > 0,
      },
    });
  }

  function setRoot(note) {
    if (!NOTE_NAMES.includes(note)) return;
    state.root = note;
    audio?.synth.setRoot(note);
    el.rootName.textContent = note;
    el.rootChips.querySelectorAll('.chip').forEach((chip) => chip.classList.toggle('is-picked', chip.dataset.root === note));
    paintSecValues();
    publishHarmony();
    if (!el.notesSheet.hidden) paintHostRoll();
  }

  function stepRoot(direction) {
    const index = NOTE_NAMES.indexOf(state.root);
    const next = NOTE_NAMES[(index + direction + NOTE_NAMES.length) % NOTE_NAMES.length];
    setRoot(next);
  }

  /** Zone labels sit top→bottom: 9, 7, sus, triad. Both sus bands share one. */
  const ZONE_SPAN = { ninth: 0, seventh: 1, sus2: 2, sus4: 2, triad: 3 };

  function paintZone(y) {
    const spans = el.zones?.children;
    if (!spans?.length) return;
    const hit = y == null ? -1 : ZONE_SPAN[extensionFromY(y)] ?? -1;
    [...spans].forEach((span, index) => span.classList.toggle('is-active', index === hit));
  }

  function syncModeChrome() {
    const bass = state.instrument === 'bass';
    const fxMode = state.padMode === 'fx';
    const samplerMode = state.padMode === 'sampler';
    const chords = !fxMode && !samplerMode && state.mode === 'chords' && !bass;
    el.zones.hidden = !chords;
    renderer.setMode(fxMode ? 'fx' : chords ? 'chords' : 'single');
    if (!chords) paintZone(null);
    syncPadMarks();
    // FX and the sampler own the pad: the note-mode row and the loop buttons
    // they ride with step aside. Bass never plays chords, so its mode chips
    // hide too.
    el.playBar.hidden = fxMode;
    if (el.sampler) el.sampler.hidden = !samplerMode;
    samplerUi.setEditMode(state.samplerEdit);
    if (el.sampleEdit) {
      el.sampleEdit.hidden = !samplerMode;
      el.sampleEdit.classList.toggle('is-on', Boolean(state.samplerEdit));
      el.sampleEdit.setAttribute('aria-pressed', state.samplerEdit ? 'true' : 'false');
      paintSampleEditButton(el.sampleEdit);
    }
    // In tune/erase mode the pads never reach the recorder — dim Rec so a
    // dead-looking tap doesn't read as a broken record button.
    el.loop?.classList.toggle('is-off', Boolean(state.samplerEdit));
    el.pad.classList.toggle('is-sampler', samplerMode);
    if (el.modeRow) el.modeRow.hidden = bass || samplerMode;
    selectInRow(el.modeRow, 'mode', bass ? 'single' : state.mode, 'is-on');
    el.padMode?.querySelectorAll('[data-padmode]').forEach((chip) => {
      chip.classList.toggle('is-on', chip.dataset.padmode === state.padMode);
    });
    if (!el.hint) return;
    if (samplerMode) {
      el.hint.textContent = state.samplerEdit
        ? 'Tap a pad to edit it — the panel sliders set pitch, stretch, volume. ✕ wipes a sample’s hits. Rec is off.'
        : 'Tap pads to play. SOLO mutes everything else while held.';
    } else if (fxMode) {
      el.hint.textContent = '— filters only. 1/4 → 1/32 holds stutter. Up cuts lows, down cuts highs.';
    } else if (bass) {
      el.hint.textContent = 'One scale step. Hold and slide.';
    } else if (state.mode === 'chords') {
      el.hint.textContent = 'X is the step. Y is triad, sus, 7th, 9th.';
    } else {
      el.hint.textContent = 'X is the note. Hold and slide.';
    }
  }

  /* ---------- Sequencer ---------- */

  /**
   * One history, two views: every edit sits in its editor's stack AND in the
   * shared stack. Whichever undo consumes an entry also drops it from the
   * other stack, so a change can never be undone twice and later undos keep
   * working. Redo pushes the entry back onto both stacks.
   */
  const ownPast = new Map();
  const globalPast = [];
  /** Redo is personal like undo: each editor gets back only their own undos. */
  const ownFuture = new Map();
  let litStep = -1;

  function pushCapped(stack, entry, cap = 40) {
    stack.push(entry);
    while (stack.length > cap) stack.shift();
  }

  /** Pre-change state of every recorder that is about to be touched. */
  function snapshotOf(playerIds) {
    return [...playerIds].map((id) => ({ playerId: id, events: audio?.loops.get(id)?.exportEvents() ?? null }));
  }

  function pushEdit(editorId, targets) {
    const entry = { targets, editorId };
    let own = ownPast.get(editorId);
    if (!own) {
      own = [];
      ownPast.set(editorId, own);
    }
    pushCapped(own, entry);
    // The shared stack serves 'undo all' — keep it deeper so one player
    // spamming taps cannot evict everyone's history.
    pushCapped(globalPast, entry, 120);
    const future = ownFuture.get(editorId);
    if (future) future.length = 0;
  }

  /** Drop this exact entry wherever the other stack still lists it. */
  function dropEntry(stack, entry) {
    const index = stack?.lastIndexOf(entry) ?? -1;
    if (index >= 0) stack.splice(index, 1);
  }

  function rememberEdit(editorId, targetIds) {
    if (!audio || !targetIds?.length) return;
    pushEdit(editorId, snapshotOf(targetIds));
  }

  function paintRecButton() {
    const on = Boolean(audio?.loops.get('host')?.isRecording);
    el.loop.classList.toggle('is-on', on);
    el.loop.setAttribute('aria-pressed', on ? 'true' : 'false');
    // Red-pink heart glow on the pad while a take is open.
    el.pad?.classList.toggle('is-recording', on);
  }

  function restoreTargets(targets) {
    if (!audio) return;
    for (const { playerId, events } of targets || []) {
      const recorder = recorderFor(playerId);
      if (!recorder) continue;
      // An undo landing inside an open take does not end it: the take keeps
      // recording, and its own history entry still covers what fingers write.
      if (events) recorder.restoreEvents(events);
      else recorder.clear();
    }
    paintRecButton();
  }

  /** The recorder that owns a strip. voiceIds are unique across players. */
  function ownerOfVoice(voiceId) {
    if (!audio) return null;
    for (const [playerId, recorder] of audio.loops) {
      if (recorder.notes().some((note) => note.voiceId === voiceId)) return playerId;
    }
    return null;
  }

  /** The future entry an undo leaves for its editor to redo. */
  function pushFuture(editorId, targets) {
    let future = ownFuture.get(editorId);
    if (!future) {
      future = [];
      ownFuture.set(editorId, future);
    }
    future.push({ targets, editorId });
  }

  function undoOwn(editorId) {
    const entry = ownPast.get(editorId)?.pop();
    if (!entry || !audio) return false;
    dropEntry(globalPast, entry);
    pushFuture(editorId, snapshotOf(entry.targets.map((item) => item.playerId)));
    restoreTargets(entry.targets);
    refreshLoops();
    flushLoopPush();
    return true;
  }

  function undoAll(editorId) {
    const entry = globalPast.pop();
    if (!entry || !audio) return false;
    dropEntry(ownPast.get(entry.editorId), entry);
    // Whoever pressed 'undo all' gets the redo — a stray press is theirs to
    // take back, not the original author's.
    pushFuture(editorId, snapshotOf(entry.targets.map((item) => item.playerId)));
    restoreTargets(entry.targets);
    refreshLoops();
    flushLoopPush();
    return true;
  }

  function redoOwn(editorId) {
    const entry = ownFuture.get(editorId)?.pop();
    if (!entry || !audio) return false;
    const back = { targets: snapshotOf(entry.targets.map((item) => item.playerId)), editorId: entry.editorId };
    let own = ownPast.get(entry.editorId);
    if (!own) {
      own = [];
      ownPast.set(entry.editorId, own);
    }
    pushCapped(own, back);
    pushCapped(globalPast, back, 120);
    restoreTargets(entry.targets);
    refreshLoops();
    flushLoopPush();
    return true;
  }

  /** Voice ids + scale degrees an entry would change if applied right now. */
  function previewTargets(entry) {
    const voices = new Set();
    const degrees = new Set();
    if (!audio || !entry) return { voices, degrees };
    for (const { playerId, events } of entry.targets || []) {
      const now = audio.loops.get(playerId)?.events ?? [];
      const before = new Map((events || []).map((event) => [`${event.voiceId}:${event.step}:${event.type}`, event]));
      const after = new Map(now.map((event) => [`${event.voiceId}:${event.step}:${event.type}`, event]));
      const changed = (event) => {
        voices.add(event.voiceId);
        if (Number.isFinite(event.degree)) degrees.add(event.degree);
      };
      for (const [key, event] of after) if (!before.has(key)) changed(event);
      for (const [key, event] of before) if (!after.has(key)) changed(event);
    }
    return { voices, degrees };
  }

  /**
   * While an undo/redo button is held, ring the pad dots and roll strips it
   * would affect — nobody has to guess what the arrow will move.
   */
  function bindHistoryPreview(button, peekEntry) {
    let active = false;
    const show = () => {
      if (active || !peekEntry()) return;
      active = true;
      const { voices, degrees } = previewTargets(peekEntry());
      renderer.setUndoPreview(degrees);
      if (!el.notesSheet.hidden) setRollUndoPreview(el.noteTape, voices);
    };
    const hide = () => {
      if (!active) return;
      active = false;
      renderer.setUndoPreview(null);
      if (!el.notesSheet.hidden) setRollUndoPreview(el.noteTape, null);
    };
    button.addEventListener('pointerdown', show);
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) button.addEventListener(type, hide);
  }

  function drumCellPx() {
    const steps = Math.max(1, state.drumSteps || 16);
    const view = el.sequencer?.clientWidth || 0;
    const width = view > 80 ? view : Math.max(280, window.innerWidth - 16);
    const fit = Math.max(8, (width - 128 - STEP_GAP * Math.max(0, steps - 1) - 8) / steps);
    return fit + (Math.max(fit, DRUM_EDIT_PX) - fit) * drumZoom;
  }

  /** Pinch/wheel zoom: translate a wanted cell size back into drumZoom. */
  function applyDrumCellPx(px) {
    const steps = Math.max(1, state.drumSteps || 16);
    const view = el.sequencer?.clientWidth || 0;
    const width = view > 80 ? view : Math.max(280, window.innerWidth - 16);
    const fit = Math.max(8, (width - 128 - STEP_GAP * Math.max(0, steps - 1) - 8) / steps);
    const span = Math.max(fit, DRUM_EDIT_PX) - fit;
    drumZoom = span > 0 ? Math.max(0, Math.min(1, (px - fit) / span)) : 0;
    renderSequencer();
    return drumCellPx();
  }

  function drumsPayload() {
    return {
      steps: state.drumSteps,
      preset: state.drumPreset,
      repeat: state.drumRepeat,
      pitch: state.drumPitch,
      grid: Object.fromEntries(
        TRACKS.map(({ id }) => [
          id,
          (state.grid[id] || []).slice(0, state.drumSteps).map((slot) => ({
            on: Boolean(slot?.on),
            division: slot?.division === 3 ? 3 : 1,
          })),
        ]),
      ),
    };
  }

  /** The grid ships inside the shared host state so every guest sees edits. */
  let drumPushTimer = 0;
  let drumPushDirty = false;
  function publishDrums() {
    socket.broadcastState({ drums: drumsPayload() });
  }
  function queueDrumPush() {
    drumPushDirty = true;
    if (drumPushTimer) return;
    drumPushTimer = setTimeout(() => {
      drumPushTimer = 0;
      if (!drumPushDirty) return;
      drumPushDirty = false;
      publishDrums();
    }, 60);
  }
  function flushDrumPush() {
    if (drumPushTimer) {
      clearTimeout(drumPushTimer);
      drumPushTimer = 0;
    }
    if (!drumPushDirty) return;
    drumPushDirty = false;
    publishDrums();
  }

  function setDrumCell(track, step, value) {
    const row = state.grid[track];
    if (!row || step < 0 || step >= state.drumSteps) return false;
    const next = { on: Boolean(value?.on), division: value?.on && Number(value?.division) === 3 ? 3 : 1 };
    const prev = row[step];
    if (prev && prev.on === next.on && (prev.division || 1) === next.division) return false;
    row[step] = next;
    audio?.drums.setStep(track, step, next.on, next.division);
    drumGrid.paintCell(track, step);
    return true;
  }

  function markDrumEdited() {
    if (!state.drumPreset) return;
    state.drumPreset = '';
    markDrumPreset('');
  }

  /** One write from the grid; repeat mode lands it on every matching bar. */
  function applyDrumCell(track, step, value) {
    let changed = false;
    for (const s of repeatTargets(state.drumRepeat, state.drumSteps, step)) {
      changed = setDrumCell(track, s, value) || changed;
    }
    if (!changed) return;
    markDrumEdited();
    queueDrumPush();
  }

  const drumGrid = createDrumGrid(el.sequencer, {
    tracks: TRACKS,
    steps: () => state.drumSteps,
    cell: (track, step) => state.grid[track]?.[step],
    cellPx: drumCellPx,
    iconFor: (track) => chipIcon(track.id),
    mirrorSpan: () => repeatSpanSteps(state.drumRepeat, state.drumSteps),
    writeMode: () => state.drumWrite,
    applyCell: applyDrumCell,
    onGesture: (phase) => {
      if (phase === 'end') flushDrumPush();
    },
    onZoom: applyDrumCellPx,
  });

  function renderSequencer() {
    drumGrid.render();
  }

  /** Copy the leading bars over the rest of the loop when repeat allows it. */
  function tileDrumRepeat() {
    const span = repeatSpanSteps(state.drumRepeat, state.drumSteps);
    if (!span) return;
    for (const track of TRACKS) {
      const row = state.grid[track.id];
      for (let s = span; s < state.drumSteps; s += 1) {
        setDrumCell(track.id, s, row[s % span] || { on: false, division: 1 });
      }
    }
  }

  function paintDrumLength() {
    el.drumLengthRow?.querySelectorAll('[data-steps]').forEach((chip) => {
      chip.classList.toggle('is-picked', Number(chip.dataset.steps) === state.drumSteps);
    });
  }

  function paintDrumEditRows() {
    el.drumWriteRow?.querySelectorAll('[data-write]').forEach((chip) => {
      chip.classList.toggle('is-picked', chip.dataset.write === state.drumWrite);
    });
    el.drumRepeatRow?.querySelectorAll('[data-repeat-bars]').forEach((chip) => {
      const mode = chip.dataset.repeatBars;
      const picked = String(state.drumRepeat) === mode;
      const bars = mode === 'off' ? 0 : Number(mode) || 0;
      // A repeat that spans the whole loop changes nothing — grey it out.
      setControlEnabled(chip, bars === 0 || bars * 16 < state.drumSteps || picked);
      chip.classList.toggle('is-picked', picked);
      chip.setAttribute('aria-pressed', picked ? 'true' : 'false');
    });
  }

  function drumPitchLabel() {
    const st = state.drumPitch;
    return `Drum pitch · ${st > 0 ? '+' : ''}${st} st`;
  }

  function setDrumPitch(value, { republish = true } = {}) {
    const next = Math.min(12, Math.max(-12, Math.round(Number(value) || 0)));
    if (next === state.drumPitch) return;
    state.drumPitch = next;
    audio?.drums.setPitch(next);
    if (el.drumPitch && String(el.drumPitch.value) !== String(next)) el.drumPitch.value = String(next);
    if (el.drumPitchLabel) el.drumPitchLabel.textContent = drumPitchLabel();
    // A dragged slider fires input at pointer rate — batch through the drum push.
    if (republish) queueDrumPush();
  }

  el.drumPitch?.addEventListener('input', () => setDrumPitch(el.drumPitch.value));
  el.drumAdvCheck?.addEventListener('change', () => {
    const on = Boolean(el.drumAdvCheck.checked);
    if (el.drumAdvPanel) el.drumAdvPanel.hidden = !on;
    if (!on) setDrumWrite('single');
  });
  el.drumLengthRow?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-steps]');
    if (!chip || chip.getAttribute('aria-disabled') === 'true') return;
    setSharedLength(Number(chip.dataset.steps));
  });

  function setDrumRepeat(mode) {
    const next = mode === 'off' || mode === '0' || mode === 0 ? 'off' : Math.min(2, Math.max(1, Number(mode) || 1));
    state.drumRepeat = next;
    paintDrumEditRows();
    if (next !== 'off') tileDrumRepeat();
    renderSequencer();
    publishDrums();
  }

  function setDrumWrite(mode) {
    state.drumWrite = mode === 'triplet' ? 'triplet' : 'single';
    paintDrumEditRows();
  }

  el.drumWriteRow?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-write]');
    if (!chip || chip.getAttribute('aria-disabled') === 'true') return;
    setDrumWrite(chip.dataset.write);
  });
  el.drumRepeatRow?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-repeat-bars]');
    if (!chip || chip.getAttribute('aria-disabled') === 'true') return;
    setDrumRepeat(chip.dataset.repeatBars);
  });

  function highlightStep(step) {
    litStep = step;
    drumGrid.setLit(step);
    const running = Boolean(audio?.engine.transportRunning);
    const shown = running && step >= 0 ? step % Math.max(1, state.noteSteps) : parkedLoopStep();
    paintBar(shown);
    paintNotePlayhead(step);
    syncPadPulse(running, step);
    renderer.setLitStep(running && step >= 0 ? step % Math.max(1, state.noteSteps) : -1);
  }

  function beatSeconds() {
    const bpm = Math.min(200, Math.max(40, Number(state.bpm) || 96));
    return 60 / bpm;
  }

  function syncPadPulse(running, step = 0, { retune = false } = {}) {
    const pad = el.pad;
    if (!pad) return;
    const seconds = beatSeconds();
    pad.style.setProperty('--beat-seconds', `${seconds}s`);
    if (!running) {
      pad.classList.remove('is-pulsing');
      return;
    }
    if (!pad.classList.contains('is-pulsing') || retune) {
      const into = step >= 0 ? (Math.floor(step) % 16) / 16 : 0;
      pad.style.setProperty('--pulse-delay', `-${into * seconds * 4}s`);
      pad.classList.remove('is-pulsing');
      void pad.offsetWidth;
      pad.classList.add('is-pulsing');
    }
  }

  function loopBarCount() {
    return Math.max(1, Math.round(state.noteSteps / 16));
  }

  function formatBar(step) {
    if (step == null || step < 0) return 'Bar —';
    const total = loopBarCount();
    return `Bar ${(Math.floor(step / 16) % total) + 1} / ${total}`;
  }

  function paintBeatDots(step) {
    const beat = step == null || step < 0 ? -1 : Math.floor((Math.floor(step) % 16) / 4);
    const dots = el.beatDots?.children;
    if (!dots) return;
    for (let i = 0; i < dots.length; i += 1) {
      const on = i === beat;
      if (dots[i].classList.contains('is-on') !== on) dots[i].classList.toggle('is-on', on);
    }
  }

  function paintBar(step) {
    const text = formatBar(step);
    if (el.barLabel.textContent !== text) el.barLabel.textContent = text;
    paintBeatDots(text === 'Bar —' ? null : step);
  }

  function transportAbsoluteStep() {
    if (!audio?.engine.started) return -1;
    const transport = audio.engine.tone.getTransport();
    const ticksPerStep = (transport.PPQ || 192) / 4;
    const value = Math.floor(Math.max(0, Number(transport.ticks) || 0) / ticksPerStep);
    return value < 0 ? 0 : value;
  }

  function parkedLoopStep() {
    const absolute = transportAbsoluteStep();
    if (absolute < 0) return null;
    return absolute % Math.max(1, state.noteSteps);
  }

  function paintNotePlayhead(drumStep) {
    const absolute = drumStep < 0 ? -1 : transportAbsoluteStep();
    const local = absolute < 0 || !state.noteSteps ? -1 : absolute % state.noteSteps;
    if (!el.notesSheet.hidden) setRollPlayhead(el.noteTape, local);
    if (state.peers.size && absolute >= 0) socket.pulse(absolute, { running: audio.engine.transportRunning });
  }

  function ensureDrumRows(length) {
    for (const track of TRACKS) {
      const row = state.grid[track.id];
      while (row.length < length) row.push({ on: false, division: 1 });
    }
  }

  function applyPattern(pattern, span) {
    const length = state.drumSteps;
    ensureDrumRows(length);
    for (const track of TRACKS) {
      const cells = tileCells(pattern[track.id] ?? [], length, span);
      for (let i = 0; i < length; i += 1) {
        const slot = { on: cells.has(i), division: cells.get(i) ?? 1 };
        state.grid[track.id][i] = slot;
        audio?.drums.setStep(track.id, i, slot.on, slot.division);
      }
    }
    renderSequencer();
  }

  function markDrumPreset(id) {
    for (const row of [el.drumPresets, el.drumPresetsMain]) {
      row?.querySelectorAll('.chip').forEach((chip) => chip.classList.toggle('is-picked', chip.dataset.preset === id));
    }
    paintSecValues();
  }

  function pickDrumPreset(id) {
    const preset = DRUM_PRESETS[id];
    if (!preset) return;
    state.drumPreset = id;
    // Every pattern ships with a repeat default: one bar everywhere but
    // Jersey Club, which repeats its two bars over a 4-bar loop.
    state.drumRepeat = preset.repeat ?? 1;
    paintDrumEditRows();
    applyPattern(preset.pattern, preset.span);
    markDrumPreset(id);
    publishDrums();
  }

  function renderDrumPresets() {
    for (const row of [el.drumPresets, el.drumPresetsMain]) {
      if (!row) continue;
      row.replaceChildren();
      for (const preset of Object.values(DRUM_PRESETS)) {
        const button = pressable(`chip${preset.id === state.drumPreset ? ' is-picked' : ''}`);
        button.dataset.preset = preset.id;
        button.textContent = preset.label;
        button.title = preset.title || preset.label;
        button.addEventListener('click', () => pickDrumPreset(preset.id));
        row.append(button);
      }
    }
    markDrumPreset(state.drumPreset);
  }

  el.drumsOpen?.addEventListener('click', () => {
    el.drumsSheet.hidden = false;
    renderSequencer();
  });
  el.drumsClose?.addEventListener('click', () => {
    el.drumsSheet.hidden = true;
  });

  /* ---------- Per-instrument and drum effects ---------- */

  /** Drum effects moved into the drum sheet's Advanced panel as sliders. */
  function renderDrumFx() {
    const specs = drumFxSpecs(lite);
    const box = el.drumFxBox;
    if (!box) return;
    box.replaceChildren();
    if (!specs.length) return;
    const heading = document.createElement('p');
    heading.className = 'fx-slider__group';
    heading.textContent = 'Drum effects';
    box.append(heading);
    for (const spec of specs) {
      const amount = clampFx(state.effects.drums?.[spec.id] ?? 0);
      const row = document.createElement('label');
      row.className = 'fx-slider';
      row.dataset.fx = spec.id;
      row.style.setProperty('--chip', FX_COLORS[spec.id] || '#e2b43a');
      const name = document.createElement('span');
      const specName = FX_FULL_LABELS[spec.id] ?? spec.label;
      name.textContent = `${specName} · ${Math.round(amount * 100)}%`;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = '100';
      input.step = '1';
      input.value = String(Math.round(amount * 100));
      input.setAttribute('aria-label', specName);
      input.addEventListener('input', () => {
        const value = Number(input.value) / 100;
        name.textContent = `${specName} · ${input.value}%`;
        state.effects.drums[spec.id] = value;
        audio?.drumsFx.setEffect(spec.id, value);
        publishHarmony();
      });
      row.append(name, input);
      box.append(row);
    }
  }

  function applyStoredEffects() {
    if (!audio) return;
    for (const [instrument, levels] of Object.entries(state.effects)) {
      if (instrument === 'drums') {
        for (const [id, level] of Object.entries(levels)) audio.drumsFx.setEffect(id, level);
      } else {
        for (const [id, level] of Object.entries(levels)) audio.bus.setEffect(instrument, id, level);
      }
    }
    for (const [instrument, level] of Object.entries(state.levels)) audio.bus.setLevel(instrument, level);
  }

  const MIX_VOICES = ['pad', 'bass', 'organ', 'kalimba', 'synth', 'drums'];

  function applyMix() {
    if (!audio) return;
    // A held sampler SOLO overrides the whole mix until the last holder lets
    // go — the stored mute/solo flags themselves stay untouched.
    const sampleSolo = soloHolders.size > 0;
    const anySolo = !sampleSolo && MIX_VOICES.some((id) => state.solo[id]);
    for (const id of MIX_VOICES) {
      let heard = !sampleSolo && !state.mute[id] && (!anySolo || state.solo[id]);
      // A playing beat loop already carries the drums — the kit ducks under it.
      if (id === 'drums' && beatDucking.size) heard = false;
      if (id === 'drums') audio.drumsFx.setAudible(heard);
      else audio.bus.setAudible(id, heard);
    }
    // The sampler bus has no solo flag — an instrument solo cuts it too.
    audio.sampler.setAudible(!anySolo || sampleSolo);
  }

  function paintMixFlags() {
    document.querySelectorAll('#host-screen [data-mix]').forEach((button) => {
      const voice = button.dataset.voice;
      const on = button.dataset.mix === 'mute' ? state.mute[voice] : state.solo[voice];
      button.classList.toggle('is-on', Boolean(on));
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  /** The master slider under a finger (element), so remote echoes don't fight it. */
  let masterDrag = null;
  const MASTER_DIVISIONS = new Set(REPEAT_ORDER);

  function applyMasterFx({ prime = false } = {}) {
    const fx = audio?.engine.masterFx;
    if (!fx) return;
    if (prime) {
      fx.setBpm(state.bpm);
      fx.setDivision(state.masterFx.division);
      if (state.masterFx.hold) fx.setHold(true);
    }
    fx.setCutoff(state.masterFx.cutoff);
    fx.setHipass(state.masterFx.hipass);
    fx.setCrush(state.masterFx.grit);
    fx.setWah(state.masterFx.wah);
    audio.engine.setMasterVolume(state.masterFx.volume);
  }

  function masterLabel(key) {
    if (key === 'cutoff') {
      const amount = state.masterFx.cutoff;
      if (amount < 0.02) return 'Cutoff · Off';
      return `Cutoff · ${Math.round(masterCutoffHz(amount))} Hz`;
    }
    if (key === 'grit') {
      return `8-bit grit · ${state.masterFx.grit < 0.02 ? 'Off' : `${Math.round(state.masterFx.grit * 100)}%`}`;
    }
    if (key === 'volume') {
      return `Master volume · ${Math.round(state.masterFx.volume * 100)}%`;
    }
    return `Wah frequency · ${state.masterFx.wah < 0.02 ? 'Off' : `${Math.round(160 * Math.pow(2400 / 160, state.masterFx.wah))} Hz`}`;
  }

  function syncMasterSliderInputs() {
    el.masterSliders?.querySelectorAll('[data-master]').forEach((input) => {
      const key = input.dataset.master;
      if (input === masterDrag) return;
      const next = String(Math.round(state.masterFx[key] * 100));
      if (input.value !== next) input.value = next;
      const name = input.previousElementSibling;
      if (name) name.textContent = masterLabel(key);
    });
  }

  function renderMasterSliders() {
    const rows = [];
    const add = (key, label, value, max, step, onInput) => {
      const row = document.createElement('label');
      row.className = 'fx-slider fx-slider--master';
      const name = document.createElement('span');
      name.textContent = label();
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = String(max);
      input.step = String(step);
      input.dataset.master = key;
      input.value = String(value);
      const claim = () => {
        masterDrag = input;
      };
      const release = () => {
        if (masterDrag === input) masterDrag = null;
      };
      input.addEventListener('pointerdown', claim);
      input.addEventListener('pointerup', release);
      input.addEventListener('pointercancel', release);
      input.addEventListener('input', () => {
        onInput(Number(input.value));
        name.textContent = label();
      });
      row.append(name, input);
      rows.push(row);
    };
    // Lite builds no 8-bit/wah inserts — only the volume slider stays.
    for (const key of lite ? ['volume'] : ['grit', 'wah', 'volume']) {
      add(
        key,
        () => masterLabel(key),
        Math.round(state.masterFx[key] * 100),
        100,
        1,
        (value) => {
          state.masterFx[key] = value / 100;
          applyMasterFx();
          publishHarmony();
        },
      );
    }
    el.masterSliders.replaceChildren(...rows);
  }

  el.hostScreen.addEventListener('click', (event) => {
    const flag = event.target.closest('[data-mix]');
    if (!flag || !el.hostScreen.contains(flag)) return;
    const voice = flag.dataset.voice;
    if (!MIX_VOICES.includes(voice)) return;
    const bucket = flag.dataset.mix === 'mute' ? state.mute : state.solo;
    bucket[voice] = !bucket[voice];
    paintMixFlags();
    applyMix();
  });

  el.master?.addEventListener('click', () => {
    renderMasterSliders();
    el.masterSheet.hidden = false;
  });
  el.masterClose?.addEventListener('click', () => {
    el.masterSheet.hidden = true;
  });

  el.qrCard?.addEventListener('click', () => {
    el.shareSheet.hidden = false;
  });
  el.shareClose?.addEventListener('click', () => {
    el.shareSheet.hidden = true;
  });

  /* ---------- Pad mode: Notes, or the master FX surface ---------- */

  /** Who currently holds the stutter: 'host', or a guest peerId. */
  let masterHolder = null;
  /** Who last steered the bipolar filter — reset on vanish so it can't stick. */
  let filterHolder = null;
  /** FX pad fingers, insertion-ordered — the newest finger drives the master. */
  const fxFingers = new Map();

  function fxZone(point) {
    const index = Math.min(FX_PAD_DIVISIONS.length - 1, Math.max(0, Math.floor(point.x * FX_PAD_DIVISIONS.length)));
    const division = FX_PAD_DIVISIONS[index];
    return { division, label: division ? `1/${division.replace('n', '')}` : '—' };
  }

  /** Filter amount above/below the Y middle. |y − 0.5| inside the dead band is Off. */
  const FX_DEAD = 0.04;
  function fxFilter(point) {
    const t = point.y * 2 - 1;
    const edge = FX_DEAD * 2;
    const amount = Math.abs(t) <= edge ? 0 : clampFx((Math.abs(t) - edge) / (1 - edge));
    return {
      cutoff: t < 0 ? amount : 0,
      hipass: t > 0 ? amount : 0,
      label:
        amount < 0.02
          ? 'open'
          : t > 0
            ? `${masterHipassHz(amount) >= 1000 ? `${(masterHipassHz(amount) / 1000).toFixed(1)} kHz` : `${Math.round(masterHipassHz(amount))} Hz`} HP`
            : `${masterCutoffHz(amount) >= 1000 ? `${(masterCutoffHz(amount) / 1000).toFixed(1)} kHz` : `${Math.round(masterCutoffHz(amount))} Hz`} LP`,
    };
  }

  function fxCaption(point) {
    return `${fxZone(point).label} · ${fxFilter(point).label}`;
  }

  /** Harmless echo throttle: audio applies instantly, guests can lag a frame or two. */
  let harmonyPushTimer = 0;
  function queueHarmony() {
    if (harmonyPushTimer) return;
    harmonyPushTimer = setTimeout(() => {
      harmonyPushTimer = 0;
      publishHarmony();
    }, 90);
  }

  /** One finger on the FX pad: X = stutter division (held), Y = master cutoff. */
  function driveFxPad() {
    const point = [...fxFingers.values()].pop();
    if (!point) {
      // The engine may have released on its own (a thrown capture call) —
      // mirror that here so the state can't claim a hold that isn't real.
      if (!audio?.engine.masterFx?.holding?.() && state.masterFx.hold) {
        state.masterFx.hold = false;
        if (masterHolder) masterHolder = null;
      }
      // A guest mid-hold keeps both: don't open the filter under their finger.
      const owned = masterHolder === 'host';
      if (owned) {
        masterHolder = null;
        state.masterFx.hold = false;
        audio?.engine.masterFx?.setHold(false);
      }
      if (owned || !masterHolder) {
        if (state.masterFx.cutoff !== 0) {
          state.masterFx.cutoff = 0;
          audio?.engine.masterFx?.setCutoff(0);
        }
        if (state.masterFx.hipass !== 0) {
          state.masterFx.hipass = 0;
          audio?.engine.masterFx?.setHipass(0);
        }
        if (filterHolder === 'host') filterHolder = null;
      }
      setLabel('—');
      queueHarmony();
      return;
    }
    const { division } = fxZone(point);
    const { cutoff, hipass } = fxFilter(point);
    filterHolder = 'host';
    // The left lane is filter-only: sliding into it releases the stutter
    // without lifting the finger, sliding back out re-grabs the slice.
    const wantsHold = Boolean(division);
    // Trust the engine's own held flag, not the mirrored state: if a capture
    // threw mid-schedule the engine released while state.masterFx.hold stayed
    // true, and a stale `wasHeld` would skip re-grabbing — the pad then moved
    // the filter but the beat never stuttered.
    const wasHeld = Boolean(audio?.engine.masterFx?.holding?.()) && masterHolder === 'host';
    state.masterFx.cutoff = cutoff;
    state.masterFx.hipass = hipass;
    if (wantsHold) {
      const divisionChanged = state.masterFx.division !== division;
      state.masterFx.division = division;
      state.masterFx.hold = true;
      if (!wasHeld) {
        masterHolder = 'host';
        audio?.engine.masterFx?.setDivision(division);
        audio?.engine.masterFx?.setHold(true);
      } else if (divisionChanged) {
        // A held stutter re-grabs the slice on a zone crossing.
        audio?.engine.masterFx?.setDivision(division);
      }
      if (!wasHeld || divisionChanged) {
        setLabel(fxCaption(point));
        audio?.engine.masterFx?.setCutoff(cutoff);
        audio?.engine.masterFx?.setHipass(hipass);
        queueHarmony();
        return;
      }
    } else if (wasHeld || (masterHolder === 'host' && state.masterFx.hold)) {
      // Also covers a stale hold flag whose engine hold already died.
      masterHolder = null;
      state.masterFx.hold = false;
      audio?.engine.masterFx?.setHold(false);
      queueHarmony();
    }
    audio?.engine.masterFx?.setCutoff(cutoff);
    audio?.engine.masterFx?.setHipass(hipass);
    setLabel(fxCaption(point));
    queueHarmony();
  }

  function fxPadDown(point) {
    fxFingers.set(point.id, { x: point.x, y: point.y });
    paintTouch(`host:${point.id}`, { x: point.x, y: point.y });
    driveFxPad();
  }

  function fxPadMove(point) {
    if (!fxFingers.has(point.id)) return;
    fxFingers.set(point.id, { x: point.x, y: point.y });
    paintTouch(`host:${point.id}`, { x: point.x, y: point.y });
    driveFxPad();
  }

  function fxPadUp(point) {
    fxFingers.delete(point.id);
    paintTouch(`host:${point.id}`, null);
    driveFxPad();
  }

  /**
   * Held fingers leave through the OLD mode first: notes get their note-off,
   * an FX hold releases the stutter — nothing rings across the flip.
   */
  function setPadMode(next) {
    const mode = ['fx', 'sampler'].includes(next) ? next : 'notes';
    if (mode === state.padMode) return;
    const leaving = state.padMode;
    hostPad.releaseHeld();
    fxFingers.clear();
    samplerUi.releaseAll();
    // The sampler owns the pad — a take still open on the notes pad ends here.
    if (mode === 'sampler' && audio?.loops.get('host')?.isRecording) setHostRecording(false);
    // A sounding one-shot rings on past the mode flip — only the held
    // gestures (SOLO, a pressed pad) release.
    if (leaving === 'sampler') state.samplerEdit = '';
    state.padMode = mode;
    syncModeChrome();
  }

  el.padMode?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-padmode]');
    if (chip) setPadMode(chip.dataset.padmode);
  });
  /** The pencil alone is enough — the merged tune/erase layer can read as
     plain "edit" (✎ also covers wiping a pad's hits). */
  function paintSampleEditButton(button) {
    button.classList.add('has-icon', 'sample-edit-btn');
    const text = document.createElement('span');
    text.className = 'chip-label';
    text.textContent = 'Edit';
    button.replaceChildren(chipIcon('edit'), text);
  }

  el.sampleEdit?.addEventListener('click', () => {
    // The edit button toggles the merged tune/erase layer on the pads.
    state.samplerEdit = state.samplerEdit ? '' : 'edit';
    samplerUi.releaseAll();
    syncModeChrome();
  });

  /* ---------- Sampler ---------- */

  /** Peers currently holding SOLO — 'host' or guest peerIds. */
  const soloHolders = new Set();
  /** Beat-locked pads (spec.sync) currently sounding — the drum machine is
      muted while any plays, so the beat never fights the kit. */
  const beatDucking = new Set();
  let liveHitSeq = 0;

  /**
   * Seconds inside the session loop right now — the beat-locked pad enters
   * at this phase, so a mid-bar tap continues the loop's bar instead of
   * restarting it. Null before the audio engine exists.
   */
  function sampleLoopClock() {
    const transport = audio?.engine.tone.getTransport();
    if (!transport) return {};
    const steps = Math.max(1, Math.round(state.noteSteps || 16));
    const stepSeconds = 15 / (transport.bpm.value || state.bpm || 120);
    const ticksPerStep = (transport.PPQ || 192) / 4;
    let pos = transport.getTicksAtTime(audio.engine.tone.now()) / ticksPerStep;
    if (!Number.isFinite(pos) || pos < 0) pos = 0;
    pos %= steps;
    return { phase: pos * stepSeconds, cycle: steps * stepSeconds };
  }

  /**
   * One pad tap: trigger the engine hit and capture it when the player is
   * recording. Auditions (edit-mode release, roll taps) pass record=false so
   * they never land in history.
   */
  function fireSample(peerId, sampleId, { record = true } = {}) {
    if (!audio || !SAMPLE_BANK.some((sample) => sample.id === sampleId)) return false;
    // A hit never knocks a held FX gesture off: the pad modes are exclusive,
    // so the holder can only be another peer whose finger is still down.
    audio.sampler.trigger(sampleId, { id: `smp:${peerId}:${liveHitSeq++}`, ...sampleLoopClock() });
    const wrote = record && recorderFor(peerId)?.captureHit(sampleId);
    if (wrote) refreshLoops(true);
    return true;
  }

  /**
   * Gate-style solo: any holder mutes every bus but the sampler until the
   * last finger lifts. Transient state only — never written to a loop.
   */
  function setSampleSolo(peerId, held) {
    const was = soloHolders.size > 0;
    if (held) {
      soloHolders.add(peerId);
    } else {
      soloHolders.delete(peerId);
    }
    // A guest's held SOLO glows on the host grid; the host's own hold is lit
    // by the grid's pointer tracking already.
    samplerUi.setSoloRemote(soloHolders.has('host') ? false : soloHolders.size > 0);
    if ((soloHolders.size > 0) !== was) {
      applyMix();
      queueHarmony();
    }
  }

  /**
   * The session tempo moved: tempo-locked pads re-fit, badges and guests
   * follow.
   */
  function syncSamplerBpm() {
    if (!audio) return;
    for (const id of audio.sampler.setBpm(state.bpm)) {
      const cur = audio.sampler.paramsOf(id);
      if (cur && state.sampleParams[id]) state.sampleParams[id].stretch = cur.stretch;
      samplerUi.updateParam(id);
      queueHarmony();
    }
  }

  /** Editor-panel move: store the new params, repaint the pad, push to guests. */
  function applySampleTune(peerId, sampleId, next, phase = 'move') {
    const params = state.sampleParams[sampleId];
    if (!params || !next) return;
    const spec = SAMPLE_BANK.find((item) => item.id === sampleId);
    params.pitch = clampSamplePitch(next.pitch);
    params.volume = clampSampleVolume(next.volume ?? params.volume);
    if (spec?.bpm) {
      // Tempo-locked: the sampler owns `stretch` (bpm-fitted); the panel
      // moves pitch and volume only. Keep the synced value in state so
      // badges and guests show the truth.
      const cur = audio?.sampler.paramsOf(sampleId);
      if (cur) params.stretch = cur.stretch;
      audio?.sampler.setParams(sampleId, { pitch: params.pitch, volume: params.volume });
    } else {
      params.stretch = clampSampleStretch(next.stretch ?? params.stretch);
      audio?.sampler.setParams(sampleId, params);
    }
    samplerUi.updateParam(sampleId);
    // 'end' auditions the retuned pad; slider commits arrive as 'set' and
    // stay silent — playback is triggered by the pad/name tap, not the knobs.
    if (phase === 'end') fireSample(peerId, sampleId, { record: false });
    queueHarmony();
  }

  /** Any player's loop carries hits of this sample — gates the pad's ✕. */
  function sampleHasHits(sampleId) {
    if (!audio) return false;
    for (const recorder of audio.loops.values()) {
      const has = recorder
        .notes()
        .some((note) => storedInstrument(note.instrument) === SAMPLER_INSTRUMENT && note.sample === sampleId);
      if (has) return true;
    }
    return false;
  }

  /**
   * Edit mode: the pad's corner ✕ drops that sample's recorded hits — across
   * every player's loop, like the shared note editor does.
   */
  function eraseSampleHits(peerId, sampleId) {
    if (!audio || !SAMPLE_BANK.some((sample) => sample.id === sampleId)) return;
    const owners = [];
    for (const [playerId, recorder] of audio.loops) {
      const has = recorder.notes().some(
        (note) => storedInstrument(note.instrument) === SAMPLER_INSTRUMENT && note.sample === sampleId,
      );
      if (has) owners.push(playerId);
    }
    if (!owners.length) return;
    rememberEdit(peerId, owners);
    for (const ownerId of owners) audio.loops.get(ownerId)?.clearSample(sampleId);
    refreshLoops();
    flushLoopPush();
    log(`${sampleLabel(sampleId)} hits cleared`, 'loop');
  }

  const samplerUi = createSampleGrid(el.sampler, {
    editMode: () => state.samplerEdit,
    params: (id) => state.sampleParams[id],
    onHit: (id) => fireSample('host', id),
    onRelease: (id) => {
      audio?.sampler.releasePad(id);
      // The gate's 'up' lands at the real release spot — not the grid.
      if (recorderFor('host')?.captureRelease(id)) refreshLoops(true);
    },
    onSolo: (held) => setSampleSolo('host', held),
    onTune: (id, next, phase) => applySampleTune('host', id, next, phase),
    onErase: (id) => eraseSampleHits('host', id),
    // Picking a sample for the panel plays it once — the tap doubles as an
    // audition so the edited sound is always heard.
    onSelect: (id) => fireSample('host', id, { record: false }),
    // Done keeps the committed params and leaves the edit layer.
    onDone: () => {
      state.samplerEdit = '';
      samplerUi.releaseAll();
      syncModeChrome();
    },
    hasHits: (id) => sampleHasHits(id),
    panelHost: el.hostScreen,
  });

  /* ---------- Harmony, tempo, instruments, loop ---------- */

  function renderRootChips() {
    el.rootChips.replaceChildren();
    for (const note of NOTE_NAMES) {
      const chip = pressable(`chip${note === state.root ? ' is-picked' : ''}`);
      chip.dataset.root = note;
      chip.textContent = note;
      chip.addEventListener('click', () => setRoot(note));
      el.rootChips.append(chip);
    }
    el.rootName.textContent = state.root;
  }

  el.rootPrev.addEventListener('click', () => stepRoot(-1));
  el.rootNext.addEventListener('click', () => stepRoot(1));

  function selectInRow(row, attr, value, className = 'is-picked') {
    row?.querySelectorAll(`[data-${attr}]`).forEach((chip) => chip.classList.toggle(className, chip.dataset[attr] === value));
  }

  function paintInstruments(row, selected) {
    row?.querySelectorAll('[data-instrument]').forEach((chip) => {
      const id = chip.dataset.instrument;
      const spec = INSTRUMENTS.find((item) => item.id === id);
      chip.classList.add('has-swatch');
      chip.classList.toggle('is-on', id === selected);
      chip.style.setProperty('--chip', INSTRUMENT_COLORS[id] || '#e2b43a');
      chip.closest('.inst-card')?.classList.toggle('is-on', id === selected);
      paintIconButton(chip, id, spec?.label || id);
    });
  }

  el.hostScreen.querySelector('#mode-row')?.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip?.dataset.mode) return;
    state.mode = chip.dataset.mode;
    audio?.synth.setMode(state.mode);
    syncModeChrome();
  });

  el.hostScreen.querySelector('#harmony-row').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    if (chip.dataset.scale) {
      state.scale = chip.dataset.scale;
      audio?.synth.setScale(state.scale);
      selectInRow(el.hostScreen.querySelector('#harmony-row'), 'scale', state.scale, 'is-picked');
      paintSecValues();
      publishHarmony();
      if (!el.notesSheet.hidden) paintHostRoll();
    }
  });

  /** Paint the carousel label; re-paint and re-center the open roll. */
  /** The roll shows every instrument plus one sampler lane view. */
  const ROLL_VIEWS = [...INSTRUMENT_IDS, SAMPLER_INSTRUMENT];

  function rollInstrument() {
    return state.rollView === SAMPLER_INSTRUMENT ? SAMPLER_INSTRUMENT : state.instrument;
  }

  function paintRollInstrument() {
    const view = rollInstrument();
    if (view === SAMPLER_INSTRUMENT) {
      el.instName.style.setProperty('--chip', INSTRUMENT_COLORS.sampler || '#e2b43a');
      paintIconButton(el.instName, 'sampler', 'Samples');
    } else {
      const spec = INSTRUMENTS.find((item) => item.id === state.instrument);
      el.instName.style.setProperty('--chip', INSTRUMENT_COLORS[state.instrument] || '#e2b43a');
      paintIconButton(el.instName, state.instrument, spec?.label || state.instrument);
    }
    if (!el.notesSheet.hidden) {
      paintHostRoll();
      revealRoll();
    }
  }

  function pickInstrument(instrument) {
    // A switch never interrupts an open take: recording keeps rolling, held
    // fingers stay on the instrument they started on (padFingers pins it),
    // and the mode/pad selection stays where the user left it.
    state.instrument = normalizeInstrument(instrument);
    state.fxFor = state.instrument;
    paintInstruments(el.instruments, state.instrument);
    paintInstrumentMini();
    paintSecValues();
    if (!el.fxSheet.hidden) renderFxSliders();
    syncModeChrome();
    paintRollInstrument();
  }

  function cycleInstrument(direction) {
    const index = INSTRUMENT_IDS.indexOf(state.instrument);
    const next = INSTRUMENT_IDS[(index + direction + INSTRUMENT_IDS.length) % INSTRUMENT_IDS.length];
    pickInstrument(next);
  }

  function cycleRollInstrument(direction) {
    const index = ROLL_VIEWS.indexOf(rollInstrument());
    const next = ROLL_VIEWS[(index + direction + ROLL_VIEWS.length) % ROLL_VIEWS.length];
    if (next === SAMPLER_INSTRUMENT) {
      state.rollView = SAMPLER_INSTRUMENT;
      paintRollInstrument();
      return;
    }
    state.rollView = null;
    pickInstrument(next);
  }

  el.instruments.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-instrument]');
    if (!chip) return;
    pickInstrument(chip.dataset.instrument);
  });

  /* Section headers toggle; carousel arrows and card MORE live outside the
     heads so they never fight the collapse toggle. Heads are plain divs so
     a touch drag still scrolls the page. */
  el.hostScreen.addEventListener('click', (event) => {
    const head = event.target.closest('.tool-sec__head');
    // Controls inside a head (Edit notes) act for themselves, never toggle.
    if (head && el.hostScreen.contains(head) && !event.target.closest('button, [role="button"], input, select, a')) {
      const section = head.closest('.tool-sec');
      const open = section.classList.toggle('is-open');
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      return;
    }
    const cycle = event.target.closest('[data-inst-cycle]');
    if (cycle) {
      cycleInstrument(Number(cycle.dataset.instCycle) || 1);
      return;
    }
    const more = event.target.closest('[data-more]');
    if (more) openFxSheet(more.dataset.more);
  });

  el.hostScreen.addEventListener('keydown', (event) => {
    const head = event.target.closest('.tool-sec__head');
    if (!head || event.target !== head || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    head.click();
  });

  /* Landscape phone: the topbar is hidden by CSS, so Play and Back move
     into the play-bar (Play lands between the mode chips and Rec).
     Rotating back moves the buttons home. */
  const landscapeMq = matchMedia('(orientation: landscape) and (max-height: 560px) and (pointer: coarse)');
  const backButton = el.topbar?.querySelector('[data-action="back"]');
  const chromeHomes = [el.transport, backButton]
    .filter(Boolean)
    .map((node) => ({ node, parent: node.parentNode, next: node.nextSibling }));

  function placeLandscapeChrome() {
    if (!el.playBar || !el.transport) return;
    if (landscapeMq.matches) {
      el.playBar.insertBefore(el.transport, el.loop ?? null);
      if (backButton) el.playBar.insertBefore(backButton, el.playBar.firstChild);
    } else {
      for (const { node, parent, next } of chromeHomes) parent.insertBefore(node, next);
    }
  }

  placeLandscapeChrome();
  landscapeMq.addEventListener('change', placeLandscapeChrome);

  function setSharedBpm(bpm) {
    state.bpm = Number(bpm);
    audio?.engine.setBpm(state.bpm);
    syncSamplerBpm();
    el.hostScreen.querySelectorAll('[data-group="bpm"]').forEach((row) => selectInRow(row, 'bpm', String(state.bpm)));
    syncPadPulse(Boolean(audio?.engine.transportRunning), transportAbsoluteStep(), { retune: true });
    publishHarmony();
  }

  el.hostScreen.querySelectorAll('[data-group="bpm"]').forEach((row) => {
    row.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-bpm]');
      if (chip) setSharedBpm(chip.dataset.bpm);
    });
  });

  function ensureTransport() {
    if (!audio || audio.engine.transportRunning) return;
    audio.engine.startTransport();
    paintTransport(true);
  }

  function recorderFor(playerId) {
    if (!audio || !playerId) return null;
    let recorder = audio.loops.get(playerId);
    if (!recorder) {
      recorder = new PerformanceRecorder(audio.engine, audio.synth, {
        playerId,
        sampler: audio.sampler,
        loopSteps: state.noteSteps,
        // Every completed take is its own undo step: the callback hands the
        // loop as it was just before that take's first note-on.
        onTake: (events) => pushEdit(playerId, [{ playerId, events }]),
      });
      audio.loops.set(playerId, recorder);
    }
    return recorder;
  }

  function setHostRecording(next) {
    const recorder = recorderFor('host');
    if (!recorder) return;
    if (next) {
      ensureTransport();
      recorder.start();
      paintRecButton();
      log('recording into the loop from the next bar', 'loop');
    } else {
      recorder.stop();
      paintRecButton();
      refreshLoops();
      flushLoopPush();
      log(`${recorder.length} events`, 'loop');
    }
  }

  el.loop.addEventListener('click', () => {
    if (!audio) return;
    setHostRecording(!recorderFor('host').isRecording);
  });

  /** Tap clears only your own loop; holding clears everyone's — the hold is
   * the confirmation, so a stray tap can't wipe the whole jam. */
  function clearOwnLoop() {
    if (!audio) return;
    const targets = snapshotOf(['host']);
    if (targets.some((target) => target.events?.length)) pushEdit('host', targets);
    recorderFor('host').clear();
    refreshLoops();
    flushLoopPush();
    log('your loop cleared', 'loop');
  }

  function clearAllLoops() {
    if (!audio) return;
    const targets = snapshotOf(audio.loops.keys());
    // Clearing an already-empty loop would push a dead entry the next undo
    // silently eats — only record a clear that actually removed notes.
    if (targets.some((target) => target.events?.length)) pushEdit('host', targets);
    for (const recorder of audio.loops.values()) recorder.clear();
    refreshLoops();
    flushLoopPush();
    log('all loops cleared', 'loop');
  }

  let clearHold = null;
  const disarmClear = () => {
    el.loopClear.classList.remove('is-arming');
    if (!clearHold) return;
    clearTimeout(clearHold);
    clearHold = null;
  };
  el.loopClear.addEventListener('pointerdown', () => {
    if (!audio || clearHold) return;
    el.loopClear.classList.add('is-arming');
    clearHold = setTimeout(() => {
      clearHold = null;
      disarmClear();
      clearAllLoops();
    }, 600);
  });
  el.loopClear.addEventListener('pointerup', () => {
    if (!clearHold) {
      el.loopClear.classList.remove('is-arming');
      return;
    }
    disarmClear();
    clearOwnLoop();
  });
  // Dragging off or a cancelled press aborts the hold — no clear at all.
  for (const type of ['pointerleave', 'pointercancel']) {
    el.loopClear.addEventListener(type, disarmClear);
  }

  el.loopUndo.addEventListener('click', () => {
    if (undoOwn('host')) log('change undone', 'loop');
  });
  el.loopRedo.addEventListener('click', () => {
    if (redoOwn('host')) log('change redone', 'loop');
  });
  bindHistoryPreview(el.loopUndo, () => ownPast.get('host')?.at(-1));
  bindHistoryPreview(el.loopRedo, () => ownFuture.get('host')?.at(-1));
  bindHistoryPreview(el.noteUndo, () => ownPast.get('host')?.at(-1));
  bindHistoryPreview(el.noteUndoAll, () => globalPast.at(-1));
  bindHistoryPreview(el.noteRedo, () => ownFuture.get('host')?.at(-1));

  function rollFocusMidi() {
    const instrument = normalizeInstrument(state.instrument);
    const octave = state.octaves[instrument] ?? defaultOctaves()[instrument];
    return instrumentHomeMidi(state.root, octave);
  }

  function revealRoll() {
    const focus = rollFocusMidi();
    const run = (attempt) => {
      const landed = scrollRollToMidi(el.noteTape, focus);
      markScrollEdges(el.noteTape, 'both');
      if (!landed && attempt < 3) requestAnimationFrame(() => run(attempt + 1));
    };
    requestAnimationFrame(() => run(0));
  }

  function pitchesFor(note) {
    // Sample hits have no pitch — the lane view positions them by `sample`.
    if (note.instrument === SAMPLER_INSTRUMENT) return [];
    const instrument = normalizeInstrument(note.instrument);
    return resolveGesture({
      x: note.x,
      y: note.y,
      mode: note.instrument === 'bass' ? 'single' : note.mode,
      instrument,
      root: state.root,
      scale: state.scale,
      octave: state.octaves[instrument] ?? defaultOctaves()[instrument],
      degree: note.degree,
      midi: note.midi,
    }).soundingMidis;
  }

  function choiceFor(midi, note, prefer) {
    const instrument = normalizeInstrument(note.instrument);
    return pitchChoice(midi, {
      root: state.root,
      scale: state.scale,
      octave: state.octaves[instrument],
      instrument,
      mode: note.mode,
      y: note.y,
      prefer,
    });
  }

  function writePlacedNotes(recorder, { step, instrument, x, y, degree, midi, sample }) {
    if (!recorder) return;
    recorder.addNote({
      step,
      x,
      y: Number.isFinite(Number(y)) ? Number(y) : 0.55,
      instrument,
      mode: 'single',
      degree,
      midi,
      sample,
    });
  }

  function previewRoll(down, midi, pointerId, peerId = 'host', instrument = state.instrument) {
    if (!audio?.synth || !Number.isFinite(Number(midi))) return;
    const id = `preview:${peerId}:${pointerId ?? 0}`;
    if (!down) {
      audio.synth.release(id);
      return;
    }
    audio.synth.attack({
      id,
      x: 0.5,
      y: 0.62,
      instrument: normalizeInstrument(instrument),
      mode: 'single',
      midi,
    });
  }

  /** Dragged strips can belong to any recorder — route each by voiceId. */
  function moveSharedGroup(editorId, changes) {
    if (!audio || !changes?.length) return;
    const jobs = [];
    const targets = new Set();
    for (const change of changes) {
      const ownerId = ownerOfVoice(change.voiceId);
      if (ownerId == null) continue;
      const recorder = audio.loops.get(ownerId);
      const note = recorder.notes().find((item) => item.voiceId === change.voiceId);
      if (!note) continue;
      targets.add(ownerId);
      jobs.push({ recorder, note, change });
    }
    if (!jobs.length) return;
    rememberEdit(editorId, [...targets]);
    for (const { recorder, note, change } of jobs) {
      // Sample strips only move along the beat — a lane drag never retunes.
      if (note.instrument === SAMPLER_INSTRUMENT) {
        recorder.moveNote(change.voiceId, { step: change.step });
        continue;
      }
      const sounding = pitchesFor(note)[0];
      const prefer = change.midi > sounding ? 'up' : change.midi < sounding ? 'down' : undefined;
      const choice = choiceFor(change.midi, note, prefer);
      recorder.moveNote(change.voiceId, {
        step: change.step,
        x: choice.x,
        degree: choice.degree,
        // An in-scale landing stays scale-relative like a recorded take —
        // octave/key changes still reach it, a chord strip stays a chord.
        // An exact midi is kept only for a pitch no scale degree expresses.
        midi: choice.distance === 0 ? null : change.midi,
      });
    }
    refreshLoops();
  }

  function syncHostHistory() {
    setControlEnabled(el.noteUndo, Boolean(ownPast.get('host')?.length));
    setControlEnabled(el.noteUndoAll, globalPast.length > 0);
    setControlEnabled(el.noteRedo, Boolean(ownFuture.get('host')?.length));
    setControlEnabled(el.loopUndo, Boolean(ownPast.get('host')?.length));
    setControlEnabled(el.loopRedo, Boolean(ownFuture.get('host')?.length));
  }

  function hostNoteStepPx() {
    const steps = Math.max(16, state.noteSteps || 32);
    const view = el.noteTape?.clientWidth || 0;
    const width = view > 40 ? view : Math.max(280, window.innerWidth - 16);
    const fit = Math.max(6, (width - 50) / steps);
    return fit + (Math.max(fit, 44) - fit) * noteZoom;
  }

  /** Pinch/wheel zoom: translate a wanted step width back into noteZoom. */
  function applyNoteStepPx(px) {
    const steps = Math.max(16, state.noteSteps || 32);
    const view = el.noteTape?.clientWidth || 0;
    const width = view > 40 ? view : Math.max(280, window.innerWidth - 16);
    const fit = Math.max(6, (width - 50) / steps);
    const span = Math.max(fit, 44) - fit;
    noteZoom = span > 0 ? Math.max(0, Math.min(1, (px - fit) / span)) : 0;
    paintHostRoll();
    return hostNoteStepPx();
  }

  /** Pending debounced repaint of the open sheet during a recording burst. */
  let rollPaintTimer = 0;

  function paintHostRoll() {
    if (rollPaintTimer) {
      clearTimeout(rollPaintTimer);
      rollPaintTimer = 0;
    }
    const view = rollInstrument();
    const lanes =
      view === SAMPLER_INSTRUMENT ? SAMPLE_BANK.map(({ id, label }) => ({ id, label })) : undefined;
    renderPianoRoll(el.noteTape, {
      notes: allLoopNotes(),
      steps: state.noteSteps,
      stepPx: hostNoteStepPx(),
      onZoom: applyNoteStepPx,
      pitchesFor,
      lanes,
      colorFor: (note) => INSTRUMENT_COLORS[storedInstrument(note.instrument)] || '#e0a12e',
      onDelete: (voiceId) => {
        const ownerId = ownerOfVoice(voiceId);
        if (ownerId == null) return;
        rememberEdit('host', [ownerId]);
        audio?.loops.get(ownerId)?.removeNote(voiceId);
        refreshLoops();
        log('note removed from the loop', 'loop');
      },
      instrument: view,
      owner: 'host',
      selectMode,
      onMoveGroup: (changes) => moveSharedGroup('host', changes),
      onResize: (voiceId, change) => {
        const ownerId = ownerOfVoice(voiceId);
        if (ownerId == null) return;
        const recorder = audio.loops.get(ownerId);
        const note = recorder?.notes().find((item) => item.voiceId === voiceId);
        if (!note) return;
        rememberEdit('host', [ownerId]);
        recorder.moveNote(voiceId, {
          step: note.step,
          x: note.x,
          degree: note.degree,
          duration: change.duration,
        });
        refreshLoops();
      },
      focusMidi: rollFocusMidi(),
      inScale: (midi) => midiInScale(midi, state.root, state.scale),
      onAudition: ({ down, midi, pointerId, lane }) => {
        if (lane) {
          if (down) fireSample('host', lane, { record: false });
          return;
        }
        previewRoll(down, midi, pointerId);
      },
      onPlace: ({ step, midi, lane }) => {
        if (lane) {
          rememberEdit('host', ['host']);
          writePlacedNotes(recorderFor('host'), { step, instrument: SAMPLER_INSTRUMENT, x: 0.5, y: 0.55, sample: lane });
          ensureTransport();
          refreshLoops();
          return;
        }
        const instrument = state.instrument;
        const draft = { x: 0.5, y: 0.55, mode: 'single', instrument };
        const choice = choiceFor(midi, draft);
        rememberEdit('host', ['host']);
        // Keep an exact midi only for a pitch the scale can't express — an
        // in-scale note stays degree-relative and follows octave changes.
        writePlacedNotes(recorderFor('host'), {
          step,
          instrument,
          x: choice.x,
          y: 0.55,
          degree: choice.degree,
          midi: choice.distance === 0 ? null : midi,
        });
        ensureTransport();
        refreshLoops();
      },
    });
    syncHostHistory();
    paintNotePlayhead(litStep);
  }

  function fitDrumRows(length) {
    for (const track of TRACKS) {
      const row = state.grid[track.id];
      while (row.length < length) row.push({ on: false, division: 1 });
      if (row.length > length) row.length = length;
    }
  }

  /** The loop and the drum machine share one length: 1, 2 or 4 bars. */
  function setSharedLength(length) {
    const next = normalizeLoopSteps(length);
    if (next === state.noteSteps && next === state.drumSteps) {
      paintDrumLength();
      return next;
    }
    state.noteSteps = next;
    state.drumSteps = audio?.drums.setLength(next) ?? next;
    fitDrumRows(next);
    if (state.drumPreset && DRUM_PRESETS[state.drumPreset]) {
      const preset = DRUM_PRESETS[state.drumPreset];
      applyPattern(preset.pattern, preset.span);
    } else {
      tileDrumRepeat();
      renderSequencer();
    }
    paintDrumEditRows();
    paintDrumLength();
    publishDrums();
    if (audio) {
      for (const recorder of audio.loops.values()) recorder.setLoopSteps(next);
      shareLoop();
    }
    setIconLabel(el.bars, barCountLabel(next));
    paintBar(audio?.engine.transportRunning ? litStep % Math.max(1, next) : parkedLoopStep());
    if (!el.notesSheet.hidden) paintHostRoll();
    publishHarmony();
    return next;
  }

  el.bars.addEventListener('click', () => setSharedLength(nextLoopSteps(state.noteSteps)));

  /** Bumps on every shareLoop: guests skip repaints on identical echoes. */
  let loopVersion = 0;

  /** Every player's loop, broadcast as one map so all editors see all notes. */
  function shareLoop() {
    if (!audio) return;
    const players = {};
    const ids = new Set([...audio.loops.keys(), ...ownPast.keys()]);
    for (const playerId of ids) {
      const recorder = audio.loops.get(playerId);
      players[playerId] = {
        notes: recorder?.notes() ?? [],
        noteSteps: recorder?.loopSteps ?? state.noteSteps,
        canUndo: Boolean(ownPast.get(playerId)?.length),
        canRedo: Boolean(ownFuture.get(playerId)?.length),
        recording: Boolean(recorder?.isRecording),
      };
    }
    socket.broadcastState({
      loopNotes: {
        v: ++loopVersion,
        noteSteps: state.noteSteps,
        players,
        canUndoAll: globalPast.length > 0,
      },
    });
    syncPadMarks();
  }

  /* A recording burst lands a note per grid step: collapse the broadcast to
     ~80 ms so guests get the latest map once instead of every note. */
  let loopPushTimer = 0;
  let loopPushDirty = false;
  function queueLoopPush() {
    loopPushDirty = true;
    if (loopPushTimer) return;
    loopPushTimer = setTimeout(() => {
      loopPushTimer = 0;
      if (!loopPushDirty) return;
      loopPushDirty = false;
      shareLoop();
    }, 80);
  }
  function flushLoopPush() {
    if (loopPushTimer) {
      clearTimeout(loopPushTimer);
      loopPushTimer = 0;
    }
    if (!loopPushDirty) return;
    loopPushDirty = false;
    shareLoop();
  }

  /** Recorded loop notes of the selected instrument show as dots on the pad. */
  function syncPadMarks() {
    if (state.padMode !== 'notes' || !audio) {
      renderer.setMarks([]);
      return;
    }
    const notes = [];
    for (const recorder of audio.loops.values()) notes.push(...recorder.notes());
    renderer.setMarks(padNoteMarks(notes, state.instrument));
  }

  /** Notes from every recorder, tagged with the owning player. */
  function allLoopNotes() {
    const rows = [];
    if (!audio) return rows;
    for (const [playerId, recorder] of audio.loops) {
      for (const note of recorder.notes()) rows.push({ ...note, owner: playerId });
    }
    return rows;
  }

  /* A capture lands on every grid step of a slide: while a take is open the
     open sheet repaints on a ~180 ms timer instead of per note. Stops, undo
     and manual edits call refreshLoops() eager and paint at once — the eager
     paint in paintHostRoll clears any pending lazy timer. */
  function queueHostRoll() {
    if (el.notesSheet.hidden || rollPaintTimer) return;
    rollPaintTimer = setTimeout(() => {
      rollPaintTimer = 0;
      if (!el.notesSheet.hidden) paintHostRoll();
    }, 180);
  }

  /** Any loop changed: repaint the open sheet and push the map to the guests. */
  function refreshLoops(lazy = false) {
    if (!el.notesSheet.hidden) {
      if (lazy) queueHostRoll();
      else paintHostRoll();
    }
    // Hits may have appeared/vanished under the open edit layer.
    if (state.samplerEdit) samplerUi.refreshErase();
    syncHostHistory();
    queueLoopPush();
  }

  function renderFxSliders() {
    const rows = [];
    const instrument = state.fxFor;
    const spec0 = INSTRUMENTS.find((item) => item.id === instrument);
    if (el.fxTitle) el.fxTitle.textContent = spec0 ? `${spec0.label} · sound` : 'Effect detail';
    const level = clampFx(state.levels[instrument] ?? 1);
    const volumeRow = document.createElement('label');
    volumeRow.className = 'fx-slider';
    volumeRow.style.setProperty('--chip', INSTRUMENT_COLORS[instrument] || '#e2b43a');
    const volumeName = document.createElement('span');
    volumeName.textContent = `Volume · ${Math.round(level * 100)}%`;
    const volume = document.createElement('input');
    volume.type = 'range';
    volume.min = '0';
    volume.max = '100';
    volume.step = '1';
    volume.value = String(Math.round(level * 100));
    volume.addEventListener('input', () => {
      const value = Number(volume.value) / 100;
      volumeName.textContent = `Volume · ${volume.value}%`;
      state.levels[instrument] = value;
      audio?.bus.setLevel(instrument, value);
      publishHarmony();
    });
    volumeRow.append(volumeName, volume);
    rows.push(volumeRow);
    const octaveValue = state.octaves[instrument] ?? defaultOctaves()[instrument];
    const octaveRow = document.createElement('label');
    octaveRow.className = 'fx-slider fx-slider--octave';
    octaveRow.style.setProperty('--chip', INSTRUMENT_COLORS[instrument] || '#e2b43a');
    const octaveName = document.createElement('span');
    octaveName.textContent = `Octave · ${octaveValue}`;
    const octave = document.createElement('input');
    octave.type = 'range';
    octave.min = '1';
    octave.max = '6';
    octave.step = '1';
    octave.value = String(octaveValue);
    octave.setAttribute('aria-label', 'Octave');
    octave.addEventListener('input', () => {
      const value = Number(octave.value);
      octaveName.textContent = `Octave · ${value}`;
      state.octaves[instrument] = value;
      audio?.synth.setInstrumentOctave(instrument, value);
      publishHarmony();
    });
    octaveRow.append(octaveName, octave);
    rows.push(octaveRow);
    const addGroup = (title, specs, levels, onInput) => {
      const heading = document.createElement('p');
      heading.className = 'fx-slider__group';
      heading.textContent = title;
      rows.push(heading);
      for (const spec of specs) {
        const amount = clampFx(levels?.[spec.id] ?? 0);
        const row = document.createElement('label');
        row.className = 'fx-slider';
        row.style.setProperty('--chip', FX_COLORS[spec.id] || '#e2b43a');
        const name = document.createElement('span');
        const specName = FX_FULL_LABELS[spec.id] ?? spec.label;
        name.textContent = `${specName} · ${Math.round(amount * 100)}%`;
        const input = document.createElement('input');
        input.type = 'range';
        input.min = '0';
        input.max = '100';
        input.step = '1';
        input.dataset.fx = spec.id;
        input.value = String(Math.round(amount * 100));
        input.addEventListener('input', () => {
          const value = Number(input.value) / 100;
          name.textContent = `${specName} · ${input.value}%`;
          onInput(spec.id, value);
        });
        row.append(name, input);
        rows.push(row);
      }
    };
    const specs = instrumentFxSpecs(instrument, lite);
    if (specs.length) {
      addGroup('This instrument', specs, state.effects[instrument], (id, value) => {
        state.effects[instrument][id] = value;
        audio?.bus.setEffect(instrument, id, value);
        publishHarmony();
      });
    }
    el.fxSliders.replaceChildren(...rows);
  }

  /** A card's MORE opens the slider sheet for that card's instrument —
      selecting it is optional, editing does not steal the pad. */
  function openFxSheet(instrument) {
    const named = namedInstrument(instrument);
    if (!named) return;
    state.fxFor = named;
    renderFxSliders();
    el.fxSheet.hidden = false;
  }
  el.fxSheetClose.addEventListener('click', () => {
    el.fxSheet.hidden = true;
  });
  let selectMode = false;
  document.getElementById('host-select-move')?.addEventListener('click', () => {
    selectMode = !selectMode;
    const button = document.getElementById('host-select-move');
    button.classList.toggle('is-on', selectMode);
    button.setAttribute('aria-pressed', selectMode ? 'true' : 'false');
    setRollSelectMode(el.noteTape, selectMode);
  });

  el.notes.addEventListener('click', () => {
    if (!audio) return;
    el.notesSheet.hidden = false;
    paintHostRoll();
    revealRoll();
  });
  el.notesClose.addEventListener('click', () => {
    el.notesSheet.hidden = true;
  });
  el.noteUndo.addEventListener('click', () => undoOwn('host'));
  el.noteUndoAll.addEventListener('click', () => undoAll('host'));
  el.noteRedo.addEventListener('click', () => redoOwn('host'));
  el.instPrev.addEventListener('click', () => cycleRollInstrument(-1));
  el.instNext.addEventListener('click', () => cycleRollInstrument(1));
  el.instPrev.replaceChildren(chipIcon('prev'));
  el.instNext.replaceChildren(chipIcon('next'));
  paintRollInstrument();
  el.noteClear.addEventListener('click', () => {
    if (!audio) return;
    // 'clear inst' touches only your own loop — in a jam the whole-party
    // wipe stays on the held clear-all.
    const recorder = recorderFor('host');
    const instrument = rollInstrument() === SAMPLER_INSTRUMENT ? SAMPLER_INSTRUMENT : normalizeInstrument(state.instrument);
    if (!recorder?.notes().some((note) => storedInstrument(note.instrument) === instrument)) return;
    rememberEdit('host', ['host']);
    recorder.clearInstrument(instrument);
    refreshLoops();
    flushLoopPush();
    log(`cleared ${instrument} from your loop`, 'loop');
  });

  /* ---------- Audio boot ---------- */

  function describeSamples(sampleState) {
    if (sampleState.usingSamples) return 'drums: TR-808 samples';
    if (sampleState.mode === 'mixed') {
      const synthTracks = Object.entries(sampleState.tracks)
        .filter(([, kind]) => kind === 'synth')
        .map(([id]) => id)
        .join(', ');
      return `drums: synthesis (${synthTracks})`;
    }
    return 'drums: synthesis — CDN unavailable';
  }

  function setSplashPhase(phase, message = '') {
    el.splash.hidden = false;
    el.splash.dataset.phase = phase;
    el.spinner.hidden = phase !== 'loading';
    const failed = phase === 'error' || phase === 'warn';
    el.splashError.hidden = !failed;
    el.splashStart.hidden = phase === 'loading' || phase === 'warn';
    el.splashContinue.hidden = phase !== 'warn';
    if (phase === 'idle') {
      el.splashTitle.textContent = 'Sound is off';
      el.splashDetail.textContent = 'Tap to warm up Tone.js and the drum samples. The pad stays quiet until the engine is ready.';
    }
    if (phase === 'loading') {
      el.splashTitle.textContent = 'Warming up';
      el.splashDetail.textContent = 'Tone.js, instruments, and drum samples. The pad turns on when startup finishes.';
    }
    if (phase === 'error') {
      el.splashTitle.textContent = 'Sound did not start';
      el.splashDetail.textContent = 'Try again. Touches stay blocked while this error is on screen.';
      el.splashError.textContent = message;
    }
    if (phase === 'warn') {
      el.splashTitle.textContent = 'Some samples did not load';
      el.splashDetail.textContent = 'The engine is ready. Missing drum files play as synthesis.';
      el.splashError.textContent = message;
    }
  }

  function unlockHost() {
    state.audioReady = true;
    state.audioError = null;
    hostPad.setLocked(false);
    el.pad.classList.remove('is-locked');
    setControlEnabled(el.loop, true);
    setControlEnabled(el.loopClear, true);
    setControlEnabled(el.notes, true);
    setControlEnabled(el.transport, true);
    setControlEnabled(el.drumTransport, true);
    el.audioStatus.textContent = 'audio: on';
    el.audioStatus.dataset.state = 'online';
  }

  function finishSplash() {
    el.splash.hidden = true;
    el.splash.dataset.phase = 'ready';
    publishHarmony();
  }

  function disposePartial({ engine, drums, synth, bus, drumsFx, sampler }) {
    try {
      sampler?.dispose();
      synth?.dispose();
      bus?.dispose();
      drumsFx?.dispose();
      drums?.dispose();
      engine?.dispose();
    } catch (error) {
      log(error.message, 'dispose');
    }
  }

  async function startAudio() {
    if (audio) return null;
    const engine = await new AudioEngine({ bpm: state.bpm, lite }).start();
    /** @type {{ drums?: DrumMachine, synth?: TouchSynth, bus?: ReturnType<typeof createInstrumentBus>, drumsFx?: ReturnType<typeof createDrumBus> }} */
    const partial = { engine };
    try {
      partial.bus = createInstrumentBus(engine.tone, lite);
      partial.drumsFx = createDrumBus(engine.tone, lite);
      partial.drums = new DrumMachine(engine);
      partial.synth = new TouchSynth(engine, partial.bus, {
        root: state.root,
        scale: state.scale,
        mode: state.mode,
        lite,
      });
      partial.sampler = new PadSampler(engine, { params: state.sampleParams });
      // The sampler sits outside the instrument bus so SOLO can mute
      // everything else without muting itself.
      partial.sampler.output.connect(engine.master);
      partial.sampler.onFire = (id) => samplerUi.flash(id);
      // Gate pads stay lit for their real sounding length — live hold,
      // audition and loop playback alike.
      partial.sampler.onVoice = (id, on) => {
        samplerUi.setPlaying(id, on);
        // A beat-locked pad replaces the drum machine while it sounds.
        if (SAMPLE_BANK.some((spec) => spec.id === id && spec.sync)) {
          const was = beatDucking.size > 0;
          if (on) beatDucking.add(id);
          else beatDucking.delete(id);
          if ((beatDucking.size > 0) !== was) applyMix();
        }
      };
      // Tempo-synced pads start stretched to the session bpm; the params the
      // grid badges show must carry that fit from the start.
      for (const id of partial.sampler.setBpm(state.bpm)) {
        const cur = partial.sampler.paramsOf(id);
        if (cur && state.sampleParams[id]) state.sampleParams[id].stretch = cur.stretch;
        samplerUi.updateParam(id);
      }
      partial.drums.output.connect(partial.drumsFx.input);
      partial.drumsFx.output.connect(engine.master);
      partial.bus.mix.connect(engine.master);
      partial.drums.onStep(highlightStep);
      partial.drums.setLength(state.drumSteps);

      for (const track of TRACKS) {
        for (let i = 0; i < state.drumSteps; i += 1) {
          const slot = state.grid[track.id][i];
          partial.drums.setStep(track.id, i, slot.on, slot.division);
        }
      }

      /** Lite still loads the full kit — only the drum FX chain is leaner. */
      const samples = partial.drums.loadSamples();
      const [sampleState] = await Promise.all([samples, partial.bus.ready, partial.drumsFx.ready, partial.sampler.ready]);
      for (const [id, octave] of Object.entries(state.octaves)) partial.synth.setInstrumentOctave(id, octave);
      partial.synth.warmUp();

      audio = {
        engine,
        drums: partial.drums,
        synth: partial.synth,
        bus: partial.bus,
        drumsFx: partial.drumsFx,
        sampler: partial.sampler,
        loops: new Map(),
      };
      applyStoredEffects();
      applyMix();
      applyMasterFx({ prime: true });
      partial.drums.start();
      paintBar(parkedLoopStep());

      el.drumSource.textContent = describeSamples(sampleState);
      el.drumSource.dataset.state = sampleState.usingSamples ? 'online' : 'error';
      log(
        sampleState.usingSamples ? 'TR-808 from the CDN' : 'synthesis, sample CDN unavailable',
        'drums',
      );
      log(`Tone.js ${globalThis.Tone.version}, context ${engine.contextState} @ ${Math.round(engine.sampleRate / 100) / 10} kHz`, 'audio');
      if (lite) log('lite mode — 24 kHz context, fewer voices, dry instruments, EQ drums, no 8-bit/wah', 'audio');
      return sampleState;
    } catch (error) {
      disposePartial(partial);
      audio = null;
      throw error;
    }
  }

  async function beginAudio() {
    if (state.audioReady || state.booting) return;
    state.booting = true;
    setSplashPhase('loading');
    setControlEnabled(el.splashStart, false);
    try {
      const sampleState = await startAudio();
      state.audioError = null;
      if (sampleState?.fallback) {
        setSplashPhase('warn', describeSamples(sampleState));
        setControlEnabled(el.splashStart, true);
        return;
      }
      unlockHost();
      finishSplash();
    } catch (error) {
      state.audioError = error?.message || String(error?.stack || error) || 'Could not start audio';
      publishHarmony();
      setSplashPhase('error', state.audioError);
      setControlEnabled(el.splashStart, true);
      el.audioStatus.dataset.state = 'error';
      el.audioStatus.textContent = 'audio: error';
      log(state.audioError, 'error');
    } finally {
      state.booting = false;
    }
  }

  el.splashStart.addEventListener('click', () => {
    beginAudio();
  });
  el.hostScreen.addEventListener('pointerdown', (event) => {
    if (event.target.closest('[data-action="back"]')) return;
    if (!state.audioReady && !state.booting) beginAudio();
  });
  el.splashContinue.addEventListener('click', () => {
    if (!audio) return;
    unlockHost();
    finishSplash();
  });

  function exportSnapshot() {
    const steps = state.noteSteps;
    const notes = [];
    const players = [];
    if (audio) {
      for (const recorder of audio.loops.values()) {
        notes.push(...recorder.notes());
        players.push({ playerId: recorder.playerId, events: recorder.exportEvents() });
      }
    }
    const drums = {};
    for (const track of TRACKS) {
      drums[track.id] = (state.grid[track.id] || []).slice(0, steps).map((slot) => ({
        on: Boolean(slot?.on),
        division: slot?.division === 3 ? 3 : 1,
      }));
    }
    return {
      bpm: state.bpm,
      steps,
      notes,
      drums,
      players,
      root: state.root,
      scale: state.scale,
      effects: state.effects,
      levels: state.levels,
      octaves: state.octaves,
      mute: state.mute,
      solo: state.solo,
      masterFx: { ...state.masterFx },
      drumPitch: state.drumPitch,
      sampleParams: state.sampleParams,
    };
  }

  function showExportError(message) {
    if (!el.exportError) return;
    el.exportError.hidden = !message;
    el.exportError.textContent = message || '';
  }

  el.exportOpen?.addEventListener('click', () => {
    showExportError('');
    el.exportSheet.hidden = false;
  });
  el.exportClose?.addEventListener('click', () => {
    el.exportSheet.hidden = true;
  });
  el.exportMidi?.addEventListener('click', () => {
    const repeats = readRepeats(el.exportRepeats.value);
    if (!repeats) {
      showExportError('Use a whole number of repeats from 1 to 128.');
      return;
    }
    showExportError('');
    const bytes = buildLoopMidi({ ...exportSnapshot(), repeats });
    saveBlob(bytes, 'jam-loop.mid', 'audio/midi');
  });
  el.exportWav?.addEventListener('click', async () => {
    const repeats = readRepeats(el.exportRepeats.value);
    if (!repeats) {
      showExportError('Use a whole number of repeats from 1 to 128.');
      return;
    }
    if (!globalThis.Tone) {
      showExportError('Tone.js is not loaded yet.');
      return;
    }
    showExportError('');
    setControlEnabled(el.exportWav, false);
    const previous = el.exportWav.textContent;
    el.exportWav.textContent = 'Rendering…';
    try {
      const wav = await renderLoopWav(globalThis.Tone, {
        ...exportSnapshot(),
        repeats,
        includeSamples: el.exportSamples ? !el.exportSamples.checked : false,
      });
      saveBlob(wav, 'jam-loop.wav', 'audio/wav');
    } catch (error) {
      showExportError(error?.message || 'Could not render the WAV.');
    } finally {
      setControlEnabled(el.exportWav, true);
      el.exportWav.textContent = previous;
    }
  });

  /** Play/Stop is shared: the topbar button, the drum machine button, and guest toggles all land here. */
  function toggleTransport() {
    if (!audio) return;
    if (audio.engine.transportRunning) {
      audio.engine.stopTransport();
      audio.synth.releaseMatching('loop:');
      // The clock reset to tick 0: re-anchor every loop strip into the first
      // cycle, or a note armed at bar N stays silent for N bars after resume.
      for (const recorder of audio.loops.values()) recorder.rearm();
      highlightStep(-1);
      if (state.peers.size) {
        const parked = transportAbsoluteStep();
        if (parked >= 0) socket.pulse(parked, { reliable: true, running: false });
      }
      paintTransport(false);
    } else {
      audio.engine.startTransport();
      paintTransport(true);
    }
    publishHarmony();
  }

  el.transport.addEventListener('click', toggleTransport);
  el.drumTransport.addEventListener('click', toggleTransport);

  /* ---------- One sound path for the host pad and for guests ---------- */

  function paintTouch(id, point) {
    if (point) state.activeTouches.add(id);
    else state.activeTouches.delete(id);
    renderer.update(id, point);
    el.pad.classList.toggle('is-active', state.activeTouches.size > 0);
  }

  function soundTouch(data) {
    if (!audio || !state.audioReady) return;
    const instrument = data.instrument ? normalizeInstrument(data.instrument) : String(data.id).startsWith('host:') ? state.instrument : 'pad';
    const payload = {
      ...data,
      instrument,
      mode: data.mode ?? state.mode,
      direction: data.direction === 'up' ? 'up' : 'down',
    };
    let gesture = null;
    if (payload.type === 'down') gesture = audio.synth.attack(payload);
    else if (payload.type === 'move') gesture = audio.synth.move(payload);
    else audio.synth.release(payload.id);
    paintTouch(payload.id, payload.type === 'up' ? null : { x: payload.x, y: payload.y });
    paintZone(payload.type !== 'up' && payload.mode === 'chords' ? payload.y : null);
    if (payload.type === 'up') padFingers.delete(payload.id);
    else padFingers.set(payload.id, { instrument, x: payload.x, y: payload.y });
    if (sameInstrument(instrument)) {
      if (gesture?.label) setLabel(gesture.label);
      else if (payload.type === 'up' && !selectedFingerHeld()) setLabel('—');
    }
    const playerId = playerIdFromTouch(payload.id);
    const wrote = recorderFor(playerId)?.capture(payload);
    if (wrote === 'chord' || wrote === 'note') refreshLoops(true);
  }

  const hostPad = new TouchPad(el.pad, {
    locked: true,
    // Lite moves at ~21 Hz: fewer retriggers, captures and repaints per slide.
    throttleMs: lite?.coarseTouch ? 48 : undefined,
    onStart: (point) => {
      if (state.padMode === 'sampler') return;
      if (state.padMode === 'fx') {
        fxPadDown(point);
        return;
      }
      soundTouch({ ...point, id: `host:${point.id}`, name: 'host', instrument: state.instrument, mode: state.mode });
    },
    onMove: (point) => {
      if (state.padMode === 'sampler') return;
      if (state.padMode === 'fx') {
        fxPadMove(point);
        return;
      }
      // A finger keeps the instrument it came down on — an instrument switch
      // mid-hold must not re-voice it or write chord notes under the new pick.
      const held = padFingers.get(`host:${point.id}`);
      soundTouch({ ...point, id: `host:${point.id}`, name: 'host', instrument: held?.instrument ?? state.instrument, mode: state.mode });
    },
    onEnd: (point) => {
      if (state.padMode === 'sampler') return;
      if (state.padMode === 'fx') {
        fxPadUp(point);
        return;
      }
      const held = padFingers.get(`host:${point.id}`);
      soundTouch({ ...point, id: `host:${point.id}`, name: 'host', instrument: held?.instrument ?? state.instrument, mode: state.mode });
    },
  });

  function handleTouch(data) {
    const id = `${data.peerId}:${data.id}`;
    soundTouch({ ...data, id });
    if (data.type !== 'move') {
      log(`${data.name ?? 'guest'} · ${data.type} · x=${data.x.toFixed(2)} y=${data.y.toFixed(2)}`, 'touch');
    }
  }

  function namedInstrument(value) {
    if (value === 'piano') return 'synth';
    return INSTRUMENT_IDS.includes(value) ? value : null;
  }

  function applyGuestEffect(data) {
    const effect = data?.effect;
    const instrument = namedInstrument(effect?.instrument);
    if (!effect || !instrument) return;
    const known = INSTRUMENT_FX[instrument]?.some((item) => item.id === effect.id);
    if (!known || !Number.isFinite(Number(effect.level))) return;
    const level = clampFx(effect.level);
    state.effects[instrument][effect.id] = level;
    audio?.bus.setEffect(instrument, effect.id, level);
    if (state.fxFor === instrument && !el.fxSheet.hidden) renderFxSliders();
    queueHarmony();
    log(`${data.name ?? 'guest'} · ${instrument} ${effect.id} ${fxAmountLabel(level)}`, 'effect');
  }

  function applyGuestOctave(data) {
    const octave = data?.octave;
    const instrument = namedInstrument(octave?.instrument);
    if (!octave || !instrument || !Number.isFinite(Number(octave.value))) return;
    const value = Math.min(6, Math.max(1, Math.round(Number(octave.value))));
    state.octaves[instrument] = value;
    audio?.synth.setInstrumentOctave(instrument, value);
    if (state.fxFor === instrument && !el.fxSheet.hidden) renderFxSliders();
    queueHarmony();
  }

  function applyGuestLevel(data) {
    const level = data?.level;
    const instrument = namedInstrument(level?.instrument);
    if (!level || !instrument || !Number.isFinite(Number(level.value))) return;
    const value = clampFx(level.value);
    state.levels[instrument] = value;
    audio?.bus.setLevel(instrument, value);
    if (state.fxFor === instrument && !el.fxSheet.hidden) renderFxSliders();
    queueHarmony();
  }

  function applyGuestMaster(data) {
    const patch = data?.masterFx;
    if (!patch || typeof patch !== 'object') return;
    // The bipolar filter is owned by whoever last steered it — a guest who
    // vanishes mid-gesture then gets their leftover clamp reset on peer:leave.
    if (patch.cutoff !== undefined || patch.hipass !== undefined) {
      const peerId = data.peerId || 'guest';
      if (Number(patch.cutoff) > 0 || Number(patch.hipass) > 0) filterHolder = peerId;
      else if (filterHolder === peerId) filterHolder = null;
    }
    let changed = false;
    for (const key of ['cutoff', 'hipass', 'grit', 'wah', 'volume']) {
      if (!Number.isFinite(Number(patch[key])) || masterDrag?.dataset?.master === key) continue;
      const value = clampFx(patch[key]);
      if (state.masterFx[key] !== value) {
        state.masterFx[key] = value;
        changed = true;
      }
    }
    if (!changed) return;
    applyMasterFx();
    syncMasterSliderInputs();
    queueHarmony();
  }

  function applyGuestHold(data) {
    const hold = data?.masterHold;
    if (!hold || typeof hold !== 'object') return;
    const peerId = data.peerId || 'guest';
    if (hold.hold) {
      const division = MASTER_DIVISIONS.has(hold.division) ? hold.division : '16n';
      masterHolder = peerId;
      state.masterFx.division = division;
      state.masterFx.hold = true;
      audio?.engine.masterFx?.setDivision(division);
      audio?.engine.masterFx?.setHold(true);
    } else if (masterHolder === peerId) {
      masterHolder = null;
      state.masterFx.hold = false;
      audio?.engine.masterFx?.setHold(false);
    } else {
      publishHarmony();
      return;
    }
    publishHarmony();
  }

  /** Guests write drum cells like the host brush: value + repeat expansion. */
  function applyGuestDrumSet(data) {
    const list = Array.isArray(data.drumSet) ? data.drumSet : [data.drumSet];
    let changed = false;
    for (const entry of list) {
      const track = String(entry?.track ?? '');
      if (!TRACKS.some((item) => item.id === track)) continue;
      const step = Math.floor(Number(entry?.step));
      if (!(step >= 0 && step < state.drumSteps)) continue;
      const value = { on: Boolean(entry?.on), division: Number(entry?.division) === 3 ? 3 : 1 };
      for (const s of repeatTargets(state.drumRepeat, state.drumSteps, step)) {
        changed = setDrumCell(track, s, value) || changed;
      }
    }
    if (!changed) return;
    markDrumEdited();
    queueDrumPush();
  }

  function handleControl(data) {
    if (data.masterHold) applyGuestHold(data);
    if (data.masterFx) applyGuestMaster(data);
    if (data.drumSet) applyGuestDrumSet(data);
    if (typeof data.drumPreset === 'string' && DRUM_PRESETS[data.drumPreset]) {
      pickDrumPreset(data.drumPreset);
      log(`${data.name ?? 'guest'} · drums ${DRUM_PRESETS[data.drumPreset].label}`, 'drums');
    }
    if (data.drumRepeat !== undefined) setDrumRepeat(data.drumRepeat);
    if (Number.isFinite(Number(data.drumLength))) setSharedLength(Number(data.drumLength));
    if (Number.isFinite(Number(data.drumPitch))) setDrumPitch(Number(data.drumPitch));
    if (Number.isFinite(Number(data.bpm))) setSharedBpm(Number(data.bpm));
    // Sampler pads — hits record into the peer's loop, previews never do.
    if (data.sampleHit) fireSample(data.peerId, String(data.sampleHit));
    if (data.samplePreview) fireSample(data.peerId, String(data.samplePreview), { record: false });
    if (data.sampleRelease) {
      const releaseId = String(data.sampleRelease);
      audio?.sampler.releasePad(releaseId);
      if (recorderFor(data.peerId)?.captureRelease(releaseId)) refreshLoops(true);
    }
    if (data.sampleSolo !== undefined) setSampleSolo(data.peerId, Boolean(data.sampleSolo));
    if (data.sampleClear) eraseSampleHits(data.peerId, String(data.sampleClear));
    if (data.sampleTune) {
      const tune = data.sampleTune;
      applySampleTune(
        data.peerId,
        String(tune.sample),
        { pitch: tune.pitch, stretch: tune.stretch, volume: tune.volume },
        'move',
      );
    }
    if (data.sampleTuneDone) {
      const tune = data.sampleTuneDone;
      // 'quiet' commits (e.g. a guest reset) skip the audition.
      applySampleTune(
        data.peerId,
        String(tune.sample),
        { pitch: tune.pitch, stretch: tune.stretch, volume: tune.volume },
        tune.quiet ? 'set' : 'end',
      );
    }
    if (data.preview) {
      previewRoll(Boolean(data.preview.down), data.preview.midi, data.preview.pointerId, data.peerId || 'guest', data.preview.instrument);
      return;
    }
    applyGuestEffect(data);
    applyGuestLevel(data);
    applyGuestOctave(data);
    if (data.eraseNote && audio) {
      const voiceId = String(data.eraseNote);
      const ownerId = ownerOfVoice(voiceId);
      if (ownerId != null) {
        rememberEdit(data.peerId, [ownerId]);
        audio.loops.get(ownerId).removeNote(voiceId);
        refreshLoops();
      }
    }
    if (Array.isArray(data.moveGroup) && data.moveGroup.length && audio) {
      moveSharedGroup(data.peerId, data.moveGroup);
    }
    if (data.moveNote && audio) {
      const move = data.moveNote;
      const voiceId = String(move?.voiceId ?? '');
      const ownerId = ownerOfVoice(voiceId);
      if (ownerId != null) {
        rememberEdit(data.peerId, [ownerId]);
        audio.loops.get(ownerId).moveNote(voiceId, {
          step: move.step,
          x: move.x,
          degree: move.degree,
          midi: move.midi,
          duration: move.duration,
        });
        refreshLoops();
      }
    }
    if (data.addNote && audio) {
      const add = data.addNote;
      const instrument = add?.instrument === SAMPLER_INSTRUMENT ? SAMPLER_INSTRUMENT : namedInstrument(add?.instrument);
      if (instrument && Number.isFinite(Number(add.step)) && Number.isFinite(Number(add.x))) {
        rememberEdit(data.peerId, [data.peerId]);
        writePlacedNotes(recorderFor(data.peerId), {
          step: add.step,
          instrument,
          x: add.x,
          y: Number.isFinite(Number(add.y)) ? Number(add.y) : 0.55,
          degree: add.degree,
          midi: add.midi,
          sample: add.sample,
        });
        ensureTransport();
        refreshLoops();
      }
    }
    if (data.history === 'undo' && audio) undoOwn(data.peerId);
    if (data.history === 'undo-all' && audio) undoAll(data.peerId);
    if (data.history === 'redo' && audio) redoOwn(data.peerId);
    if (data.transport === 'toggle' && audio) toggleTransport();
    if (data.erase === 'show' && audio) refreshLoops();
    const instrument = namedInstrument(data.instrument);
    if (instrument) {
      state.lastRemote = { peerId: data.peerId, name: data.name, instrument };
      log(`${data.name ?? 'guest'} → ${instrument}`, 'tone');
    }
    if (!data.loop || !audio) return;
    const recorder = recorderFor(data.peerId);
    if (!recorder) return;
    if (data.loop === 'record') {
      ensureTransport();
      recorder.start();
      log(`${data.name ?? 'guest'} is recording a loop`, 'loop');
    }
    if (data.loop === 'stop') {
      recorder.stop();
      refreshLoops();
      flushLoopPush();
      log(`${data.name ?? 'guest'} loop paused, ${recorder.length} events`, 'loop');
    }
    if (data.loop === 'clear') {
      if (data.fromEditor || data.scope === 'mine') {
        // Editor 'clear inst' and the panel tap both stay in your own loop;
        // clearing everyone's takes the held clear-all.
        const instrument = data.fromEditor
          ? data.instrument === SAMPLER_INSTRUMENT
            ? SAMPLER_INSTRUMENT
            : namedInstrument(data.instrument)
          : null;
        const target = recorderFor(data.peerId);
        const has = instrument
          ? target?.notes().some((note) => storedInstrument(note.instrument) === instrument)
          : target?.length;
        if (has) {
          rememberEdit(data.peerId, [data.peerId]);
          if (instrument) target.clearInstrument(instrument);
          else target.clear();
        }
      } else {
        const targets = snapshotOf(audio.loops.keys());
        if (targets.some((target) => target.events?.length)) pushEdit(data.peerId, targets);
        for (const target of audio.loops.values()) target.clear();
      }
      refreshLoops();
      flushLoopPush();
      log(`${data.name ?? 'guest'} cleared ${data.scope === 'mine' ? 'their loop' : data.fromEditor ? `${data.instrument || 'notes'} in their loop` : 'all loops'}`, 'loop');
    }
    state.lastRemote = {
      peerId: data.peerId,
      name: data.name,
      instrument: instrument ?? state.lastRemote?.instrument ?? null,
      loop: data.loop,
      length: recorder.length,
      recording: recorder.isRecording,
    };
  }

  function clearPeer(peerId) {
    const prefix = `${peerId}:`;
    for (const id of [...state.activeTouches]) {
      if (id.startsWith(prefix)) paintTouch(id, null);
    }
    audio?.synth.releaseMatching(prefix);
    // A leaving peer can't hold SOLO or keep a live pad voice ringing.
    setSampleSolo(peerId, false);
    audio?.sampler.releaseMatching(`smp:${peerId}:`);
    // A finger still down when the peer vanished leaves an open take — close
    // it with a synthetic note-off at the last known position.
    const recorder = audio?.loops.get(peerId);
    for (const [id, finger] of [...padFingers]) {
      if (!id.startsWith(prefix)) continue;
      padFingers.delete(id);
      recorder?.capture({
        id,
        type: 'up',
        direction: 'up',
        instrument: finger.instrument,
        mode: 'single',
        x: finger.x,
        y: finger.y,
      });
    }
  }

  /* ---------- Socket ---------- */

  let session = null;
  let joinUrl = '';
  let reopening = false;

  socket.on('connect', () => {
    el.socketStatus.textContent = 'socket: online';
    el.socketStatus.dataset.state = 'online';
    // A reconnect is a brand-new server socket — the old session is gone,
    // so open a fresh room instead of showing a dead join code.
    if (session && !reopening) reopenSession();
  });
  socket.on('disconnect', () => {
    el.socketStatus.textContent = 'socket: offline';
    el.socketStatus.dataset.state = 'error';
  });
  socket.on('connect_error', () => {
    // Still dialing — a cold backend can take a while to wake.
    el.socketStatus.textContent = 'socket: connecting…';
    el.socketStatus.dataset.state = 'pending';
  });

  /* The header stamp is 168px for crispness at thumbnail size; the invite
     sheet re-renders the same link at 512px so a camera can scan it across
     the room. */
  async function paintJoinQr(url) {
    try {
      await loadScript(QR_SRC, 15000);
      const QRCode = globalThis.QRCode;
      if (!QRCode) throw new Error('QR library failed to load');
      for (const [box, size] of [[el.qr, 168], [el.shareQr, 512]]) {
        if (!box) continue;
        box.replaceChildren();
        new QRCode(box, {
          text: url,
          width: size,
          height: size,
          colorDark: '#06231d',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M,
        });
        /* qrcode.js swaps its canvas for a data-URI <img> only after an async
           probe that can stall — then the raw 512px canvas stays visible and
           the card crops the finder patterns off. Do the swap synchronously. */
        const canvas = box.querySelector('canvas');
        if (canvas) {
          const img = document.createElement('img');
          img.src = canvas.toDataURL('image/png');
          img.alt = 'Scan me!';
          box.replaceChildren(img);
        }
      }
    } catch (error) {
      el.qr.textContent = 'QR unavailable';
      log(error.message, 'qr');
    }
  }

  /* Session code and join link are duplicated on the invite sheet — not
     every camera reads QR, so the text stays visible next to it. */
  function paintInvite() {
    el.code.textContent = session.code;
    el.codeBig.textContent = session.code;
    el.joinUrl.textContent = joinUrl;
    el.joinUrl.title = joinUrl;
    el.joinUrlBig.textContent = joinUrl;
  }

  /** After a reconnect the server has already dropped the room: open a new one. */
  async function reopenSession() {
    reopening = true;
    try {
      session = await socket.createSession();
    } catch (error) {
      log(error.message, 'net');
      reopening = false;
      return;
    }
    joinUrl = await guestJoinUrl(session.code);
    paintInvite();
    for (const peerId of [...state.peers.keys()]) clearPeer(peerId);
    state.peers.clear();
    setPeers();
    if (masterHolder) {
      masterHolder = null;
      state.masterFx.hold = false;
      audio?.engine.masterFx?.setHold(false);
    }
    // Every peer is gone with the old room — a leftover guest filter opens.
    if (filterHolder && filterHolder !== 'host') {
      filterHolder = null;
      state.masterFx.cutoff = 0;
      state.masterFx.hipass = 0;
      audio?.engine.masterFx?.setCutoff(0);
      audio?.engine.masterFx?.setHipass(0);
    }
    if (audio) {
      for (const [playerId, recorder] of audio.loops) {
        if (playerId === 'host') continue;
        recorder.clear();
        audio.loops.delete(playerId);
      }
    }
    publishHarmony();
    paintJoinQr(joinUrl);
    log(`reconnected — new session ${session.code}`, 'net');
    reopening = false;
  }
  socket.on(EVENTS.touch, handleTouch);
  socket.on(EVENTS.control, handleControl);
  socket.on(EVENTS.peerJoin, ({ peerId, name }) => {
    state.peers.set(peerId, name);
    setPeers();
    // Full snapshot: a late joiner gets drums and loopNotes too, not just the harmony patch.
    socket.broadcastSnapshot();
    const parked = transportAbsoluteStep();
    if (parked >= 0) socket.pulse(parked, { reliable: true, running: Boolean(audio?.engine.transportRunning) });
    log(`${name} joined`, 'guest');
  });
  socket.on(EVENTS.peerLeave, ({ peerId, name }) => {
    state.peers.delete(peerId);
    setPeers();
    clearPeer(peerId);
    audio?.synth.releaseMatching(`preview:${peerId}`);
    // A guest who leaves mid-recording never sends the note-off: close their
    // open takes so the loop does not replay an endless note.
    audio?.loops.get(peerId)?.stop();
    if (masterHolder === peerId) {
      masterHolder = null;
      state.masterFx.hold = false;
      audio?.engine.masterFx?.setHold(false);
      publishHarmony();
    }
    // A socket that dies mid-gesture never sends the filter release — open
    // the master filter if the gone peer was the one steering it.
    if (filterHolder === peerId) {
      filterHolder = null;
      state.masterFx.cutoff = 0;
      state.masterFx.hipass = 0;
      audio?.engine.masterFx?.setCutoff(0);
      audio?.engine.masterFx?.setHipass(0);
      publishHarmony();
    }
    log(`${name ?? peerId} left`, 'guest');
  });

  function paintTransport(running) {
    for (const button of [el.transport, el.drumTransport]) {
      if (!button) continue;
      paintIconButton(button, running ? 'stop' : 'play', running ? 'Stop' : 'Play');
      button.classList.toggle('is-on', Boolean(running));
    }
  }

  function paintHostActions() {
    paintIconButton(el.loop, 'loop', 'Rec');
    el.loopUndo.replaceChildren(chipIcon('undo'));
    el.loopRedo.replaceChildren(chipIcon('redo'));
    el.loopClear.replaceChildren(chipIcon('erase'));
    el.loopClear.setAttribute('aria-label', 'Clear all loops');
    paintIconButton(el.notes, 'notes', 'Edit notes');
    paintIconButton(el.bars, 'bars', barCountLabel(state.noteSteps));
    paintIconButton(el.drumsOpen, 'edit', 'Edit drums');
    paintIconButton(el.noteUndo, 'undo', 'Undo');
    paintIconButton(el.noteUndoAll, 'undo', 'Undo all');
    paintIconButton(el.noteRedo, 'redo', 'Redo');
    paintIconButton(el.noteClear, 'erase', 'clear inst');
    el.modeRow?.querySelectorAll('[data-mode]').forEach((chip) => {
      paintIconButton(chip, chip.dataset.mode === 'chords' ? 'chords' : 'notes', chip.dataset.mode === 'chords' ? 'Chords' : 'Notes');
    });
    const padNotesChip = el.padMode?.querySelector('[data-padmode="notes"]');
    const padFxChip = el.padMode?.querySelector('[data-padmode="fx"]');
    const padSamplerChip = el.padMode?.querySelector('[data-padmode="sampler"]');
    if (padNotesChip) paintIconButton(padNotesChip, 'notes', 'Keys');
    if (padFxChip) paintIconButton(padFxChip, 'scissors', 'FX');
    if (padSamplerChip) paintIconButton(padSamplerChip, 'sampler', 'SMP');
    if (el.sampleEdit) paintIconButton(el.sampleEdit, 'edit', 'Tune');
    paintIconButton(el.notesClose, 'done', 'Done');
    paintIconButton(el.fxSheetClose, 'done', 'Done');
    document.querySelectorAll('#host-screen [data-inst-cycle]').forEach((arrow) => {
      arrow.replaceChildren(chipIcon(Number(arrow.dataset.instCycle) < 0 ? 'prev' : 'next'));
    });
    paintTransport(Boolean(audio?.engine.transportRunning));
  }

  renderSequencer();
  paintHostActions();
  paintDrumEditRows();
  paintDrumLength();
  if (el.drumPitchLabel) el.drumPitchLabel.textContent = drumPitchLabel();
  renderRootChips();
  renderDrumPresets();
  publishDrums();
  renderDrumFx();
  el.litePill.hidden = !lite;
  el.hostScreen.classList.toggle('is-lite', Boolean(lite));
  paintInstruments(el.instruments, state.instrument);
  paintInstrumentMini();
  paintSecValues();
  // Touch phones start the instruments section on the carousel — the card
  // grid costs too much pad space.
  if (matchMedia('(pointer: coarse), (max-width: 700px)').matches) {
    el.secInstruments?.classList.remove('is-open');
    el.secInstruments?.querySelector('.tool-sec__head')?.setAttribute('aria-expanded', 'false');
  }
  paintMixFlags();
  syncModeChrome();
  setPeers();
  requestAnimationFrame(() => renderer.resize());

  /**
   * A session that never opened leaves listeners, the pad, the drum grid and
   * a half-open socket behind — tear them down so a retry starts clean and
   * the orphan socket does not linger on the server.
   */
  function abortBoot() {
    clearTimeout(drumPushTimer);
    clearTimeout(loopPushTimer);
    clearTimeout(harmonyPushTimer);
    clearTimeout(rollPaintTimer);
    clearTimeout(clearHold);
    drumGrid.destroy();
    hostPad.destroy();
    samplerUi.destroy();
    renderer.destroy();
    socket.disconnect();
  }

  el.socketStatus.textContent = 'socket: connecting…';
  el.socketStatus.dataset.state = 'pending';
  try {
    session = await socket.createSession();
  } catch (error) {
    abortBoot();
    throw error;
  }
  joinUrl = await guestJoinUrl(session.code);
  paintInvite();
  publishHarmony();
  await paintJoinQr(joinUrl);

  log(`session ${session.code} is open`, 'net');
  markScrollEdges(document.querySelector('.host-tools'), 'y');
  markPageEdges();

  let parked = null;
  let parkGen = 0;
  let parkTimer = 0;

  function forgetFingers() {
    hostPad.releaseHeld();
    fxFingers.clear();
    samplerUi.releaseAll();
    audio?.sampler.stopAll();
    for (const id of [...state.activeTouches]) paintTouch(id, null);
    setLabel('—');
  }

  function beginPark() {
    if (!audio?.engine.started || parked) return;
    const gen = ++parkGen;
    parked = {
      gen,
      transport: audio.engine.transportRunning,
      drums: audio.drums.running,
      gain: audio.engine.duckMaster(0.18),
      effects: JSON.parse(JSON.stringify(state.effects)),
      levels: { ...state.levels },
    };
    forgetFingers();
    audio.synth.silence();
    audio.drums.silence();
    clearTimeout(parkTimer);
    parkTimer = setTimeout(() => {
      if (!audio || gen !== parkGen || !parked || document.visibilityState !== 'hidden') return;
      try {
        if (parked.transport) audio.engine.stopTransport();
        if (parked.drums) audio.drums.stop();
      } catch {
        // The context had already paused.
      }
      audio.synth.silence();
      audio.drums.silence();
      highlightStep(-1);
    }, 180);
  }

  async function beginWake() {
    if (!parked || !audio?.engine.started) return;
    const snapshot = parked;
    parked = null;
    parkGen += 1;
    clearTimeout(parkTimer);
    await audio.engine.resumeContext();
    if (document.visibilityState === 'hidden') {
      beginPark();
      return;
    }
    state.effects = snapshot.effects;
    state.levels = { ...state.levels, ...snapshot.levels };
    applyStoredEffects();
    renderDrumFx();
    audio.synth.silence();
    audio.engine.rewindTransport();
    for (const recorder of audio.loops.values()) recorder.rearm();
    if (snapshot.drums) audio.drums.start();
    audio.engine.restoreMaster(snapshot.gain, 0.18);
    if (snapshot.transport) {
      audio.engine.startTransport();
      paintTransport(true);
    } else {
      paintTransport(false);
    }
  }

  function onVisibility() {
    if (document.visibilityState === 'hidden') beginPark();
    else beginWake();
  }

  document.addEventListener('visibilitychange', onVisibility);

  const view = {
    get code() {
      return session.code;
    },
    get joinUrl() {
      return joinUrl;
    },
    get audio() {
      return audio;
    },
    get harmony() {
      return { root: state.root, scale: state.scale, audioReady: state.audioReady, audioError: state.audioError };
    },
    get effects() {
      return state.effects;
    },
    get masterFx() {
      return { ...state.masterFx };
    },
    get drumSteps() {
      return state.drumSteps;
    },
    get noteSteps() {
      return audio?.loops.get('host')?.loopSteps ?? state.noteSteps;
    },
    drumHits(track = 'kick') {
      return (state.grid[track] || []).filter((slot) => slot.on).length;
    },
    get lastRemote() {
      return state.lastRemote;
    },
    get label() {
      return el.label.textContent;
    },
    loopFor(playerId) {
      return audio?.loops.get(playerId) ?? null;
    },
    get history() {
      return {
        own: Object.fromEntries([...ownPast].map(([id, stack]) => [id, stack.length])),
        global: globalPast.length,
        future: Object.fromEntries([...ownFuture].map(([id, stack]) => [id, stack.length])),
      };
    },
    destroy() {
      landscapeMq.removeEventListener('change', placeLandscapeChrome);
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(parkTimer);
      clearTimeout(drumPushTimer);
      clearTimeout(loopPushTimer);
      clearTimeout(harmonyPushTimer);
      clearTimeout(rollPaintTimer);
      // A clear-hold pending past destroy would fire clearAllLoops on a null audio.
      clearTimeout(clearHold);
      drumGrid.destroy();
      hostPad.destroy();
      samplerUi.destroy();
      if (audio) {
        for (const recorder of audio.loops.values()) recorder.clear();
        audio.drums.dispose();
        audio.synth.dispose();
        audio.sampler.dispose();
        audio.bus.dispose();
        audio.drumsFx.dispose();
        audio.engine.dispose();
      }
      audio = null;
      renderer.destroy();
      socket.disconnect();
      if (globalThis.__jam === view) delete globalThis.__jam;
    },
  };

  globalThis.__jam = view;
  return view;
}
