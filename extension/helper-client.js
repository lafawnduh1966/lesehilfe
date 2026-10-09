// Connection to the local Lesehilfe helper via Chrome native messaging.
// The helper process lives as long as this port (i.e. while the side panel is open).
const HOST = 'com.lesehilfe.helper';

let port = null;
let nextId = 1;
const pending = new Map(); // id → { resolve, reject, onEvent }
const listeners = new Set();

export const helper = {
  status: null, // result of the helper's `status` method once connected
  error: null, // why the helper is unavailable

  onChange(fn) {
    listeners.add(fn);
  },

  async connect() {
    port?.disconnect();
    this.status = null;
    this.error = null;
    port = chrome.runtime.connectNative(HOST);
    port.onMessage.addListener(handleMessage);
    port.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message || 'Helper stopped.';
      port = null;
      this.status = null;
      this.error = /not found/i.test(message) ? 'not-installed' : message;
      for (const p of pending.values()) p.reject(new Error(`Helper disconnected: ${message}`));
      pending.clear();
      notify();
    });
    try {
      this.status = await this.call('status');
    } catch (e) {
      this.error ??= e.message;
    }
    notify();
  },

  /** Calls a helper method. `onEvent(event, data)` receives progress events. */
  call(method, params = {}, onEvent) {
    if (!port) return Promise.reject(new Error('Helper not connected.'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onEvent });
      port.postMessage({ id, method, params });
    });
  },
};

function handleMessage(message) {
  const entry = pending.get(message.id);
  if (!entry) return;
  if (message.event) {
    entry.onEvent?.(message.event, message.data);
    return;
  }
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(message.error));
  else entry.resolve(message.result);
}

function notify() {
  for (const fn of listeners) fn();
}
