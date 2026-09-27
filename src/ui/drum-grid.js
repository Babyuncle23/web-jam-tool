/**
 * One drum-step grid shared by the host sheet and the guest sheet.
 * Tap a cell or drag across cells like a brush: the first touched cell
 * decides the value the whole stroke writes. The view owns the data and any
 * repeat-mirror expansion; the grid owns the DOM, the gestures, and the
 * playhead column.
 *
 * On touch the browser implicitly captures the pointer to the first cell,
 * so per-cell pointerenter never fires — the brush hit-tests with
 * elementFromPoint instead.
 */

import { pressable } from './quiet-touch.js';
import { markScrollEdges } from './scroll-edges.js';

const STEP_GAP = 3;
/** A tap writes on release; any click that follows a real write is a dup. */
const CLICK_SUPPRESS_MS = 800;
/** A stroke only becomes a brush past this distance — below it is a tap. */
const ARM_PX2 = 8 * 8;

function paintCellButton(button, slot, mirrored) {
  const on = Boolean(slot?.on);
  const triplet = on && slot?.division === 3;
  button.classList.toggle('is-on', on);
  button.classList.toggle('is-triplet', triplet);
  button.classList.toggle('is-mirror', Boolean(mirrored));
  button.textContent = triplet ? '3' : '';
}

/**
 * What a stroke writes. Triplet mode stamps triplets; a stroke that starts
 * on a matching cell erases instead, so paint and erase are one gesture.
 */
function strokeValue(mode, slot) {
  if (mode === 'triplet') {
    return slot?.on && slot.division === 3 ? { on: false, division: 1 } : { on: true, division: 3 };
  }
  return slot?.on ? { on: false, division: 1 } : { on: true, division: 1 };
}

/**
 * @param {HTMLElement} container `.sequencer` element the tape is rendered into
 * @param {object} options
 * @param {Array<{id: string, label: string}>} options.tracks row order
 * @param {() => number} options.steps live step count
 * @param {(track: string, step: number) => ({on: boolean, division: number}|null)} options.cell
 * @param {() => number} options.cellPx cell size in px
 * @param {(track: {id: string}) => Node|null} [options.iconFor] row icon
 * @param {() => number} [options.mirrorSpan] active repeat span in steps, 0 = off
 * @param {() => string} [options.writeMode] 'single' | 'triplet'
 * @param {(track: string, step: number, value: {on: boolean, division: number}) => void} options.applyCell
 * @param {(phase: 'start'|'flush'|'end') => void} [options.onGesture] stroke lifecycle for batching sends
 */
export function createDrumGrid(container, options) {
  const {
    tracks,
    steps = () => 32,
    cell = () => null,
    cellPx = () => 44,
    iconFor = () => null,
    mirrorSpan = () => 0,
    writeMode = () => 'single',
    applyCell = () => {},
    onGesture = () => {},
  } = options;

  let tape = null;
  let resizer = null;
  let litStep = -1;
  let suppressUntil = 0;
  const buttons = new Map();
  const columns = [];
  const strokes = new Map();

  function mirrored(step) {
    const span = Number(mirrorSpan()) || 0;
    return span > 0 && step >= span;
  }

  function paintStep(stroke, track, step) {
    const key = `${track}:${step}`;
    if (stroke.visited.has(key)) return;
    stroke.visited.add(key);
    applyCell(track, step, stroke.value);
    stroke.dirty = true;
  }

  function strokeHit(stroke, button) {
    const track = button.dataset.track;
    const step = Number(button.dataset.step);
    const last = stroke.last;
    if (last && last.track === track && last.step !== step) {
      // Fill the cells a fast swipe skipped between the last hit and this one.
      const lo = Math.min(last.step, step);
      const hi = Math.max(last.step, step);
      for (let s = lo; s <= hi; s += 1) paintStep(stroke, track, s);
    } else {
      paintStep(stroke, track, step);
    }
    stroke.last = { track, step };
  }

  function stepAt(x, y) {
    const under = document.elementFromPoint(x, y);
    const button = under?.closest?.('.step');
    return button && tape?.contains(button) ? button : null;
  }

  /**
   * Nothing writes on pointerdown: a tap commits on release, a brush commits
   * once the pointer clearly started moving. Between those, the browser may
   * still steal the gesture for scrolling (pointercancel) — then nothing was
   * written and the tap is not a fake note.
   */
  function onPointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const button = event.target.closest?.('.step');
    if (!button || !tape?.contains(button)) return;
    event.preventDefault();
    const track = button.dataset.track;
    const step = Number(button.dataset.step);
    strokes.set(event.pointerId, {
      id: event.pointerId,
      button,
      value: strokeValue(writeMode(), cell(track, step)),
      visited: new Set(),
      dirty: false,
      armed: false,
      travel: 0,
      x: event.clientX,
      y: event.clientY,
      last: null,
    });
    onGesture('start');
  }

  function flush(stroke) {
    if (!stroke.dirty) return;
    stroke.dirty = false;
    suppressUntil = performance.now() + CLICK_SUPPRESS_MS;
    onGesture('flush');
  }

  function onPointerMove(event) {
    const stroke = strokes.get(event.pointerId);
    if (!stroke) return;
    if (!stroke.armed) {
      const dx = event.clientX - stroke.x;
      const dy = event.clientY - stroke.y;
      const dist = dx * dx + dy * dy;
      if (dist > stroke.travel) stroke.travel = dist;
      if (dist < ARM_PX2) return;
      // On touch/pen a vertical drag belongs to scrolling (the browser cancels
      // the stroke anyway), so the brush only arms on a horizontal pull.
      if (event.pointerType !== 'mouse' && Math.abs(dy) > Math.abs(dx)) return;
      stroke.armed = true;
      strokeHit(stroke, stroke.button);
    }
    // A click that follows the release must stay suppressed however long
    // the finger was held, so the window refreshes through the stroke.
    suppressUntil = performance.now() + CLICK_SUPPRESS_MS;
    const button = stepAt(event.clientX, event.clientY);
    if (button) strokeHit(stroke, button);
    flush(stroke);
  }

  function endStroke(event) {
    const stroke = strokes.get(event.pointerId);
    if (!stroke) return;
    strokes.delete(event.pointerId);
    suppressUntil = performance.now() + CLICK_SUPPRESS_MS;
    // Cancelled means the browser took the gesture for scrolling — only a
    // small-move release still counts as a tap.
    if (event.type === 'pointerup' && !stroke.armed && stroke.travel < ARM_PX2) {
      strokeHit(stroke, stroke.button);
    }
    flush(stroke);
    onGesture('end');
  }

  function onKeyClick(button, event) {
    if (performance.now() < suppressUntil) {
      // The pointerdown already wrote this cell — swallow the follow-up click.
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const track = button.dataset.track;
    const step = Number(button.dataset.step);
    applyCell(track, step, strokeValue(writeMode(), cell(track, step)));
    onGesture('flush');
  }

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', endStroke);
  window.addEventListener('pointercancel', endStroke);

  function render() {
    const length = Math.max(1, steps());
    const width = Math.max(8, cellPx());
    const span = Number(mirrorSpan()) || 0;
    const spanBars = span / 16;
    const sourceLabel = spanBars > 1 ? `1–${spanBars}` : '1';
    const previousLeft = tape?.scrollLeft ?? 0;
    const previousTop = tape?.scrollTop ?? 0;
    container.replaceChildren();
    buttons.clear();
    columns.length = 0;

    tape = document.createElement('div');
    tape.className = 'seq-tape';
    tape.addEventListener('pointerdown', onPointerDown);

    const ruler = document.createElement('div');
    ruler.className = 'seq-row seq-ruler';
    const spacer = document.createElement('span');
    spacer.className = 'seq-row__label seq-ruler-spacer';
    ruler.append(spacer);
    const marks = document.createElement('div');
    marks.className = 'seq-ruler__marks';
    const barCount = Math.max(1, Math.round(length / 16));
    const barWidth = 16 * width + 15 * STEP_GAP;
    for (let bar = 0; bar < barCount; bar += 1) {
      const mark = document.createElement('span');
      mark.className = 'seq-ruler__bar';
      const copy = spanBars > 0 && bar >= spanBars;
      mark.textContent = copy ? `${bar + 1} ← ${sourceLabel}` : `${bar + 1}`;
      if (copy) {
        mark.classList.add('is-mirror');
        mark.title = `Repeats bar ${sourceLabel}`;
      }
      mark.style.width = `${barWidth}px`;
      marks.append(mark);
    }
    ruler.append(marks);
    tape.append(ruler);

    for (const track of tracks) {
      const row = document.createElement('div');
      row.className = 'seq-row';
      row.dataset.track = track.id;
      const label = document.createElement('span');
      label.className = 'seq-row__label';
      label.title = track.label;
      const icon = iconFor(track);
      if (icon) label.append(icon);
      const name = document.createElement('span');
      name.textContent = track.label;
      label.append(name);
      row.append(label);

      const rowSteps = document.createElement('div');
      rowSteps.className = 'seq-row__steps';
      for (let step = 0; step < length; step += 1) {
        const button = pressable('step');
        button.style.width = `${width}px`;
        button.style.flexBasis = `${width}px`;
        button.dataset.step = String(step);
        button.dataset.track = track.id;
        button.dataset.beat = String(step % 4 === 0);
        button.dataset.bar = String(step % 16 === 0);
        button.setAttribute('aria-label', `${track.label} step ${step + 1}`);
        paintCellButton(button, cell(track.id, step), mirrored(step));
        if (step === litStep) button.classList.add('is-playing');
        button.addEventListener('click', (event) => onKeyClick(button, event));
        buttons.set(`${track.id}:${step}`, button);
        if (!columns[step]) columns[step] = [];
        columns[step].push(button);
        rowSteps.append(button);
      }
      row.append(rowSteps);
      tape.append(row);
    }

    const gridlines = document.createElement('div');
    gridlines.className = 'seq-gridlines';
    gridlines.style.left = '132px';
    const pitch = width + STEP_GAP;
    for (let step = 0; step <= length; step += 4) {
      if (step === length && length % 16 !== 0) continue;
      const line = document.createElement('span');
      const bar = step % 16 === 0;
      line.className = bar ? 'seq-barline' : 'seq-beatline';
      line.dataset.step = String(step);
      const atEnd = step === length;
      const left = step === 0 ? 0 : atEnd ? length * pitch - STEP_GAP : step * pitch - STEP_GAP / 2;
      line.style.left = `${left}px`;
      gridlines.append(line);
    }
    tape.append(gridlines);
    container.append(tape);

    // The brush owns every drag on cells, so sideways travel lives on its own
    // slider — mirroring tape.scrollLeft in both directions.
    const scroll = document.createElement('input');
    scroll.type = 'range';
    scroll.className = 'seq-scroll';
    scroll.min = '0';
    scroll.step = '1';
    scroll.value = '0';
    scroll.setAttribute('aria-label', 'Scroll the drum grid');
    scroll.addEventListener('input', () => {
      tape.scrollLeft = Number(scroll.value);
    });
    tape.addEventListener('scroll', () => {
      scroll.value = String(tape.scrollLeft);
    });
    container.append(scroll);
    const syncScroll = () => {
      const room = Math.max(0, tape.scrollWidth - tape.clientWidth);
      scroll.max = String(room);
      scroll.value = String(Math.min(tape.scrollLeft, room));
      scroll.classList.toggle('is-empty', room <= 0);
    };
    resizer?.disconnect();
    resizer = new ResizeObserver(syncScroll);
    resizer.observe(tape);

    const lastRow = [...tape.querySelectorAll('.seq-row')].at(-1);
    if (lastRow) {
      gridlines.style.bottom = 'auto';
      gridlines.style.height = `${lastRow.offsetTop + lastRow.offsetHeight}px`;
    }
    tape.scrollLeft = previousLeft;
    tape.scrollTop = previousTop;
    syncScroll();
    markScrollEdges(tape, 'both');
  }

  function paintCell(track, step) {
    const button = buttons.get(`${track}:${step}`);
    if (button) paintCellButton(button, cell(track, step), mirrored(step));
  }

  function paintAll() {
    for (const [key, button] of buttons) {
      const split = key.lastIndexOf(':');
      const track = key.slice(0, split);
      const step = Number(key.slice(split + 1));
      paintCellButton(button, cell(track, step), mirrored(step));
    }
  }

  function setLit(step) {
    if (step === litStep) return;
    if (litStep >= 0) for (const button of columns[litStep] || []) button.classList.remove('is-playing');
    litStep = step;
    if (step >= 0) for (const button of columns[step] || []) button.classList.add('is-playing');
  }

  function destroy() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endStroke);
    window.removeEventListener('pointercancel', endStroke);
    resizer?.disconnect();
    strokes.clear();
    buttons.clear();
    columns.length = 0;
    tape = null;
  }

  return { render, paintCell, paintAll, setLit, destroy };
}
