/**
 * CONTROLLER view (guest phone): no audio and no page zoom.
 * The page can scroll vertically. Harmony comes from the host.
 * The caption uses the same resolveGesture function the host plays.
 */

import { TouchPad, TouchPadRenderer } from '../ui/touch-pad.js';
import { INSTRUMENT_COLORS, INSTRUMENTS, LOOP_STEPS, NOTE_NAMES, SCALE_LABELS, SCALES, barCountLabel, defaultOctaves, instrumentHomeMidi, midiInScale, normalizeInstrument, pitchChoice, resolveGesture } from '../audio/synth.js';
import { FX_COLORS, INSTRUMENT_FX, clampFx, cycleFxAmount, defaultFxState, defaultLevels, fxAmountLabel, masterCutoffHz } from '../audio/effects.js';
import { JamSocket, EVENTS } from '../network/socket.js';
import { paintIconButton, setIconLabel } from '../ui/icons.js';
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
    bars: document.getElementById('controller-bars'),
    fxDetail: document.getElementById('controller-fx-detail'),
    fxSheet: document.getElementById('controller-fx-sheet'),
    fxSliders: document.getElementById('controller-fx-sliders'),
    fxSheetClose: document.getElementById('controller-fx-close'),
    master: document.getElementById('controller-master'),
    masterSheet: document.getElementById('controller-master-sheet'),
    masterSliders: document.getElementById('controller-master-sliders'),
    masterClose: document.getElementById('controller-master-close'),
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
    marks: [],
    noteSteps: LOOP_STEPS,
    bpm: 96,
    masterFx: { division: '16n', cutoff: 0, grit: 0, wah: 0, hold: false },
    canUndo: false,
    canUndoAll: false,
    canRedo: false,
    clearUndo: false,
    peerId: null,
  };
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

  function syncChrome() {
    const bassPicked = state.instrument === 'bass';
    const shownMode = bassPicked ? 'single' : state.mode;
    el.screen.querySelectorAll('[data-mode]').forEach((chip) => {
      chip.hidden = bassPicked && chip.dataset.mode === 'chords';
      chip.classList.toggle('is-on', chip.dataset.mode === shownMode);
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
    const chords = state.mode === 'chords' && !bass;
    el.zones.hidden = !chords;
    el.hint.textContent = bass
      ? 'One scale step. Hold and slide.'
      : chords
        ? 'X is the chord. Y is triad, sus, 7th, 9th.'
        : 'X is one note in the host key.';
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
    setControlEnabled(el.bars, true);
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
    setControlEnabled(el.bars, false);
  }

  function rollFocusMidi() {
    const instrument = normalizeInstrument(state.instrument);
    const octave = state.octaves[instrument] ?? (instrument === 'bass' ? 2 : 3);
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
      octave: state.octaves[instrument] ?? (instrument === 'bass' ? 2 : 3),
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
    const octaveValue = state.octaves[state.instrument] ?? (state.instrument === 'bass' ? 2 : 3);
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

  socket.on(EVENTS.pulse, ({ step, running }) => {
    if (!(step >= 0)) return;
    paintGuestBar(step);
    syncGuestPulse(Boolean(running), step);
    if (el.notesSheet.hidden || !(state.noteSteps > 0)) return;
    setRollPlayhead(el.noteTape, step % state.noteSteps);
  });
  const GUEST_DIVISIONS = new Set(['4n', '8n', '16n', '32n']);
  let guestMasterDrag = null;
  let guestStutterPointer = null;

  function guestMasterLabel(key) {
    if (key === 'cutoff') {
      const amount = state.masterFx.cutoff;
      if (amount < 0.02) return 'Cutoff · Off';
      return `Cutoff · ${Math.round(masterCutoffHz(amount))} Hz`;
    }
    if (key === 'grit') {
      return `8-bit grit · ${state.masterFx.grit < 0.02 ? 'Off' : `${Math.round(state.masterFx.grit * 100)}%`}`;
    }
    return `Wah frequency · ${state.masterFx.wah < 0.02 ? 'Off' : `${Math.round(160 * Math.pow(2400 / 160, state.masterFx.wah))} Hz`}`;
  }

  function paintGuestHold() {
    document.querySelectorAll('#controller-stutter [data-repeat]').forEach((button) => {
      const on = Boolean(state.masterFx.hold) && button.dataset.repeat === state.masterFx.division;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function syncGuestMasterSliders() {
    el.masterSliders?.querySelectorAll('[data-master]').forEach((input) => {
      const key = input.dataset.master;
      if (key === guestMasterDrag) return;
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
        guestMasterDrag = key;
      };
      const release = () => {
        if (guestMasterDrag === key) guestMasterDrag = null;
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
    add('cutoff');
    add('grit');
    add('wah');
    el.masterSliders.replaceChildren(...rows);
  }

  function endGuestStutter(event) {
    if (guestStutterPointer == null) return;
    if (event?.pointerId != null && event.pointerId !== guestStutterPointer) return;
    guestStutterPointer = null;
    state.masterFx.hold = false;
    paintGuestHold();
    socket.sendControl({ masterHold: { hold: false } });
  }

  document.querySelectorAll('#controller-stutter [data-repeat]').forEach((button) => {
    button.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (!GUEST_DIVISIONS.has(button.dataset.repeat)) return;
      event.preventDefault();
      if (guestStutterPointer != null) endGuestStutter();
      guestStutterPointer = event.pointerId;
      try {
        button.setPointerCapture(event.pointerId);
      } catch {
        // Capture can fail if the pointer already ended.
      }
      state.masterFx.division = button.dataset.repeat;
      state.masterFx.hold = true;
      paintGuestHold();
      socket.sendControl({ masterHold: { hold: true, division: button.dataset.repeat } });
    });
    button.addEventListener('pointerup', endGuestStutter);
    button.addEventListener('pointercancel', endGuestStutter);
    button.addEventListener('lostpointercapture', endGuestStutter);
    const quiet = (event) => event.preventDefault();
    button.addEventListener('contextmenu', quiet);
    button.addEventListener('selectstart', quiet);
  });
  window.addEventListener('pointerup', endGuestStutter);
  window.addEventListener('pointercancel', endGuestStutter);

  el.master?.addEventListener('click', () => {
    renderGuestMaster();
    paintGuestHold();
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
      if (GUEST_DIVISIONS.has(next.division)) state.masterFx.division = next.division;
      if (typeof next.hold === 'boolean') state.masterFx.hold = next.hold;
      for (const key of ['cutoff', 'grit', 'wah']) {
        if (!Number.isFinite(Number(next[key])) || guestMasterDrag === key) continue;
        state.masterFx[key] = clampFx(next[key]);
      }
      paintGuestHold();
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
    }
    if (Number.isFinite(Number(payload?.bpm))) {
      const next = Math.min(200, Math.max(40, Number(payload.bpm)));
      if (next !== state.bpm) {
        state.bpm = next;
        syncGuestPulse(el.pad.classList.contains('is-pulsing'), guestStep ?? 0, { retune: true });
      }
    }
    if (Number.isFinite(Number(payload?.loopBars))) {
      state.noteSteps = Number(payload.loopBars);
      setIconLabel(el.bars, barCountLabel(state.noteSteps));
      if (guestStep != null) paintGuestBar(guestStep);
    }
    if (payload?.loopNotes && typeof payload.loopNotes === 'object') {
      const pack = payload.loopNotes;
      if (Number.isFinite(Number(pack.noteSteps))) {
        state.noteSteps = Number(pack.noteSteps);
        setIconLabel(el.bars, barCountLabel(state.noteSteps));
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
      state.canRedo = Boolean(pack.canRedo);
      if (typeof mine?.clearUndo === 'boolean') {
        state.clearUndo = mine.clearUndo;
        paintGuestClear();
      }
      syncGuestHistory();
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
      if (!state.audioReady) return;
      socket.sendTouch(touchPayload(point));
      el.pad.classList.add('is-active');
      renderer.update(point.id, point);
      setLabel(caption(point));
    },
    onMove: (point) => {
      if (!state.audioReady) return;
      renderer.update(point.id, point);
      setLabel(caption(point));
      socket.sendTouch(touchPayload(point));
    },
    onEnd: (point) => {
      renderer.update(point.id, null);
      if (!pad.activePointers.size) {
        el.pad.classList.remove('is-active');
        setLabel('—');
      }
      if (!state.audioReady) return;
      socket.sendTouch(touchPayload(point));
    },
  });

  function onChipClick(event) {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    if (chip.dataset.fx) {
      cycleGuestFx(chip.dataset.fx);
      return;
    }
    if (chip.dataset.mode && !(state.instrument === 'bass' && chip.dataset.mode === 'chords')) state.mode = chip.dataset.mode;
    if (chip.dataset.instrument) {
      state.instrument = normalizeInstrument(chip.dataset.instrument);
      socket.sendControl({ instrument: state.instrument });
      renderGuestFx();
      if (!el.fxSheet.hidden) renderGuestSliders();
    }
    syncChrome();
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

  el.loop.addEventListener('click', () => {
    if (!state.audioReady) return;
    setRecording(!state.recording);
  });

  function paintGuestClear() {
    paintIconButton(el.loopClear, state.clearUndo ? 'undo' : 'erase', state.clearUndo ? 'undo' : 'clr all');
  }

  el.loopClear.addEventListener('click', () => {
    if (!state.audioReady) return;
    if (state.clearUndo) {
      socket.sendControl({ loop: 'undo-clear' });
      return;
    }
    state.marks = [];
    state.clearUndo = true;
    paintGuestClear();
    if (!el.notesSheet.hidden) paintGuestNotes();
    socket.sendControl({ loop: 'clear' });
  });

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
  el.noteClear.addEventListener('click', () => {
    if (!state.audioReady) return;
    socket.sendControl({ loop: 'clear', fromEditor: true, instrument: state.instrument });
  });
  el.bars.addEventListener('click', () => {
    if (!state.audioReady) return;
    socket.sendControl({ loopBars: 'cycle' });
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
  paintGuestClear();
  paintIconButton(el.notes, 'notes', 'Notes');
  paintIconButton(el.bars, 'bars', barCountLabel(state.noteSteps));
  paintIconButton(el.noteUndo, 'undo', 'Undo');
  paintIconButton(el.noteUndoAll, 'undo', 'Undo all');
  paintIconButton(el.noteRedo, 'redo', 'Redo');
  paintIconButton(el.noteClear, 'erase', 'clr curr inst');
  paintIconButton(el.notesClose, 'done', 'Done');
  paintIconButton(el.fxDetail, 'detail', 'More');
  paintIconButton(el.fxSheetClose, 'done', 'Done');
  renderGuestFx();
  markScrollEdges(document.querySelector('.controller-foot'), 'y');
  markPageEdges();

  return {
    get code() {
      return joined.code;
    },
    destroy() {
      pad.destroy();
      renderer.destroy();
      el.screen.removeEventListener('click', onChipClick);
      document.removeEventListener('gesturestart', preventGesture);
      socket.disconnect();
    },
  };
}
