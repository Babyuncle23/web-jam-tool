/**
 * One drum-step grid shared by the host sheet and the guest sheet.
 * A tap on a cell writes or erases a note; drags belong to scrolling, so a
 * release click after a long pull is swallowed once. The view owns the data
 * and any repeat-mirror expansion; the grid owns the DOM, the gestures, and
 * the playhead column.
 */

import { pressable } from './quiet-touch.js';
import { markScrollEdges } from './scroll-edges.js';

const STEP_GAP = 3;
/** A release this far from the touchdown was a drag, not a tap. */
const TAP_PX2 = 10 * 10;

/** Steps begin after the sticky label column — its width shrinks on phones. */
function labelWidth(tape) {
  const w = tape ? parseFloat(getComputedStyle(tape).getPropertyValue('--seq-label-w')) : 0;
  return w > 0 ? w : 132;
}

function paintCellButton(button, slot, mirrored) {
  const on = Boolean(slot?.on);
  const triplet = on && slot?.division === 3;
  button.classList.toggle('is-on', on);
  button.classList.toggle('is-triplet', triplet);
  button.classList.toggle('is-mirror', Boolean(mirrored));
  button.textContent = triplet ? '3' : '';
}

/**
 * What a tap writes. Triplet mode stamps triplets; a tap on a matching cell
 * erases instead.
 */
function tapValue(mode, slot) {
  if (mode === 'triplet') {
    return slot?.on && slot.division === 3 ? { on: false, division: 1 } : { on: true, division: 3 };
  }
  return slot?.on ? { on: false, division: 1 } : { on: true, division: 1 };
}

/**
 * @param {HTMLElement} container `.sequencer` element the tape is rendered into
 * @param {object} options
 * @param {Array<{id: string, label: string, shortLabel?: string}>} options.tracks row order
 * @param {() => number} options.steps live step count
 * @param {(track: string, step: number) => ({on: boolean, division: number}|null)} options.cell
 * @param {() => number} options.cellPx cell size in px
 * @param {(track: {id: string}) => Node|null} [options.iconFor] row icon
 * @param {() => number} [options.mirrorSpan] active repeat span in steps, 0 = off
 * @param {() => string} [options.writeMode] 'single' | 'triplet'
 * @param {(track: string, step: number, value: {on: boolean, division: number}) => void} options.applyCell
 * @param {(phase: 'end') => void} [options.onGesture] fired after a write so the view can commit
 * @param {(nextPx: number) => number} [options.onZoom] pinch/wheel zoom: sets the cell size, returns the applied px
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
    onZoom = null,
  } = options;

  let tape = null;
  let resizer = null;
  let litStep = -1;
  let panDown = null;
  let pinch = null;
  let blockUntil = 0;
  const pointers = new Map();
  const buttons = new Map();
  const columns = [];

  function mirrored(step) {
    const span = Number(mirrorSpan()) || 0;
    return span > 0 && step >= span;
  }

  /**
   * Clicks write cells; drags pan the tape on both axes (leftover vertical
   * motion scrolls the sheet card), two fingers pinch-zoom the cell size.
   * A release click that follows a pull or a pinch is not a tap — clicks are
   * swallowed for a short window after the gesture ends.
   */
  function onPointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2 && !pinch && tape) {
      const [a, b] = [...pointers.values()];
      const rect = tape.getBoundingClientRect();
      pinch = {
        d0: Math.max(24, Math.hypot(a.x - b.x, a.y - b.y)),
        px0: Math.max(8, cellPx()),
        anchorX: tape.scrollLeft + (a.x + b.x) / 2 - rect.left - labelWidth(tape),
        anchorY: tape.scrollTop + (a.y + b.y) / 2 - rect.top,
        raf: 0,
      };
      panDown = null;
      return;
    }
    if (pointers.size > 2) return;
    panDown = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: tape?.scrollLeft ?? 0,
      top: tape?.scrollTop ?? 0,
      panned: false,
      pinched: Boolean(pinch),
    };
  }

  function applyPinch() {
    if (!pinch) return;
    pinch.raf = 0;
    const [a, b] = [...pointers.values()];
    if (!a || !b || !tape) return;
    const rect = tape.getBoundingClientRect();
    const spread = Math.hypot(a.x - b.x, a.y - b.y);
    const wanted = pinch.px0 * Math.max(0.2, Math.min(6, spread / pinch.d0));
    const applied = onZoom?.(wanted) ?? wanted;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    tape.scrollLeft = Math.max(0, labelWidth(tape) + pinch.anchorX * (applied / pinch.px0) - (midX - rect.left));
    tape.scrollTop = Math.max(0, pinch.anchorY - (midY - rect.top));
  }

  function onPointerMove(event) {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX;
    point.y = event.clientY;
    if (pinch) {
      if (event.cancelable) event.preventDefault();
      if (!pinch.raf) pinch.raf = requestAnimationFrame(applyPinch);
      return;
    }
    if (!panDown || event.pointerId !== panDown.id || !tape) return;
    const dx = event.clientX - panDown.x;
    const dy = event.clientY - panDown.y;
    if (!panDown.panned && dx * dx + dy * dy < 36) return;
    panDown.panned = true;
    if (event.cancelable) event.preventDefault();
    tape.scrollLeft = panDown.left - dx;
    const wanted = panDown.top - dy;
    tape.scrollTop = wanted;
    const rest = wanted - tape.scrollTop;
    const card = tape.closest('.fx-sheet__card');
    if (rest && card) card.scrollTop += rest;
  }

  function onPointerUp(event) {
    pointers.delete(event.pointerId);
    if (pinch) {
      if (pinch.raf) cancelAnimationFrame(pinch.raf);
      applyPinch();
      pinch = null;
      blockUntil = performance.now() + 350;
      // A finger still on the glass keeps panning instead of writing a cell.
      const remaining = [...pointers.entries()][0];
      panDown = remaining
        ? {
            id: remaining[0],
            x: remaining[1].x,
            y: remaining[1].y,
            left: tape?.scrollLeft ?? 0,
            top: tape?.scrollTop ?? 0,
            panned: true,
            pinched: true,
          }
        : null;
      return;
    }
    if (!panDown || event.pointerId !== panDown.id) return;
    const dx = event.clientX - panDown.x;
    const dy = event.clientY - panDown.y;
    const suppress = panDown.pinched || dx * dx + dy * dy > TAP_PX2;
    panDown = null;
    if (suppress) blockUntil = performance.now() + 350;
  }

  function onPointerCancel(event) {
    pointers.delete(event.pointerId);
    if (pinch) {
      if (pinch.raf) cancelAnimationFrame(pinch.raf);
      pinch = null;
      panDown = null;
      blockUntil = performance.now() + 350;
      return;
    }
    if (panDown?.id === event.pointerId) panDown = null;
  }

  function onTapeClick(event) {
    if (performance.now() >= blockUntil) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onWheel(event) {
    if (!tape) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const px0 = Math.max(8, cellPx());
      const rect = tape.getBoundingClientRect();
      const anchorX = tape.scrollLeft + event.clientX - rect.left - labelWidth(tape);
      const wanted = px0 * (event.deltaY < 0 ? 1.15 : 1 / 1.15);
      const applied = onZoom?.(wanted) ?? wanted;
      tape.scrollLeft = Math.max(0, labelWidth(tape) + anchorX * (applied / px0) - (event.clientX - rect.left));
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      tape.scrollLeft += event.deltaY || event.deltaX;
    }
  }

  function onKeyClick(button) {
    const track = button.dataset.track;
    const step = Number(button.dataset.step);
    applyCell(track, step, tapValue(writeMode(), cell(track, step)));
    onGesture('end');
  }

  /* Window-level move/up: the tape node is rebuilt on every render, so a
     pointer captured by an old tape would leave the gesture without events. */
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);

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
    tape.addEventListener('wheel', onWheel, { passive: false });
    tape.addEventListener('click', onTapeClick, true);

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
      name.className = 'seq-row__name';
      name.textContent = track.label;
      const short = document.createElement('span');
      short.className = 'seq-row__short';
      short.textContent = track.shortLabel || track.label;
      label.append(name, short);
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
        button.addEventListener('click', () => onKeyClick(button));
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

    // Drags pan the tape themselves; this range mirrors tape.scrollLeft as a
    // scrollbar-shaped fallback for anyone who needs one (accessibility).
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
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    resizer?.disconnect();
    panDown = null;
    pinch = null;
    pointers.clear();
    blockUntil = 0;
    buttons.clear();
    columns.length = 0;
    tape = null;
  }

  return { render, paintCell, paintAll, setLit, destroy };
}
