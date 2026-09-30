import {
  SAMPLE_BANK,
  SAMPLER_PAD_CELLS,
  SOLO_ACTION,
  clampSamplePitch,
  clampSampleStretch,
  sampleBpm,
  sampleLabel,
  sampleMode,
} from '../audio/sampler.js';
import { pressable } from './quiet-touch.js';

/**
 * The pad that replaces the touchpad in sampler mode — host and guest build
 * the same grid; guests only emit callbacks, the host turns them into sound.
 *
 * Play mode: a press fires onHit and lights the pad while held; several
 * fingers can hold different pads at once (sample + SOLO together included).
 * Edit mode (editMode() truthy) merges tuning and erasing: tapping a pad
 * arms it — the crosshair HUD stays on it — and any drag, on the pad or on
 * empty grid space, retunes it: vertical moves pitch in semitones,
 * horizontal stretches time without pitch. A double-tap resets the pad, a
 * mouse wheel steps pitch (shift → stretch), and the corner ✕ calls
 * onErase — it ignores presses that land while a tune gesture is held, so
 * an edit drag can never wipe hits by accident.
 */

const PITCH_PX_PER_STEP = 28;
const STRETCH_PX_PER_OCTAVE = 240;
const FLASH_MS = 150;
const TAP_DRAG_PX = 5;
const DOUBLE_TAP_MS = 320;
const WHEEL_STRETCH_STEP = 1 / 12;

function formatBadge(params) {
  const pitch = params?.pitch || 0;
  const stretch = params?.stretch ?? 1;
  const flat = pitch === 0 && stretch === 1;
  return flat ? '' : `${pitch > 0 ? '+' : ''}${pitch} · ×${stretch.toFixed(2)}`;
}

export function createSampleGrid(container, { editMode, onHit, onRelease, onSolo, onTune, onErase, hasHits, params } = {}) {
  container.classList.add('sampler');
  const grid = document.createElement('div');
  grid.className = 'sampler-grid';
  const hud = document.createElement('div');
  hud.className = 'sampler-hud';
  hud.hidden = true;
  hud.innerHTML =
    '<div class="sampler-hud__axis-x"><span>← squeeze · stretch →</span></div>' +
    '<div class="sampler-hud__axis-y"><span>pitch</span></div>' +
    '<div class="sampler-hud__dot" hidden></div>' +
    '<p class="sampler-hud__label">—</p>' +
    '<p class="sampler-hud__value">—</p>';
  container.append(grid, hud);

  const pads = [];
  const flashTimers = new Map();
  /** Gate pads currently sounding (live or loop playback) — lit the whole way. */
  const playing = new Set();
  const playTimers = new Map();
  /** pointerId → { kind:'solo'|'hit'|'tune', pad, … } */
  const held = new Map();
  let soloRemote = false;

  /** truthy = the merged tune/erase edit layer, driven by the view. */
  const editing = () => (typeof editMode === 'function' ? editMode() : editMode) || '';
  const paramsOf = (id) => (typeof params === 'function' ? params(id) : params?.[id]) || { pitch: 0, stretch: 1 };
  /** A pad only wears its ✕ when the loops hold hits of that sample. */
  const hitsOf = (id) => (typeof hasHits === 'function' ? hasHits(id) : true);

  function refreshErase() {
    for (const pad of pads) {
      if (pad.dataset.sample) pad.classList.toggle('has-hits', hitsOf(pad.dataset.sample));
    }
  }

  /** Tune mode keeps one pad armed: background drags still steer it. */
  let armedPad = null;
  let armedId = null;
  let lastTap = { pad: null, at: 0 };

  function armPad(pad) {
    if (armedPad && armedPad !== pad) armedPad.classList.remove('is-editing');
    armedPad = pad;
    armedId = pad?.dataset.sample || null;
    if (armedPad) {
      armedPad.classList.add('is-editing');
      showHud(armedPad, armedId);
      paintHud(armedId, paramsOf(armedId), null);
    } else {
      hideHud();
    }
  }

  function startTune(event, pad, sampleId, fromPad = true) {
    held.set(event.pointerId, {
      kind: 'tune',
      pad,
      sample: sampleId,
      startX: event.clientX,
      startY: event.clientY,
      // Snapshot — paramsOf hands back the view's live object, which the
      // onTune callbacks mutate in place. Aliasing it would compound every
      // move delta into runaway drift.
      start: { ...paramsOf(sampleId) },
      current: { ...paramsOf(sampleId) },
      moved: false,
      fromPad,
    });
    try {
      pad.setPointerCapture(event.pointerId);
    } catch {
      // An already-ended pointer can still tune on window listeners.
    }
    onTune?.(sampleId, paramsOf(sampleId), 'start');
    // The dot lands on the press point — that spot IS the zero anchor for
    // this drag, so showing it keeps the neutral position readable.
    const rect = container.getBoundingClientRect();
    paintHud(sampleId, held.get(event.pointerId).current, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  }

  function litState(pad) {
    let on = false;
    for (const entry of held.values()) if (entry.pad === pad) on = true;
    if (pad.dataset.action === SOLO_ACTION && soloRemote) on = true;
    // A gate pad glows for as long as it actually sounds, not just held.
    if (pad.dataset.sample && playing.has(pad.dataset.sample)) on = true;
    pad.classList.toggle('is-lit', on);
  }

  function padCenter(pad) {
    return { x: pad.offsetLeft + pad.offsetWidth / 2, y: pad.offsetTop + pad.offsetHeight / 2 };
  }

  function showHud(pad, id) {
    const at = padCenter(pad);
    hud.style.setProperty('--hx', `${at.x}px`);
    hud.style.setProperty('--hy', `${at.y}px`);
    hud.querySelector('.sampler-hud__label').textContent = sampleLabel(id);
    hud.hidden = false;
    container.classList.add('is-tuning');
  }

  function paintHud(id, next, dot) {
    const value = hud.querySelector('.sampler-hud__value');
    const pitch = next.pitch || 0;
    // Locked pads show the tempo-fit, not a gesture-editable stretch.
    const locked = Boolean(sampleBpm(id));
    hud.classList.toggle('is-locked', locked);
    const time = locked ? 'bpm' : next.stretch < 1 ? 'squeeze' : 'stretch';
    value.textContent = `pitch ${pitch > 0 ? '+' : ''}${pitch} st · ${time} ×${next.stretch.toFixed(2)}`;
    const marker = hud.querySelector('.sampler-hud__dot');
    if (dot) {
      marker.hidden = false;
      marker.style.transform = `translate(${dot.x}px, ${dot.y}px)`;
    } else {
      marker.hidden = true;
    }
  }

  function hideHud() {
    hud.hidden = true;
    container.classList.remove('is-tuning');
  }

  const endPointer = (event, cancelled = false) => {
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
    } else if (entry.kind === 'tune' && !cancelled) {
      if (!entry.moved) {
        const now = performance.now();
        if (entry.fromPad && lastTap.pad === entry.pad && now - lastTap.at < DOUBLE_TAP_MS) {
          // Double-tap resets the pad's tuning without an extra audition.
          onTune?.(entry.sample, { pitch: 0, stretch: 1 }, 'set');
          paintHud(entry.sample, { pitch: 0, stretch: 1 }, null);
          lastTap = { pad: null, at: 0 };
        } else {
          lastTap = { pad: entry.fromPad ? entry.pad : null, at: now };
          // A tap on empty grid space disarms — the pad's own taps keep it.
          if (!entry.fromPad) armPad(null);
        }
      }
      onTune?.(entry.sample, entry.current, 'end');
      // The gesture is over — park the dot instead of leaving it frozen at
      // the release point, which read as a drifting "zero".
      paintHud(entry.sample, entry.current, null);
    }
    if (!armedPad && ![...held.values()].some((item) => item.kind === 'tune')) hideHud();
    litState(entry.pad);
  };

  const movePointer = (event) => {
    const entry = held.get(event.pointerId);
    if (!entry || entry.kind !== 'tune') return;
    event.preventDefault();
    const dy = entry.startY - event.clientY;
    const dx = event.clientX - entry.startX;
    if (!entry.moved && Math.abs(dx) + Math.abs(dy) > TAP_DRAG_PX) entry.moved = true;
    let pitch = clampSamplePitch(entry.start.pitch + dy / PITCH_PX_PER_STEP);
    // Tempo-locked pads (scratches) stretch only with the session BPM — a
    // horizontal drag on them tunes nothing.
    const locked = Boolean(sampleBpm(entry.sample));
    let stretch = locked
      ? entry.start.stretch
      : clampSampleStretch(entry.start.stretch * Math.pow(2, dx / STRETCH_PX_PER_OCTAVE));
    if (Math.abs(pitch) < 0.6) pitch = 0;
    if (Math.abs(stretch - 1) < 0.05) stretch = locked ? stretch : 1;
    entry.current = { pitch, stretch };
    const rect = container.getBoundingClientRect();
    paintHud(entry.sample, entry.current, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
    onTune?.(entry.sample, entry.current, 'move');
  };

  const upPointer = (event) => endPointer(event, event.type === 'pointercancel');
  window.addEventListener('pointermove', movePointer, { passive: false });
  window.addEventListener('pointerup', upPointer);
  window.addEventListener('pointercancel', upPointer);

  /**
   * Losing the window mid-gesture (alt-tab, an OS edge swipe stealing the
   * touch) must not leave a stuck entry — that stale 'tune' would block the
   * erase ✕ and keep the pad lit forever. Drop everything, like a pointerup.
   */
  const dropAll = () => {
    const gates = new Set();
    for (const [pointerId, entry] of [...held.entries()]) {
      held.delete(pointerId);
      if (entry.kind === 'solo') onSolo?.(false);
      else if (entry.kind === 'hit' && entry.pad?.dataset.sample) gates.add(entry.pad.dataset.sample);
      else if (entry.kind === 'tune') paintHud(entry.sample, entry.current, null);
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
      // Edit mode's erase handle. Tuning starts from a pad drag, so a ✕
      // press that lands while a tune gesture is held is ignored — the
      // finger was aiming at the pad, not the corner.
      const cross = document.createElement('span');
      cross.className = 'sampler-pad__x';
      cross.textContent = '✕';
      cross.setAttribute('aria-hidden', 'true');
      cross.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!editing() || !hitsOf(cell.sample)) return;
        if ([...held.values()].some((entry) => entry.kind === 'tune')) return;
        pad.classList.add('is-erase');
        setTimeout(() => pad.classList.remove('is-erase'), 220);
        onErase?.(cell.sample);
      });
      cross.addEventListener('click', (event) => event.stopPropagation());
      pad.append(label, badge, cross);
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
      const mode = editing();
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
        // An empty cell in edit mode steers the armed pad — more room to drag.
        if (mode && armedPad) {
          startTune(event, armedPad, armedId, false);
          return;
        }
        pad.classList.add('is-bump');
        setTimeout(() => pad.classList.remove('is-bump'), 160);
        return;
      }
      if (mode) {
        armPad(pad);
        startTune(event, pad, sampleId, true);
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
      if (editing()) armPad(pad);
      else onHit?.(pad.dataset.sample);
    });

    // Wheel = fine pitch steps; shift+wheel = stretch. Desktop tuning without
    // the drag gesture.
    pad.addEventListener(
      'wheel',
      (event) => {
        if (!editing() || !pad.dataset.sample) return;
        event.preventDefault();
        const id = pad.dataset.sample;
        const next = { ...paramsOf(id) };
        const dir = event.deltaY < 0 ? 1 : -1;
        if (event.shiftKey && !sampleBpm(id)) next.stretch = clampSampleStretch(next.stretch * Math.pow(2, dir * WHEEL_STRETCH_STEP));
        else next.pitch = clampSamplePitch(next.pitch + dir);
        armPad(pad);
        onTune?.(id, next, 'set');
        paintHud(id, next, null);
      },
      { passive: false },
    );
    pads.push(pad);
    grid.append(pad);
  });

  // Pointers that land between cells must not fall through to the touchpad —
  // and while a pad is armed, empty space is the roomiest tuning surface.
  grid.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (editing() && armedPad) startTune(event, armedPad, armedId, false);
  });

  return {
    /** Brief trigger flash — loop playback, remote hits, auditions. */
    flash(id) {
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
    },
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
      const pad = pads.find((item) => item.dataset.sample === id);
      if (pad) pad.querySelector('.sampler-pad__badge').textContent = formatBadge(paramsOf(id));
    },
    updateAllParams() {
      for (const spec of SAMPLE_BANK) this.updateParam(spec.id);
    },
    setEditMode(mode) {
      container.classList.toggle('is-editing', Boolean(mode));
      if (mode) refreshErase();
      else armPad(null);
    },
    /** Re-check which pads carry recorded hits — the ✕ follows. */
    refreshErase,
    /** Mode switches and locks drop every held pad like a real pointerup. */
    releaseAll() {
      dropAll();
      armPad(null);
    },
    destroy() {
      window.removeEventListener('pointermove', movePointer);
      window.removeEventListener('pointerup', upPointer);
      window.removeEventListener('pointercancel', upPointer);
      window.removeEventListener('blur', dropAll);
      for (const timer of flashTimers.values()) clearTimeout(timer);
      for (const timer of playTimers.values()) clearTimeout(timer);
      container.replaceChildren();
      container.classList.remove('sampler', 'is-editing', 'is-erasing', 'is-tuning');
    },
  };
}
