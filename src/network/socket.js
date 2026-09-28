/**
 * Network layer. Guests emit touches, the host receives them and sounds them.
 * Thin wrapper over the Socket.io client so the UI never touches raw events.
 *
 * Local pages talk to this same machine. A public page (GitHub Pages) has no
 * backend, so it talks to the Socket.io server hosted on Render.
 */

/**
 * Cloud Socket.io origin (Render). Keep it in sync with the Render service
 * name: https://<service>.onrender.com
 */
export const PUBLIC_BACKEND_URL = 'https://web-jam-tool.onrender.com';

export function isLocalHostname(hostname) {
  const host = String(hostname || '');
  return host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.') || host.startsWith('10.');
}

/**
 * Where the browser opens the Socket.io connection. Local dev and LAN jams
 * talk to the server that served the page; the public build on GitHub Pages
 * switches to the Render backend instead.
 */
export function socketServerUrl(page = globalThis.location) {
  if (!page?.origin) return PUBLIC_BACKEND_URL;
  if (isLocalHostname(page.hostname)) return page.origin;
  return PUBLIC_BACKEND_URL || page.origin;
}

const SERVER_FULL_MESSAGE = 'Server is full';
const SERVER_FULL_RETRY_MS = 2500;

/** Continuous controls go out at most this often; the trailing value always lands. */
const CONTROL_THROTTLE_MS = 50;

/**
 * Coalesce key for a control patch: the field names plus the nested target
 * (instrument / effect id / the masterFx field set), so two different
 * sliders never overwrite each other's pending value.
 */
function controlSlotKey(control) {
  const keys = [];
  for (const [field, value] of Object.entries(control)) {
    if (!value || typeof value !== 'object') {
      keys.push(field);
      continue;
    }
    const target = value.instrument
      ? `${value.instrument}/${value.id ?? ''}`
      : Object.keys(value).sort().join(',');
    keys.push(`${field}:${target}`);
  }
  return keys.join('|');
}

/** True when a connect_error came from the server's capacity gate. */
export function isServerFullError(error) {
  const text = `${error?.message ?? ''} ${error?.data?.message ?? ''}`.toLowerCase();
  return text.includes(SERVER_FULL_MESSAGE.toLowerCase());
}

export const EVENTS = {
  hostCreate: 'host:create',
  controllerJoin: 'controller:join',
  touch: 'controller:touch',
  control: 'controller:control',
  hostState: 'host:state',
  pulse: 'host:pulse',
  peerJoin: 'peer:join',
  peerLeave: 'peer:leave',
  sessionClosed: 'session:closed',
};

export class JamSocket {
  #io;
  #socket = null;
  #listeners = new Map();
  #role = null;
  #code = null;
  #shared = {};
  #waitingForSlot = false;
  #slotTimer = 0;
  #controlPending = new Map();
  #controlTimer = 0;
  #controlSentAt = 0;

  constructor({ io = globalThis.io, url } = {}) {
    if (!io) throw new Error('Socket.io client is not loaded');
    this.#io = io;
    this.url = url === undefined ? socketServerUrl() : url;
    const retry = this.#waitingOverlay()?.querySelector('#server-full-retry');
    retry?.addEventListener('click', () => this.#retryNow());
  }

  get socket() {
    return this.#socket;
  }

  get connected() {
    return Boolean(this.#socket?.connected);
  }

  get role() {
    return this.#role;
  }

  get code() {
    return this.#code;
  }

  connect() {
    if (this.#socket) {
      // A dropped socket that will not auto-reconnect (e.g. the server closed
      // it) must be poked, or the next request just sits in the emit buffer.
      if (!this.#socket.connected && !this.#socket.active) this.#socket.connect();
      return this.#socket;
    }
    this.#socket = this.url ? this.#io(this.url) : this.#io();
    this.#socket.on('connect', () => this.#setWaitingForSlot(false));
    this.#socket.on('connect_error', (error) => {
      if (isServerFullError(error)) this.#setWaitingForSlot(true);
    });
    for (const [event, callbacks] of this.#listeners) {
      for (const callback of callbacks) this.#socket.on(event, callback);
    }
    return this.#socket;
  }

  /** Full-screen "server is full" gate from index.html, if this page has it. */
  #waitingOverlay() {
    return typeof document === 'undefined' ? null : document.getElementById('server-full');
  }

  #setWaitingForSlot(on) {
    this.#waitingForSlot = on;
    const overlay = this.#waitingOverlay();
    if (overlay) overlay.hidden = !on;
    clearTimeout(this.#slotTimer);
    // Every failed attempt reschedules one manual retry — this keeps the
    // queue moving even where the manager would not reconnect on its own.
    if (on) this.#slotTimer = setTimeout(() => this.#retryNow(), SERVER_FULL_RETRY_MS);
  }

  #retryNow() {
    if (!this.#waitingForSlot || !this.#socket || this.#socket.connected) return;
    this.#socket.connect();
  }

  on(event, callback) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(callback);
    this.#socket?.on(event, callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    this.#listeners.get(event)?.delete(callback);
    this.#socket?.off(event, callback);
  }

  #request(event, payload) {
    return new Promise((resolve, reject) => {
      const socket = this.connect();
      const timer = setTimeout(() => reject(new Error(`${event}: timed out`)), 8000);
      socket.emit(event, payload, (response) => {
        clearTimeout(timer);
        if (response?.ok) resolve(response);
        else reject(new Error(response?.error || `${event}: failed`));
      });
    });
  }

  /** Host side: opens a session and returns its join code. */
  async createSession() {
    const response = await this.#request(EVENTS.hostCreate, {});
    this.#role = 'host';
    this.#code = response.code;
    return response;
  }

  /** Guest side: joins an existing session by code. */
  async joinSession(code, name) {
    const response = await this.#request(EVENTS.controllerJoin, { code, name });
    this.#role = 'controller';
    this.#code = response.code;
    return response;
  }

  sendTouch(touch) {
    if (!this.#socket) return;
    const payload = { ...touch, clientTime: Date.now() };
    if (touch.type === 'move') this.#socket.volatile.emit(EVENTS.touch, payload);
    else this.#socket.emit(EVENTS.touch, payload);
  }

  sendControl(control) {
    this.#socket?.emit(EVENTS.control, control);
  }

  /**
   * Continuous controls (sliders, the guest FX pad) coalesce per target and
   * fly volatile — like move touches, a dropped frame only means the next
   * one lands sooner. Discrete edits keep using sendControl: the protocol
   * stays reliable where losing a message would corrupt state. The newest
   * value per slot always goes out when the throttle window opens.
   */
  sendControlThrottled(control) {
    if (!this.#socket || !control) return;
    this.#controlPending.set(controlSlotKey(control), control);
    const wait = CONTROL_THROTTLE_MS - (Date.now() - this.#controlSentAt);
    if (wait <= 0) this.#flushControls();
    else if (!this.#controlTimer) this.#controlTimer = setTimeout(() => this.#flushControls(), wait);
  }

  #flushControls() {
    clearTimeout(this.#controlTimer);
    this.#controlTimer = 0;
    this.#controlSentAt = Date.now();
    const batch = [...this.#controlPending.values()];
    this.#controlPending.clear();
    for (const control of batch) this.#socket?.volatile.emit(EVENTS.control, control);
  }

  /** One transport step for the guest playhead. Live steps are volatile; a stop is reliable. */
  pulse(step, { reliable = false, running = true } = {}) {
    const payload = { step, running: Boolean(running) };
    if (reliable) this.#socket?.emit(EVENTS.pulse, payload);
    else this.#socket?.volatile.emit(EVENTS.pulse, payload);
  }

  get sharedState() {
    return { ...this.#shared };
  }

  /** Host → room. Emits just the patch; guests merge fields, so a guest always sees the latest key and readiness. */
  broadcastState(state) {
    this.#shared = { ...this.#shared, ...state };
    this.#socket?.emit(EVENTS.hostState, state);
  }

  /** Full accumulated state — a guest that just joined catches up without waiting for the next patch. */
  broadcastSnapshot() {
    this.#socket?.emit(EVENTS.hostState, { ...this.#shared });
  }

  disconnect() {
    this.#setWaitingForSlot(false);
    clearTimeout(this.#controlTimer);
    this.#controlTimer = 0;
    this.#controlPending.clear();
    this.#socket?.disconnect();
    this.#socket = null;
    this.#role = null;
    this.#code = null;
  }
}
