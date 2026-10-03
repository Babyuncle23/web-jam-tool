import {
  SAMPLE_BANK,
  SAMPLER_PAD_CELLS,
  SOLO_ACTION,
  SAMPLE_PITCH_RANGE,
  SAMPLE_VOLUME_MAX,
  clampSamplePitch,
  clampSampleStretch,
  clampSampleVolume,
  sampleBpm,
  sampleLabel,
  sampleMode,
} from '../audio/sampler.js';
import { pressable, setControlEnabled } from './quiet-touch.js';
import { chipIcon } from './icons.js';

/**
 * The pad that replaces the touchpad in sampler mode — host and guest build
 * the same grid; guests only emit callbacks, the host turns them into sound.
 *
 * Play mode: a press fires onHit and lights the pad while held; several
 * fingers can hold different pads at once (sample + SOLO together included).
 * Edit mode (editMode() truthy): tapping a pad selects its sample for the
 * editor panel and auditions it through onSelect (gate pads sound only
 * while held, like live play). The panel offers pitch, stretch and volume
 * sliders plus a carousel (◀ name ▶) that picks the edited sample without
 * touching the grid. The corner ✕ on a pad still calls onErase.
 *
 * Placement follows the layout: in portrait the panel is a plain block
 * right below the pad — it scrolls with the page and can never cover a
 * cell; on landscape/desktop it rides the top of the tools column (sticky),
 * always in reach without hiding pads. The panel must live OUTSIDE the pad
 * element: .pad clips children and quiet-touch never synthesizes clicks
 * inside it, so it mounts next to the pad's stage instead.
 */

const FLASH_MS = 150;
/** Stretch slider is logarithmic: position 50 = ×1, 0 = ×0.5, 100 = ×2. */
const STRETCH_POS_MID = 50;

function stretchToPos(stretch) {
  return Math.round(STRETCH_POS_MID + STRETCH_POS_MID * Math.log2(clampSampleStretch(stretch)));
}

function posToStretch(pos) {
  return clampSampleStretch(Math.pow(2, (pos - STRETCH_POS_MID) / STRETCH_POS_MID));
}

function formatBadge(params, tempoLocked) {
  const pitch = params?.pitch || 0;
  const stretch = params?.stretch ?? 1;
  const volume = params?.volume ?? 1;
  const parts = [];
  if (pitch) parts.push(`${pitch > 0 ? '+' : ''}${pitch}`);
  // A tempo-locked pad's stretch is the bpm fit, not a user setting —
  // showing ×0.75 on BEAT reads like someone retuned it.
  if (!tempoLocked && stretch !== 1) parts.push(`×${stretch.toFixed(2)}`);
  if (volume !== 1) parts.push(`${Math.round(volume * 100)}%`);
  return parts.join(' ');
}

export function createSampleGrid(
  container,
  { editMode, onHit, onRelease, onSolo, onTune, onErase, onSelect, onDone, hasHits, params, panelHost } = {},
) {
  container.classList.add('sampler');
  const grid = document.createElement('div');
  grid.className = 'sampler-grid';
  // Legal strip over the grid's reserved headroom — the meme sources are
  // not cleared for commercial use (see README § «Семплер: откуда сэмплы»).
  const notice = document.createElement('p');
  notice.className = 'sampler-note';
  notice.textContent = 'meme sounds · non-commercial use only';
  container.append(grid, notice);

  const pads = [];
  const flashTimers = new Map();
  /** Gate pads currently sounding (live or loop playback) — lit the whole way. */
  const playing = new Set();
  const playTimers = new Map();
  /** pointerId → { kind:'solo'|'hit', pad } */
  const held = new Map();
  let soloRemote = false;

  /** truthy = the edit layer, driven by the view. */
  const editing = () => (typeof editMode === 'function' ? editMode() : editMode) || '';
  const paramsOf = (id) =>
    (typeof params === 'function' ? params(id) : params?.[id]) || { pitch: 0, stretch: 1, volume: 1 };
  /** A pad only wears its ✕ when the loops hold hits of that sample. */
  const hitsOf = (id) => (typeof hasHits === 'function' ? hasHits(id) : true);

  function refreshErase() {
    for (const pad of pads) {
      if (pad.dataset.sample) pad.classList.toggle('has-hits', hitsOf(pad.dataset.sample));
    }
  }

  function updateBadge(id) {
    const pad = pads.find((item) => item.dataset.sample === id);
    const tempoLocked = Boolean(SAMPLE_BANK.find((spec) => spec.id === id)?.bpm);
    if (pad) pad.querySelector('.sampler-pad__badge').textContent = formatBadge(paramsOf(id), tempoLocked);
  }

  /* ---------- Editor panel (overlay beside/below the pad) ---------- */

  /** Sample ids in grid order — the carousel walks this list. */
  const ORDER = SAMPLER_PAD_CELLS.filter((cell) => cell.sample).map((cell) => cell.sample);
  /** The sample the panel edits — a pad tap or the carousel moves it. */
  let selectedId = null;
  /** Slider under a finger — echo repaints must not yank it mid-drag. */
  let activeSlider = null;
  /** A move happened since the last commit — release sends the 'set'. */
  let pendingEnd = false;

  const editor = document.createElement('div');
  editor.className = 'sampler-editor';
  editor.hidden = true;

  const carousel = document.createElement('div');
  carousel.className = 'sampler-editor__carousel';
  const prevBtn = pressable('btn btn--ghost sampler-editor__arrow');
  prevBtn.setAttribute('aria-label', 'Previous sample');
  prevBtn.append(chipIcon('prev'));
  // The name doubles as the audition button — tap it to hear the pick.
  const nameBtn = pressable('sampler-editor__name');
  nameBtn.title = 'Tap to hear the sample';
  const nextBtn = pressable('btn btn--ghost sampler-editor__arrow');
  nextBtn.setAttribute('aria-label', 'Next sample');
  nextBtn.append(chipIcon('next'));
  carousel.append(prevBtn, nameBtn, nextBtn);

  function makeSlider(ariaLabel) {
    const row = document.createElement('label');
    row.className = 'fx-slider sampler-editor__slider';
    const name = document.createElement('span');
    const input = document.createElement('input');
    input.type = 'range';
    input.step = '1';
    input.setAttribute('aria-label', ariaLabel);
    row.append(name, input);
    return { row, name, input };
  }

  const pitchSlider = makeSlider('Pitch');
  pitchSlider.input.min = String(-SAMPLE_PITCH_RANGE);
  pitchSlider.input.max = String(SAMPLE_PITCH_RANGE);
  const stretchSlider = makeSlider('Stretch');
  stretchSlider.input.min = '0';
  stretchSlider.input.max = '100';
  const volumeSlider = makeSlider('Volume');
  volumeSlider.input.min = '0';
  volumeSlider.input.max = String(SAMPLE_VOLUME_MAX * 100);
  const sliders = [pitchSlider, stretchSlider, volumeSlider];

  const resetBtn = pressable('btn btn--ghost sampler-editor__reset');
  resetBtn.textContent = 'Reset';
  resetBtn.setAttribute('aria-label', 'Reset pitch, stretch and volume');
  // Done leaves edit mode — the moves were already committed live.
  const doneBtn = pressable('btn btn--primary sampler-editor__done has-icon');
  const doneLabel = document.createElement('span');
  doneLabel.className = 'chip-label';
  doneLabel.textContent = 'Done';
  doneBtn.append(chipIcon('done'), doneLabel);
  const actions = document.createElement('div');
  actions.className = 'sampler-editor__actions';
  actions.append(resetBtn, doneBtn);

  editor.append(carousel, pitchSlider.row, stretchSlider.row, volumeSlider.row, actions);

  /**
   * Mount the editor for the current layout — portrait docks it in the page
   * flow right below the pad (nothing covers the cells, the page scrolls
   * normally), landscape/desktop parks it inside the tools column where CSS
   * sticks it to the column's top. Re-runs on orientation/breakpoint flips.
   */
  const padBoxEl = container.closest('.pad');
  const flowAnchor = padBoxEl?.closest('.pad-stage, .pad-wrap') || null;
  const toolsColumn =
    (panelHost || document).querySelector?.('.host-tools, .controller-foot') || null;
  const railQuery =
    typeof matchMedia === 'function'
      ? matchMedia(
          '(min-width: 1024px) and (min-height: 640px), (orientation: landscape) and (max-height: 560px) and (pointer: coarse)',
        )
      : null;
  function mountEditor() {
    if (railQuery?.matches && toolsColumn) toolsColumn.prepend(editor);
    else if (flowAnchor) flowAnchor.after(editor);
    else (panelHost || document.body).append(editor);
  }
  railQuery?.addEventListener?.('change', mountEditor);
  mountEditor();

  function paintEditor() {
    if (!selectedId) return;
    const current = paramsOf(selectedId);
    const bpm = sampleBpm(selectedId);
    nameBtn.textContent = sampleLabel(selectedId);
    pitchSlider.name.textContent = `Pitch · ${current.pitch > 0 ? '+' : ''}${current.pitch || 0} st`;
    if (activeSlider !== pitchSlider.input) {
      pitchSlider.input.value = String(clampSamplePitch(current.pitch));
    }
    stretchSlider.name.textContent = bpm
      ? `Stretch · locked to ${bpm} BPM`
      : `Stretch · ×${(current.stretch ?? 1).toFixed(2)}`;
    setControlEnabled(stretchSlider.input, !bpm);
    if (activeSlider !== stretchSlider.input) {
      stretchSlider.input.value = String(stretchToPos(current.stretch ?? 1));
    }
    const percent = Math.round(clampSampleVolume(current.volume ?? 1) * 100);
    volumeSlider.name.textContent = `Volume · ${percent}%`;
    if (activeSlider !== volumeSlider.input) volumeSlider.input.value = String(percent);
  }

  function flashPad(id) {
    const pad = pads.find((item) => item.dataset.sample === id);
    if (!pad) return;
    pad.classList.add('is-hit');
    clearTimeout(flashTimers.get(pad));
    flashTimers.set(
      pad,
      setTimeout(() => {
        pad.classList.remove('is-hit');
        flashTimers.delete(pad);
      }, FLASH_MS),
    );
  }

  function selectSample(id, { audition = false } = {}) {
    selectedId = id;
    for (const pad of pads) pad.classList.toggle('is-editing', Boolean(id) && pad.dataset.sample === id);
    paintEditor();
    // The pick flashes even without local audio — a guest's audition sounds
    // on the host, so the pad itself is the feedback.
    if (audition && id) {
      flashPad(id);
      onSelect?.(id);
    }
  }

  function writeParam(key, value) {
    if (!selectedId) return;
    onTune?.(selectedId, { ...paramsOf(selectedId), [key]: value }, 'move');
    pendingEnd = true;
    updateBadge(selectedId);
  }

  /** Finger lift / keyboard commit — silent ('set'), the slider never
     triggers a playback; audition stays on the pad tap / name button. */
  function commitParams() {
    if (!pendingEnd || !selectedId) return;
    pendingEnd = false;
    activeSlider = null;
    onTune?.(selectedId, { ...paramsOf(selectedId) }, 'set');
    updateBadge(selectedId);
  }

  pitchSlider.input.addEventListener('input', () => {
    if (pitchSlider.input.disabled) return;
    writeParam('pitch', clampSamplePitch(Number(pitchSlider.input.value)));
    paintEditor();
  });
  stretchSlider.input.addEventListener('input', () => {
    if (stretchSlider.input.disabled) return;
    writeParam('stretch', posToStretch(Number(stretchSlider.input.value)));
    paintEditor();
  });
  volumeSlider.input.addEventListener('input', () => {
    if (volumeSlider.input.disabled) return;
    writeParam('volume', clampSampleVolume(Number(volumeSlider.input.value) / 100));
    paintEditor();
  });
  for (const slider of sliders) {
    const input = slider.input;
    input.addEventListener('pointerdown', () => {
      activeSlider = input;
    });
    input.addEventListener(
      'touchstart',
      () => {
        activeSlider = input;
      },
      { passive: true },
    );
    for (const type of ['pointerup', 'pointercancel', 'touchend', 'touchcancel', 'change']) {
      input.addEventListener(type, commitParams);
    }
  }
  const clearActiveSlider = () => {
    activeSlider = null;
  };
  window.addEventListener('pointerup', clearActiveSlider);
  window.addEventListener('pointercancel', clearActiveSlider);
  window.addEventListener('touchend', clearActiveSlider);
  window.addEventListener('touchcancel', clearActiveSlider);

  prevBtn.addEventListener('click', () => {
    const index = Math.max(0, ORDER.indexOf(selectedId));
    selectSample(ORDER[(index - 1 + ORDER.length) % ORDER.length]);
  });
  nextBtn.addEventListener('click', () => {
    const index = Math.max(0, ORDER.indexOf(selectedId));
    selectSample(ORDER[(index + 1) % ORDER.length]);
  });
  /**
   * The carousel name auditions the pick. Gate pads play while the button is
   * held (pointer down→up); a click-activated audition (keyboard, the
   * quiet-touch synthesized tap) still plays — that lift releases the voice
   * through onRelease, so a tap is a blip and a hold plays until let go.
   */
  let nameGatePointer = null;
  let nameGateEndedAt = -Infinity;
  nameBtn.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || nameGatePointer !== null) return;
    if (!selectedId || sampleMode(selectedId) !== 'gate') return;
    nameGatePointer = event.pointerId;
    try {
      nameBtn.setPointerCapture(event.pointerId);
    } catch {
      // The window listeners below still close the voice.
    }
    onSelect?.(selectedId);
  });
  const endNameGate = (event) => {
    if (nameGatePointer === null || event.pointerId !== nameGatePointer) return;
    nameGatePointer = null;
    nameGateEndedAt = performance.now();
    onRelease?.(selectedId);
  };
  window.addEventListener('pointerup', endNameGate);
  window.addEventListener('pointercancel', endNameGate);
  nameBtn.addEventListener('click', () => {
    if (!selectedId) return;
    if (sampleMode(selectedId) !== 'gate') {
      onSelect?.(selectedId);
      return;
    }
    // A pointer tap already held the gate above — its trailing click must not
    // re-fire. A keyboard/screen-reader click has no hold: give it a bounded
    // preview instead of the whole buffer.
    if (performance.now() - nameGateEndedAt < 400) return;
    onSelect?.(selectedId);
    const previewing = selectedId;
    setTimeout(() => {
      if (selectedId === previewing) onRelease?.(previewing);
    }, 1200);
  });
  resetBtn.addEventListener('click', () => {
    if (!selectedId) return;
    // Locked pads keep their bpm-fitted stretch — "neutral" for them is the
    // synced value the host already reports. 'set' = silent commit.
    const current = paramsOf(selectedId);
    onTune?.(selectedId, { pitch: 0, stretch: current.stretch, volume: 1 }, 'set');
    pendingEnd = false;
    updateBadge(selectedId);
    paintEditor();
  });
  doneBtn.addEventListener('click', () => {
    // A slider still in flight commits quietly before the panel closes.
    commitParams();
    onDone?.();
  });

  /* ---------- Pad grid ---------- */

  function litState(pad) {
    let on = false;
    for (const entry of held.values()) if (entry.pad === pad) on = true;
    if (pad.dataset.action === SOLO_ACTION && soloRemote) on = true;
    // A gate pad glows for as long as it actually sounds, not just held.
    if (pad.dataset.sample && playing.has(pad.dataset.sample)) on = true;
    pad.classList.toggle('is-lit', on);
  }

  const endPointer = (event) => {
    const entry = held.get(event.pointerId);
    if (!entry) return;
    held.delete(event.pointerId);
    if (entry.kind === 'solo') {
      const still = [...held.values()].some((item) => item.kind === 'solo' && item.pad === entry.pad);
      if (!still) onSolo?.(false);
    } else if (entry.kind === 'hit') {
      // Gate pads sound only while a finger is down — release once the last
      // finger on that pad lifts. One-shots just ring out.
      const id = entry.pad?.dataset.sample;
      const still = [...held.values()].some((item) => item.kind === 'hit' && item.pad === entry.pad);
      if (!still && id && sampleMode(id) === 'gate') onRelease?.(id);
    }
    litState(entry.pad);
  };

  const upPointer = endPointer;
  window.addEventListener('pointerup', upPointer);
  window.addEventListener('pointercancel', upPointer);

  /**
   * Losing the window mid-gesture (alt-tab, an OS edge swipe stealing the
   * touch) must not leave a stuck entry — a stale 'hit' would keep the pad
   * lit forever. Drop everything, like a pointerup.
   */
  const dropAll = () => {
    const gates = new Set();
    for (const [pointerId, entry] of [...held.entries()]) {
      held.delete(pointerId);
      if (entry.kind === 'solo') onSolo?.(false);
      else if (entry.kind === 'hit' && entry.pad?.dataset.sample) gates.add(entry.pad.dataset.sample);
      litState(entry.pad);
    }
    for (const id of gates) {
      if (sampleMode(id) === 'gate') onRelease?.(id);
    }
  };
  window.addEventListener('blur', dropAll);

  SAMPLER_PAD_CELLS.forEach((cell, index) => {
    const pad = pressable('sampler-pad');
    pad.dataset.cell = String(index);
    if (cell.sample) {
      pad.dataset.sample = cell.sample;
      pad.classList.add('sampler-pad--sample');
      const label = document.createElement('span');
      label.className = 'sampler-pad__label';
      label.textContent = sampleLabel(cell.sample);
      const badge = document.createElement('span');
      badge.className = 'sampler-pad__badge';
      // Edit mode's erase handle. A ✕ press that lands while a finger is on
      // the grid is ignored — it was aiming at the pad, not the corner.
      const cross = document.createElement('span');
      cross.className = 'sampler-pad__x';
      cross.textContent = '✕';
      cross.setAttribute('aria-hidden', 'true');
      cross.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!editing() || !hitsOf(cell.sample)) return;
        if (held.size) return;
        pad.classList.add('is-erase');
        setTimeout(() => pad.classList.remove('is-erase'), 220);
        onErase?.(cell.sample);
      });
      cross.addEventListener('click', (event) => event.stopPropagation());
      pad.append(label, badge, cross);
      // Gate pads sound only while held — a bottom pill spells out the gesture.
      if (sampleMode(cell.sample) === 'gate') {
        const hold = document.createElement('span');
        hold.className = 'sampler-pad__hold';
        hold.textContent = 'HOLD';
        hold.setAttribute('aria-hidden', 'true');
        pad.append(hold);
      }
    } else if (cell.action === SOLO_ACTION) {
      pad.dataset.action = SOLO_ACTION;
      pad.classList.add('sampler-pad--solo');
      const label = document.createElement('span');
      label.className = 'sampler-pad__label';
      label.textContent = cell.label || 'SOLO';
      pad.append(label);
    } else {
      pad.classList.add('sampler-pad--empty');
      pad.setAttribute('aria-hidden', 'true');
      pad.tabIndex = -1;
    }

    pad.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const sampleId = pad.dataset.sample;
      if (pad.dataset.action === SOLO_ACTION) {
        held.set(event.pointerId, { kind: 'solo', pad });
        try {
          pad.setPointerCapture(event.pointerId);
        } catch {
          // Window listeners still release the gate.
        }
        onSolo?.(true);
        litState(pad);
        return;
      }
      if (!sampleId) {
        pad.classList.add('is-bump');
        setTimeout(() => pad.classList.remove('is-bump'), 160);
        return;
      }
      if (editing()) {
        // A tap picks the sample for the panel and auditions it. Gate pads
        // keep their hold-to-play feel while previewing — the finger lift
        // cuts the voice instead of letting the whole buffer ring out.
        if (sampleMode(sampleId) === 'gate') {
          held.set(event.pointerId, { kind: 'hit', pad });
          try {
            pad.setPointerCapture(event.pointerId);
          } catch {
            // Window listeners still release the gate.
          }
        }
        selectSample(sampleId, { audition: true });
        litState(pad);
        return;
      }
      held.set(event.pointerId, { kind: 'hit', pad });
      try {
        pad.setPointerCapture(event.pointerId);
      } catch {
        // Window listeners still end the press.
      }
      litState(pad);
      onHit?.(sampleId);
    });

    // Keyboard activation lands here (detail 0); pointer presses are already
    // handled on pointerdown, so a real click would double-fire.
    pad.addEventListener('click', (event) => {
      if (event.detail !== 0) return;
      if (pad.dataset.action === SOLO_ACTION || !pad.dataset.sample) return;
      if (editing()) selectSample(pad.dataset.sample, { audition: true });
      else onHit?.(pad.dataset.sample);
    });

    pads.push(pad);
    grid.append(pad);
  });

  // Pointers that land between cells must not fall through to the touchpad.
  grid.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  return {
    /** Brief trigger flash — loop playback, remote hits, auditions. */
    flash: flashPad,
    /** Someone else is holding SOLO — glow without owning the gesture. */
    setSoloRemote(on) {
      soloRemote = Boolean(on);
      const pad = pads.find((item) => item.dataset.action === SOLO_ACTION);
      if (pad) litState(pad);
    },
    /** A gate pad's voice started/ended — keep it lit while it sounds. */
    setPlaying(id, on) {
      const pad = pads.find((item) => item.dataset.sample === id);
      if (!pad) return;
      clearTimeout(playTimers.get(pad));
      playTimers.delete(pad);
      if (on) playing.add(id);
      else playing.delete(id);
      litState(pad);
    },
    /**
     * Timed variant for views that only see the schedule, not the audio —
     * a guest lights its gate pad for the note's real (fractional) length.
     */
    flashFor(id, ms) {
      const pad = pads.find((item) => item.dataset.sample === id);
      if (!pad) return;
      playing.add(id);
      litState(pad);
      clearTimeout(playTimers.get(pad));
      playTimers.set(
        pad,
        setTimeout(() => {
          playing.delete(id);
          playTimers.delete(pad);
          litState(pad);
        }, Math.max(80, ms)),
      );
    },
    updateParam(id) {
      updateBadge(id);
      if (id === selectedId) paintEditor();
    },
    updateAllParams() {
      for (const spec of SAMPLE_BANK) this.updateParam(spec.id);
    },
    setEditMode(mode) {
      const on = Boolean(mode);
      container.classList.toggle('is-editing', on);
      editor.hidden = !on;
      if (on) {
        refreshErase();
        if (!selectedId) selectSample(ORDER[0]);
        else {
          for (const pad of pads) {
            pad.classList.toggle('is-editing', pad.dataset.sample === selectedId);
          }
          paintEditor();
        }
      } else {
        for (const pad of pads) pad.classList.remove('is-editing');
      }
    },
    /** Re-check which pads carry recorded hits — the ✕ follows. */
    refreshErase,
    /** Mode switches and locks drop every held pad like a real pointerup. */
    releaseAll() {
      dropAll();
    },
    destroy() {
      window.removeEventListener('pointerup', upPointer);
      window.removeEventListener('pointercancel', upPointer);
      window.removeEventListener('blur', dropAll);
      window.removeEventListener('pointerup', clearActiveSlider);
      window.removeEventListener('pointercancel', clearActiveSlider);
      window.removeEventListener('touchend', clearActiveSlider);
      window.removeEventListener('touchcancel', clearActiveSlider);
      railQuery?.removeEventListener?.('change', mountEditor);
      window.removeEventListener('pointerup', endNameGate);
      window.removeEventListener('pointercancel', endNameGate);
      for (const timer of flashTimers.values()) clearTimeout(timer);
      for (const timer of playTimers.values()) clearTimeout(timer);
      if (padBoxEl) {
        padBoxEl.style.removeProperty('max-height');
        padBoxEl.style.removeProperty('min-height');
      }
      editor.remove();
      container.replaceChildren();
      container.classList.remove('sampler', 'is-editing');
    },
  };
}
