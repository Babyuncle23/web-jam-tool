/**
 * Entry point: role picker → HOST view or CONTROLLER view.
 * The heavy modules are imported lazily so a guest phone never downloads the
 * host-only audio code.
 */

import { markPageEdges } from './ui/scroll-edges.js';
import { installQuietTouch } from './ui/quiet-touch.js';
import { initRoleExtras } from './ui/install-share.js';
import { loadScript } from './network/load-script.js';
import { LITE } from './audio/effects.js';

/** Tone.js is ~1.5 MB of UMD and only the host evaluates it — fetch on demand, not for guest phones. */
const TONE_SRC = 'https://cdn.jsdelivr.net/npm/tone@15.0.4/build/Tone.js';

installQuietTouch(document.getElementById('host-screen'), document.getElementById('controller-screen'));
initRoleExtras();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

const screens = {
  role: document.getElementById('role-screen'),
  host: document.getElementById('host-screen'),
  controller: document.getElementById('controller-screen'),
};

/**
 * Pristine copies of the two app screens, taken before any view attaches
 * listeners or fills them in. Re-entering a role starts from this DOM — the
 * same state a fresh page load would have — so leftover listeners from a
 * destroyed view cannot fire twice (or fight the new view's state).
 */
const pristineScreens = {
  host: screens.host.cloneNode(true),
  controller: screens.controller.cloneNode(true),
};

function resetScreen(name) {
  const fresh = pristineScreens[name].cloneNode(true);
  screens[name].replaceWith(fresh);
  screens[name] = fresh;
}

let activeView = null;

function showScreen(name) {
  for (const [key, element] of Object.entries(screens)) element.hidden = key !== name;
  document.body.dataset.view = name;
  markPageEdges();
}

const hostButton = document.getElementById('btn-role-host');
const liteCheck = document.getElementById('role-lite');

function hostButtonLabel() {
  return liteCheck?.checked ? 'Open host — Lite' : 'Open host';
}

function setHostLoading(loading) {
  hostButton.disabled = loading;
  hostButton.classList.toggle('is-loading', loading);
  hostButton.textContent = loading ? 'Loading sound…' : hostButtonLabel();
}

async function enterHost(lite = false) {
  // Tone installs itself as a global, so it must finish before host.js runs.
  // Warming it at role entry hides the CDN delay behind the "Start sound" tap.
  setHostLoading(true);
  try {
    await loadScript(TONE_SRC);
    const { createHostView } = await import('./views/host.js');
    activeView?.destroy?.();
    resetScreen('host');
    showScreen('host');
    activeView = await createHostView({ lite: lite ? LITE : null });
  } finally {
    setHostLoading(false);
  }
}

async function enterController(code) {
  const { createControllerView } = await import('./views/controller.js');
  activeView?.destroy?.();
  resetScreen('controller');
  showScreen('controller');
  activeView = await createControllerView({ code });
}

function backToRolePicker() {
  activeView?.destroy?.();
  activeView = null;
  showScreen('role');
  history.replaceState(null, '', location.pathname);
}

const joinForm = document.getElementById('join-form');
const joinError = document.getElementById('join-error');

function hostOpenFailed(error) {
  console.error('[host]', error);
  activeView?.destroy?.();
  activeView = null;
  showScreen('role');
  joinError.textContent = `Could not open the host: ${error.message}`;
  joinError.hidden = false;
}

document.getElementById('btn-role-host').addEventListener('click', () => {
  enterHost(liteCheck?.checked).catch(hostOpenFailed);
});

joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = String(new FormData(joinForm).get('code') || '').trim().toUpperCase();
  joinError.hidden = true;
  if (code.length !== 4) {
    joinError.textContent = 'The session code is 4 characters. Read it on the host screen.';
    joinError.hidden = false;
    return;
  }
  try {
    await enterController(code);
  } catch (error) {
    showScreen('role');
    joinError.textContent =
      error?.message === 'SESSION_NOT_FOUND'
        ? 'No session with that code. Check the host screen.'
        : `Could not connect: ${error.message}`;
    joinError.hidden = false;
  }
});

// Delegated: the back buttons live inside screens that resetScreen replaces.
document.addEventListener('click', (event) => {
  if (event.target.closest('[data-action="back"]')) backToRolePicker();
});

document.addEventListener('gesturestart', (event) => event.preventDefault());
document.addEventListener(
  'touchmove',
  (event) => {
    if (document.body.dataset.view === 'role') return;
    if (event.touches.length > 1) event.preventDefault();
  },
  { passive: false },
);

const params = new URLSearchParams(location.search);

/** Weak-device heuristic for the lite default; ?lite=1|0 overrides it. */
function detectLiteHost() {
  const cores = Number(navigator.hardwareConcurrency) || 8;
  const memory = Number(navigator.deviceMemory) || 8;
  return cores <= 4 || memory <= 4;
}

if (liteCheck) {
  const liteParam = params.get('lite');
  liteCheck.checked = liteParam == null ? detectLiteHost() : ['1', 'true'].includes(liteParam);
  liteCheck.addEventListener('change', () => {
    hostButton.textContent = hostButtonLabel();
  });
  hostButton.textContent = hostButtonLabel();
}

if (params.get('role') === 'host') {
  enterHost(liteCheck?.checked).catch(hostOpenFailed);
} else if (params.get('role') === 'controller' && params.get('code')) {
  document.getElementById('join-code').value = params.get('code').toUpperCase();
  enterController(params.get('code').toUpperCase()).catch((error) => {
    showScreen('role');
    joinError.textContent = `Could not connect: ${error.message}`;
    joinError.hidden = false;
  });
}

markPageEdges();
