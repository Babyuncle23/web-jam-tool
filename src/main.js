/**
 * Entry point: role picker → HOST view or CONTROLLER view.
 * The heavy modules are imported lazily so a guest phone never downloads the
 * host-only audio code.
 */

import { markPageEdges } from './ui/scroll-edges.js';
import { installQuietTouch } from './ui/quiet-touch.js';

installQuietTouch(document.getElementById('host-screen'), document.getElementById('controller-screen'));

const screens = {
  role: document.getElementById('role-screen'),
  host: document.getElementById('host-screen'),
  controller: document.getElementById('controller-screen'),
};

let activeView = null;

function showScreen(name) {
  for (const [key, element] of Object.entries(screens)) element.hidden = key !== name;
  document.body.dataset.view = name;
  markPageEdges();
}

async function enterHost() {
  const { createHostView } = await import('./views/host.js');
  activeView?.destroy?.();
  showScreen('host');
  activeView = await createHostView();
}

async function enterController(code) {
  const { createControllerView } = await import('./views/controller.js');
  activeView?.destroy?.();
  showScreen('controller');
  activeView = await createControllerView({ code });
}

function backToRolePicker() {
  activeView?.destroy?.();
  activeView = null;
  showScreen('role');
  history.replaceState(null, '', location.pathname);
}

document.getElementById('btn-role-host').addEventListener('click', () => {
  enterHost().catch((error) => console.error('[host]', error));
});

const joinForm = document.getElementById('join-form');
const joinError = document.getElementById('join-error');

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

for (const button of document.querySelectorAll('[data-action="back"]')) {
  button.addEventListener('click', backToRolePicker);
}

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
if (params.get('role') === 'host') {
  enterHost().catch((error) => console.error('[host]', error));
} else if (params.get('role') === 'controller' && params.get('code')) {
  document.getElementById('join-code').value = params.get('code').toUpperCase();
  enterController(params.get('code').toUpperCase()).catch((error) => {
    showScreen('role');
    joinError.textContent = `Could not connect: ${error.message}`;
    joinError.hidden = false;
  });
}

markPageEdges();
