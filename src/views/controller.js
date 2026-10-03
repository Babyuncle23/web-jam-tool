/**
 * CONTROLLER view (guest phone): no audio and no page zoom.
 * The page can scroll vertically. Harmony comes from the host.
 * The caption uses the same resolveGesture function the host plays.
 */

import { TouchPad, TouchPadRenderer } from '../ui/touch-pad.js';
import { INSTRUMENT_COLORS, INSTRUMENT_IDS, INSTRUMENTS, LOOP_STEPS, NOTE_NAMES, SCALE_LABELS, SCALES, SAMPLER_INSTRUMENT, defaultOctaves, extensionFromY, instrumentHomeMidi, midiInScale, normalizeInstrument, padNoteMarks, pitchChoice, resolveGesture, storedInstrument } from '../audio/synth.js';
import { SAMPLE_BANK, clampSampleVolume, defaultSampleParams, sampleMode } from '../audio/sampler.js';
import { FX_COLORS, FX_FULL_LABELS, FX_PAD_DIVISIONS, clampFx, defaultFxState, defaultLevels, instrumentFxSpecs, masterCutoffHz, masterHipassHz, REPEAT_ORDER } from '../audio/effects.js';
import { DEFAULT_MASTER_GAIN } from '../audio/engine.js';
import { TRACKS, DRUM_PRESETS, STEPS as DRUM_STEPS, tileCells, repeatTargets, repeatSpanSteps } from '../audio/drums.js';
import { JamSocket, EVENTS } from '../network/socket.js';
import { chipIcon, paintIconButton, setIconLabel } from '../ui/icons.js';
import { createDrumGrid } from '../ui/drum-grid.js';
import { renderPianoRoll, scrollRollToMidi, setRollPlayhead, setRollSelectMode } from '../ui/piano-roll.js';
import { createSampleGrid } from '../ui/sample-grid.js';
import { pressable, setControlEnabled } from '../ui/quiet-touch.js';
import { markPageEdges, markScrollEdges } from '../ui/scroll-edges.js';

/** Two-level compare for `{ instrument: { fxId: level } }` state patches. */
function sameFxMap(a, b) {
  for (const key of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const inner = a?.[key] ?? {};
    const other = b?.[key] ?? {};
    for (const id of new Set([...Object.keys(inner), ...Object.keys(other)])) {
      if (inner[id] !== other[id]) return false;
    }
  }
  return true;
}

export async function createControllerView({ code, name } = {}) {
  const el = {
    pad: document.getElementById('pad'),
    canvas: document.getElementById('pad-canvas'),
    status: document.getElementById('controller-status'),
    key: document.getElementById('controller-key'),
    label: document.getElementById('controller-harmony-label'),
    barLabel: document.getElementById('controller-bar-label'),
    beatDots: document.getElementById('controller-beat-dots'),
    zones: document.getElementById('controller-y-zones'),
    hint: document.getElementById('pad-hint'),
    screen: document.getElementById('controller-screen'),
    splash: document.getElementById('controller-splash'),
    splashDetail: document.getElementById('controller-splash-detail'),
    splashError: document.getElementById('controller-splash-error'),
    loop: document.getElementById('controller-loop'),
    loopClear: document.getElementById('controller-loop-clear'),
    loopUndo: document.getElementById('controller-loop-undo'),
    loopRedo: document.getElementById('controller-loop-redo'),
    transport: document.getElementById('controller-transport'),
    instruments: document.getElementById('controller-instruments'),
    secInstruments: document.getElementById('sec-guest-instruments'),
    secInstValue: document.getElementById('sec-guest-inst-value'),
    secDrumValue: document.getElementById('sec-guest-drums-value'),
    instMiniName: document.querySelector('#sec-guest-instruments [data-inst-name]'),
    notes: document.getElementById('controller-notes'),
    notesSheet: document.getElementById('controller-notes-sheet'),
    noteTape: document.getElementById('controller-note-tape'),
    notesClose: document.getElementById('controller-notes-close'),
    noteUndo: document.getElementById('controller-undo'),
    noteUndoAll: document.getElementById('controller-undo-all'),
    noteRedo: document.getElementById('controller-redo'),
    noteClear: document.getElementById('controller-note-clear'),
    instPrev: document.getElementById('controller-inst-prev'),
    instName: document.getElementById('controller-inst-name'),
    instNext: document.getElementById('controller-inst-next'),
    fxSheet: document.getElementById('controller-fx-sheet'),
    fxSliders: document.getElementById('controller-fx-sliders'),
    fxTitle: document.getElementById('controller-fx-title'),
    fxSheetClose: document.getElementById('controller-fx-close'),
    master: document.getElementById('controller-master'),
    masterSheet: document.getElementById('controller-master-sheet'),
    masterSliders: document.getElementById('controller-master-sliders'),
    masterClose: document.getElementById('controller-master-close'),
    drumsOpen: document.getElementById('controller-drums'),
    drumsSheet: document.getElementById('controller-drums-sheet'),
    drumSequencer: document.getElementById('controller-sequencer'),
    drumPresets: document.getElementById('controller-drum-presets'),
    drumPresetsMain: document.getElementById('controller-drum-presets-main'),
    drumsClose: document.getElementById('controller-drums-close'),
    drumTransport: document.getElementById('controller-drums-transport'),
    drumWriteRow: document.getElementById('controller-drum-write'),
    drumRepeatRow: document.getElementById('controller-drum-repeat'),
    drumAdvCheck: document.getElementById('controller-drum-adv-check'),
    drumAdvPanel: document.getElementById('controller-drum-adv'),
    drumLengthRow: document.getElementById('controller-drum-length'),
    drumPitch: document.getElementById('controller-drum-pitch'),
    drumPitchLabel: document.getElementById('controller-drum-pitch-label'),
    padMode: document.getElementById('controller-pad-mode'),
    playBar: document.getElementById('controller-play-bar'),
    sampler: document.getElementById('controller-sampler'),
    sampleEdit: document.getElementById('controller-sample-edit'),
  };

  const state = {
    mode: 'chords',
    root: 'C',
    scale: 'major',
    instrument: 'pad',
    // Instrument whose sliders the More sheet shows — follows the card it
    // was opened from, not always the playing instrument.
    fxFor: 'pad',
    effects: defaultFxState(),
    levels: defaultLevels(),
    octaves: defaultOctaves(),
    audioReady: false,
    recording: false,
    transportRunning: false,
    marks: [],
    noteSteps: LOOP_STEPS,
    bpm: 120,
    masterFx: { division: '16n', cutoff: 0, hipass: 0, grit: 0, wah: 0, hold: false, volume: DEFAULT_MASTER_GAIN },
    padMode: 'notes',
    /** '' | 'edit' — the pad grid's tune/erase layer while in SMP mode. */
    samplerEdit: '',
    // Pad tuning mirrors the host's — the badges and drags are authoritative
    // over there, this copy just keeps the local grid responsive.
    sampleParams: defaultSampleParams(),
    // 'sampler' parks the roll on the lane view; anything else follows the
    // picked instrument.
    rollView: null,
    canUndo: false,
    canUndoAll: false,
    canRedo: false,
    peerId: null,
    drumWrite: 'single',
    drums: { steps: DRUM_STEPS, preset: 'break', repeat: 1, grid: null, pitch: 0 },
    /** True while the host runs the Lite rig — its FX chips are the trimmed set. */
    lite: false,
  };
  state.drums.grid = Object.fromEntries(
    TRACKS.map(({ id }) => [id, Array.from({ length: state.drums.steps }, () => ({ on: false, division: 1 }))]),
  );
  let guestSelectMode = false;
  const socket = new JamSocket();
  const renderer = new TouchPadRenderer(el.canvas, { columns: 12 });

  function setStatus(text, stateName) {
    el.status.textContent = text;
    el.status.dataset.state = stateName;
  }

  function updateKey() {
    const scale = SCALE_LABELS[state.scale] ?? state.scale;
    el.key.textContent = `${state.root} · ${scale}`;
  }

  function setLabel(text) {
    el.label.textContent = text || '—';
  }

  /** Zone labels sit top→bottom: 9, 7, sus, triad. Both sus bands share one. */
  const ZONE_SPAN = { ninth: 0, seventh: 1, sus2: 2, sus4: 2, triad: 3 };

  function paintZone(y) {
    const spans = el.zones?.children;
    if (!spans?.length) return;
    const hit = y == null || state.mode !== 'chords' || state.instrument === 'bass'
      ? -1
      : ZONE_SPAN[extensionFromY(y)] ?? -1;
    [...spans].forEach((span, index) => span.classList.toggle('is-active', index === hit));
  }

  function syncChrome() {
    const bassPicked = state.instrument === 'bass';
    const fxMode = state.padMode === 'fx';
    const samplerMode = state.padMode === 'sampler';
    const shownMode = bassPicked ? 'single' : state.mode;
    // FX and the sampler own the pad: the note-mode row and its loop buttons
    // step aside. Bass never plays chords, so its mode chips hide too.
    el.playBar.hidden = fxMode;
    if (el.sampler) el.sampler.hidden = !samplerMode;
    samplerUi.setEditMode(state.samplerEdit);
    if (el.sampleEdit) {
      el.sampleEdit.hidden = !samplerMode;
      el.sampleEdit.classList.toggle('is-on', Boolean(state.samplerEdit));
      el.sampleEdit.setAttribute('aria-pressed', state.samplerEdit ? 'true' : 'false');
      paintSampleEditButton(el.sampleEdit);
    }
    // Pads never record while tuning or erasing — dim Rec so it reads as off.
    el.loop?.classList.toggle('is-off', Boolean(state.samplerEdit));
    el.pad.classList.toggle('is-sampler', samplerMode);
    const modeRow = el.playBar?.querySelector('.play-bar__modes');
    if (modeRow) modeRow.hidden = bassPicked || samplerMode;
    el.screen.querySelectorAll('[data-mode]').forEach((chip) => {
      chip.classList.toggle('is-on', chip.dataset.mode === shownMode);
    });
    el.padMode?.querySelectorAll('[data-padmode]').forEach((chip) => {
      chip.classList.toggle('is-on', chip.dataset.padmode === state.padMode);
    });
    el.instruments.querySelectorAll('[data-instrument]').forEach((chip) => {
      const id = chip.dataset.instrument;
      chip.classList.add('has-swatch');
      chip.classList.toggle('is-on', id === state.instrument);
      chip.style.setProperty('--chip', INSTRUMENT_COLORS[id] || '#e2b43a');
      chip.closest('.inst-card')?.classList.toggle('is-on', id === state.instrument);
      const spec = INSTRUMENTS.find((item) => item.id === id);
      paintIconButton(chip, id, spec?.label || id);
    });
    paintInstrumentMini();
    paintSecValues();
    const bass = state.instrument === 'bass';
    const chords = !fxMode && !samplerMode && state.mode === 'chords' && !bass;
    el.zones.hidden = !chords;
    renderer.setMode(fxMode ? 'fx' : chords ? 'chords' : 'single');
    if (!chords) paintZone(null);
    syncPadMarks();
    el.hint.textContent = samplerMode
      ? state.samplerEdit
        ? 'Tap a pad to edit it — the panel sliders set pitch, stretch, volume. ✕ wipes a sample’s hits. Rec is off.'
        : 'Tap pads to play. SOLO mutes everything else while held.'
      : fxMode
        ? '— filters only. 1/4 → 1/32 holds stutter. Up cuts lows, down cuts highs.'
        : bass
          ? 'One scale step. Hold and slide.'
          : chords
            ? 'X is the chord. Y is triad, sus, 7th, 9th.'
            : 'X is one note in the host key.';
  }

  /** Recorded loop notes of the selected instrument show as dots on the pad. */
  function syncPadMarks() {
    if (state.padMode !== 'notes') {
      renderer.setMarks([]);
      return;
    }
    renderer.setMarks(padNoteMarks(state.marks, state.instrument));
  }

  /** Section headers always read out the current value when collapsed. */
  function paintSecValues() {
    const spec = INSTRUMENTS.find((item) => item.id === state.instrument);
    if (el.secInstValue) el.secInstValue.textContent = spec?.label ?? state.instrument;
    if (el.secDrumValue) el.secDrumValue.textContent = DRUM_PRESETS[state.drums.preset]?.label ?? 'Custom';
  }

  /** The collapsed instrument section is a one-item carousel. */
  function paintInstrumentMini() {
    if (!el.instMiniName) return;
    const spec = INSTRUMENTS.find((item) => item.id === state.instrument);
    el.instMiniName.style.setProperty('--chip', INSTRUMENT_COLORS[state.instrument] || '#e2b43a');
    paintIconButton(el.instMiniName, state.instrument, spec?.label || state.instrument);
  }

  function unlock() {
    state.audioReady = true;
    pad.setLocked(false);
    el.pad.classList.remove('is-locked');
    setControlEnabled(el.loop, true);
    setControlEnabled(el.loopClear, true);
    setControlEnabled(el.notes, true);
    setControlEnabled(el.transport, true);
    syncGuestHistory();
    el.splash.hidden = true;
    el.splash.dataset.phase = 'ready';
  }

  function showHostError(message) {
    el.splash.hidden = false;
    el.splash.dataset.phase = 'error';
    el.splashError.hidden = false;
    el.splashError.textContent = message;
    el.splashDetail.textContent = 'The host could not start audio. Touches stay off until the host tries again.';
    pad.setLocked(true);
    setControlEnabled(el.loop, false);
    setControlEnabled(el.loopClear, false);
    setControlEnabled(el.notes, false);
    setControlEnabled(el.transport, false);
    syncGuestHistory();
  }

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

  function syncGuestHistory() {
    setControlEnabled(el.noteUndo, state.canUndo);
    setControlEnabled(el.noteUndoAll, state.canUndoAll);
    setControlEnabled(el.noteRedo, state.canRedo);
    setControlEnabled(el.loopUndo, state.audioReady && state.canUndo);
    setControlEnabled(el.loopRedo, state.audioReady && state.canRedo);
  }

  let noteZoom = 0;

  function guestNoteStepPx() {
    const steps = Math.max(16, state.noteSteps || 32);
    const view = el.noteTape?.clientWidth || 0;
    const width = view > 40 ? view : Math.max(280, window.innerWidth - 16);
    const fit = Math.max(6, (width - 50) / steps);
    return fit + (Math.max(fit, 44) - fit) * noteZoom;
  }

  /** Pinch/wheel zoom: translate a wanted step width back into noteZoom. */
  function applyGuestNoteStepPx(px) {
    const steps = Math.max(16, state.noteSteps || 32);
    const view = el.noteTape?.clientWidth || 0;
    const width = view > 40 ? view : Math.max(280, window.innerWidth - 16);
    const fit = Math.max(6, (width - 50) / steps);
    const span = Math.max(fit, 44) - fit;
    noteZoom = span > 0 ? Math.max(0, Math.min(1, (px - fit) / span)) : 0;
    paintGuestNotes();
    return guestNoteStepPx();
  }

  /* While any player is recording the host pushes a fresh loopNotes map every
     ~80 ms; repainting the open sheet on a ~180 ms timer batches those bursts
     and the latest map still lands within a quarter beat of the capture.
     paintGuestNotes clears a pending timer, so manual repaints win at once. */
  let guestNotesTimer = 0;
  function queueGuestNotes() {
    if (el.notesSheet.hidden || guestNotesTimer) return;
    guestNotesTimer = setTimeout(() => {
      guestNotesTimer = 0;
      if (!el.notesSheet.hidden) paintGuestNotes();
    }, 180);
  }

  function paintGuestNotes() {
    if (guestNotesTimer) {
      clearTimeout(guestNotesTimer);
      guestNotesTimer = 0;
    }
    const view = rollInstrument();
    const lanes =
      view === SAMPLER_INSTRUMENT ? SAMPLE_BANK.map(({ id, label }) => ({ id, label })) : undefined;
    renderPianoRoll(el.noteTape, {
      notes: state.marks,
      steps: state.noteSteps,
      stepPx: guestNoteStepPx(),
      onZoom: applyGuestNoteStepPx,
      pitchesFor,
      lanes,
      colorFor: (note) => INSTRUMENT_COLORS[storedInstrument(note.instrument)] || '#e0a12e',
      onDelete: (voiceId) => {
        socket.sendControl({ eraseNote: voiceId });
      },
      instrument: view,
      owner: state.peerId,
      selectMode: guestSelectMode,
      onMoveGroup: (changes) => {
        socket.sendControl({
          moveGroup: changes.map((change) => {
            const note = state.marks.find((item) => item.voiceId === change.voiceId);
            // Sample strips only move along the beat — no pitch fields.
            if (note?.instrument === SAMPLER_INSTRUMENT) {
              return { voiceId: change.voiceId, step: change.step };
            }
            const sounding = note ? pitchesFor(note)[0] : change.midi;
            const prefer = change.midi > sounding ? 'up' : change.midi < sounding ? 'down' : undefined;
            const choice = note ? choiceFor(change.midi, note, prefer) : { x: 0.5, degree: 0 };
            return {
              voiceId: change.voiceId,
              step: change.step,
              x: choice.x,
              degree: choice.degree,
              midi: change.midi,
            };
          }),
        });
      },
      onResize: (voiceId, change) => {
        const note = state.marks.find((item) => item.voiceId === voiceId);
        if (!note) return;
        socket.sendControl({
          moveNote: {
            voiceId,
            step: note.step,
            x: note.x,
            degree: note.degree,
            duration: change.duration,
          },
        });
      },
      focusMidi: rollFocusMidi(),
      inScale: (midi) => midiInScale(midi, state.root, state.scale),
      onAudition: ({ down, midi, pointerId, lane }) => {
        if (lane) {
          if (down) socket.sendControl({ samplePreview: lane });
          return;
        }
        socket.sendControl({ preview: { down, midi, pointerId, instrument: state.instrument } });
      },
      onPlace: ({ step, midi, lane }) => {
        if (lane) {
          socket.sendControl({
            addNote: { step, x: 0.5, y: 0.55, instrument: SAMPLER_INSTRUMENT, mode: 'single', sample: lane },
          });
          return;
        }
        const draft = { x: 0.5, y: 0.55, mode: 'single', instrument: state.instrument };
        const choice = choiceFor(midi, draft);
        socket.sendControl({
          addNote: {
            step,
            x: choice.x,
            y: 0.55,
            instrument: state.instrument,
            mode: 'single',
            degree: choice.degree,
            // In-scale stays degree-relative — octave changes reach the note;
            // exact midi is only for a pitch no scale degree expresses.
            midi: choice.distance === 0 ? null : midi,
          },
        });
      },
    });
    syncGuestHistory();
  }

  /* ---------- Drums (mirrors the host sheet; edits go over the socket) ---------- */

  let drumZoom = 0;
  let pendingDrumWrites = [];

  function guestDrumCellPx() {
    const steps = Math.max(1, state.drums.steps || 16);
    const view = el.drumSequencer?.clientWidth || 0;
    const width = view > 80 ? view : Math.max(280, window.innerWidth - 16);
    const fit = Math.max(8, (width - 128 - 3 * Math.max(0, steps - 1) - 8) / steps);
    return fit + (Math.max(fit, 46) - fit) * drumZoom;
  }

  /** Pinch/wheel zoom: translate a wanted cell size back into drumZoom. */
  function applyGuestDrumCellPx(px) {
    const steps = Math.max(1, state.drums.steps || 16);
    const view = el.drumSequencer?.clientWidth || 0;
    const width = view > 80 ? view : Math.max(280, window.innerWidth - 16);
    const fit = Math.max(8, (width - 128 - 3 * Math.max(0, steps - 1) - 8) / steps);
    const span = Math.max(fit, 46) - fit;
    drumZoom = span > 0 ? Math.max(0, Math.min(1, (px - fit) / span)) : 0;
    drumGrid.render();
    return guestDrumCellPx();
  }

  function ensureGuestDrumRows() {
    for (const { id } of TRACKS) {
      const row = state.drums.grid[id] || (state.drums.grid[id] = []);
      while (row.length < state.drums.steps) row.push({ on: false, division: 1 });
      if (row.length > state.drums.steps) row.length = state.drums.steps;
    }
  }

  function setGuestDrumCell(track, step, value) {
    const row = state.drums.grid[track];
    if (!row || step < 0 || step >= state.drums.steps) return false;
    const next = { on: Boolean(value?.on), division: value?.on && Number(value?.division) === 3 ? 3 : 1 };
    const prev = row[step];
    if (prev && prev.on === next.on && (prev.division || 1) === next.division) return false;
    row[step] = next;
    drumGrid.paintCell(track, step);
    return true;
  }

  /** Optimistic write: paint locally now, let the host broadcast confirm. */
  function applyGuestDrumCell(track, step, value) {
    const write = {
      track,
      step,
      on: Boolean(value?.on),
      division: value?.on && Number(value?.division) === 3 ? 3 : 1,
    };
    pendingDrumWrites.push(write);
    let changed = false;
    for (const s of repeatTargets(state.drums.repeat, state.drums.steps, step)) {
      changed = setGuestDrumCell(track, s, write) || changed;
    }
    if (!changed) return;
    if (state.drums.preset) {
      state.drums.preset = '';
      paintGuestDrumPreset();
    }
  }

  function flushGuestDrumWrites() {
    if (!pendingDrumWrites.length) return;
    socket.sendControl({ drumSet: pendingDrumWrites.splice(0) });
  }

  const drumGrid = createDrumGrid(el.drumSequencer, {
    tracks: TRACKS,
    steps: () => state.drums.steps,
    cell: (track, step) => state.drums.grid[track]?.[step],
    cellPx: guestDrumCellPx,
    iconFor: (track) => chipIcon(track.id),
    mirrorSpan: () => repeatSpanSteps(state.drums.repeat, state.drums.steps),
    writeMode: () => state.drumWrite,
    applyCell: applyGuestDrumCell,
    onGesture: (phase) => {
      if (phase === 'flush' || phase === 'end') flushGuestDrumWrites();
    },
    onZoom: applyGuestDrumCellPx,
  });

  function paintGuestDrumPreset() {
    for (const row of [el.drumPresets, el.drumPresetsMain]) {
      row?.querySelectorAll('.chip').forEach((chip) => {
        chip.classList.toggle('is-picked', chip.dataset.preset === state.drums.preset);
      });
    }
    const preset = DRUM_PRESETS[state.drums.preset];
    if (el.drumsOpen) setIconLabel(el.drumsOpen, 'Edit drums', preset?.label);
    if (el.secDrumValue) el.secDrumValue.textContent = preset?.label ?? 'Custom';
  }

  function renderGuestDrumPresets() {
    for (const row of [el.drumPresets, el.drumPresetsMain]) {
      if (!row) continue;
      row.replaceChildren();
      for (const preset of Object.values(DRUM_PRESETS)) {
        const button = pressable(`chip${preset.id === state.drums.preset ? ' is-picked' : ''}`);
        button.dataset.preset = preset.id;
        button.textContent = preset.label;
        button.title = preset.title || preset.label;
        button.addEventListener('click', () => pickGuestDrumPreset(preset.id));
        row.append(button);
      }
    }
    paintGuestDrumPreset();
  }

  function applyGuestPattern(pattern, span) {
    ensureGuestDrumRows();
    for (const { id } of TRACKS) {
      const cells = tileCells(pattern[id] ?? [], state.drums.steps, span);
      for (let i = 0; i < state.drums.steps; i += 1) {
        state.drums.grid[id][i] = { on: cells.has(i), division: cells.get(i) ?? 1 };
      }
    }
  }

  function pickGuestDrumPreset(id) {
    const preset = DRUM_PRESETS[id];
    if (!preset) return;
    state.drums.preset = id;
    state.drums.repeat = preset.repeat ?? 1;
    applyGuestPattern(preset.pattern, preset.span);
    paintGuestDrumPreset();
    paintGuestDrumEditRows();
    drumGrid.render();
    socket.sendControl({ drumPreset: id });
  }

  function tileGuestDrumRepeat() {
    const span = repeatSpanSteps(state.drums.repeat, state.drums.steps);
    if (!span) return;
    for (const { id } of TRACKS) {
      const row = state.drums.grid[id];
      for (let s = span; s < state.drums.steps; s += 1) {
        const src = row[s % span];
        row[s] = { on: Boolean(src?.on), division: src?.division === 3 ? 3 : 1 };
      }
    }
  }

  function paintGuestDrumEditRows() {
    el.drumWriteRow?.querySelectorAll('[data-write]').forEach((chip) => {
      chip.classList.toggle('is-picked', chip.dataset.write === state.drumWrite);
    });
    el.drumRepeatRow?.querySelectorAll('[data-repeat-bars]').forEach((chip) => {
      const mode = chip.dataset.repeatBars;
      const picked = String(state.drums.repeat) === mode;
      const bars = mode === 'off' ? 0 : Number(mode) || 0;
      setControlEnabled(chip, bars === 0 || bars * 16 < state.drums.steps || picked);
      chip.classList.toggle('is-picked', picked);
      chip.setAttribute('aria-pressed', picked ? 'true' : 'false');
    });
  }

  function setGuestDrumRepeat(mode) {
    const next = mode === 'off' || mode === '0' || mode === 0 ? 'off' : Math.min(2, Math.max(1, Number(mode) || 1));
    state.drums.repeat = next;
    paintGuestDrumEditRows();
    if (next !== 'off') tileGuestDrumRepeat();
    drumGrid.render();
    socket.sendControl({ drumRepeat: next });
  }

  function paintGuestBpm() {
    el.drumsSheet?.querySelectorAll('[data-bpm]').forEach((chip) => {
      chip.classList.toggle('is-picked', chip.dataset.bpm === String(state.bpm));
    });
  }

  function paintGuestDrumLength() {
    el.drumLengthRow?.querySelectorAll('[data-steps]').forEach((chip) => {
      chip.classList.toggle('is-picked', Number(chip.dataset.steps) === state.drums.steps);
    });
  }

  let guestPitchDrag = false;

  function guestPitchLabel() {
    const st = state.drums.pitch;
    return `Drum pitch · ${st > 0 ? '+' : ''}${st} st`;
  }

  function syncGuestDrumPitch() {
    if (!guestPitchDrag && el.drumPitch && String(el.drumPitch.value) !== String(state.drums.pitch)) {
      el.drumPitch.value = String(state.drums.pitch);
    }
    if (el.drumPitchLabel) el.drumPitchLabel.textContent = guestPitchLabel();
  }

  /** Host broadcast is the authority: adopt the whole drum state. */
  function applyHostDrums(d) {
    const prevSteps = state.drums.steps;
    const prevRepeat = state.drums.repeat;
    let changed = false;
    if (Number.isFinite(Number(d.steps))) {
      const next = Math.max(16, Math.round(Number(d.steps)));
      if (next !== state.drums.steps) {
        state.drums.steps = next;
        changed = true;
      }
    }
    if (typeof d.preset === 'string' || d.preset === '') {
      const next = d.preset || '';
      if (next !== state.drums.preset) {
        state.drums.preset = next;
        changed = true;
      }
    }
    if (d.repeat === 'off' || Number(d.repeat) > 0) {
      const next = d.repeat === 'off' ? 'off' : Math.min(2, Math.max(1, Number(d.repeat)));
      if (next !== state.drums.repeat) {
        state.drums.repeat = next;
        changed = true;
      }
    }
    if (Number.isFinite(Number(d.pitch))) {
      const next = Math.min(12, Math.max(-12, Math.round(Number(d.pitch))));
      if (next !== state.drums.pitch) {
        state.drums.pitch = next;
        changed = true;
        syncGuestDrumPitch();
      }
    }
    if (d.grid && typeof d.grid === 'object') {
      for (const { id } of TRACKS) {
        const row = Array.isArray(d.grid[id]) ? d.grid[id] : [];
        const target = state.drums.grid[id] || (state.drums.grid[id] = []);
        for (let i = 0; i < row.length; i += 1) {
          const next = { on: Boolean(row[i]?.on), division: row[i]?.division === 3 ? 3 : 1 };
          const prev = target[i];
          if (prev && prev.on === next.on && (prev.division || 1) === next.division) continue;
          target[i] = next;
          changed = true;
        }
        if (target.length !== row.length) {
          target.length = row.length;
          changed = true;
        }
      }
    }
    // An identical echo (a join snapshot, the tail of a debounced push)
    // leaves the DOM alone — the grid only repaints on real edits.
    if (!changed) return;
    ensureGuestDrumRows();
    paintGuestDrumPreset();
    paintGuestDrumEditRows();
    paintGuestDrumLength();
    if (el.drumsSheet.hidden) return;
    if (state.drums.steps !== prevSteps || state.drums.repeat !== prevRepeat) drumGrid.render();
    else drumGrid.paintAll();
  }

  el.drumsOpen?.addEventListener('click', () => {
    el.drumsSheet.hidden = false;
    drumGrid.render();
  });
  el.drumsClose?.addEventListener('click', () => {
    el.drumsSheet.hidden = true;
  });
  el.drumTransport?.addEventListener('click', () => {
    if (!state.audioReady) return;
    state.transportRunning = !state.transportRunning;
    paintGuestTransport();
    socket.sendControl({ transport: 'toggle' });
  });
  el.drumWriteRow?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-write]');
    if (!chip || chip.getAttribute('aria-disabled') === 'true') return;
    state.drumWrite = chip.dataset.write === 'triplet' ? 'triplet' : 'single';
    paintGuestDrumEditRows();
  });
  el.drumRepeatRow?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-repeat-bars]');
    if (!chip || chip.getAttribute('aria-disabled') === 'true') return;
    setGuestDrumRepeat(chip.dataset.repeatBars);
  });
  el.drumsSheet?.querySelector('[data-group="bpm"]')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-bpm]');
    if (!chip || chip.getAttribute('aria-disabled') === 'true') return;
    socket.sendControl({ bpm: Number(chip.dataset.bpm) });
  });
  el.drumAdvCheck?.addEventListener('change', () => {
    const on = Boolean(el.drumAdvCheck.checked);
    if (el.drumAdvPanel) el.drumAdvPanel.hidden = !on;
    if (!on && state.drumWrite !== 'single') {
      state.drumWrite = 'single';
      paintGuestDrumEditRows();
    }
  });
  el.drumLengthRow?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-steps]');
    if (!chip || chip.getAttribute('aria-disabled') === 'true') return;
    socket.sendControl({ drumLength: Number(chip.dataset.steps) });
  });
  el.drumPitch?.addEventListener('pointerdown', () => {
    guestPitchDrag = true;
  });
  el.drumPitch?.addEventListener('pointerup', () => {
    guestPitchDrag = false;
  });
  el.drumPitch?.addEventListener('pointercancel', () => {
    guestPitchDrag = false;
  });
  el.drumPitch?.addEventListener('input', () => {
    state.drums.pitch = Math.min(12, Math.max(-12, Math.round(Number(el.drumPitch.value) || 0)));
    syncGuestDrumPitch();
    socket.sendControlThrottled({ drumPitch: state.drums.pitch });
  });

  function renderGuestSliders() {
    const rows = [];
    const target = state.fxFor;
    const spec0 = INSTRUMENTS.find((item) => item.id === target);
    if (el.fxTitle) el.fxTitle.textContent = spec0 ? `${spec0.label} · sound` : 'Effect detail';
    const level = clampFx(state.levels[target] ?? 1);
    const volumeRow = document.createElement('label');
    volumeRow.className = 'fx-slider';
    volumeRow.style.setProperty('--chip', INSTRUMENT_COLORS[target] || '#e2b43a');
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
      state.levels[target] = value;
      socket.sendControlThrottled({ level: { instrument: target, value } });
    });
    volumeRow.append(volumeName, volume);
    rows.push(volumeRow);
    const octaveValue = state.octaves[target] ?? defaultOctaves()[target];
    const octaveRow = document.createElement('label');
    octaveRow.className = 'fx-slider fx-slider--octave';
    octaveRow.style.setProperty('--chip', INSTRUMENT_COLORS[target] || '#e2b43a');
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
      state.octaves[target] = value;
      socket.sendControlThrottled({ octave: { instrument: target, value } });
    });
    octaveRow.append(octaveName, octave);
    rows.push(octaveRow);
    for (const spec of instrumentFxSpecs(target, state.lite)) {
      const amount = clampFx(state.effects[target]?.[spec.id] ?? 0);
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
        if (!state.effects[target]) state.effects[target] = {};
        state.effects[target][spec.id] = value;
        socket.sendControlThrottled({ effect: { instrument: target, id: spec.id, level: value } });
      });
      row.append(name, input);
      rows.push(row);
    }
    el.fxSliders.replaceChildren(...rows);
  }

  socket.on('disconnect', () => setStatus('connection lost', 'error'));
  socket.on(EVENTS.sessionClosed, () => setStatus('host closed the session', 'error'));
  let guestStep = null;
  function paintGuestBeats(step) {
    const beat = step == null || step < 0 ? -1 : Math.floor((Math.floor(step) % 16) / 4);
    const dots = el.beatDots?.children;
    if (!dots) return;
    for (let i = 0; i < dots.length; i += 1) {
      const on = i === beat;
      if (dots[i].classList.contains('is-on') !== on) dots[i].classList.toggle('is-on', on);
    }
  }

  function paintGuestBar(step) {
    if (!(step >= 0)) return;
    guestStep = step;
    const total = Math.max(1, Math.round(state.noteSteps / 16));
    const text = `Bar ${(Math.floor(step / 16) % total) + 1} / ${total}`;
    if (el.barLabel.textContent !== text) el.barLabel.textContent = text;
    paintGuestBeats(step);
  }

  function syncGuestPulse(running, step = 0, { retune = false } = {}) {
    const pad = el.pad;
    if (!pad) return;
    const bpm = Math.min(200, Math.max(40, Number(state.bpm) || 96));
    const seconds = 60 / bpm;
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

  function paintGuestTransport() {
    el.transport.replaceChildren(chipIcon(state.transportRunning ? 'stop' : 'play'));
    el.transport.classList.toggle('is-on', state.transportRunning);
    el.transport.setAttribute('aria-pressed', state.transportRunning ? 'true' : 'false');
    if (el.drumTransport) {
      el.drumTransport.textContent = state.transportRunning ? 'Stop' : 'Play';
      el.drumTransport.classList.toggle('is-on', state.transportRunning);
      el.drumTransport.setAttribute('aria-pressed', state.transportRunning ? 'true' : 'false');
    }
  }

  function syncGuestTransport(running) {
    const next = Boolean(running);
    if (next === state.transportRunning) return;
    state.transportRunning = next;
    paintGuestTransport();
  }

  socket.on(EVENTS.pulse, ({ step, running }) => {
    if (!(step >= 0)) return;
    paintGuestBar(step);
    if (typeof running === 'boolean') syncGuestTransport(running);
    syncGuestPulse(Boolean(running), step);
    renderer.setLitStep(running ? step % Math.max(1, state.noteSteps) : -1);
    // Recorded hits flash the pads they fire on — the same cue the host gets.
    // Gate hits stay lit for their real (fractional) hold length.
    if (running && state.noteSteps > 0) {
      const local = step % state.noteSteps;
      const stepMs = 60000 / Math.max(40, Number(state.bpm) || 120) / 4;
      for (const note of state.marks) {
        if (note.instrument !== SAMPLER_INSTRUMENT || !note.sample) continue;
        if (note.step !== local) continue;
        if (sampleMode(note.sample) === 'gate') {
          let span = (note.endStep ?? note.step + 1) - note.step;
          if (span <= 0) span += state.noteSteps;
          samplerUi.flashFor(note.sample, span * stepMs);
        } else {
          samplerUi.flash(note.sample);
        }
      }
    }
    if (!el.drumsSheet.hidden) drumGrid.setLit(step % Math.max(1, state.drums.steps));
    if (el.notesSheet.hidden || !(state.noteSteps > 0)) return;
    setRollPlayhead(el.noteTape, step % state.noteSteps);
  });
  const GUEST_DIVISIONS = new Set(REPEAT_ORDER);
  /** The master slider under a finger (element), so host echoes don't fight it. */
  let guestMasterDrag = null;

  function guestMasterLabel(key) {
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

  function syncGuestMasterSliders() {
    el.masterSliders?.querySelectorAll('[data-master]').forEach((input) => {
      const key = input.dataset.master;
      if (input === guestMasterDrag) return;
      const next = String(Math.round(state.masterFx[key] * 100));
      if (input.value !== next) input.value = next;
      const name = input.previousElementSibling;
      if (name) name.textContent = guestMasterLabel(key);
    });
  }

  function renderGuestMaster() {
    const rows = [];
    const add = (key) => {
      const row = document.createElement('label');
      row.className = 'fx-slider fx-slider--master';
      const name = document.createElement('span');
      name.textContent = guestMasterLabel(key);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = '100';
      input.step = '1';
      input.dataset.master = key;
      input.value = String(Math.round(state.masterFx[key] * 100));
      const claim = () => {
        guestMasterDrag = input;
      };
      const release = () => {
        if (guestMasterDrag === input) guestMasterDrag = null;
      };
      input.addEventListener('pointerdown', claim);
      input.addEventListener('pointerup', release);
      input.addEventListener('pointercancel', release);
      input.addEventListener('input', () => {
        const value = Number(input.value) / 100;
        state.masterFx[key] = value;
        name.textContent = guestMasterLabel(key);
        socket.sendControlThrottled({ masterFx: { [key]: value } });
      });
      row.append(name, input);
      rows.push(row);
    };
    // A lite host has no 8-bit/wah inserts — only the volume slider stays.
    for (const key of state.lite ? ['volume'] : ['grit', 'wah', 'volume']) add(key);
    el.masterSliders.replaceChildren(...rows);
  }

  /* ---------- Pad mode: Notes, or the master FX surface ---------- */

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

  /**
   * FX touches ride the existing control channel: masterHold carries the
   * stutter on/off + division, masterFx carries the bipolar filter (lowpass
   * below the Y middle, highpass above it). No new protocol.
   */
  function driveFxPad() {
    const point = [...fxFingers.values()].pop();
    if (!point) {
      state.masterFx.hold = false;
      state.masterFx.cutoff = 0;
      state.masterFx.hipass = 0;
      setLabel('—');
      // Both releases are final values and ride the reliable channel: a
      // dropped volatile here left the host filter clamped after the finger
      // was already gone. sendControl also drops any queued move value.
      socket.sendControl({ masterHold: { hold: false } });
      socket.sendControl({ masterFx: { cutoff: 0, hipass: 0 } });
      return;
    }
    const { division } = fxZone(point);
    const { cutoff, hipass } = fxFilter(point);
    // The left lane is filter-only: there the finger drops the stutter but
    // keeps steering the filter.
    const wantsHold = Boolean(division);
    const wasHeld = state.masterFx.hold;
    const divisionChanged = wantsHold && state.masterFx.division !== division;
    if (wantsHold) state.masterFx.division = division;
    state.masterFx.hold = wantsHold;
    state.masterFx.cutoff = cutoff;
    state.masterFx.hipass = hipass;
    // The stutter edge is discrete and stays reliable; only the bipolar
    // filter rides the throttled volatile path.
    if (wantsHold !== wasHeld || divisionChanged) {
      socket.sendControl({ masterHold: { hold: wantsHold, division: division ?? '16n' } });
    }
    socket.sendControlThrottled({ masterFx: { cutoff, hipass } });
    setLabel(fxCaption(point));
  }

  function fxPadDown(point) {
    fxFingers.set(point.id, { x: point.x, y: point.y });
    el.pad.classList.add('is-active');
    renderer.update(point.id, point);
    driveFxPad();
  }

  function fxPadMove(point) {
    if (!fxFingers.has(point.id)) return;
    fxFingers.set(point.id, { x: point.x, y: point.y });
    renderer.update(point.id, point);
    driveFxPad();
  }

  function fxPadUp(point) {
    fxFingers.delete(point.id);
    renderer.update(point.id, null);
    if (!pad.activePointers.size) el.pad.classList.remove('is-active');
    driveFxPad();
  }

  /**
   * Held fingers leave through the OLD mode first: a notes finger sends its
   * note-off, an FX finger releases the stutter — nothing hangs on the flip.
   */
  function setPadMode(next) {
    const mode = ['fx', 'sampler'].includes(next) ? next : 'notes';
    if (mode === state.padMode) return;
    pad.releaseHeld();
    fxFingers.clear();
    // releaseAll() ends a held SOLO — the up edge still reaches the host.
    samplerUi.releaseAll();
    // The sampler owns the pad — a take still open on the notes pad ends here.
    if (mode === 'sampler' && state.recording) setRecording(false);
    if (state.padMode === 'sampler') state.samplerEdit = '';
    state.padMode = mode;
    syncChrome();
  }

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
    samplerUi.setEditMode(state.samplerEdit);
    syncChrome();
  });

  /**
   * The guest grid only emits controls — the host turns them into sound and
   * echoes the tuning back through host:state.
   */
  const samplerUi = createSampleGrid(el.sampler, {
    editMode: () => state.samplerEdit,
    params: (id) => state.sampleParams[id],
    onHit: (id) => {
      if (state.audioReady) socket.sendControl({ sampleHit: id });
    },
    onRelease: (id) => {
      if (state.audioReady) socket.sendControl({ sampleRelease: id });
    },
    onSolo: (held) => {
      if (state.audioReady) socket.sendControl({ sampleSolo: held });
    },
    onTune: (id, next, phase) => {
      const params = state.sampleParams[id];
      if (params && next) {
        params.pitch = next.pitch;
        params.stretch = next.stretch;
        params.volume = next.volume;
      }
      if (phase === 'start' || !state.audioReady) return;
      const tune = { sample: id, pitch: next.pitch, stretch: next.stretch, volume: next.volume };
      // 'set' commits skip the host-side audition.
      if (phase === 'end' || phase === 'set') socket.sendControl({ sampleTuneDone: { ...tune, quiet: phase === 'set' } });
      else socket.sendControlThrottled({ sampleTune: tune });
    },
    onErase: (id) => {
      if (state.audioReady) socket.sendControl({ sampleClear: id });
    },
    // Picking a sample in the panel plays it on the host — never recorded.
    onSelect: (id) => {
      if (state.audioReady) socket.sendControl({ samplePreview: id });
    },
    // Done keeps the committed params and leaves the edit layer.
    onDone: () => {
      state.samplerEdit = '';
      samplerUi.releaseAll();
      syncChrome();
    },
    hasHits: (id) => state.marks.some((note) => note.instrument === SAMPLER_INSTRUMENT && note.sample === id),
    panelHost: el.screen,
  });

  el.master?.addEventListener('click', () => {
    renderGuestMaster();
    el.masterSheet.hidden = false;
  });
  el.masterClose?.addEventListener('click', () => {
    el.masterSheet.hidden = true;
  });

  /** Last loopNotes version seen — identical echoes skip the note rebuild. */
  let hostLoopVersion = -1;

  socket.on(EVENTS.hostState, (payload) => {
    const previousRoot = state.root;
    const previousScale = state.scale;
    if (payload?.root && NOTE_NAMES.includes(payload.root)) state.root = payload.root;
    if (payload?.scale && SCALES[payload.scale]) state.scale = payload.scale;
    // A lite host advertises its trimmed FX set once — swap the chip specs
    // before the effects patch below repaints them.
    if (typeof payload?.lite === 'boolean' && payload.lite !== state.lite) {
      state.lite = payload.lite;
      renderer.setLite(payload.lite);
      el.screen.classList.toggle('is-lite', payload.lite);
      if (!el.fxSheet.hidden) renderGuestSliders();
    }
    if (payload?.masterFx && typeof payload.masterFx === 'object') {
      const next = payload.masterFx;
      const dragKey = guestMasterDrag?.dataset?.master;
      if (GUEST_DIVISIONS.has(next.division) && !fxFingers.size) state.masterFx.division = next.division;
      // Mid-gesture the finger's own hold flag is authoritative — except a
      // released flag: if the host dropped our hold (another finger took it,
      // a reconnect cleared it) the next move must re-send masterHold, or
      // the stutter silently never re-engages while the finger keeps moving.
      if (typeof next.hold === 'boolean' && (!fxFingers.size || next.hold === false)) {
        state.masterFx.hold = next.hold;
      }
      for (const key of ['cutoff', 'hipass', 'grit', 'wah', 'volume']) {
        if (!Number.isFinite(Number(next[key])) || dragKey === key) continue;
        if ((key === 'cutoff' || key === 'hipass') && fxFingers.size) continue;
        state.masterFx[key] = clampFx(next[key]);
      }
      syncGuestMasterSliders();
    }
    if ((state.root !== previousRoot || state.scale !== previousScale) && !el.notesSheet.hidden) paintGuestNotes();
    if (payload?.effects && typeof payload.effects === 'object') {
      // Harmony patches echo every ~90 ms while the host drags — the sheet
      // sliders only repaint on a real change so a local drag is not cut.
      const changed = !sameFxMap(payload.effects, state.effects);
      state.effects = payload.effects;
      if (changed && !el.fxSheet.hidden) renderGuestSliders();
    }
    if (payload?.levels && typeof payload.levels === 'object') {
      state.levels = { ...state.levels, ...payload.levels };
    }
    if (payload?.octaves && typeof payload.octaves === 'object') {
      state.octaves = { ...state.octaves, ...payload.octaves };
    }
    if (Number.isFinite(Number(payload?.bpm))) {
      const next = Math.min(200, Math.max(40, Number(payload.bpm)));
      if (next !== state.bpm) {
        state.bpm = next;
        syncGuestPulse(el.pad.classList.contains('is-pulsing'), guestStep ?? 0, { retune: true });
        paintGuestBpm();
      }
    }
    if (payload?.drums && typeof payload.drums === 'object') applyHostDrums(payload.drums);
    if (payload?.sampler && typeof payload.sampler === 'object') {
      // Pad tuning is host-owned: fold the echo in and repaint the badges.
      if (payload.sampler.params && typeof payload.sampler.params === 'object') {
        for (const spec of SAMPLE_BANK) {
          const next = payload.sampler.params[spec.id];
          if (!next) continue;
          state.sampleParams[spec.id] = {
            pitch: Math.round(Number(next.pitch) || 0),
            stretch: Number(next.stretch) || 1,
            volume: clampSampleVolume(next.volume ?? 1),
          };
          samplerUi.updateParam(spec.id);
        }
      }
      if (typeof payload.sampler.solo === 'boolean') samplerUi.setSoloRemote(payload.sampler.solo);
    }
    if (typeof payload?.transport === 'boolean') syncGuestTransport(payload.transport);
    if (Number.isFinite(Number(payload?.loopBars))) {
      state.noteSteps = Number(payload.loopBars);
      if (guestStep != null) paintGuestBar(guestStep);
    }
    if (payload?.loopNotes && typeof payload.loopNotes === 'object') {
      const pack = payload.loopNotes;
      if (Number.isFinite(Number(pack.noteSteps))) {
        state.noteSteps = Number(pack.noteSteps);
        if (guestStep != null) paintGuestBar(guestStep);
      }
      const players = pack.players && typeof pack.players === 'object' ? pack.players : {};
      const mine = players[state.peerId];
      state.canUndo = Boolean(mine?.canUndo);
      state.canUndoAll = Boolean(pack.canUndoAll);
      state.canRedo = Boolean(mine?.canRedo);
      // The host's recorder flag is authoritative — the Rec chip follows it,
      // not our local toggle, so a rejoin or a drifted tap can't desync it.
      if (typeof mine?.recording === 'boolean' && mine.recording !== state.recording) {
        state.recording = mine.recording;
        el.loop.classList.toggle('is-on', state.recording);
        el.loop.setAttribute('aria-pressed', state.recording ? 'true' : 'false');
        el.pad?.classList.toggle('is-recording', state.recording);
      }
      syncGuestHistory();
      // `v` bumps on the host only when the loop really changed, so an
      // identical echo (a snapshot after another guest joined) skips the
      // note rebuild and the pad/roll repaints entirely. Hosts without `v`
      // fall through to the old always-rebuild behaviour.
      const version = Number(pack.v);
      if (!Number.isFinite(version) || version !== hostLoopVersion) {
        if (Number.isFinite(version)) hostLoopVersion = version;
        const marks = [];
        for (const [owner, entry] of Object.entries(players)) {
          for (const note of entry?.notes || []) marks.push({ ...note, owner });
        }
        state.marks = marks;
        syncPadMarks();
        if (state.samplerEdit) samplerUi.refreshErase();
        if (!el.notesSheet.hidden) {
          if (Object.values(players).some((entry) => entry?.recording)) queueGuestNotes();
          else paintGuestNotes();
        }
      }
    }
    updateKey();
    if (payload?.audioError) {
      showHostError(payload.audioError);
      return;
    }
    if (payload?.audioReady) unlock();
  });

  let joined;
  try {
    joined = await socket.joinSession(code, name);
  } catch (error) {
    // A failed join must not leave the socket reconnecting in the
    // background — the screen it belonged to is already gone.
    socket.disconnect();
    throw error;
  }
  state.peerId = joined.peerId;
  setStatus(`${joined.name} · session ${joined.code}`, 'online');

  function caption(point) {
    return resolveGesture({
      x: point.x,
      y: point.y,
      mode: state.mode,
      root: state.root,
      scale: state.scale,
      instrument: state.instrument,
      octave: state.octaves[normalizeInstrument(state.instrument)],
      direction: point.direction,
    }).label;
  }

  /** Pointer id → instrument the finger came down on: an instrument switch
      mid-hold must not re-voice the held finger or write chord notes on the
      new pick. */
  const fingerInstruments = new Map();

  function touchPayload(point) {
    return {
      ...point,
      mode: state.mode,
      instrument: fingerInstruments.get(point.id) ?? state.instrument,
    };
  }

  const pad = new TouchPad(el.pad, {
    locked: true,
    onStart: (point) => {
      if (state.padMode === 'sampler') return;
      if (state.padMode === 'fx') {
        fxPadDown(point);
        return;
      }
      if (!state.audioReady) return;
      fingerInstruments.set(point.id, state.instrument);
      socket.sendTouch(touchPayload(point));
      el.pad.classList.add('is-active');
      renderer.update(point.id, point);
      setLabel(caption(point));
      paintZone(point.y);
    },
    onMove: (point) => {
      if (state.padMode === 'sampler') return;
      if (state.padMode === 'fx') {
        fxPadMove(point);
        return;
      }
      if (!state.audioReady) return;
      renderer.update(point.id, point);
      setLabel(caption(point));
      paintZone(point.y);
      socket.sendTouch(touchPayload(point));
    },
    onEnd: (point) => {
      if (state.padMode === 'sampler') return;
      if (state.padMode === 'fx') {
        fxPadUp(point);
        return;
      }
      renderer.update(point.id, null);
      if (!pad.activePointers.size) {
        el.pad.classList.remove('is-active');
        setLabel('—');
        paintZone(null);
      }
      if (!state.audioReady) {
        fingerInstruments.delete(point.id);
        return;
      }
      socket.sendTouch(touchPayload(point));
      fingerInstruments.delete(point.id);
    },
  });

  function onChipClick(event) {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    if (chip.dataset.padmode) {
      setPadMode(chip.dataset.padmode);
      return;
    }
    if (chip.dataset.mode && !(state.instrument === 'bass' && chip.dataset.mode === 'chords')) state.mode = chip.dataset.mode;
    if (chip.dataset.instrument) pickGuestInstrument(chip.dataset.instrument);
    syncChrome();
  }

  /** Same instrument switch as the main chips, plus the open roll follows. */
  function pickGuestInstrument(instrument) {
    // A switch never interrupts an open take: recording keeps rolling, held
    // fingers stay on the instrument they started on (fingerInstruments pins
    // it), and the mode/pad selection stays where the user left it.
    state.instrument = normalizeInstrument(instrument);
    // The More sheet follows the playing instrument until a card reopens it.
    state.fxFor = state.instrument;
    socket.sendControl({ instrument: state.instrument });
    if (!el.fxSheet.hidden) renderGuestSliders();
    syncChrome();
    paintRollInstrument();
  }

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
      paintGuestNotes();
      revealRoll();
    }
  }

  function cycleGuestInstrument(direction) {
    const index = ROLL_VIEWS.indexOf(rollInstrument());
    const next = ROLL_VIEWS[(index + direction + ROLL_VIEWS.length) % ROLL_VIEWS.length];
    if (next === SAMPLER_INSTRUMENT) {
      // View-only: the pad instrument stays put, the roll shows lanes.
      state.rollView = SAMPLER_INSTRUMENT;
      paintRollInstrument();
      return;
    }
    state.rollView = null;
    pickGuestInstrument(next);
  }

  el.screen.addEventListener('click', onChipClick);

  /** Card MORE opens the shared FX sheet pointed at that card's instrument. */
  function openFxSheet(instrument) {
    if (instrument) state.fxFor = normalizeInstrument(instrument);
    renderGuestSliders();
    el.fxSheet.hidden = false;
  }

  /* Section headers toggle; carousel arrows and card MORE live outside the
     heads so they never fight the collapse toggle. */
  el.screen.addEventListener('click', (event) => {
    const head = event.target.closest('.tool-sec__head');
    // Controls inside a head (Edit notes) act for themselves, never toggle.
    if (head && el.screen.contains(head) && !event.target.closest('button, [role="button"], input, select, a')) {
      const section = head.closest('.tool-sec');
      const open = section.classList.toggle('is-open');
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      return;
    }
    const cycle = event.target.closest('[data-inst-cycle]');
    if (cycle) {
      const index = INSTRUMENT_IDS.indexOf(state.instrument);
      const step = Number(cycle.dataset.instCycle) || 1;
      const next = INSTRUMENT_IDS[(index + step + INSTRUMENT_IDS.length) % INSTRUMENT_IDS.length];
      pickGuestInstrument(next);
      return;
    }
    const more = event.target.closest('[data-more]');
    if (more) openFxSheet(more.dataset.more);
  });
  el.screen.addEventListener('keydown', (event) => {
    const head = event.target.closest('.tool-sec__head');
    if (!head || event.target !== head || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    head.click();
  });

  function setRecording(next) {
    state.recording = next;
    el.loop.classList.toggle('is-on', next);
    el.loop.setAttribute('aria-pressed', next ? 'true' : 'false');
    // Red-pink heart glow on the pad while a take is open.
    el.pad?.classList.toggle('is-recording', next);
    socket.sendControl({ loop: next ? 'record' : 'stop' });
  }

  document.getElementById('controller-select-move')?.addEventListener('click', () => {
    guestSelectMode = !guestSelectMode;
    const button = document.getElementById('controller-select-move');
    button.classList.toggle('is-on', guestSelectMode);
    button.setAttribute('aria-pressed', guestSelectMode ? 'true' : 'false');
    setRollSelectMode(el.noteTape, guestSelectMode);
  });

  el.transport.addEventListener('click', () => {
    if (!state.audioReady) return;
    state.transportRunning = !state.transportRunning;
    paintGuestTransport();
    socket.sendControl({ transport: 'toggle' });
  });

  el.loop.addEventListener('click', () => {
    if (!state.audioReady) return;
    setRecording(!state.recording);
  });

  function paintGuestClear() {
    el.loopClear.replaceChildren(chipIcon('erase'));
    el.loopClear.setAttribute('aria-label', 'Clear your loop — hold to clear all loops');
    el.loopClear.title = 'Tap clears your loop. Hold clears all loops.';
  }

  /** Tap clears only your own loop; holding clears everyone's — the hold is
   * the confirmation, so a stray tap can't wipe the whole jam. */
  function fireGuestClear(scope) {
    if (!state.audioReady) return;
    state.marks = scope === 'mine' ? state.marks.filter((mark) => mark.owner !== state.peerId) : [];
    syncPadMarks();
    if (!el.notesSheet.hidden) paintGuestNotes();
    socket.sendControl(scope === 'mine' ? { loop: 'clear', scope: 'mine' } : { loop: 'clear' });
  }

  let guestClearHold = null;
  const disarmGuestClear = () => {
    el.loopClear.classList.remove('is-arming');
    if (!guestClearHold) return;
    clearTimeout(guestClearHold);
    guestClearHold = null;
  };
  el.loopClear.addEventListener('pointerdown', () => {
    if (!state.audioReady || guestClearHold) return;
    el.loopClear.classList.add('is-arming');
    guestClearHold = setTimeout(() => {
      guestClearHold = null;
      disarmGuestClear();
      fireGuestClear('all');
    }, 600);
  });
  el.loopClear.addEventListener('pointerup', () => {
    if (!guestClearHold) {
      el.loopClear.classList.remove('is-arming');
      return;
    }
    disarmGuestClear();
    fireGuestClear('mine');
  });
  // Dragging off or a cancelled press aborts the hold — no clear at all.
  for (const type of ['pointerleave', 'pointercancel']) {
    el.loopClear.addEventListener(type, disarmGuestClear);
  }

  el.loopUndo.addEventListener('click', () => socket.sendControl({ history: 'undo' }));
  el.loopRedo.addEventListener('click', () => socket.sendControl({ history: 'redo' }));

  el.notes.addEventListener('click', () => {
    if (!state.audioReady) return;
    socket.sendControl({ erase: 'show' });
    el.notesSheet.hidden = false;
    paintGuestNotes();
    revealRoll();
  });
  el.notesClose.addEventListener('click', () => {
    el.notesSheet.hidden = true;
  });
  el.noteUndo.addEventListener('click', () => socket.sendControl({ history: 'undo' }));
  el.noteUndoAll.addEventListener('click', () => socket.sendControl({ history: 'undo-all' }));
  el.noteRedo.addEventListener('click', () => socket.sendControl({ history: 'redo' }));
  el.instPrev.addEventListener('click', () => cycleGuestInstrument(-1));
  el.instNext.addEventListener('click', () => cycleGuestInstrument(1));
  el.instPrev.replaceChildren(chipIcon('prev'));
  el.instNext.replaceChildren(chipIcon('next'));
  const padNotesChip = el.padMode?.querySelector('[data-padmode="notes"]');
  const padFxChip = el.padMode?.querySelector('[data-padmode="fx"]');
  const padSamplerChip = el.padMode?.querySelector('[data-padmode="sampler"]');
  if (padNotesChip) paintIconButton(padNotesChip, 'notes', 'Keys');
  if (padFxChip) paintIconButton(padFxChip, 'scissors', 'FX');
  if (padSamplerChip) paintIconButton(padSamplerChip, 'sampler', 'SMP');
  if (el.sampleEdit) paintIconButton(el.sampleEdit, 'edit', 'Tune');
  paintRollInstrument();
  el.noteClear.addEventListener('click', () => {
    if (!state.audioReady) return;
    socket.sendControl({ loop: 'clear', fromEditor: true, instrument: rollInstrument() });
  });
  el.fxSheetClose.addEventListener('click', () => {
    el.fxSheet.hidden = true;
  });

  const preventGesture = (event) => event.preventDefault();
  document.addEventListener('gesturestart', preventGesture);

  updateKey();
  syncChrome();
  for (const card of [...el.instruments.querySelectorAll('.inst-card')]) {
    if (!INSTRUMENTS.some((item) => item.id === card.dataset.card)) card.remove();
  }
  for (const instrument of INSTRUMENTS) {
    if (el.instruments.querySelector(`[data-card="${instrument.id}"]`)) continue;
    const card = document.createElement('div');
    card.className = 'inst-card';
    card.dataset.card = instrument.id;
    const pick = pressable('chip has-swatch inst-card__pick');
    pick.dataset.instrument = instrument.id;
    paintIconButton(pick, instrument.id, instrument.label);
    const more = pressable('btn btn--ghost inst-card__more');
    more.dataset.more = instrument.id;
    paintIconButton(more, 'detail', 'More');
    card.append(pick, more);
    el.instruments.append(card);
  }
  el.playBar?.querySelectorAll('[data-mode]').forEach((chip) => {
    paintIconButton(chip, chip.dataset.mode === 'chords' ? 'chords' : 'notes', chip.dataset.mode === 'chords' ? 'Chords' : 'Notes');
  });
  paintIconButton(el.loop, 'loop', 'Rec');
  el.loopUndo.replaceChildren(chipIcon('undo'));
  el.loopRedo.replaceChildren(chipIcon('redo'));
  paintGuestTransport();
  paintGuestClear();
  paintGuestDrumLength();
  syncGuestDrumPitch();
  paintIconButton(el.notes, 'notes', 'Edit notes');
  paintIconButton(el.drumsOpen, 'edit', 'Edit drums');
  paintIconButton(el.noteUndo, 'undo', 'Undo');
  paintIconButton(el.noteUndoAll, 'undo', 'Undo all');
  paintIconButton(el.noteRedo, 'redo', 'Redo');
  paintIconButton(el.noteClear, 'erase', 'clear inst');
  paintIconButton(el.notesClose, 'done', 'Done');
  paintIconButton(el.fxSheetClose, 'done', 'Done');
  el.screen.querySelectorAll('[data-inst-cycle]').forEach((arrow) => {
    arrow.replaceChildren(chipIcon(Number(arrow.dataset.instCycle) < 0 ? 'prev' : 'next'));
  });
  el.screen.querySelectorAll('.inst-card__more').forEach((button) => {
    paintIconButton(button, 'detail', 'More');
  });
  el.screen.classList.toggle('is-lite', state.lite);
  paintInstrumentMini();
  paintSecValues();
  // Touch phones start the instruments section on the carousel — the card
  // grid costs too much pad space.
  if (matchMedia('(pointer: coarse), (max-width: 700px)').matches) {
    el.secInstruments?.classList.remove('is-open');
    el.secInstruments?.querySelector('.tool-sec__head')?.setAttribute('aria-expanded', 'false');
  }
  renderGuestDrumPresets();
  paintGuestDrumEditRows();
  paintGuestBpm();
  markScrollEdges(document.querySelector('.controller-foot'), 'y');
  markPageEdges();

  /* Landscape phone: the controller bar (session pill, key pill) is hidden
     by CSS, so Play and Back move into the play-bar — Play lands between
     the mode chips and Rec. Rotating back restores the buttons. */
  const landscapeMq = matchMedia('(orientation: landscape) and (max-height: 560px) and (pointer: coarse)');
  const backButton = el.screen.querySelector('.controller-bar [data-action="back"]');
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

  const view = {
    get code() {
      return joined.code;
    },
    get socket() {
      return socket;
    },
    get masterFx() {
      return { ...state.masterFx };
    },
    destroy() {
      landscapeMq.removeEventListener('change', placeLandscapeChrome);
      pad.destroy();
      drumGrid.destroy();
      samplerUi.destroy();
      renderer.destroy();
      clearTimeout(guestNotesTimer);
      el.screen.removeEventListener('click', onChipClick);
      document.removeEventListener('gesturestart', preventGesture);
      socket.disconnect();
      if (globalThis.__jam === view) delete globalThis.__jam;
    },
  };

  globalThis.__jam = view;
  return view;
}
