/**
 * CONTROLLER view (guest phone): no audio and no page zoom.
 * The page can scroll vertically. Harmony comes from the host.
 * The caption uses the same resolveGesture function the host plays.
 */

import { TouchPad, TouchPadRenderer } from '../ui/touch-pad.js';
import { INSTRUMENT_COLORS, INSTRUMENT_IDS, INSTRUMENTS, LOOP_STEPS, NOTE_NAMES, SCALE_LABELS, SCALES, defaultOctaves, extensionFromY, instrumentHomeMidi, midiInScale, normalizeInstrument, padNoteMarks, pitchChoice, resolveGesture } from '../audio/synth.js';
import { FX_COLORS, FX_FULL_LABELS, FX_PAD_DIVISIONS, INSTRUMENT_FX, clampFx, cycleFxAmount, defaultFxState, defaultLevels, fxAmountLabel, masterCutoffHz, masterHipassHz, REPEAT_ORDER } from '../audio/effects.js';
import { DEFAULT_MASTER_GAIN } from '../audio/engine.js';
import { TRACKS, DRUM_PRESETS, STEPS as DRUM_STEPS, tileCells, repeatTargets, repeatSpanSteps } from '../audio/drums.js';
import { JamSocket, EVENTS } from '../network/socket.js';
import { chipIcon, paintIconButton, setIconLabel } from '../ui/icons.js';
import { createDrumGrid } from '../ui/drum-grid.js';
import { renderPianoRoll, scrollRollToMidi, setRollPlayhead, setRollSelectMode } from '../ui/piano-roll.js';
import { pressable, setControlEnabled } from '../ui/quiet-touch.js';
import { markPageEdges, markScrollEdges } from '../ui/scroll-edges.js';

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
    advanced: document.getElementById('controller-advanced'),
    advancedSheet: document.getElementById('controller-advanced-sheet'),
    advancedClose: document.getElementById('controller-advanced-close'),
    transport: document.getElementById('controller-transport'),
    instruments: document.getElementById('controller-instruments'),
    fx: document.getElementById('controller-fx'),
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
    fxDetail: document.getElementById('controller-fx-detail'),
    fxSheet: document.getElementById('controller-fx-sheet'),
    fxSliders: document.getElementById('controller-fx-sliders'),
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
    drumZoom: document.getElementById('controller-drum-zoom'),
    drumWriteRow: document.getElementById('controller-drum-write'),
    drumRepeatRow: document.getElementById('controller-drum-repeat'),
    drumAdvCheck: document.getElementById('controller-drum-adv-check'),
    drumAdvPanel: document.getElementById('controller-drum-adv'),
    drumLengthRow: document.getElementById('controller-drum-length'),
    drumPitch: document.getElementById('controller-drum-pitch'),
    drumPitchLabel: document.getElementById('controller-drum-pitch-label'),
    padMode: document.getElementById('controller-pad-mode'),
    playBar: document.getElementById('controller-play-bar'),
  };

  const state = {
    mode: 'single',
    root: 'C',
    scale: 'major',
    instrument: 'pad',
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
    canUndo: false,
    canUndoAll: false,
    canRedo: false,
    peerId: null,
    drumWrite: 'single',
    drums: { steps: DRUM_STEPS, preset: 'break', repeat: 1, grid: null, pitch: 0 },
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
    const shownMode = bassPicked ? 'single' : state.mode;
    // FX owns the pad: the note-mode row and its loop buttons step aside.
    // Bass never plays chords, so its mode chips hide too.
    el.playBar.hidden = fxMode;
    const modeRow = el.playBar?.querySelector('.play-bar__modes');
    if (modeRow) modeRow.hidden = bassPicked;
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
      const spec = INSTRUMENTS.find((item) => item.id === id);
      paintIconButton(chip, id, spec?.label || id);
    });
    const bass = state.instrument === 'bass';
    const chords = !fxMode && state.mode === 'chords' && !bass;
    el.zones.hidden = !chords;
    renderer.setMode(fxMode ? 'fx' : chords ? 'chords' : 'single');
    if (!chords) paintZone(null);
    syncPadMarks();
    el.hint.textContent = fxMode
      ? '— filters only. 1/4 → 1/32 holds stutter. Up cuts lows, down cuts highs.'
      : bass
        ? 'One scale step. Hold and slide.'
        : chords
          ? 'X is the chord. Y is triad, sus, 7th, 9th.'
          : 'X is one note in the host key.';
  }

  /** Recorded loop notes of the selected instrument show as dots on the pad. */
  function syncPadMarks() {
    if (state.padMode === 'fx') {
      renderer.setMarks([]);
      return;
    }
    renderer.setMarks(padNoteMarks(state.marks, state.instrument, { root: state.root, scale: state.scale, octaves: state.octaves }));
  }

  function renderGuestFx() {
    const specs = INSTRUMENT_FX[state.instrument] ?? [];
    const levels = state.effects[state.instrument] ?? {};
    el.fx.replaceChildren();
    for (const spec of specs) {
      const level = clampFx(levels[spec.id] ?? 0);
      const button = pressable(`chip fx-chip has-swatch${level >= 0.08 ? ' is-on' : ''}`);
      button.style.setProperty('--chip', FX_COLORS[spec.id] || '#e2b43a');
      button.dataset.fx = spec.id;
      paintIconButton(button, spec.id, spec.label, fxAmountLabel(level));
      el.fx.append(button);
    }
  }

  function cycleGuestFx(id) {
    const level = cycleFxAmount(state.effects[state.instrument]?.[id] ?? 0);
    if (!state.effects[state.instrument]) state.effects[state.instrument] = {};
    state.effects[state.instrument][id] = level;
    socket.sendControl({ effect: { instrument: state.instrument, id, level } });
    renderGuestFx();
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

  function paintGuestNotes() {
    renderPianoRoll(el.noteTape, {
      notes: state.marks,
      steps: state.noteSteps,
      stepPx: guestNoteStepPx(),
      pitchesFor,
      colorFor: (note) => INSTRUMENT_COLORS[normalizeInstrument(note.instrument)] || '#e0a12e',
      onDelete: (voiceId) => {
        socket.sendControl({ eraseNote: voiceId });
      },
      instrument: state.instrument,
      owner: state.peerId,
      selectMode: guestSelectMode,
      onMoveGroup: (changes) => {
        socket.sendControl({
          moveGroup: changes.map((change) => {
            const note = state.marks.find((item) => item.voiceId === change.voiceId);
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
      onAudition: ({ down, midi, pointerId }) => {
        socket.sendControl({ preview: { down, midi, pointerId, instrument: state.instrument } });
      },
      onPlace: ({ step, midi }) => {
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
            midi,
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
  });

  function paintGuestDrumPreset() {
    for (const row of [el.drumPresets, el.drumPresetsMain]) {
      row?.querySelectorAll('.chip').forEach((chip) => {
        chip.classList.toggle('is-picked', chip.dataset.preset === state.drums.preset);
      });
    }
    const preset = DRUM_PRESETS[state.drums.preset];
    if (el.drumsOpen) setIconLabel(el.drumsOpen, 'Edit drums', preset?.label);
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
    if (Number.isFinite(Number(d.steps))) state.drums.steps = Math.max(16, Math.round(Number(d.steps)));
    if (typeof d.preset === 'string' || d.preset === '') state.drums.preset = d.preset || '';
    if (d.repeat === 'off' || Number(d.repeat) > 0) {
      state.drums.repeat = d.repeat === 'off' ? 'off' : Math.min(2, Math.max(1, Number(d.repeat)));
    }
    if (Number.isFinite(Number(d.pitch))) {
      state.drums.pitch = Math.min(12, Math.max(-12, Math.round(Number(d.pitch))));
      syncGuestDrumPitch();
    }
    if (d.grid && typeof d.grid === 'object') {
      for (const { id } of TRACKS) {
        const row = Array.isArray(d.grid[id]) ? d.grid[id] : [];
        state.drums.grid[id] = row.map((slot) => ({ on: Boolean(slot?.on), division: slot?.division === 3 ? 3 : 1 }));
      }
    }
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
  el.drumZoom?.addEventListener('input', (event) => {
    drumZoom = Number(event.target.value) / 100;
    drumGrid.render();
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
    socket.sendControl({ drumPitch: state.drums.pitch });
  });

  function renderGuestSliders() {
    const rows = [];
    const level = clampFx(state.levels[state.instrument] ?? 1);
    const volumeRow = document.createElement('label');
    volumeRow.className = 'fx-slider';
    volumeRow.style.setProperty('--chip', INSTRUMENT_COLORS[state.instrument] || '#e2b43a');
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
      state.levels[state.instrument] = value;
      socket.sendControl({ level: { instrument: state.instrument, value } });
    });
    volumeRow.append(volumeName, volume);
    rows.push(volumeRow);
    const octaveValue = state.octaves[state.instrument] ?? defaultOctaves()[state.instrument];
    const octaveRow = document.createElement('label');
    octaveRow.className = 'fx-slider fx-slider--octave';
    octaveRow.style.setProperty('--chip', INSTRUMENT_COLORS[state.instrument] || '#e2b43a');
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
      state.octaves[state.instrument] = value;
      syncPadMarks();
      socket.sendControl({ octave: { instrument: state.instrument, value } });
    });
    octaveRow.append(octaveName, octave);
    rows.push(octaveRow);
    for (const spec of INSTRUMENT_FX[state.instrument] ?? []) {
      const amount = clampFx(state.effects[state.instrument]?.[spec.id] ?? 0);
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
      input.value = String(Math.round(amount * 100));
      input.addEventListener('input', () => {
        const value = Number(input.value) / 100;
        name.textContent = `${specName} · ${input.value}%`;
        if (!state.effects[state.instrument]) state.effects[state.instrument] = {};
        state.effects[state.instrument][spec.id] = value;
        socket.sendControl({ effect: { instrument: state.instrument, id: spec.id, level: value } });
        renderGuestFx();
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
        socket.sendControl({ masterFx: { [key]: value } });
      });
      row.append(name, input);
      rows.push(row);
    };
    add('grit');
    add('wah');
    add('volume');
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
      socket.sendControl({ masterHold: { hold: false }, masterFx: { cutoff: 0, hipass: 0 } });
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
    const control = { masterFx: { cutoff, hipass } };
    if (wantsHold !== wasHeld || divisionChanged) control.masterHold = { hold: wantsHold, division: division ?? '16n' };
    socket.sendControl(control);
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
    const mode = next === 'fx' ? 'fx' : 'notes';
    if (mode === state.padMode) return;
    pad.releaseHeld();
    fxFingers.clear();
    state.padMode = mode;
    syncChrome();
  }

  el.advanced?.addEventListener('click', () => {
    renderGuestFx();
    el.advancedSheet.hidden = false;
  });
  el.advancedClose?.addEventListener('click', () => {
    el.advancedSheet.hidden = true;
  });

  el.master?.addEventListener('click', () => {
    renderGuestMaster();
    el.masterSheet.hidden = false;
  });
  el.masterClose?.addEventListener('click', () => {
    el.masterSheet.hidden = true;
  });

  socket.on(EVENTS.hostState, (payload) => {
    const previousRoot = state.root;
    const previousScale = state.scale;
    if (payload?.root && NOTE_NAMES.includes(payload.root)) state.root = payload.root;
    if (payload?.scale && SCALES[payload.scale]) state.scale = payload.scale;
    if (payload?.masterFx && typeof payload.masterFx === 'object') {
      const next = payload.masterFx;
      const dragKey = guestMasterDrag?.dataset?.master;
      if (GUEST_DIVISIONS.has(next.division) && !fxFingers.size) state.masterFx.division = next.division;
      if (typeof next.hold === 'boolean' && !fxFingers.size) state.masterFx.hold = next.hold;
      for (const key of ['cutoff', 'hipass', 'grit', 'wah', 'volume']) {
        if (!Number.isFinite(Number(next[key])) || dragKey === key) continue;
        if ((key === 'cutoff' || key === 'hipass') && fxFingers.size) continue;
        state.masterFx[key] = clampFx(next[key]);
      }
      syncGuestMasterSliders();
    }
    if ((state.root !== previousRoot || state.scale !== previousScale) && !el.notesSheet.hidden) paintGuestNotes();
    if (payload?.effects && typeof payload.effects === 'object') {
      state.effects = payload.effects;
      renderGuestFx();
    }
    if (payload?.levels && typeof payload.levels === 'object') {
      state.levels = { ...state.levels, ...payload.levels };
    }
    if (payload?.octaves && typeof payload.octaves === 'object') {
      state.octaves = { ...state.octaves, ...payload.octaves };
      syncPadMarks();
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
      const marks = [];
      for (const [owner, entry] of Object.entries(players)) {
        for (const note of entry?.notes || []) marks.push({ ...note, owner });
      }
      state.marks = marks;
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
      }
      syncGuestHistory();
      syncPadMarks();
      if (!el.notesSheet.hidden) paintGuestNotes();
    }
    updateKey();
    if (payload?.audioError) {
      showHostError(payload.audioError);
      return;
    }
    if (payload?.audioReady) unlock();
  });

  const joined = await socket.joinSession(code, name);
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

  function touchPayload(point) {
    return {
      ...point,
      mode: state.mode,
      instrument: state.instrument,
    };
  }

  const pad = new TouchPad(el.pad, {
    locked: true,
    onStart: (point) => {
      if (state.padMode === 'fx') {
        fxPadDown(point);
        return;
      }
      if (!state.audioReady) return;
      socket.sendTouch(touchPayload(point));
      el.pad.classList.add('is-active');
      renderer.update(point.id, point);
      setLabel(caption(point));
      paintZone(point.y);
    },
    onMove: (point) => {
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
      if (!state.audioReady) return;
      socket.sendTouch(touchPayload(point));
    },
  });

  function onChipClick(event) {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    if (chip.dataset.padmode) {
      setPadMode(chip.dataset.padmode);
      return;
    }
    if (chip.dataset.fx) {
      cycleGuestFx(chip.dataset.fx);
      return;
    }
    if (chip.dataset.mode && !(state.instrument === 'bass' && chip.dataset.mode === 'chords')) state.mode = chip.dataset.mode;
    if (chip.dataset.instrument) pickGuestInstrument(chip.dataset.instrument);
    syncChrome();
  }

  /** Same instrument switch as the main chips, plus the open roll follows. */
  function pickGuestInstrument(instrument) {
    state.instrument = normalizeInstrument(instrument);
    socket.sendControl({ instrument: state.instrument });
    renderGuestFx();
    if (!el.fxSheet.hidden) renderGuestSliders();
    syncChrome();
    paintRollInstrument();
  }

  function paintRollInstrument() {
    const spec = INSTRUMENTS.find((item) => item.id === state.instrument);
    el.instName.style.setProperty('--chip', INSTRUMENT_COLORS[state.instrument] || '#e2b43a');
    paintIconButton(el.instName, state.instrument, spec?.label || state.instrument);
    if (!el.notesSheet.hidden) {
      paintGuestNotes();
      revealRoll();
    }
  }

  function cycleGuestInstrument(direction) {
    const index = INSTRUMENT_IDS.indexOf(state.instrument);
    pickGuestInstrument(INSTRUMENT_IDS[(index + direction + INSTRUMENT_IDS.length) % INSTRUMENT_IDS.length]);
  }

  el.screen.addEventListener('click', onChipClick);

  function setRecording(next) {
    state.recording = next;
    el.loop.classList.toggle('is-on', next);
    el.loop.setAttribute('aria-pressed', next ? 'true' : 'false');
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

  document.getElementById('controller-note-zoom')?.addEventListener('input', (event) => {
    noteZoom = Number(event.target.value) / 100;
    paintGuestNotes();
  });

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
  if (padNotesChip) paintIconButton(padNotesChip, 'notes', 'Notes');
  if (padFxChip) paintIconButton(padFxChip, 'scissors', 'FX');
  paintRollInstrument();
  el.noteClear.addEventListener('click', () => {
    if (!state.audioReady) return;
    socket.sendControl({ loop: 'clear', fromEditor: true, instrument: state.instrument });
  });
  el.fxDetail.addEventListener('click', () => {
    renderGuestSliders();
    el.fxSheet.hidden = false;
  });
  el.fxSheetClose.addEventListener('click', () => {
    el.fxSheet.hidden = true;
  });

  const preventGesture = (event) => event.preventDefault();
  document.addEventListener('gesturestart', preventGesture);

  updateKey();
  syncChrome();
  for (const chip of [...el.instruments.querySelectorAll('[data-instrument]')]) {
    if (!INSTRUMENTS.some((item) => item.id === chip.dataset.instrument)) chip.remove();
  }
  for (const instrument of INSTRUMENTS) {
    if (!el.instruments.querySelector(`[data-instrument="${instrument.id}"]`)) {
      const button = pressable('chip');
      button.dataset.instrument = instrument.id;
      paintIconButton(button, instrument.id, instrument.label);
      el.instruments.append(button);
    }
  }
  paintIconButton(el.loop, 'loop', 'Rec');
  el.loopUndo.replaceChildren(chipIcon('undo'));
  el.loopRedo.replaceChildren(chipIcon('redo'));
  paintIconButton(el.advanced, 'detail', 'Advanced');
  paintGuestTransport();
  paintGuestClear();
  paintGuestDrumLength();
  syncGuestDrumPitch();
  paintIconButton(el.notes, 'notes', 'Notes');
  paintIconButton(el.drumsOpen, 'edit', 'Edit drums');
  paintIconButton(el.noteUndo, 'undo', 'Undo');
  paintIconButton(el.noteUndoAll, 'undo', 'Undo all');
  paintIconButton(el.noteRedo, 'redo', 'Redo');
  paintIconButton(el.noteClear, 'erase', 'clear inst');
  paintIconButton(el.notesClose, 'done', 'Done');
  paintIconButton(el.fxDetail, 'detail', 'More');
  paintIconButton(el.fxSheetClose, 'done', 'Done');
  renderGuestFx();
  renderGuestDrumPresets();
  paintGuestDrumEditRows();
  paintGuestBpm();
  markScrollEdges(document.querySelector('.controller-foot'), 'y');
  markPageEdges();

  return {
    get code() {
      return joined.code;
    },
    destroy() {
      pad.destroy();
      drumGrid.destroy();
      renderer.destroy();
      el.screen.removeEventListener('click', onChipClick);
      document.removeEventListener('gesturestart', preventGesture);
      socket.disconnect();
    },
  };
}
