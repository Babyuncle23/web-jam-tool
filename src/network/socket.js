/**
 * Network layer. Guests emit touches, the host receives them and sounds them.
 * Thin wrapper over the Socket.io client so the UI never touches raw events.
 *
 * Local pages talk to this same machine. A public page (GitHub Pages) talks
 * to PUBLIC_BACKEND_URL once that Render/Railway address exists.
 */

/** Render/Railway Socket.io origin. Empty until that host exists. */
export const PUBLIC_BACKEND_URL = '';

export function isLocalHostname(hostname) {
  const host = String(hostname || '');
  return host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.') || host.startsWith('10.');
}

/** Where the browser opens the Socket.io connection. */
export function socketServerUrl(page = globalThis.location) {
  if (!page?.origin) return PUBLIC_BACKEND_URL;
  if (isLocalHostname(page.hostname) || !PUBLIC_BACKEND_URL) return page.origin;
  return PUBLIC_BACKEND_URL;
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

  constructor({ io = globalThis.io, url } = {}) {
    if (!io) throw new Error('Socket.io client is not loaded');
    this.#io = io;
    this.url = url === undefined ? socketServerUrl() : url;
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
    if (this.#socket) return this.#socket;
    this.#socket = this.url ? this.#io(this.url) : this.#io();
    for (const [event, callbacks] of this.#listeners) {
      for (const callback of callbacks) this.#socket.on(event, callback);
    }
    return this.#socket;
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

  /** One transport step for the guest playhead. Live steps are volatile; a stop is reliable. */
  pulse(step, { reliable = false, running = true } = {}) {
    const payload = { step, running: Boolean(running) };
    if (reliable) this.#socket?.emit(EVENTS.pulse, payload);
    else this.#socket?.volatile.emit(EVENTS.pulse, payload);
  }

  get sharedState() {
    return { ...this.#shared };
  }

  /** Host → room. Later fields merge, so a guest always sees the latest key and readiness. */
  broadcastState(state) {
    this.#shared = { ...this.#shared, ...state };
    this.#socket?.emit(EVENTS.hostState, this.#shared);
  }

  disconnect() {
    this.#socket?.disconnect();
    this.#socket = null;
    this.#role = null;
    this.#code = null;
  }
}
