import { midiToName } from '../audio/synth.js';
import { markScrollEdges } from './scroll-edges.js';
import { pressable } from './quiet-touch.js';

export const ROLL_STEP_PX = 36;

function stepSize(scrollEl) {
  const px = Number(scrollEl?.__stepPx);
  return px >= 6 ? px : ROLL_STEP_PX;
}
const ROW_PX = 28;
const RULER_PX = 26;
const KEY_PX = 42;
const OCTAVE = 12;

/**
 * Notes editor: time runs left to right, pitch runs top to bottom.
 * A finger dragging empty space along time scrolls the tape.
 * A short tap on an empty in-scale cell places one note, silently.
 * A short tap on a note deletes that one note, unless select and move is on.
 * Only the left-hand keys preview a pitch, and that preview writes nothing.
 * Pitches outside the current scale are dimmed and do not accept new notes.
 * A drag moves one note. The whole selection moves only while select and move is on.
 * Notes owned by other players render dashed and edit like any other note.
 * A mouse drag on empty space draws a selection marquee only in that mode.
 * The playhead is a div, not a frame loop.
 */
export function renderPianoRoll(scrollEl, { notes, steps, pitchesFor, colorFor, onDelete, onMove, onMoveGroup, onResize, onPlace, onAudition, inScale, focusMidi, instrument, selectMode, stepPx: requestedStep, owner }) {
  const stepPx = Math.max(6, Number(requestedStep) || Number(scrollEl.__stepPx) || ROLL_STEP_PX);
  scrollEl.__stepPx = stepPx;
  const previousLeft = scrollEl.scrollLeft;
  const previousTop = scrollEl.scrollTop;
  const previousMidis = scrollEl.__midis;
  let anchorMidi = null;
  let anchorDelta = 0;
  if (previousMidis?.length) {
    const approx = Math.round((previousTop - RULER_PX) / ROW_PX);
    const index = Math.max(0, Math.min(previousMidis.length - 1, approx));
    anchorMidi = previousMidis[index];
    anchorDelta = previousTop - (RULER_PX + index * ROW_PX);
  }
  const safeSteps = Math.max(16, steps);
  const rows = buildRows(notes, pitchesFor, focusMidi);
  const rowOf = new Map(rows.map((midi, index) => [midi, index]));
  const sheet = document.createElement('div');
  sheet.className = 'roll__sheet';
  sheet.style.width = `${KEY_PX + safeSteps * stepPx}px`;
  sheet.style.height = `${RULER_PX + Math.max(1, rows.length) * ROW_PX}px`;
  sheet.style.gridTemplateColumns = `${KEY_PX}px ${safeSteps * stepPx}px`;
  sheet.style.gridTemplateRows = `${RULER_PX}px ${Math.max(1, rows.length) * ROW_PX}px`;

  const corner = document.createElement('div');
  corner.className = 'roll__corner';

  const ruler = document.createElement('div');
  ruler.className = 'roll__ruler';
  const bars = Math.ceil(safeSteps / 16);
  const barPx = 16 * stepPx;
  for (let bar = 0; bar < bars; bar += 1) {
    const label = document.createElement('span');
    label.className = 'roll__bar';
    label.textContent = String(bar + 1);
    label.style.left = `${bar * barPx}px`;
    label.style.width = `${barPx}px`;
    ruler.append(label);
  }

  const keys = document.createElement('div');
  keys.className = 'roll__keys';
  for (let index = 0; index < rows.length; index += 1) {
    const midi = rows[index];
    const key = document.createElement('div');
    key.className = 'roll__key';
    if (midi % 12 === 0) key.classList.add('is-c');
    else if ([1, 3, 6, 8, 10].includes(midi % 12)) key.classList.add('is-sharp');
    key.dataset.midi = String(midi);
    key.style.top = `${index * ROW_PX}px`;
    key.textContent = midiToName(midi);
    if (inScale && !inScale(midi)) key.classList.add('is-blocked');
    bindAudition(key, midi, onAudition);
    keys.append(key);
  }

  const grid = document.createElement('div');
  grid.className = 'roll__grid';
  grid.style.height = `${rows.length * ROW_PX}px`;

  for (let index = 0; index < rows.length; index += 1) {
    const shade = document.createElement('div');
    const blocked = Boolean(inScale && !inScale(rows[index]));
    shade.className = blocked ? 'roll__row is-blocked' : 'roll__row';
    shade.style.top = `${index * ROW_PX}px`;
    shade.dataset.midi = String(rows[index]);
    shade.setAttribute('aria-hidden', 'true');
    grid.append(shade);
  }

  for (let step = 0; step <= safeSteps; step += 4) {
    const isBar = step % 16 === 0;
    if (step === safeSteps && !isBar) continue;
    const mark = document.createElement('div');
    mark.className = isBar ? 'roll__beat roll__beat--bar' : 'roll__beat';
    mark.dataset.step = String(step);
    mark.style.left = `${step * stepPx}px`;
    mark.setAttribute('aria-hidden', 'true');
    grid.append(mark);
  }

  if (!notes.length) {
    const empty = document.createElement('p');
    empty.className = 'roll__empty';
    empty.textContent = 'Tap a cell to place a note';
    grid.append(empty);
  }

  for (const note of notes) {
    const midis = pitchesFor(note);
    const duration = noteDuration(note, safeSteps);
    for (const midi of midis) {
      const row = rowOf.get(Math.round(midi));
      if (row == null) continue;
      const strip = pressable('roll__note');
      strip.dataset.voice = note.voiceId;
      strip.dataset.step = String(note.step);
      strip.dataset.midi = String(Math.round(midi));
      strip.dataset.duration = String(duration);
      strip.dataset.instrument = note.instrument || '';
      strip.dataset.owner = note.owner || '';
      if (note.owner && owner && note.owner !== owner) strip.classList.add('is-remote');
      if (scrollEl.__selected?.has(note.voiceId)) strip.classList.add('is-selected');
      const width = Math.max(stepPx - 2, duration * stepPx - 2);
      strip.style.left = `${note.step * stepPx + 1}px`;
      strip.style.width = `${width}px`;
      strip.style.top = `${row * ROW_PX + 3}px`;
      strip.style.background = colorFor(note);
      strip.textContent = midiToName(midi);
      strip.setAttribute('aria-label', `${midiToName(midi)}, delete, move, or drag the right edge`);
      const grip = document.createElement('span');
      grip.className = 'roll__resize';
      grip.setAttribute('aria-hidden', 'true');
      grip.style.width = `${Math.min(22, Math.max(8, Math.round(width * 0.3)))}px`;
      strip.append(grip);
      bindStrip(strip, scrollEl, safeSteps);
      bindResize(grip, strip, note, duration, safeSteps, onResize);
      grid.append(strip);
    }
  }

  const playhead = document.createElement('div');
  playhead.className = 'roll__playhead';
  playhead.hidden = true;
  const marquee = document.createElement('div');
  marquee.className = 'roll__marquee';
  marquee.hidden = true;
  grid.append(playhead, marquee);

  keys.style.height = `${rows.length * ROW_PX}px`;
  sheet.append(corner, ruler, keys, grid);
  scrollEl.replaceChildren(sheet);
  const selectionKey = instrument || '';
  if (scrollEl.__selectionKey !== selectionKey) {
    scrollEl.__selected = new Set();
    scrollEl.__selectionKey = selectionKey;
  }
  if (!scrollEl.__selected) scrollEl.__selected = new Set();
  scrollEl.__place = onPlace || null;
  scrollEl.__onDelete = onDelete || null;
  scrollEl.__onMove = onMove || null;
  scrollEl.__onMoveGroup = onMoveGroup || onMove || null;
  scrollEl.__inScale = inScale || null;
  scrollEl.__instrument = selectionKey;
  scrollEl.__selectMode = Boolean(selectMode);
  scrollEl.__midis = rows;
  scrollEl.__steps = safeSteps;
  bindPan(scrollEl);
  scrollEl.scrollLeft = previousLeft;
  if (anchorMidi != null && rowOf.has(anchorMidi)) {
    scrollEl.scrollTop = Math.max(0, RULER_PX + rowOf.get(anchorMidi) * ROW_PX + anchorDelta);
  } else {
    scrollEl.scrollTop = previousTop;
  }
  markScrollEdges(scrollEl, 'both');
  return { notes: notes.length, steps: safeSteps };
}

/** Put one pitch row in the middle of the roll. Used when Notes opens. */
export function scrollRollToMidi(scrollEl, midi) {
  const midis = scrollEl.__midis || [];
  const wanted = Math.round(Number(midi));
  const view = scrollEl.clientHeight;
  if (!midis.length || !Number.isFinite(wanted) || !view) return false;
  let index = midis.indexOf(wanted);
  if (index < 0) {
    index = midis.reduce(
      (best, value, i) => (Math.abs(value - wanted) < Math.abs(midis[best] - wanted) ? i : best),
      0,
    );
  }
  const usable = Math.max(ROW_PX, view - RULER_PX);
  const rowTop = RULER_PX + index * ROW_PX;
  const max = Math.max(0, scrollEl.scrollHeight - view);
  const target = rowTop - RULER_PX - (usable - ROW_PX) / 2;
  scrollEl.scrollTop = Math.min(max, Math.max(0, target));
  return true;
}

/** Turn group selection on or off. Off clears the lit notes. */
export function setRollSelectMode(scrollEl, on) {
  if (!scrollEl) return;
  scrollEl.__selectMode = Boolean(on);
  if (on) return;
  scrollEl.__selected = new Set();
  scrollEl.querySelectorAll('.roll__note.is-selected').forEach((item) => item.classList.remove('is-selected'));
}

export function setRollPlayhead(scrollEl, step) {
  const head = scrollEl.querySelector('.roll__playhead');
  if (!head) return;
  if (!(step >= 0)) {
    head.hidden = true;
    return;
  }
  head.hidden = false;
  head.style.transform = `translateX(${step * stepSize(scrollEl)}px) translateX(-50%)`;
}

function noteDuration(note, steps) {
  let duration = (note.endStep ?? note.step + 1) - note.step;
  if (duration <= 0) duration += steps;
  return Math.max(1, Math.min(steps, duration));
}

function buildRows(notes, pitchesFor, focusMidi) {
  const placed = [];
  for (const note of notes) {
    for (const midi of pitchesFor(note) || []) {
      if (Number.isFinite(midi)) placed.push(Math.round(midi));
    }
  }
  const focus = Number.isFinite(Number(focusMidi)) ? Math.round(Number(focusMidi)) : null;
  let min;
  let max;
  if (placed.length) {
    min = Math.min(...placed);
    max = Math.max(...placed);
  } else if (focus != null) {
    min = focus;
    max = focus + OCTAVE - 1;
  } else {
    min = 48;
    max = 59;
  }
  if (focus != null) {
    min = Math.min(min, focus);
    max = Math.max(max, focus + OCTAVE - 1);
  }
  let lo = Math.max(0, min - OCTAVE);
  let hi = Math.min(127, max + OCTAVE);
  if (placed.length) {
    lo = Math.min(lo, Math.min(...placed));
    hi = Math.max(hi, Math.max(...placed));
  }
  if (focus != null) {
    lo = Math.min(lo, focus);
    hi = Math.max(hi, Math.min(127, focus + OCTAVE - 1));
  }
  const rows = [];
  for (let midi = hi; midi >= lo; midi -= 1) rows.push(midi);
  return rows;
}

function bindPan(scrollEl) {
  if (scrollEl.dataset.pan === '1') return;
  scrollEl.dataset.pan = '1';
  let drag = null;
  scrollEl.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('.roll__note, .roll__keys, .roll__ruler, .roll__corner')) return;
    const grid = scrollEl.querySelector('.roll__grid');
    const local = gridPoint(grid, event);
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: scrollEl.scrollLeft,
      axis: null,
      mouse: event.pointerType === 'mouse',
      local,
    };
    if (drag.mouse) {
      try {
        scrollEl.setPointerCapture(event.pointerId);
      } catch {
        // Capture can fail if the pointer already ended.
      }
    }
  });
  scrollEl.addEventListener(
    'pointermove',
    (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (drag.mouse) {
        if (!scrollEl.__selectMode) return;
        const grid = scrollEl.querySelector('.roll__grid');
        const now = gridPoint(grid, event);
        paintMarquee(grid, drag.local, now);
        event.preventDefault();
        return;
      }
      if (!drag.axis && Math.hypot(dx, dy) > 8) drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (drag.axis !== 'x') return;
      if (!drag.captured) {
        drag.captured = true;
        scrollEl.setPointerCapture?.(event.pointerId);
      }
      event.preventDefault();
      scrollEl.scrollLeft = drag.left - dx;
    },
    { passive: false },
  );
  const end = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const moved = Math.hypot(event.clientX - drag.x, event.clientY - drag.y);
    const axis = drag.axis;
    const mouse = drag.mouse;
    const local = drag.local;
    drag = null;
    const grid = scrollEl.querySelector('.roll__grid');
    const marquee = grid?.querySelector('.roll__marquee');
    if (marquee) marquee.hidden = true;
    if (mouse && scrollEl.__selectMode && moved > 6 && grid) {
      const now = gridPoint(grid, event);
      const rect = boxBetween(local, now);
      const ids = [];
      grid.querySelectorAll('.roll__note').forEach((strip) => {
        if (strip.dataset.instrument !== scrollEl.__instrument) return;
        if (intersects(noteBox(strip), rect)) ids.push(strip.dataset.voice);
      });
      setSelected(scrollEl, ids);
      return;
    }
    if (event.type === 'pointercancel' || axis === 'x' || axis === 'y' || moved > 10) return;
    if (scrollEl.__selectMode) {
      setSelected(scrollEl, []);
      return;
    }
    const place = scrollEl.__place;
    const midis = scrollEl.__midis || [];
    const steps = scrollEl.__steps || 16;
    if (!place || !grid || !midis.length) return;
    const point = gridPoint(grid, event);
    if (point.y < 0 || point.y > grid.clientHeight || point.x < 0) return;
    const step = Math.max(0, Math.min(steps - 1, Math.floor(point.x / stepSize(scrollEl))));
    const row = Math.max(0, Math.min(midis.length - 1, Math.floor(point.y / ROW_PX)));
    const midi = midis[row];
    if (!Number.isFinite(midi)) return;
    if (scrollEl.__inScale && !scrollEl.__inScale(midi)) return;
    place({ step, midi });
  };
  scrollEl.addEventListener('pointerup', end);
  scrollEl.addEventListener('pointercancel', end);
}

function bindResize(grip, strip, note, duration, steps, onResize) {
  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    try {
      grip.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture is optional. The drag still listens on the window.
    }
    const startX = event.clientX;
    let dragged = false;
    let nextDuration = duration;
    const move = (ev) => {
      if (ev.pointerId !== event.pointerId) return;
      const dx = ev.clientX - startX;
      if (!dragged && Math.abs(dx) < 6) return;
      dragged = true;
      ev.preventDefault();
      const stepPx = stepSize(grip.closest('.roll'));
      nextDuration = Math.max(1, Math.min(steps - 1, duration + Math.round(dx / stepPx)));
      strip.style.width = `${Math.max(stepPx - 2, nextDuration * stepPx - 2)}px`;
    };
    const up = (ev) => {
      if (ev.pointerId !== event.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (dragged && nextDuration !== duration) onResize?.(note.voiceId, { duration: nextDuration });
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

function midiAtEvent(scrollEl, event) {
  const grid = scrollEl.querySelector('.roll__grid');
  const midis = scrollEl.__midis || [];
  if (!grid || !midis.length) return null;
  const rect = grid.getBoundingClientRect();
  const localY = event.clientY - rect.top;
  if (localY < 0 || localY > rect.height) return null;
  const row = Math.max(0, Math.min(midis.length - 1, Math.floor(localY / ROW_PX)));
  const midi = midis[row];
  return Number.isFinite(midi) ? midi : null;
}

function bindAudition(el, midi, onAudition) {
  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      el.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture can fail if the pointer already ended.
    }
    onAudition?.({ down: true, midi, pointerId: event.pointerId });
    const end = (ev) => {
      if (ev.pointerId !== event.pointerId) return;
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      onAudition?.({ down: false, midi, pointerId: event.pointerId });
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  });
  const quiet = (event) => event.preventDefault();
  el.addEventListener('contextmenu', quiet);
  el.addEventListener('selectstart', quiet);
}

function bindStrip(strip, scrollEl, steps) {
  strip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('.roll__resize')) return;
    if (strip.dataset.instrument !== scrollEl.__instrument) return;
    event.stopPropagation();
    event.preventDefault();
    try {
      strip.setPointerCapture?.(event.pointerId);
    } catch {
      // A pointer that is already gone should still be able to drag the strip.
    }
    const voice = strip.dataset.voice;
    const shift = event.shiftKey;
    const selectMode = Boolean(scrollEl.__selectMode);
    if (!scrollEl.__selected) scrollEl.__selected = new Set();
    if (selectMode && shift) {
      scrollEl.__selected.add(voice);
      paintSelection(scrollEl);
    }
    const startX = event.clientX;
    const startY = event.clientY;
    let dragged = false;
    const move = (ev) => {
      if (ev.pointerId !== event.pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragged && Math.hypot(dx, dy) < 8) return;
      if (!dragged && selectMode && !scrollEl.__selected.has(voice)) setSelected(scrollEl, [voice]);
      dragged = true;
      ev.preventDefault();
      const stepPx = stepSize(scrollEl);
      const deltaStep = Math.round(dx / stepPx);
      const deltaMidi = Math.round(-dy / ROW_PX);
      const shift = `translate(${deltaStep * stepPx}px, ${-deltaMidi * ROW_PX}px)`;
      if (!selectMode) {
        strip.style.transform = shift;
        return;
      }
      if (!scrollEl.__selected.has(voice)) return;
      scrollEl.querySelectorAll('.roll__note').forEach((item) => {
        item.style.transform = scrollEl.__selected.has(item.dataset.voice) ? shift : '';
      });
    };
    const up = (ev) => {
      if (ev.pointerId !== event.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (ev.type === 'pointercancel' || !dragged) {
        scrollEl.querySelectorAll('.roll__note').forEach((item) => {
          item.style.transform = '';
        });
        if (ev.type === 'pointercancel') return;
        if (selectMode) {
          if (scrollEl.__selected.has(voice)) scrollEl.__selected.delete(voice);
          else scrollEl.__selected.add(voice);
          paintSelection(scrollEl);
          return;
        }
        scrollEl.__onDelete?.(voice);
        return;
      }
      const stepPx = stepSize(scrollEl);
      const deltaStep = Math.round(dx / stepPx);
      const deltaMidi = Math.round(-dy / ROW_PX);
      const grid = scrollEl.querySelector('.roll__grid');
      const members = selectMode
        ? [...grid.querySelectorAll('.roll__note')].filter((item) => scrollEl.__selected.has(item.dataset.voice))
        : [strip];
      const changes = [];
      let ok = deltaStep !== 0 || deltaMidi !== 0;
      const rows = scrollEl.__midis || [];
      for (const item of members) {
        const step = Number(item.dataset.step);
        const midi = Number(item.dataset.midi);
        const duration = Number(item.dataset.duration) || 1;
        const nextStep = step + deltaStep;
        const nextMidi = midi + deltaMidi;
        if (nextStep < 0 || nextStep >= steps || nextStep + duration > steps) ok = false;
        if (!rows.includes(nextMidi)) ok = false;
        if (scrollEl.__inScale && !scrollEl.__inScale(nextMidi)) ok = false;
        changes.push({ voiceId: item.dataset.voice, step: nextStep, midi: nextMidi });
      }
      members.forEach((item) => {
        item.style.transform = '';
      });
      if (!ok) return;
      scrollEl.__onMoveGroup?.(changes);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

function gridPoint(grid, event) {
  const rect = grid.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function boxBetween(a, b) {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  return { left, top, right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}

function noteBox(strip) {
  const left = parseFloat(strip.style.left) || 0;
  const top = parseFloat(strip.style.top) || 0;
  const width = parseFloat(strip.style.width) || stepSize(strip.closest('.roll'));
  return { left, top, right: left + width, bottom: top + 22 };
}

function intersects(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function paintMarquee(grid, start, now) {
  const box = grid?.querySelector('.roll__marquee');
  if (!box) return;
  const rect = boxBetween(start, now);
  box.hidden = false;
  box.style.left = `${rect.left}px`;
  box.style.top = `${rect.top}px`;
  box.style.width = `${rect.right - rect.left}px`;
  box.style.height = `${rect.bottom - rect.top}px`;
}

function paintSelection(scrollEl) {
  const selected = scrollEl.__selected || new Set();
  scrollEl.querySelectorAll('.roll__note').forEach((item) => {
    item.classList.toggle('is-selected', selected.has(item.dataset.voice));
  });
}

function setSelected(scrollEl, ids) {
  scrollEl.__selected = new Set(ids);
  paintSelection(scrollEl);
}
