/**
 * HOST view: owns the audio graph, plays the same XY pad as the guests, and
 * renders every touch — local and remote — through one synth path.
 * Audio only boots on the splash "Start sound" gesture.
 */

import { AudioEngine, DEFAULT_MASTER_GAIN } from '../audio/engine.js';
import { buildLoopMidi, readRepeats, renderLoopWav, saveBlob } from '../audio/export-loop.js';
import { DrumMachine, STEPS, TRACKS, DRUM_PRESETS, tileHits, repeatTargets, repeatSpanSteps } from '../audio/drums.js';
import {
  INSTRUMENT_COLORS,
  INSTRUMENT_IDS,
  INSTRUMENTS,
  NOTE_NAMES,
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
  pitchChoice,
  resolveGesture,
} from '../audio/synth.js';
import {
  DRUM_FX,
  FX_COLORS,
  INSTRUMENT_FX,
  clampFx,
  createDrumBus,
  createInstrumentBus,
  cycleFxAmount,
  defaultFxState,
  defaultLevels,
  fxAmountLabel,
  FX_PAD_DIVISIONS,
  masterCutoffHz,
  masterHipassHz,
  REPEAT_ORDER,
} from '../audio/effects.js';
import { TouchPad, TouchPadRenderer } from '../ui/touch-pad.js';
import { paintIconButton, chipIcon, setIconLabel } from '../ui/icons.js';
import { renderPianoRoll, scrollRollToMidi, setRollPlayhead, setRollSelectMode } from '../ui/piano-roll.js';
import { createDrumGrid } from '../ui/drum-grid.js';
import { pressable, setControlEnabled } from '../ui/quiet-touch.js';
import { markPageEdges, markScrollEdges } from '../ui/scroll-edges.js';
import { JamSocket, EVENTS, isLocalHostname } from '../network/socket.js';

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
      const response = await fetch('/api/lan');
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

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (globalThis.QRCode) {
      resolve(globalThis.QRCode);
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve(globalThis.QRCode);
    script.onerror = () => reject(new Error('QR library failed to load'));
    document.head.append(script);
  });
}

function playerIdFromTouch(id) {
  const value = String(id ?? '');
  if (value.startsWith('host:')) return 'host';
  if (value.startsWith('loop:')) return '';
  const split = value.indexOf(':');
  return split === -1 ? value : value.slice(0, split);
}

export async function createHostView() {
  const el = {
    code: document.getElementById('host-code'),
    joinUrl: document.getElementById('host-join-url'),
    qr: document.getElementById('host-qr'),
    socketStatus: document.getElementById('host-socket-status'),
    audioStatus: document.getElementById('host-audio-status'),
    drumSource: document.getElementById('drum-source'),
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
    instrumentFx: document.getElementById('instrument-fx'),
    drumFx: document.getElementById('drum-fx'),
    hostScreen: document.getElementById('host-screen'),
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
    fxDetail: document.getElementById('fx-detail'),
    fxSheet: document.getElementById('host-fx-sheet'),
    fxSliders: document.getElementById('host-fx-sliders'),
    fxSheetClose: document.getElementById('host-fx-close'),
    master: document.getElementById('btn-master'),
    exportOpen: document.getElementById('btn-export'),
    exportSheet: document.getElementById('host-export-sheet'),
    exportRepeats: document.getElementById('export-repeats'),
    exportMidi: document.getElementById('export-midi'),
    exportWav: document.getElementById('export-wav'),
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
  };

  const state = {
    grid: Object.fromEntries(
      TRACKS.map(({ id }) => [id, Array.from({ length: STEPS }, () => ({ on: false, division: 1 }))]),
    ),
    mode: 'single',
    root: 'C',
    scale: 'major',
    instrument: 'pad',
    bpm: 120,
    peers: new Map(),
    effects: defaultFxState(),
    levels: defaultLevels(),
    octaves: defaultOctaves(),
    mute: { pad: false, bass: false, organ: false, kalimba: false, synth: false, drums: false },
    solo: { pad: false, bass: false, organ: false, kalimba: false, synth: false, drums: false },
    masterFx: { division: '16n', cutoff: 0, hipass: 0, grit: 0, wah: 0, hold: false, volume: DEFAULT_MASTER_GAIN },
    padMode: 'notes',
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
    const on = new Set(tileHits(initialPreset.pattern[track.id] ?? [], state.drumSteps, initialPreset.span));
    for (const step of on) state.grid[track.id][step] = { on: true, division: 1 };
  }

  /** @type {{ engine: AudioEngine, drums: DrumMachine, synth: TouchSynth, bus: ReturnType<typeof createInstrumentBus>, drumsFx: ReturnType<typeof createDrumBus>, loops: Map<string, PerformanceRecorder> } | null} */
  let audio = null;

  const renderer = new TouchPadRenderer(el.canvas, { columns: 12 });
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
    });
  }

  function setRoot(note) {
    if (!NOTE_NAMES.includes(note)) return;
    state.root = note;
    audio?.synth.setRoot(note);
    el.rootName.textContent = note;
    el.rootChips.querySelectorAll('.chip').forEach((chip) => chip.classList.toggle('is-picked', chip.dataset.root === note));
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
    const chords = !fxMode && state.mode === 'chords' && !bass;
    el.zones.hidden = !chords;
    renderer.setMode(fxMode ? 'fx' : chords ? 'chords' : 'single');
    if (!chords) paintZone(null);
    // FX owns the pad: the note-mode row and the loop buttons it rides with
    // step aside. Bass never plays chords, so its mode chips hide too.
    el.playBar.hidden = fxMode;
    if (el.modeRow) el.modeRow.hidden = bass;
    selectInRow(el.modeRow, 'mode', bass ? 'single' : state.mode, 'is-on');
    el.padMode?.querySelectorAll('[data-padmode]').forEach((chip) => {
      chip.classList.toggle('is-on', chip.dataset.padmode === state.padMode);
    });
    if (!el.hint) return;
    if (fxMode) {
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
   * Two undo stacks: one per editor (their own changes) and one shared.
   * Entries snapshot every recorder about to change. A single shared redo
   * stack serves both undos and knows which stack to push back onto.
   */
  const ownPast = new Map();
  const globalPast = [];
  const sharedFuture = [];
  /** One-shot restore for the transport Clear button. Dropped on the next loop downbeat. */
  const clearUndos = new Map();
  let litStep = -1;

  function pushCapped(stack, entry) {
    stack.push(entry);
    if (stack.length > 40) stack.shift();
  }

  /** Pre-change state of every recorder that is about to be touched. */
  function snapshotOf(playerIds) {
    return [...playerIds].map((id) => ({ playerId: id, events: audio?.loops.get(id)?.exportEvents() ?? null }));
  }

  function pushEdit(editorId, targets) {
    const entry = { targets };
    let own = ownPast.get(editorId);
    if (!own) {
      own = [];
      ownPast.set(editorId, own);
    }
    pushCapped(own, entry);
    pushCapped(globalPast, entry);
    sharedFuture.length = 0;
  }

  function rememberEdit(editorId, targetIds) {
    if (!audio || !targetIds?.length) return;
    pushEdit(editorId, snapshotOf(targetIds));
  }

  function restoreTargets(targets) {
    if (!audio) return;
    for (const { playerId, events } of targets || []) {
      const recorder = recorderFor(playerId);
      if (!recorder) continue;
      if (events) recorder.restoreEvents(events);
      else recorder.clear();
    }
  }

  /** The recorder that owns a strip. voiceIds are unique across players. */
  function ownerOfVoice(voiceId) {
    if (!audio) return null;
    for (const [playerId, recorder] of audio.loops) {
      if (recorder.notes().some((note) => note.voiceId === voiceId)) return playerId;
    }
    return null;
  }

  function undoOwn(editorId) {
    const entry = ownPast.get(editorId)?.pop();
    if (!entry || !audio) return false;
    sharedFuture.push({
      targets: snapshotOf(entry.targets.map((item) => item.playerId)),
      origin: { own: editorId },
    });
    restoreTargets(entry.targets);
    refreshLoops();
    return true;
  }

  function undoAll() {
    const entry = globalPast.pop();
    if (!entry || !audio) return false;
    sharedFuture.push({ targets: snapshotOf(entry.targets.map((item) => item.playerId)), origin: null });
    restoreTargets(entry.targets);
    refreshLoops();
    return true;
  }

  function redoShared() {
    const entry = sharedFuture.pop();
    if (!entry || !audio) return false;
    const current = snapshotOf(entry.targets.map((item) => item.playerId));
    if (entry.origin?.own) {
      let own = ownPast.get(entry.origin.own);
      if (!own) {
        own = [];
        ownPast.set(entry.origin.own, own);
      }
      pushCapped(own, { targets: current });
    } else {
      pushCapped(globalPast, { targets: current });
    }
    restoreTargets(entry.targets);
    refreshLoops();
    return true;
  }

  function drumCellPx() {
    const steps = Math.max(1, state.drumSteps || 16);
    const view = el.sequencer?.clientWidth || 0;
    const width = view > 80 ? view : Math.max(280, window.innerWidth - 16);
    const fit = Math.max(8, (width - 128 - STEP_GAP * Math.max(0, steps - 1) - 8) / steps);
    return fit + (Math.max(fit, DRUM_EDIT_PX) - fit) * drumZoom;
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
    if (running && step >= 0) watchClearUndo(step);
    paintBar(shown);
    paintNotePlayhead(step);
    syncPadPulse(running, step);
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
      const on = new Set(tileHits(pattern[track.id] ?? [], length, span));
      for (let i = 0; i < length; i += 1) {
        const slot = { on: on.has(i), division: 1 };
        state.grid[track.id][i] = slot;
        audio?.drums.setStep(track.id, i, slot.on, 1);
      }
    }
    renderSequencer();
  }

  function markDrumPreset(id) {
    for (const row of [el.drumPresets, el.drumPresetsMain]) {
      row?.querySelectorAll('.chip').forEach((chip) => chip.classList.toggle('is-picked', chip.dataset.preset === id));
    }
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

  function renderFxRow(container, specs, levels, onCycle) {
    container.replaceChildren();
    for (const spec of specs) {
      const level = clampFx(levels?.[spec.id] ?? 0);
      const button = pressable(`chip fx-chip has-swatch${level >= 0.08 ? ' is-on' : ''}`);
      button.style.setProperty('--chip', FX_COLORS[spec.id] || '#e2b43a');
      button.dataset.fx = spec.id;
      paintIconButton(button, spec.id, spec.label, fxAmountLabel(level));
      button.addEventListener('click', () => onCycle(spec.id, cycleFxAmount(level)));
      container.append(button);
    }
  }

  function renderInstrumentFx() {
    const specs = INSTRUMENT_FX[state.instrument] ?? [];
    renderFxRow(el.instrumentFx, specs, state.effects[state.instrument], (id, level) => {
      state.effects[state.instrument][id] = level;
      audio?.bus.setEffect(state.instrument, id, level);
      renderInstrumentFx();
      publishHarmony();
    });
  }

  function renderDrumFx() {
    renderFxRow(el.drumFx, DRUM_FX, state.effects.drums, (id, level) => {
      state.effects.drums[id] = level;
      audio?.drumsFx.setEffect(id, level);
      renderDrumFx();
      publishHarmony();
    });
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
    const anySolo = MIX_VOICES.some((id) => state.solo[id]);
    for (const id of MIX_VOICES) {
      const heard = !state.mute[id] && (!anySolo || state.solo[id]);
      if (id === 'drums') audio.drumsFx.setAudible(heard);
      else audio.bus.setAudible(id, heard);
    }
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
    add(
      'grit',
      () => masterLabel('grit'),
      Math.round(state.masterFx.grit * 100),
      100,
      1,
      (value) => {
        state.masterFx.grit = value / 100;
        applyMasterFx();
        publishHarmony();
      },
    );
    add(
      'wah',
      () => masterLabel('wah'),
      Math.round(state.masterFx.wah * 100),
      100,
      1,
      (value) => {
        state.masterFx.wah = value / 100;
        applyMasterFx();
        publishHarmony();
      },
    );
    add(
      'volume',
      () => masterLabel('volume'),
      Math.round(state.masterFx.volume * 100),
      100,
      1,
      (value) => {
        state.masterFx.volume = value / 100;
        applyMasterFx();
        publishHarmony();
      },
    );
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

  /* ---------- Pad mode: Notes, or the master FX surface ---------- */

  /** Who currently holds the stutter: 'host', or a guest peerId. */
  let masterHolder = null;
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
      }
      setLabel('—');
      publishHarmony();
      return;
    }
    const { division } = fxZone(point);
    const { cutoff, hipass } = fxFilter(point);
    // The left lane is filter-only: sliding into it releases the stutter
    // without lifting the finger, sliding back out re-grabs the slice.
    const wantsHold = Boolean(division);
    const wasHeld = state.masterFx.hold && masterHolder === 'host';
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
        publishHarmony();
        return;
      }
    } else if (wasHeld) {
      masterHolder = null;
      state.masterFx.hold = false;
      audio?.engine.masterFx?.setHold(false);
      publishHarmony();
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
    const mode = next === 'fx' ? 'fx' : 'notes';
    if (mode === state.padMode) return;
    hostPad.releaseHeld();
    fxFingers.clear();
    state.padMode = mode;
    syncModeChrome();
  }

  el.padMode?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-padmode]');
    if (chip) setPadMode(chip.dataset.padmode);
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
      publishHarmony();
      if (!el.notesSheet.hidden) paintHostRoll();
    }
  });

  /** Paint the carousel label; re-paint and re-center the open roll. */
  function paintRollInstrument() {
    const spec = INSTRUMENTS.find((item) => item.id === state.instrument);
    el.instName.style.setProperty('--chip', INSTRUMENT_COLORS[state.instrument] || '#e2b43a');
    paintIconButton(el.instName, state.instrument, spec?.label || state.instrument);
    if (!el.notesSheet.hidden) {
      paintHostRoll();
      revealRoll();
    }
  }

  function pickInstrument(instrument) {
    state.instrument = normalizeInstrument(instrument);
    paintInstruments(el.instruments, state.instrument);
    renderInstrumentFx();
    if (!el.fxSheet.hidden) renderFxSliders();
    syncModeChrome();
    paintRollInstrument();
  }

  function cycleRollInstrument(direction) {
    const index = INSTRUMENT_IDS.indexOf(state.instrument);
    pickInstrument(INSTRUMENT_IDS[(index + direction + INSTRUMENT_IDS.length) % INSTRUMENT_IDS.length]);
  }

  el.instruments.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-instrument]');
    if (!chip) return;
    pickInstrument(chip.dataset.instrument);
  });

  function setSharedBpm(bpm) {
    state.bpm = Number(bpm);
    audio?.engine.setBpm(state.bpm);
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
        loopSteps: state.noteSteps,
        onPlayback: (event, gesture) => {
          if (!sameInstrument(event?.instrument)) return;
          if (event?.type === 'up') {
            if (!selectedFingerHeld()) setLabel('—');
            return;
          }
          if (gesture?.label) setLabel(gesture.label);
        },
      });
      audio.loops.set(playerId, recorder);
    }
    return recorder;
  }

  function setHostRecording(next) {
    const recorder = recorderFor('host');
    if (!recorder) return;
    if (next) {
      rememberEdit('host', ['host']);
      ensureTransport();
      recorder.start();
      el.loop.classList.add('is-on');
      el.loop.setAttribute('aria-pressed', 'true');
      log('recording into the loop from the next bar', 'loop');
    } else {
      recorder.stop();
      el.loop.classList.remove('is-on');
      el.loop.setAttribute('aria-pressed', 'false');
      refreshLoops();
      log(`${recorder.length} events`, 'loop');
    }
  }

  el.loop.addEventListener('click', () => {
    if (!audio) return;
    setHostRecording(!recorderFor('host').isRecording);
  });

  function paintHostClear(undo) {
    el.loopClear.replaceChildren(chipIcon(undo ? 'undo' : 'erase'));
    el.loopClear.setAttribute('aria-label', undo ? 'Undo clear' : 'Clear all loops');
  }

  function armClearUndo(playerId, targets) {
    const origin = litStep >= 0 ? litStep % Math.max(1, state.noteSteps) : -1;
    clearUndos.set(playerId, { targets, leftBar: origin > 0 });
    if (playerId === 'host') paintHostClear(true);
    refreshLoops();
  }

  function finishClearUndo(playerId) {
    if (!clearUndos.delete(playerId)) return;
    if (playerId === 'host') paintHostClear(false);
    refreshLoops();
  }

  function restoreClearUndo(playerId) {
    const pending = clearUndos.get(playerId);
    if (!pending) return false;
    restoreTargets(pending.targets);
    finishClearUndo(playerId);
    return true;
  }

  /** A new loop round is the playhead back on bar 1. Undo for Clear expires there. */
  function watchClearUndo(step) {
    if (!clearUndos.size) return;
    const origin = step % Math.max(1, state.noteSteps);
    for (const [playerId, pending] of [...clearUndos]) {
      if (origin !== 0) pending.leftBar = true;
      else if (pending.leftBar) finishClearUndo(playerId);
    }
  }

  el.loopClear.addEventListener('click', () => {
    if (!audio) return;
    if (clearUndos.has('host')) {
      restoreClearUndo('host');
      log('loops restored', 'loop');
      return;
    }
    const targets = snapshotOf(audio.loops.keys());
    pushEdit('host', targets);
    for (const recorder of audio.loops.values()) recorder.clear();
    armClearUndo('host', targets);
    log('all loops cleared', 'loop');
  });

  el.loopUndo.addEventListener('click', () => {
    if (undoOwn('host')) log('change undone', 'loop');
  });
  el.loopRedo.addEventListener('click', () => {
    if (redoShared()) log('change redone', 'loop');
  });

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

  function writePlacedNotes(recorder, { step, instrument, x, y, degree, midi }) {
    if (!recorder) return;
    recorder.addNote({
      step,
      x,
      y: Number.isFinite(Number(y)) ? Number(y) : 0.55,
      instrument,
      mode: 'single',
      degree,
      midi,
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
      const sounding = pitchesFor(note)[0];
      const prefer = change.midi > sounding ? 'up' : change.midi < sounding ? 'down' : undefined;
      const choice = choiceFor(change.midi, note, prefer);
      recorder.moveNote(change.voiceId, {
        step: change.step,
        x: choice.x,
        degree: choice.degree,
        midi: change.midi,
      });
    }
    refreshLoops();
  }

  function syncHostHistory() {
    setControlEnabled(el.noteUndo, Boolean(ownPast.get('host')?.length));
    setControlEnabled(el.noteUndoAll, globalPast.length > 0);
    setControlEnabled(el.noteRedo, sharedFuture.length > 0);
    setControlEnabled(el.loopUndo, Boolean(ownPast.get('host')?.length));
    setControlEnabled(el.loopRedo, sharedFuture.length > 0);
  }

  function hostNoteStepPx() {
    const steps = Math.max(16, state.noteSteps || 32);
    const view = el.noteTape?.clientWidth || 0;
    const width = view > 40 ? view : Math.max(280, window.innerWidth - 16);
    const fit = Math.max(6, (width - 50) / steps);
    return fit + (Math.max(fit, 44) - fit) * noteZoom;
  }

  function paintHostRoll() {
    renderPianoRoll(el.noteTape, {
      notes: allLoopNotes(),
      steps: state.noteSteps,
      stepPx: hostNoteStepPx(),
      pitchesFor,
      colorFor: (note) => INSTRUMENT_COLORS[normalizeInstrument(note.instrument)] || '#e0a12e',
      onDelete: (voiceId) => {
        const ownerId = ownerOfVoice(voiceId);
        if (ownerId == null) return;
        rememberEdit('host', [ownerId]);
        audio?.loops.get(ownerId)?.removeNote(voiceId);
        refreshLoops();
        log('note removed from the loop', 'loop');
      },
      instrument: state.instrument,
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
      onAudition: ({ down, midi, pointerId }) => previewRoll(down, midi, pointerId),
      onPlace: ({ step, midi }) => {
        const instrument = state.instrument;
        const draft = { x: 0.5, y: 0.55, mode: 'single', instrument };
        const choice = choiceFor(midi, draft);
        rememberEdit('host', ['host']);
        writePlacedNotes(recorderFor('host'), { step, instrument, x: choice.x, y: 0.55, degree: choice.degree, midi });
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

  /** Every player's loop, broadcast as one map so all editors see all notes. */
  function shareLoop() {
    if (!audio) return;
    const players = {};
    // Players with a pending clear-undo but no recorder still need their flag.
    const ids = new Set([...audio.loops.keys(), ...clearUndos.keys(), ...ownPast.keys()]);
    for (const playerId of ids) {
      const recorder = audio.loops.get(playerId);
      players[playerId] = {
        notes: recorder?.notes() ?? [],
        noteSteps: recorder?.loopSteps ?? state.noteSteps,
        canUndo: Boolean(ownPast.get(playerId)?.length),
        clearUndo: clearUndos.has(playerId),
      };
    }
    socket.broadcastState({
      loopNotes: {
        noteSteps: state.noteSteps,
        players,
        canUndoAll: globalPast.length > 0,
        canRedo: sharedFuture.length > 0,
      },
    });
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

  /** Any loop changed: repaint the open sheet and push the map to the guests. */
  function refreshLoops() {
    if (!el.notesSheet.hidden) paintHostRoll();
    syncHostHistory();
    shareLoop();
  }

  function renderFxSliders() {
    const rows = [];
    const instrument = state.instrument;
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
        name.textContent = `${spec.label} · ${Math.round(amount * 100)}%`;
        const input = document.createElement('input');
        input.type = 'range';
        input.min = '0';
        input.max = '100';
        input.step = '1';
        input.value = String(Math.round(amount * 100));
        input.addEventListener('input', () => {
          const value = Number(input.value) / 100;
          name.textContent = `${spec.label} · ${input.value}%`;
          onInput(spec.id, value);
        });
        row.append(name, input);
        rows.push(row);
      }
    };
    addGroup('This instrument', INSTRUMENT_FX[state.instrument] ?? [], state.effects[state.instrument], (id, value) => {
      state.effects[state.instrument][id] = value;
      audio?.bus.setEffect(state.instrument, id, value);
      renderInstrumentFx();
      publishHarmony();
    });
    el.fxSliders.replaceChildren(...rows);
  }

  el.fxDetail.addEventListener('click', () => {
    renderFxSliders();
    el.fxSheet.hidden = false;
  });
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

  document.getElementById('host-note-zoom')?.addEventListener('input', (event) => {
    noteZoom = Number(event.target.value) / 100;
    paintHostRoll();
  });
  document.getElementById('drum-zoom')?.addEventListener('input', (event) => {
    drumZoom = Number(event.target.value) / 100;
    renderSequencer();
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
  el.noteUndoAll.addEventListener('click', () => undoAll());
  el.noteRedo.addEventListener('click', () => redoShared());
  el.instPrev.addEventListener('click', () => cycleRollInstrument(-1));
  el.instNext.addEventListener('click', () => cycleRollInstrument(1));
  el.instPrev.replaceChildren(chipIcon('prev'));
  el.instNext.replaceChildren(chipIcon('next'));
  paintRollInstrument();
  el.noteClear.addEventListener('click', () => {
    if (!audio) return;
    rememberEdit('host', [...audio.loops.keys()]);
    for (const recorder of audio.loops.values()) recorder.clearInstrument(state.instrument);
    refreshLoops();
    log(`cleared ${state.instrument} from every loop`, 'loop');
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

  function disposePartial({ engine, drums, synth, bus, drumsFx }) {
    try {
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
    const engine = await new AudioEngine({ bpm: state.bpm }).start();
    /** @type {{ drums?: DrumMachine, synth?: TouchSynth, bus?: ReturnType<typeof createInstrumentBus>, drumsFx?: ReturnType<typeof createDrumBus> }} */
    const partial = { engine };
    try {
      partial.bus = createInstrumentBus(engine.tone);
      partial.drumsFx = createDrumBus(engine.tone);
      partial.drums = new DrumMachine(engine);
      partial.synth = new TouchSynth(engine, partial.bus, {
        root: state.root,
        scale: state.scale,
        mode: state.mode,
      });
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

      const [sampleState] = await Promise.all([partial.drums.loadSamples(), partial.bus.ready, partial.drumsFx.ready]);
      for (const [id, octave] of Object.entries(state.octaves)) partial.synth.setInstrumentOctave(id, octave);
      partial.synth.warmUp();

      audio = {
        engine,
        drums: partial.drums,
        synth: partial.synth,
        bus: partial.bus,
        drumsFx: partial.drumsFx,
        loops: new Map(),
      };
      applyStoredEffects();
      applyMix();
      applyMasterFx({ prime: true });
      partial.drums.start();
      paintBar(parkedLoopStep());

      el.drumSource.textContent = describeSamples(sampleState);
      el.drumSource.dataset.state = sampleState.usingSamples ? 'online' : 'error';
      log(sampleState.usingSamples ? 'TR-808 from the CDN' : 'synthesis, sample CDN unavailable', 'drums');
      log(`Tone.js ${globalThis.Tone.version}, context ${engine.contextState}`, 'audio');
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
      const wav = await renderLoopWav(globalThis.Tone, { ...exportSnapshot(), repeats });
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
    if (wrote === 'chord' || wrote === 'note') refreshLoops();
  }

  const hostPad = new TouchPad(el.pad, {
    locked: true,
    onStart: (point) => {
      if (state.padMode === 'fx') {
        fxPadDown(point);
        return;
      }
      soundTouch({ ...point, id: `host:${point.id}`, name: 'host', instrument: state.instrument, mode: state.mode });
    },
    onMove: (point) => {
      if (state.padMode === 'fx') {
        fxPadMove(point);
        return;
      }
      soundTouch({ ...point, id: `host:${point.id}`, name: 'host', instrument: state.instrument, mode: state.mode });
    },
    onEnd: (point) => {
      if (state.padMode === 'fx') {
        fxPadUp(point);
        return;
      }
      soundTouch({ ...point, id: `host:${point.id}`, name: 'host', instrument: state.instrument, mode: state.mode });
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
    if (state.instrument === instrument) renderInstrumentFx();
    publishHarmony();
    log(`${data.name ?? 'guest'} · ${instrument} ${effect.id} ${fxAmountLabel(level)}`, 'effect');
  }

  function applyGuestOctave(data) {
    const octave = data?.octave;
    const instrument = namedInstrument(octave?.instrument);
    if (!octave || !instrument || !Number.isFinite(Number(octave.value))) return;
    const value = Math.min(6, Math.max(1, Math.round(Number(octave.value))));
    state.octaves[instrument] = value;
    audio?.synth.setInstrumentOctave(instrument, value);
    publishHarmony();
  }

  function applyGuestLevel(data) {
    const level = data?.level;
    const instrument = namedInstrument(level?.instrument);
    if (!level || !instrument || !Number.isFinite(Number(level.value))) return;
    const value = clampFx(level.value);
    state.levels[instrument] = value;
    audio?.bus.setLevel(instrument, value);
    if (state.instrument === instrument && !el.fxSheet.hidden) renderFxSliders();
    publishHarmony();
  }

  function applyGuestMaster(data) {
    const patch = data?.masterFx;
    if (!patch || typeof patch !== 'object') return;
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
    publishHarmony();
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
      const instrument = namedInstrument(add?.instrument);
      if (instrument && Number.isFinite(Number(add.step)) && Number.isFinite(Number(add.x))) {
        rememberEdit(data.peerId, [data.peerId]);
        writePlacedNotes(recorderFor(data.peerId), {
          step: add.step,
          instrument,
          x: add.x,
          y: Number.isFinite(Number(add.y)) ? Number(add.y) : 0.55,
          degree: add.degree,
          midi: add.midi,
        });
        ensureTransport();
        refreshLoops();
      }
    }
    if (data.history === 'undo' && audio) undoOwn(data.peerId);
    if (data.history === 'undo-all' && audio) undoAll();
    if (data.history === 'redo' && audio) redoShared();
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
      rememberEdit(data.peerId, [data.peerId]);
      ensureTransport();
      recorder.start();
      log(`${data.name ?? 'guest'} is recording a loop`, 'loop');
    }
    if (data.loop === 'stop') {
      recorder.stop();
      refreshLoops();
      log(`${data.name ?? 'guest'} loop paused, ${recorder.length} events`, 'loop');
    }
    if (data.loop === 'undo-clear') {
      const restored = restoreClearUndo(data.peerId);
      if (!restored) refreshLoops();
      log(`${data.name ?? 'guest'} ${restored ? 'restored the loop' : 'undo missed'}`, 'loop');
    }
    if (data.loop === 'clear') {
      if (data.fromEditor) {
        const instrument = namedInstrument(data.instrument);
        rememberEdit(data.peerId, [...audio.loops.keys()]);
        for (const target of audio.loops.values()) {
          if (instrument) target.clearInstrument(instrument);
          else target.clear();
        }
        refreshLoops();
      } else {
        const targets = snapshotOf(audio.loops.keys());
        pushEdit(data.peerId, targets);
        for (const target of audio.loops.values()) target.clear();
        armClearUndo(data.peerId, targets);
      }
      log(`${data.name ?? 'guest'} cleared ${data.fromEditor ? data.instrument || 'the loop' : 'the loop'}`, 'loop');
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

  async function paintJoinQr(url) {
    try {
      const QRCode = await loadScript(QR_SRC);
      el.qr.replaceChildren();
      const qr = new QRCode(el.qr, {
        text: url,
        width: 168,
        height: 168,
        colorDark: '#06231d',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M,
      });
      qr.makeCode(url);
    } catch (error) {
      el.qr.textContent = 'QR unavailable';
      log(error.message, 'qr');
    }
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
    el.code.textContent = session.code;
    joinUrl = await guestJoinUrl(session.code);
    el.joinUrl.textContent = joinUrl;
    el.joinUrl.title = joinUrl;
    for (const peerId of [...state.peers.keys()]) clearPeer(peerId);
    state.peers.clear();
    setPeers();
    if (masterHolder) {
      masterHolder = null;
      state.masterFx.hold = false;
      audio?.engine.masterFx?.setHold(false);
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
    publishHarmony();
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
    paintHostClear(clearUndos.has('host'));
    paintIconButton(el.notes, 'notes', 'Notes');
    paintIconButton(el.bars, 'bars', barCountLabel(state.noteSteps));
    paintIconButton(el.noteUndo, 'undo', 'Undo');
    paintIconButton(el.noteUndoAll, 'undo', 'Undo all');
    paintIconButton(el.noteRedo, 'redo', 'Redo');
    paintIconButton(el.noteClear, 'erase', 'clr curr inst');
    paintIconButton(el.notesClose, 'done', 'Done');
    paintIconButton(el.fxDetail, 'detail', 'More');
    paintIconButton(el.fxSheetClose, 'done', 'Done');
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
  renderInstrumentFx();
  renderDrumFx();
  paintInstruments(el.instruments, state.instrument);
  paintMixFlags();
  syncModeChrome();
  setPeers();
  requestAnimationFrame(() => renderer.resize());

  session = await socket.createSession();
  el.code.textContent = session.code;
  joinUrl = await guestJoinUrl(session.code);
  el.joinUrl.textContent = joinUrl;
  el.joinUrl.title = joinUrl;
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
    renderInstrumentFx();
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
    destroy() {
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(parkTimer);
      clearTimeout(drumPushTimer);
      clearTimeout(harmonyPushTimer);
      drumGrid.destroy();
      hostPad.destroy();
      if (audio) {
        for (const recorder of audio.loops.values()) recorder.clear();
        audio.drums.dispose();
        audio.synth.dispose();
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
