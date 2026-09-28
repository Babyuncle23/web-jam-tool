/**
 * XY touch pad — guest devices (and the host monitor, in read-only mode).
 * Pointer Events only, so a mouse, a pen and up to N fingers behave the same.
 * Coordinates are normalised: x ∈ [0,1] left→right, y ∈ [0,1] bottom→top.
 */

import { CHORD_ZONE_EDGES } from '../audio/synth.js';
import { FX_PAD_DIVISIONS } from '../audio/effects.js';

/** 30 Hz is the cap: finer than the ear or the eye needs, far cheaper than 60. */
const THROTTLE_MS = 33;

/** Below this the move is inaudible and invisible, so it never leaves the device. */
const MIN_DELTA = 0.002;

export class TouchPad {
  #element;
  #handlers;
  #throttleMs;
  #lastSent = new Map();
  #lastPoint = new Map();
  #pendingPoint = new Map();
  #pendingTimer = new Map();
  #lastDirection = new Map();
  #locked = false;
  /** @type {Map<number, { x: number, y: number }>} */
  #pointers = new Map();
  #bound = {};

  constructor(element, { onStart, onMove, onEnd, throttleMs = THROTTLE_MS, locked = false } = {}) {
    if (!element) throw new Error('TouchPad needs a DOM element');
    this.#element = element;
    this.#handlers = { onStart, onMove, onEnd };
    this.#throttleMs = throttleMs;
    this.#locked = Boolean(locked);
    this.#element.classList.toggle('is-locked', this.#locked);
    this.#element.style.touchAction = 'none';

    this.#bound.down = (event) => this.#onDown(event);
    this.#bound.move = (event) => this.#onMove(event);
    this.#bound.up = (event) => this.#onUp(event);
    this.#bound.menu = (event) => event.preventDefault();
    this.#bound.touch = (event) => {
      if (event.cancelable) event.preventDefault();
    };

    this.#element.addEventListener('pointerdown', this.#bound.down);
    this.#element.addEventListener('pointermove', this.#bound.move);
    this.#element.addEventListener('pointerup', this.#bound.up);
    this.#element.addEventListener('pointercancel', this.#bound.up);
    this.#element.addEventListener('lostpointercapture', this.#bound.up);
    this.#element.addEventListener('touchstart', this.#bound.touch, { passive: false });
    this.#element.addEventListener('contextmenu', this.#bound.menu);
    this.#element.addEventListener('selectstart', this.#bound.menu);
  }

  get activePointers() {
    return this.#pointers;
  }

  get locked() {
    return this.#locked;
  }

  /** While the engine is cold, fingers must not start notes. */
  setLocked(locked) {
    const next = Boolean(locked);
    if (next === this.#locked) return;
    this.#locked = next;
    this.#element.classList.toggle('is-locked', next);
    if (!next) return;
    for (const pointerId of [...this.#pointers.keys()]) {
      const point = this.#pointers.get(pointerId);
      this.#forget(pointerId);
      this.#handlers.onEnd?.({ id: String(pointerId), ...point, type: 'up' });
    }
  }

  toNormalised(event) {
    const rect = this.#element.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = 1 - (event.clientY - rect.top) / rect.height;
    return {
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
      pressure: event.pressure > 0 ? event.pressure : 0.5,
    };
  }

  #direction(pointerId, point) {
    const previous = this.#lastPoint.get(pointerId);
    if (!previous || Math.abs(point.y - previous.y) < 0.01) {
      return this.#lastDirection.get(pointerId) ?? 'down';
    }
    const direction = point.y > previous.y ? 'up' : 'down';
    this.#lastDirection.set(pointerId, direction);
    return direction;
  }

  #onDown(event) {
    event.preventDefault();
    if (this.#locked) return;
    // A pointer that is not active (synthetic events, already released) throws
    // and would drop the note. Capture is an optimisation, not the gesture.
    try {
      this.#element.setPointerCapture?.(event.pointerId);
    } catch {
      // ignore
    }
    const point = { ...this.toNormalised(event), direction: 'down' };
    this.#pointers.set(event.pointerId, point);
    this.#lastSent.set(event.pointerId, performance.now());
    this.#lastPoint.set(event.pointerId, point);
    this.#lastDirection.set(event.pointerId, 'down');
    this.#handlers.onStart?.({ id: String(event.pointerId), ...point, type: 'down' });
  }

  #onMove(event) {
    if (!this.#pointers.has(event.pointerId)) return;
    event.preventDefault();
    const point = this.toNormalised(event);
    this.#pointers.set(event.pointerId, point);
    if (!this.#hasMoved(event.pointerId, point)) return;

    const waited = performance.now() - (this.#lastSent.get(event.pointerId) ?? 0);
    if (waited >= this.#throttleMs) {
      this.#emitMove(event.pointerId, point);
      return;
    }
    // Keep the freshest position and release it when the window closes, so a
    // finger that stops mid-gesture still lands on its real note.
    this.#pendingPoint.set(event.pointerId, point);
    if (this.#pendingTimer.has(event.pointerId)) return;
    const timer = setTimeout(() => {
      this.#pendingTimer.delete(event.pointerId);
      const pending = this.#pendingPoint.get(event.pointerId);
      this.#pendingPoint.delete(event.pointerId);
      if (pending && this.#pointers.has(event.pointerId)) this.#emitMove(event.pointerId, pending);
    }, this.#throttleMs - waited);
    this.#pendingTimer.set(event.pointerId, timer);
  }

  #hasMoved(pointerId, point) {
    const previous = this.#lastPoint.get(pointerId);
    if (!previous) return true;
    return Math.abs(previous.x - point.x) >= MIN_DELTA || Math.abs(previous.y - point.y) >= MIN_DELTA;
  }

  #emitMove(pointerId, point) {
    const payload = { ...point, direction: this.#direction(pointerId, point) };
    this.#lastSent.set(pointerId, performance.now());
    this.#lastPoint.set(pointerId, payload);
    this.#pointers.set(pointerId, payload);
    this.#handlers.onMove?.({ id: String(pointerId), ...payload, type: 'move' });
  }

  #onUp(event) {
    if (!this.#pointers.has(event.pointerId)) return;
    event.preventDefault();
    const point = this.#pointers.get(event.pointerId);
    this.#forget(event.pointerId);
    try {
      this.#element.releasePointerCapture?.(event.pointerId);
    } catch {
      // ignore
    }
    this.#handlers.onEnd?.({ id: String(event.pointerId), ...point, type: 'up' });
  }

  #forget(pointerId) {
    clearTimeout(this.#pendingTimer.get(pointerId));
    this.#pointers.delete(pointerId);
    this.#lastSent.delete(pointerId);
    this.#lastPoint.delete(pointerId);
    this.#lastDirection.delete(pointerId);
    this.#pendingPoint.delete(pointerId);
    this.#pendingTimer.delete(pointerId);
  }

  /** The finger is gone. Do not keep a note held for a pointer that left the page. */
  releaseHeld() {
    for (const pointerId of [...this.#pointers.keys()]) {
      const point = this.#pointers.get(pointerId);
      this.#forget(pointerId);
      try {
        this.#element.releasePointerCapture?.(pointerId);
      } catch {
        // The pointer was already gone.
      }
      this.#handlers.onEnd?.({ id: String(pointerId), ...point, type: 'up' });
    }
  }

  destroy() {
    this.#element.removeEventListener('pointerdown', this.#bound.down);
    this.#element.removeEventListener('pointermove', this.#bound.move);
    this.#element.removeEventListener('pointerup', this.#bound.up);
    this.#element.removeEventListener('pointercancel', this.#bound.up);
    this.#element.removeEventListener('lostpointercapture', this.#bound.up);
    this.#element.removeEventListener('touchstart', this.#bound.touch);
    this.#element.removeEventListener('contextmenu', this.#bound.menu);
    this.#element.removeEventListener('selectstart', this.#bound.menu);
    for (const pointerId of [...this.#pointers.keys()]) {
      const point = this.#pointers.get(pointerId);
      this.#forget(pointerId);
      this.#handlers.onEnd?.({ id: String(pointerId), ...point, type: 'up' });
    }
  }
}

const GLOW_RADIUS = 64;
const RESIZE_DEBOUNCE_MS = 150;

/**
 * Draws live finger positions plus the note grid on a canvas overlay.
 * Strictly event-driven: a frame is requested only when a point actually
 * changes, and a still finger costs nothing. The glow and the grid are
 * pre-rendered once, so a frame is a couple of `drawImage` calls.
 */
export class TouchPadRenderer {
  #canvas;
  #ctx;
  #points = new Map();
  #marks = [];
  #columns;
  #mode = 'single';
  #frame = null;
  #glow = null;
  #grid = null;
  #size = { width: 0, height: 0 };
  #resizeTimer = null;
  #onResize;

  constructor(canvas, { columns = 12 } = {}) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d');
    this.#columns = columns;
    this.#buildGlow();
    this.resize();
    this.#onResize = () => {
      clearTimeout(this.#resizeTimer);
      this.#resizeTimer = setTimeout(() => this.resize(), RESIZE_DEBOUNCE_MS);
    };
    window.addEventListener('resize', this.#onResize);
    window.addEventListener('orientationchange', this.#onResize);
  }

  setColumns(columns) {
    this.#columns = columns;
    this.#buildGrid();
    this.#schedule();
  }

  /**
   * 'single' draws scale columns, 'chords' adds the Y zone borders the DOM
   * labels describe, 'fx' swaps the grid for stutter zones + a filter shade.
   */
  setMode(mode) {
    const next = mode === 'chords' || mode === 'fx' ? mode : 'single';
    if (next === this.#mode) return;
    this.#mode = next;
    this.#buildGrid();
    this.#schedule();
  }

  resize() {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.#canvas.getBoundingClientRect();
    this.#size = { width: rect.width, height: rect.height };
    this.#canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    this.#canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    this.#ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.#buildGrid();
    this.#schedule();
  }

  update(id, point) {
    if (point) this.#points.set(id, { x: point.x, y: point.y });
    else this.#points.delete(id);
    this.#schedule();
  }

  /** Recorded-note dots. One frame, no polling loop. */
  setMarks(marks) {
    this.#marks = Array.isArray(marks) ? marks : [];
    this.#schedule();
  }

  clear() {
    if (!this.#points.size) return;
    this.#points.clear();
    this.#schedule();
  }

  destroy() {
    window.removeEventListener('resize', this.#onResize);
    window.removeEventListener('orientationchange', this.#onResize);
    clearTimeout(this.#resizeTimer);
    if (this.#frame) cancelAnimationFrame(this.#frame);
    this.#frame = null;
    this.#points.clear();
    this.#marks = [];
  }

  #buildGlow() {
    const size = GLOW_RADIUS * 2;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(GLOW_RADIUS, GLOW_RADIUS, 2, GLOW_RADIUS, GLOW_RADIUS, GLOW_RADIUS);
    gradient.addColorStop(0, 'rgba(242, 193, 75, 0.95)');
    gradient.addColorStop(1, 'rgba(242, 193, 75, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#fff6e4';
    ctx.strokeStyle = '#1c140c';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(GLOW_RADIUS, GLOW_RADIUS, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    this.#glow = canvas;
  }

  #buildGrid() {
    const { width, height } = this.#size;
    if (width < 1 || height < 1) return;
    const ratio = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (this.#mode === 'fx') {
      this.#paintFxGrid(ctx, width, height);
      this.#grid = canvas;
      return;
    }
    ctx.strokeStyle = 'rgba(28, 20, 12, 0.16)';
    ctx.lineWidth = 1;
    for (let i = 1; i < this.#columns; i += 1) {
      const x = (width / this.#columns) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    if (this.#mode === 'chords') {
      ctx.strokeStyle = 'rgba(28, 20, 12, 0.34)';
      ctx.lineWidth = 2;
      for (const edge of CHORD_ZONE_EDGES) {
        const y = (1 - edge) * height;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
    }
    this.#grid = canvas;
  }

  /**
   * FX mode: X picks the stutter division — the left zone is filter-only,
   * then slice lines pack tighter towards the right. Y is bipolar around the
   * mid line: above it the highpass thins the lows (lighter shade), below it
   * the lowpass closes the highs (darker shade). Labels sit in the canvas.
   */
  #paintFxGrid(ctx, width, height) {
    const mid = height / 2;
    const topShade = ctx.createLinearGradient(0, 0, 0, mid);
    topShade.addColorStop(0, 'rgba(255, 250, 235, 0.5)');
    topShade.addColorStop(1, 'rgba(255, 250, 235, 0)');
    ctx.fillStyle = topShade;
    ctx.fillRect(0, 0, width, mid);
    const bottomShade = ctx.createLinearGradient(0, mid, 0, height);
    bottomShade.addColorStop(0, 'rgba(28, 20, 12, 0)');
    bottomShade.addColorStop(1, 'rgba(28, 20, 12, 0.22)');
    ctx.fillStyle = bottomShade;
    ctx.fillRect(0, mid, width, height - mid);

    // The neutral line: a finger resting on the middle applies no filter.
    ctx.strokeStyle = 'rgba(28, 20, 12, 0.55)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();
    ctx.setLineDash([]);

    const zones = FX_PAD_DIVISIONS.length;
    const zoneWidth = width / zones;
    for (let z = 0; z < zones; z += 1) {
      const left = zoneWidth * z;
      if (z > 0) {
        ctx.strokeStyle = 'rgba(28, 20, 12, 0.5)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(left, 0);
        ctx.lineTo(left, height);
        ctx.stroke();
      }
      // Zone 0 has no slices — it is the filter-only lane. The rest get
      // 1, 2, 4, 8 slices: the right edge reads as the fastest cut.
      const slices = z === 0 ? 0 : 2 ** (z - 1);
      ctx.strokeStyle = 'rgba(28, 20, 12, 0.16)';
      ctx.lineWidth = 1;
      for (let i = 1; i < slices; i += 1) {
        const x = left + (zoneWidth / slices) * i;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(28, 20, 12, 0.78)';
      ctx.font = '800 16px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = z === 0 ? '—' : `1/${FX_PAD_DIVISIONS[z].replace('n', '')}`;
      ctx.fillText(label, left + zoneWidth / 2, height - 62);
    }

    ctx.fillStyle = 'rgba(28, 20, 12, 0.5)';
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('low cut', width - 10, 16);
    ctx.fillText('open', width - 10, mid - 6);
    ctx.fillText('high cut', width - 10, height - 14);
  }

  #schedule() {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.#draw();
    });
  }

  #draw() {
    const { width, height } = this.#size;
    const ctx = this.#ctx;
    ctx.clearRect(0, 0, width, height);
    if (this.#grid) ctx.drawImage(this.#grid, 0, 0, width, height);

    // The strip the finger plays: its scale column, plus the chord zone it
    // sits in when the pad is in chords mode. FX fingers light their stutter
    // zone and shade the filtered-away half — dark below for the lowpass,
    // light above for the highpass.
    const columnWidth = width / this.#columns;
    const zoneBounds = [0, ...CHORD_ZONE_EDGES, 1];
    for (const point of this.#points.values()) {
      if (this.#mode === 'fx') {
        const zones = FX_PAD_DIVISIONS.length;
        const zone = Math.min(zones - 1, Math.max(0, Math.floor(point.x * zones)));
        ctx.fillStyle = 'rgba(242, 193, 75, 0.24)';
        ctx.fillRect(zone * (width / zones), 0, width / zones, height);
        const fingerY = (1 - point.y) * height;
        if (fingerY > height / 2) {
          ctx.fillStyle = 'rgba(28, 20, 12, 0.14)';
          ctx.fillRect(0, fingerY, width, height - fingerY);
        } else {
          ctx.fillStyle = 'rgba(255, 250, 235, 0.35)';
          ctx.fillRect(0, 0, width, fingerY);
        }
        continue;
      }
      if (this.#mode === 'chords') {
        let zone = 0;
        while (zone < CHORD_ZONE_EDGES.length && point.y >= CHORD_ZONE_EDGES[zone]) zone += 1;
        const top = (1 - zoneBounds[zone + 1]) * height;
        const bottom = (1 - zoneBounds[zone]) * height;
        ctx.fillStyle = 'rgba(47, 143, 85, 0.16)';
        ctx.fillRect(0, top, width, bottom - top);
      }
      const column = Math.min(this.#columns - 1, Math.max(0, Math.floor(point.x * this.#columns)));
      ctx.fillStyle = 'rgba(242, 193, 75, 0.24)';
      ctx.fillRect(column * columnWidth, 0, columnWidth, height);
    }

    for (const mark of this.#marks) {
      const x = mark.x * width;
      const y = (1 - mark.y) * height;
      ctx.beginPath();
      ctx.arc(x, y, 16, 0, Math.PI * 2);
      ctx.fillStyle = mark.color || '#e2b43a';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#1c140c';
      ctx.stroke();
    }

    for (const point of this.#points.values()) {
      const x = point.x * width;
      const y = (1 - point.y) * height;
      ctx.drawImage(this.#glow, x - GLOW_RADIUS, y - GLOW_RADIUS);
    }
  }
}
