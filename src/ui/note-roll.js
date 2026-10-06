import { midiToName } from '../audio/synth.js';
import { sampleMode } from '../audio/sampler.js';
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
 * An empty-space drag draws a selection marquee in that mode — mouse or touch.
 * A strip or resize drag near the sheet edge auto-scrolls it into view.
 * The playhead is a div, not a frame loop.
 */
export function renderNoteRoll(scrollEl, { notes, steps, pitchesFor, colorFor, onDelete, onMove, onMoveGroup, onResize, onResizeGroup, onPlace, onAudition, onZoom, onSelection, inScale, focusMidi, instrument, selectMode, stepPx: requestedStep, owner, lanes }) {
  const laneMode = Array.isArray(lanes) && lanes.length > 0;
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
  // Lane mode (sampler hits): rows are the pad lanes top→bottom, no pitch
  // grid. Row index doubles as the stored "midi" so a vertical drag moves a
  // hit between lanes with the same math as a pitch drag.
  const rows = laneMode ? lanes.map((_, index) => index) : buildRows(notes, pitchesFor, focusMidi);
  const rowOf = new Map(rows.map((midi, index) => [midi, index]));

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
  scrollEl.__onResizeGroup = onResizeGroup || null;
  scrollEl.__onSelection = onSelection || null;
  scrollEl.__inScale = laneMode ? null : inScale || null;
  scrollEl.__instrument = selectionKey;
  scrollEl.__selectMode = Boolean(selectMode);
  scrollEl.__midis = rows;
  scrollEl.__lanes = laneMode ? lanes : null;
  scrollEl.__steps = safeSteps;
  scrollEl.__onZoom = onZoom || null;
  bindPan(scrollEl);

  /* Rows, steps, zoom, instrument, owner and the scale mask make the frame.
     A recording burst changes none of them — only the strips — so patch
     those in place and keep keys, beats, scroll position and playhead. */
  const frame = [
    rows.join(','),
    safeSteps,
    stepPx,
    selectionKey,
    owner || '',
    inScale ? rows.map((midi) => (inScale(midi) ? '1' : '0')).join('') : '-',
  ].join('|');
  const liveGrid = scrollEl.__frame === frame ? scrollEl.querySelector('.roll__grid') : null;
  if (liveGrid) {
    patchRollNotes(liveGrid, scrollEl, notes, { steps: safeSteps, pitchesFor, colorFor, onResize, owner });
    markScrollEdges(scrollEl, 'both');
    scrollEl.__onSelection?.(scrollEl.__selected);
    return { notes: notes.length, steps: safeSteps };
  }
  scrollEl.__frame = frame;

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
    if (laneMode) {
      key.classList.add('roll__key--lane');
      key.textContent = lanes[midi]?.label || '';
    } else {
      if (midi % 12 === 0) key.classList.add('is-c');
      else if ([1, 3, 6, 8, 10].includes(midi % 12)) key.classList.add('is-sharp');
      key.textContent = midiToName(midi);
      if (inScale && !inScale(midi)) key.classList.add('is-blocked');
    }
    key.dataset.midi = String(midi);
    key.style.top = `${index * ROW_PX}px`;
    if (laneMode) {
      const lane = lanes[midi];
      bindAudition(key, midi, lane ? (info) => onAudition?.({ ...info, lane: lane.id }) : null);
    } else {
      bindAudition(key, midi, onAudition);
    }
    keys.append(key);
  }

  const grid = document.createElement('div');
  grid.className = 'roll__grid';
  grid.style.height = `${rows.length * ROW_PX}px`;

  for (let index = 0; index < rows.length; index += 1) {
    const shade = document.createElement('div');
    const blocked = !laneMode && Boolean(inScale && !inScale(rows[index]));
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

  const emptyText = laneMode ? 'Tap a cell to place a hit' : 'Tap a cell to place a note';
  if (!notes.length) {
    const empty = document.createElement('p');
    empty.className = 'roll__empty';
    empty.textContent = emptyText;
    grid.append(empty);
  }

  for (const note of notes) {
    const duration = noteDuration(note, safeSteps);
    for (const place of stripPlacements(scrollEl, note, pitchesFor, rowOf)) {
      grid.append(
        makeStrip(scrollEl, note, place.midi, place.row, duration, { steps: safeSteps, stepPx, colorFor, onResize, owner }),
      );
    }
  }

  const playhead = document.createElement('div');
  playhead.className = 'roll__playhead';
  playhead.hidden = true;
  const marquee = document.createElement('div');
  marquee.className = 'roll__marquee';
  marquee.hidden = true;
  grid.append(playhead, marquee);
  orderStrips(grid, scrollEl);

  keys.style.height = `${rows.length * ROW_PX}px`;
  sheet.append(corner, ruler, keys, grid);
  scrollEl.replaceChildren(sheet);
  scrollEl.scrollLeft = previousLeft;
  if (anchorMidi != null && rowOf.has(anchorMidi)) {
    scrollEl.scrollTop = Math.max(0, RULER_PX + rowOf.get(anchorMidi) * ROW_PX + anchorDelta);
  } else {
    scrollEl.scrollTop = previousTop;
  }
  markScrollEdges(scrollEl, 'both');
  scrollEl.__onSelection?.(scrollEl.__selected);
  return { notes: notes.length, steps: safeSteps };
}

/**
 * Paint order IS the z-order (all strips share one z-index): strips that
 * start on the same step stack longest-first so a short note never hides
 * under a longer neighbour, and same-length ties put the viewed
 * instrument's strips on top.
 */
function orderStrips(grid, scrollEl) {
  const own = scrollEl.__instrument;
  const strips = [...grid.querySelectorAll('.roll__note')];
  strips.sort((a, b) => {
    const stepA = Number(a.dataset.step);
    const stepB = Number(b.dataset.step);
    if (stepA !== stepB) return stepA - stepB;
    const durA = Number(a.dataset.duration) || 1;
    const durB = Number(b.dataset.duration) || 1;
    if (durA !== durB) return durB - durA;
    return Number(a.dataset.instrument === own) - Number(b.dataset.instrument === own);
  });
  for (const strip of strips) grid.append(strip);
}

/** Everything one strip paints — an identical signature keeps the element. */
function stripSignature(note, midi, row, duration, colorFor, owner) {
  const remote = Boolean(note.owner && owner && note.owner !== owner);
  return [note.step, midi, row, duration, note.instrument || '', remote ? 1 : 0, colorFor(note)].join('|');
}

/**
 * Where one note lands as strips. Pitch mode resolves notes to midi rows;
 * lane mode parks every sampler hit on its pad's row — hits of other
 * instruments are invisible in the sampler view and vice versa.
 */
function stripPlacements(scrollEl, note, pitchesFor, rowOf) {
  const lanes = scrollEl.__lanes;
  if (lanes) {
    if (note.instrument !== 'sampler') return [];
    const row = lanes.findIndex((lane) => lane.id === note.sample);
    return row >= 0 ? [{ row, midi: row }] : [];
  }
  const placements = [];
  for (const midi of pitchesFor(note) || []) {
    const row = rowOf.get(Math.round(midi));
    if (row != null) placements.push({ row, midi: Math.round(midi) });
  }
  return placements;
}

/** One note strip: geometry, colors and the drag/resize bindings for a row. */
function makeStrip(scrollEl, note, midi, row, duration, { steps, stepPx, colorFor, onResize, owner }) {
  const lanes = scrollEl.__lanes;
  const lane = lanes ? lanes[midi] : null;
  const strip = pressable('roll__note');
  strip.dataset.voice = note.voiceId;
  strip.dataset.step = String(note.step);
  strip.dataset.midi = String(midi);
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
  strip.textContent = lane ? lane.label : midiToName(midi);
  strip.setAttribute(
    'aria-label',
    lane ? `${lane.label} hit, delete or drag` : `${midiToName(midi)}, delete, move, or drag the right edge`,
  );
  // One-shot hits are fixed at one step; gate pads stretch like notes.
  if (!lane || sampleMode(lane.id) === 'gate') {
    const grip = document.createElement('span');
    grip.className = 'roll__resize';
    grip.setAttribute('aria-hidden', 'true');
    grip.style.width = `${Math.min(22, Math.max(8, Math.round(width * 0.3)))}px`;
    strip.append(grip);
    bindResize(grip, strip, note, duration, steps, onResize);
  }
  bindStrip(strip, scrollEl, steps);
  strip.__sig = stripSignature(note, midi, row, duration, colorFor, owner);
  return strip;
}

/**
 * Intact frame, new notes: sync the strips with the note list instead of a
 * rebuild. Keyed by voice+midi — a strip whose signature is unchanged keeps
 * its element and pointer bindings, a changed note swaps in a fresh strip,
 * a gone note's strip is removed.
 */
function patchRollNotes(grid, scrollEl, notes, { steps, pitchesFor, colorFor, onResize, owner }) {
  const stepPx = stepSize(scrollEl);
  const rowOf = new Map((scrollEl.__midis || []).map((midi, index) => [midi, index]));
  const wanted = new Map();
  for (const note of notes) {
    const duration = noteDuration(note, steps);
    for (const place of stripPlacements(scrollEl, note, pitchesFor, rowOf)) {
      wanted.set(`${note.voiceId}@${place.midi}`, { note, midi: place.midi, row: place.row, duration });
    }
  }
  const kept = new Map();
  for (const strip of grid.querySelectorAll('.roll__note')) {
    const key = `${strip.dataset.voice}@${strip.dataset.midi}`;
    if (!wanted.has(key) || kept.has(key)) strip.remove();
    else kept.set(key, strip);
  }
  for (const [key, item] of wanted) {
    const strip = kept.get(key);
    const sig = stripSignature(item.note, item.midi, item.row, item.duration, colorFor, owner);
    if (strip && strip.__sig === sig) {
      strip.classList.toggle('is-selected', Boolean(scrollEl.__selected?.has(item.note.voiceId)));
      continue;
    }
    const next = makeStrip(scrollEl, item.note, item.midi, item.row, item.duration, {
      steps,
      stepPx,
      colorFor,
      onResize,
      owner,
    });
    if (strip) strip.replaceWith(next);
    else grid.append(next);
  }
  const empty = grid.querySelector('.roll__empty');
  if (wanted.size && empty) empty.remove();
  else if (!wanted.size && !empty) {
    const hint = document.createElement('p');
    hint.className = 'roll__empty';
    hint.textContent = scrollEl.__lanes ? 'Tap a cell to place a hit' : 'Tap a cell to place a note';
    grid.append(hint);
  }
  orderStrips(grid, scrollEl);
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
  scrollEl.__onSelection?.(scrollEl.__selected);
}

/** The currently selected voiceIds — for duplicate and toolbar state. */
export function rollSelection(scrollEl) {
  return new Set(scrollEl?.__selected ?? []);
}

/** Replace the selection — a duplicate lights its fresh copies, not the source. */
export function selectRollNotes(scrollEl, voiceIds) {
  if (!scrollEl) return;
  scrollEl.__selected = new Set(voiceIds || []);
  paintSelection(scrollEl);
}

/** Ring the notes an undo/redo press would touch; null clears the preview. */
export function setRollUndoPreview(scrollEl, voiceIds) {
  if (!scrollEl) return;
  const set = voiceIds?.size ? voiceIds : null;
  scrollEl.querySelectorAll('.roll__note').forEach((item) => {
    const base = String(item.dataset.voice || '').split('@@')[0];
    item.classList.toggle('is-undo-preview', Boolean(set?.has(item.dataset.voice) || set?.has(base)));
  });
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

/**
 * Grid gestures: one finger (or a mouse drag) on empty space pans both axes;
 * two fingers pinch-zoom the step width while the midpoint stays put and
 * moving both fingers together pans as well. Ctrl/Cmd+wheel zooms at the
 * cursor, Shift+wheel slides sideways. A tap is still a write.
 */
function bindPan(scrollEl) {
  if (scrollEl.dataset.pan === '1') return;
  scrollEl.dataset.pan = '1';
  let drag = null;
  let pinch = null;
  let pinchEndedAt = 0;
  const pointers = new Map();

  /* Every finger counts even on strips, keys and the ruler — those swallow
     the pointerdown on its way back up, so tracking runs in capture phase. */
  scrollEl.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size !== 2 || pinch) return;
      const [a, b] = [...pointers.values()];
      const rect = scrollEl.getBoundingClientRect();
      pinch = {
        d0: Math.max(24, Math.hypot(a.x - b.x, a.y - b.y)),
        step0: stepSize(scrollEl),
        anchorX: scrollEl.scrollLeft + (a.x + b.x) / 2 - rect.left - KEY_PX,
        anchorY: scrollEl.scrollTop + (a.y + b.y) / 2 - rect.top - RULER_PX,
        raf: 0,
      };
      scrollEl.__pinching = true;
      scrollEl.__pinchStamp = performance.now();
      drag = null;
      /* Strips capture their pointer for note drags; a pinch rebuilds the
         sheet mid-gesture, which would leave that capture on a detached
         node and starve the tracker. Hand both fingers back to the roll. */
      for (const el of scrollEl.querySelectorAll('.roll__note, .roll__resize')) {
        for (const id of pointers.keys()) {
          try {
            el.releasePointerCapture(id);
          } catch {
            // That pointer was never captured here.
          }
        }
      }
    },
    { capture: true },
  );

  const applyPinch = () => {
    if (!pinch) return;
    pinch.raf = 0;
    const [a, b] = [...pointers.values()];
    if (!a || !b) return;
    const rect = scrollEl.getBoundingClientRect();
    const spread = Math.hypot(a.x - b.x, a.y - b.y);
    const wanted = pinch.step0 * Math.max(0.2, Math.min(6, spread / pinch.d0));
    const applied = scrollEl.__onZoom?.(wanted) ?? wanted;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    scrollEl.scrollLeft = Math.max(0, KEY_PX + pinch.anchorX * (applied / pinch.step0) - (midX - rect.left));
    scrollEl.scrollTop = Math.max(0, RULER_PX + pinch.anchorY - (midY - rect.top));
  };

  scrollEl.addEventListener('pointerdown', (event) => {
    if (pinch || event.button !== 0) return;
    if (event.target.closest('.roll__note, .roll__keys')) return;
    const grid = scrollEl.querySelector('.roll__grid');
    const local = gridPoint(grid, event);
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      panned: false,
      mouse: event.pointerType === 'mouse',
      local,
    };
    try {
      scrollEl.setPointerCapture(event.pointerId);
    } catch {
      // Capture can fail if the pointer already ended.
    }
  });
  scrollEl.addEventListener(
    'pointermove',
    (event) => {
      const point = pointers.get(event.pointerId);
      if (point) {
        point.x = event.clientX;
        point.y = event.clientY;
      }
      if (pinch) {
        event.preventDefault();
        if (!pinch.raf) pinch.raf = requestAnimationFrame(applyPinch);
        return;
      }
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      // Select mode turns the empty-space drag into a marquee on mouse AND
      // touch — panning is still on two fingers and the scrollbars.
      if (scrollEl.__selectMode) {
        const grid = scrollEl.querySelector('.roll__grid');
        drag.mx = event.clientX;
        drag.my = event.clientY;
        if (!drag.scroller) {
          drag.scroller = edgeScroller(scrollEl, () => {
            const g = scrollEl.querySelector('.roll__grid');
            if (g && drag?.local) paintMarquee(g, drag.local, gridPoint(g, { clientX: drag.mx, clientY: drag.my }));
          });
        }
        drag.scroller.update(event.clientX, event.clientY);
        paintMarquee(grid, drag.local, gridPoint(grid, event));
        event.preventDefault();
        return;
      }
      if (!drag.panned && Math.hypot(dx, dy) < 8) return;
      drag.panned = true;
      event.preventDefault();
      scrollEl.scrollLeft -= event.clientX - drag.lastX;
      const before = scrollEl.scrollTop;
      scrollEl.scrollTop -= event.clientY - drag.lastY;
      const rest = drag.lastY - event.clientY - (scrollEl.scrollTop - before);
      const card = scrollEl.closest('.fx-sheet__card');
      if (rest && card) card.scrollTop += rest;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
    },
    { passive: false },
  );
  const end = (event) => {
    pointers.delete(event.pointerId);
    if (pinch) {
      if (pinch.raf) cancelAnimationFrame(pinch.raf);
      applyPinch();
      pinch = null;
      scrollEl.__pinching = false;
      scrollEl.__pinchStamp = performance.now();
      pinchEndedAt = performance.now();
      // A finger still on the glass keeps panning instead of tapping.
      const remaining = [...pointers.entries()][0];
      if (remaining) {
        const [id, point] = remaining;
        drag = {
          id,
          x: point.x,
          y: point.y,
          lastX: point.x,
          lastY: point.y,
          panned: true,
          mouse: false,
          local: null,
        };
      }
      return;
    }
    if (!drag || event.pointerId !== drag.id) return;
    const moved = Math.hypot(event.clientX - drag.x, event.clientY - drag.y);
    const local = drag.local;
    const panned = drag.panned;
    drag.scroller?.stop();
    drag = null;
    const grid = scrollEl.querySelector('.roll__grid');
    const marquee = grid?.querySelector('.roll__marquee');
    if (marquee) marquee.hidden = true;
    if (scrollEl.__selectMode && moved > 6 && grid && local) {
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
    if (event.type === 'pointercancel' || panned || moved > 10) return;
    if (performance.now() - pinchEndedAt < 350) return;
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
    place({ step, midi, lane: scrollEl.__lanes?.[row]?.id });
  };
  /* Finger releases must be heard even past the roll's edge — a pointerup
     that lands outside never bubbles here, and a leaked pointer would
     resurrect the pinch on the next touch. */
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  scrollEl.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const before = stepSize(scrollEl);
        const rect = scrollEl.getBoundingClientRect();
        const anchorX = scrollEl.scrollLeft + event.clientX - rect.left - KEY_PX;
        const wanted = before * (event.deltaY < 0 ? 1.15 : 1 / 1.15);
        const applied = scrollEl.__onZoom?.(wanted) ?? wanted;
        scrollEl.scrollLeft = Math.max(0, KEY_PX + anchorX * (applied / before) - (event.clientX - rect.left));
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        scrollEl.scrollLeft += event.deltaY || event.deltaX;
      }
    },
    { passive: false },
  );
}

function bindResize(grip, strip, note, duration, steps, onResize) {
  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const rollEl = grip.closest('.roll');
    const startedAt = performance.now();
    const swallowed = () => rollEl && (rollEl.__pinching || (rollEl.__pinchStamp || 0) > startedAt);
    try {
      grip.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture is optional. The drag still listens on the window.
    }
    // With a group selected, the grip drags every selected strip by the same
    // step delta — one gesture, one undo entry.
    const members = () => {
      const selected = rollEl?.__selected;
      if (!rollEl?.__selectMode || !selected?.has(strip.dataset.voice) || selected.size < 2) return [strip];
      return [...rollEl.querySelectorAll('.roll__note')].filter(
        (item) => selected.has(item.dataset.voice) && item.dataset.instrument === rollEl.__instrument,
      );
    };
    const startX = event.clientX;
    const startLeft = rollEl ? rollEl.scrollLeft : 0;
    let lastX = startX;
    const scroller = edgeScroller(rollEl, () => applyWidth({ clientX: lastX }));
    let dragged = false;
    let nextDuration = duration;
    const applyWidth = (point) => {
      const dx = point.clientX - startX + (rollEl ? rollEl.scrollLeft - startLeft : 0);
      const stepPx = stepSize(grip.closest('.roll'));
      nextDuration = Math.max(1, Math.min(steps - 1, duration + Math.round(dx / stepPx)));
      const delta = nextDuration - duration;
      for (const item of members()) {
        const base = Number(item.dataset.duration) || 1;
        const next = Math.max(1, Math.min(steps - 1, base + delta));
        item.style.width = `${Math.max(stepPx - 2, next * stepPx - 2)}px`;
      }
    };
    const move = (ev) => {
      if (ev.pointerId !== event.pointerId || swallowed()) return;
      const dx = ev.clientX - startX + (rollEl ? rollEl.scrollLeft - startLeft : 0);
      if (!dragged && Math.abs(dx) < 6) return;
      dragged = true;
      ev.preventDefault();
      lastX = ev.clientX;
      scroller.update(ev.clientX, ev.clientY);
      applyWidth(ev);
    };
    const up = (ev) => {
      if (ev.pointerId !== event.pointerId) return;
      scroller.stop();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (swallowed() || !dragged) return;
      const delta = nextDuration - duration;
      const group = members();
      if (group.length > 1 && delta) {
        const changes = [];
        for (const item of group) {
          const base = Number(item.dataset.duration) || 1;
          const next = Math.max(1, Math.min(steps - 1, base + delta));
          if (next !== base) changes.push({ voiceId: item.dataset.voice, duration: next });
        }
        if (changes.length) {
          if (rollEl?.__onResizeGroup) rollEl.__onResizeGroup(changes);
          else for (const change of changes) onResize?.(change.voiceId, { duration: change.duration });
          return;
        }
      }
      // A rejected group drag leaves no repaint — put the widths back.
      const stepPx = stepSize(rollEl);
      for (const item of group) {
        const base = Number(item.dataset.duration) || 1;
        item.style.width = `${Math.max(stepPx - 2, base * stepPx - 2)}px`;
      }
      if (group.length === 1 && nextDuration !== duration) onResize?.(note.voiceId, { duration: nextDuration });
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

/**
 * Drag near the sheet edge scrolls it — the destination stays in view while
 * the pointer creeps past the visible strip. Velocity grows as the pointer
 * sinks into a ~28 px edge band; stops when the gesture ends.
 */
function edgeScroller(scrollEl, onScroll) {
  const EDGE = 28;
  const MAX = 14;
  if (!scrollEl) return { update() {}, stop() {} };
  let raf = 0;
  let x = 0;
  let y = 0;
  const tick = () => {
    raf = 0;
    const rect = scrollEl.getBoundingClientRect();
    const vx =
      x < rect.left + EDGE
        ? (-MAX * (rect.left + EDGE - x)) / EDGE
        : x > rect.right - EDGE
          ? (MAX * (x - rect.right + EDGE)) / EDGE
          : 0;
    const vy =
      y < rect.top + EDGE
        ? (-MAX * (rect.top + EDGE - y)) / EDGE
        : y > rect.bottom - EDGE
          ? (MAX * (y - rect.bottom + EDGE)) / EDGE
          : 0;
    if (vx) scrollEl.scrollLeft += vx;
    if (vy) scrollEl.scrollTop += vy;
    if (vx || vy) {
      onScroll?.();
      raf = requestAnimationFrame(tick);
    }
  };
  return {
    update(px, py) {
      x = px;
      y = py;
      if (!raf) raf = requestAnimationFrame(tick);
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
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
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      onAudition?.({ down: false, midi, pointerId: event.pointerId });
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    // If pointer capture fails, a release outside the strip would never reach it.
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
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
    const startedAt = performance.now();
    const swallowed = () => scrollEl.__pinching || (scrollEl.__pinchStamp || 0) > startedAt;
    const startX = event.clientX;
    const startY = event.clientY;
    // Auto-scroll adds the scrolled distance to the gesture delta so the
    // strip stays glued to a pointer that never moved.
    const startLeft = scrollEl.scrollLeft;
    const startTop = scrollEl.scrollTop;
    let lastX = startX;
    let lastY = startY;
    const scroller = edgeScroller(scrollEl, () => apply({ clientX: lastX, clientY: lastY }));
    let dragged = false;
    const apply = (point) => {
      const dx = point.clientX - startX + (scrollEl.scrollLeft - startLeft);
      const dy = point.clientY - startY + (scrollEl.scrollTop - startTop);
      const stepPx = stepSize(scrollEl);
      const deltaStep = Math.round(dx / stepPx);
      // Row indices grow downward; pitch midis shrink. Lane strips store the
      // row index as their "midi", so the sign flips between the two modes.
      const deltaRow = Math.round(dy / ROW_PX);
      const deltaMidi = scrollEl.__lanes ? deltaRow : -deltaRow;
      const shift = `translate(${deltaStep * stepPx}px, ${deltaRow * ROW_PX}px)`;
      if (!selectMode) {
        strip.style.transform = shift;
        return;
      }
      if (!scrollEl.__selected.has(voice)) return;
      scrollEl.querySelectorAll('.roll__note').forEach((item) => {
        item.style.transform = scrollEl.__selected.has(item.dataset.voice) ? shift : '';
      });
    };
    const move = (ev) => {
      if (ev.pointerId !== event.pointerId || swallowed()) return;
      const dx = ev.clientX - startX + (scrollEl.scrollLeft - startLeft);
      const dy = ev.clientY - startY + (scrollEl.scrollTop - startTop);
      if (!dragged && Math.hypot(dx, dy) < 8) return;
      if (!dragged && selectMode && !scrollEl.__selected.has(voice)) setSelected(scrollEl, [voice]);
      dragged = true;
      ev.preventDefault();
      lastX = ev.clientX;
      lastY = ev.clientY;
      scroller.update(lastX, lastY);
      apply(ev);
    };
    const up = (ev) => {
      if (ev.pointerId !== event.pointerId) return;
      scroller.stop();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const dx = ev.clientX - startX + (scrollEl.scrollLeft - startLeft);
      const dy = ev.clientY - startY + (scrollEl.scrollTop - startTop);
      if (ev.type === 'pointercancel' || !dragged || swallowed()) {
        scrollEl.querySelectorAll('.roll__note').forEach((item) => {
          item.style.transform = '';
        });
        if (ev.type === 'pointercancel' || swallowed()) return;
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
      const deltaRow = Math.round(dy / ROW_PX);
      const deltaMidi = scrollEl.__lanes ? deltaRow : -deltaRow;
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
        // A strip may hang over the loop edge — reject only a drag that
        // leaves it completely outside the grid.
        if (nextStep + duration <= 0 || nextStep >= steps) ok = false;
        if (!rows.includes(nextMidi)) ok = false;
        if (scrollEl.__inScale && !scrollEl.__inScale(nextMidi)) ok = false;
        changes.push({
          voiceId: item.dataset.voice,
          step: nextStep,
          midi: nextMidi,
          lane: scrollEl.__lanes?.[nextMidi]?.id,
        });
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
  scrollEl.__onSelection?.(selected);
}

function setSelected(scrollEl, ids) {
  scrollEl.__selected = new Set(ids);
  paintSelection(scrollEl);
}
