/**
 * The client side of the socket.
 *
 * Reconnection is not optional here: this runs in a room with an audience, on
 * venue wifi, on phones that sleep. Every surface assumes the socket will drop
 * and come back, and nothing about the show should depend on it not dropping.
 */

import type { ClientMessage, ServerMessage } from '../../shared/protocol.ts';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'failed';

export type ConnectionOptions = {
  onMessage: (message: ServerMessage) => void;
  onStatus?: (status: ConnectionStatus) => void;
  /** Sent immediately on every (re)connect, so state resyncs automatically. */
  hello: () => ClientMessage;
};

export class Connection {
  private socket: WebSocket | undefined;
  private attempt = 0;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private readonly options: ConnectionOptions;

  /** Estimated serverNow - Date.now(), so countdowns agree across devices. */
  clockOffset = 0;
  status: ConnectionStatus = 'connecting';

  constructor(options: ConnectionOptions) {
    this.options = options;
    this.open();

    // A phone waking from sleep reports online before its socket recovers;
    // reconnect eagerly rather than waiting out the backoff.
    globalThis.addEventListener?.('online', () => this.reconnectNow());
    document?.addEventListener?.('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.reconnectNow();
    });
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus?.(status);
  }

  private url(): string {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/ws`;
  }

  private open(): void {
    if (this.closed) return;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

    const socket = new WebSocket(this.url());
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0;
      // Hello goes first, always. Status handlers react by sending things that
      // require a completed handshake, so announcing 'open' before the hello
      // is on the wire gets those messages rejected.
      this.send(this.options.hello());
      this.setStatus('open');

      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 25_000);
    });

    socket.addEventListener('message', (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }

      if ('serverNow' in message && typeof message.serverNow === 'number') {
        this.clockOffset = message.serverNow - Date.now();
      }
      this.options.onMessage(message);
    });

    socket.addEventListener('close', () => {
      clearInterval(this.pingTimer);
      if (this.closed) return;
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => socket.close());
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer);
    this.attempt++;
    // Fast at first — a blip should be invisible — then back off.
    const delay = Math.min(8000, 250 * 2 ** Math.min(this.attempt - 1, 5));
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  /** Skips the backoff, for when we have a reason to think the network is back. */
  reconnectNow(): void {
    if (this.closed) return;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    clearTimeout(this.reconnectTimer);
    this.attempt = 0;
    this.open();
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Server wall-clock estimate, for countdowns that agree across devices. */
  now(): number {
    return Date.now() + this.clockOffset;
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    this.socket?.close();
  }
}

/** A stable, meaningless per-device id. Not personal data; only dedupes votes. */
export function deviceId(): string {
  const key = 'interactive-scenario.device';
  let id = localStorage.getItem(key);
  if (!id || id.length < 8) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

export function queryParam(name: string): string | undefined {
  return new URLSearchParams(location.search).get(name) ?? undefined;
}
