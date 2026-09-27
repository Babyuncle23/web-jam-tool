/**
 * Phone controls should not buzz, select text, or wait on a click.
 * Host and guest buttons are divs with role="button": a real <button>
 * is what iOS vibrates. The note still leaves on pointerdown.
 * A slider keeps its own pointer and touch id, so it keeps moving while
 * another finger holds Stutter.
 */

export function pressable(className = '') {
  const el = document.createElement('div');
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  if (className) el.className = className;
  return el;
}

export function setControlEnabled(el, enabled) {
  if (!el) return;
  const on = Boolean(enabled);
  el.disabled = !on;
  if (on) el.removeAttribute('aria-disabled');
  else el.setAttribute('aria-disabled', 'true');
  el.tabIndex = on ? 0 : -1;
}

function softenButtons(root) {
  for (const button of [...root.querySelectorAll('button')]) {
    const div = document.createElement('div');
    div.setAttribute('role', 'button');
    for (const attr of [...button.attributes]) {
      if (attr.name === 'type') continue;
      div.setAttribute(attr.name, attr.value);
    }
    if (button.disabled || button.hasAttribute('disabled')) div.setAttribute('aria-disabled', 'true');
    div.tabIndex = div.getAttribute('aria-disabled') === 'true' ? -1 : 0;
    while (button.firstChild) div.append(button.firstChild);
    button.replaceWith(div);
  }
}

function quietTarget(node) {
  return node?.closest?.('.pad, .btn, .chip, .step, .mix-flag, .stutter-hold, .roll__note, .roll__key, input[type="range"], [role="button"]') || null;
}

/**
 * The quiet rules only apply inside the two jam screens, where buttons were
 * softened into div[role="button"]. The role picker and the "server is full"
 * overlay keep native <button> elements: a suppressed native click with no
 * synthesized replacement leaves them dead on touch devices.
 */
function inJamScreen(node) {
  return Boolean(node?.closest?.('#host-screen, #controller-screen'));
}

function wantsClick(el) {
  if (!el || !el.isConnected) return false;
  if (el.getAttribute('aria-disabled') === 'true' || el.disabled) return false;
  if (el.closest('.pad')) return false;
  if (el.matches('.stutter-hold, .roll__note, .roll__key, input')) return false;
  return el.matches('[role="button"]');
}

function writeRange(input, clientX) {
  const rect = input.getBoundingClientRect();
  const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const step = Number(input.step || 1);
  let value = min + ratio * (max - min);
  if (step > 0) value = Math.round((value - min) / step) * step + min;
  value = Math.min(max, Math.max(min, value));
  const next = String(value);
  if (input.value === next) return;
  input.value = next;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function armRangePointer(input, event) {
  const pointerId = event.pointerId;
  if (input.__rangePointer === pointerId) return;
  input.__rangePointer = pointerId;
  try {
    input.setPointerCapture(pointerId);
  } catch {
    // Window tracking still follows this pointer if capture is refused.
  }
  const move = (ev) => {
    if (ev.pointerId !== pointerId) return;
    if (ev.cancelable) ev.preventDefault();
    writeRange(input, ev.clientX);
  };
  const end = (ev) => {
    if (ev.pointerId !== pointerId) return;
    if (input.__rangePointer === pointerId) input.__rangePointer = null;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
  };
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  writeRange(input, event.clientX);
}

function armRangeTouch(input, touch) {
  const id = touch.identifier;
  if (input.__rangeTouch === id) return;
  input.__rangeTouch = id;
  const move = (ev) => {
    const current = [...ev.touches].find((item) => item.identifier === id);
    if (!current) return;
    if (ev.cancelable) ev.preventDefault();
    writeRange(input, current.clientX);
  };
  const end = (ev) => {
    if (![...ev.changedTouches].some((item) => item.identifier === id)) return;
    if (input.__rangeTouch === id) input.__rangeTouch = null;
    input.removeEventListener('touchmove', move);
    input.removeEventListener('touchend', end);
    input.removeEventListener('touchcancel', end);
  };
  input.addEventListener('touchmove', move, { passive: false });
  input.addEventListener('touchend', end);
  input.addEventListener('touchcancel', end);
  writeRange(input, touch.clientX);
}

function rangeInJam(node) {
  const input = node?.closest?.('input[type="range"]');
  if (!input?.closest('#host-screen, #controller-screen')) return null;
  return input;
}

/**
 * @param {...HTMLElement} roots host and guest screens, softened before views bind them
 */
export function installQuietTouch(...roots) {
  for (const root of roots) {
    if (root) softenButtons(root);
  }

  const pending = new Map();
  let suppressClick = null;
  let suppressAt = 0;

  document.addEventListener(
    'touchstart',
    (event) => {
      let quiet = false;
      for (const touch of event.changedTouches) {
        if (!inJamScreen(touch.target)) continue;
        const range = rangeInJam(touch.target);
        if (range) {
          armRangeTouch(range, touch);
          quiet = true;
          continue;
        }
        const el = quietTarget(touch.target);
        if (!el) continue;
        quiet = true;
        pending.set(touch.identifier, { el, x: touch.clientX, y: touch.clientY });
      }
      if (quiet && event.cancelable) event.preventDefault();
    },
    { passive: false, capture: true },
  );

  document.addEventListener(
    'touchend',
    (event) => {
      for (const touch of event.changedTouches) {
        const armed = pending.get(touch.identifier);
        pending.delete(touch.identifier);
        if (!armed) continue;
        if (Math.hypot(touch.clientX - armed.x, touch.clientY - armed.y) > 12) continue;
        if (!wantsClick(armed.el)) continue;
        suppressClick = armed.el;
        suppressAt = performance.now();
        armed.el.click();
      }
    },
    { capture: true },
  );

  document.addEventListener(
    'touchcancel',
    (event) => {
      for (const touch of event.changedTouches) pending.delete(touch.identifier);
    },
    { capture: true },
  );

  document.addEventListener(
    'click',
    (event) => {
      if (!event.isTrusted || !suppressClick) return;
      if (performance.now() - suppressAt > 700) return;
      const hit = event.target?.closest?.('[role="button"], .chip, .step, .mix-flag');
      if (hit && (hit === suppressClick || suppressClick.contains(event.target))) {
        event.stopPropagation();
        event.preventDefault();
      }
    },
    true,
  );

  const blockMenu = (event) => {
    if (quietTarget(event.target) && inJamScreen(event.target)) event.preventDefault();
  };
  document.addEventListener('contextmenu', blockMenu, true);
  document.addEventListener('selectstart', blockMenu, true);

  document.addEventListener(
    'pointerdown',
    (event) => {
      const input = rangeInJam(event.target);
      if (!input) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (event.cancelable) event.preventDefault();
      armRangePointer(input, event);
    },
    true,
  );

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const el = event.target?.closest?.('[role="button"]');
    if (!el || !inJamScreen(el)) return;
    if (el.getAttribute('aria-disabled') === 'true') return;
    event.preventDefault();
    el.click();
  });
}
