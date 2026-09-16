/**
 * The loopback socket.
 *
 * Two surfaces sit on the far end of this and both are on the same machine:
 * the board window the operator works in, and the stage window they drag onto
 * the projector. It carries the same `Snapshot` messages the public server
 * sends, because the stage *is* the display — the renderer that already knows
 * how to letterbox a 1920x1080 surface, prefetch a show's worth of artwork and
 * keep playing locally if the socket goes.
 *
 * What is gone, and why it is gone rather than simply unused:
 *
 * The public server's version validates every frame, checks a token against
 * the room, rate-limits each connection and treats the sender as hostile,
 * because it is on the internet and one of its roles is a phone in a stranger's
 * hand. None of that describes this socket. It binds to 127.0.0.1, both ends
 * are windows this process opened, and a token proved only that the person
 * holding it had been given the link — which on loopback is everybody who can
 * reach the port at all, which is the operator. Keeping the ceremony would be
 * security theatre with a real cost: a reader would have to work out what it
 * was protecting against before concluding the answer is nothing.
 *
 * Frames are still parsed through the shared schema. Not as a defence — as the
 * one thing that keeps this socket and the public one speaking the same
 * language, so the stage does not have to know which it is plugged into.
 */

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { Server } from 'node:http';
import { parseClientMessage } from '../../../shared/show/protocol.ts';
import type { Subscriber } from '../../../server/room.ts';
import { currentShow } from './session.ts';

type Connection = {
  socket: WebSocket;
  subscriber?: Subscriber;
  alive: boolean;
};

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function fail(socket: WebSocket, code: string, message: string, fatal = true): void {
  send(socket, { type: 'error', code, message, fatal });
  if (fatal) socket.close(1008, code);
}

export type ShowSocket = {
  /**
   * Drops every connected surface.
   *
   * Called when a show ends, so the stage's own `Connection` reconnects and
   * re-announces itself against whatever is running next. Without it a stage
   * window left open across a Stop and a Play would sit holding a subscription
   * to a Room nobody has any more, showing the last frame of the old show.
   */
  dropAll(): void;
  close(): void;
};

export function attachShowSocket(server: Server): ShowSocket {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });
  const connections = new Set<Connection>();

  wss.on('connection', (socket: WebSocket) => {
    const connection: Connection = { socket, alive: true };
    connections.add(connection);

    socket.on('pong', () => {
      connection.alive = true;
    });

    socket.on('message', (raw: RawData) => {
      const message = parseClientMessage(raw.toString());
      if (!message) {
        fail(socket, 'badMessage', 'Unrecognised message.', false);
        return;
      }

      if (message.type === 'ping') {
        send(socket, { type: 'pong', serverNow: Date.now() });
        return;
      }

      if (message.type === 'hello') {
        if (connection.subscriber) {
          fail(socket, 'badMessage', 'Already joined.', false);
          return;
        }
        const show = currentShow();
        if (!show) {
          // Fatal, so the socket closes and the surface's own backoff brings
          // it back. A window left open between two shows is the ordinary
          // case, not an error anybody needs to read about.
          fail(socket, 'badRoom', 'No show is running.');
          return;
        }
        // No player ever reaches this socket: phones talk to the relay, which
        // talks to the link, which casts into the Room from inside this
        // process. A `player` hello here is a surface that has misunderstood
        // where it is.
        if (message.role === 'player') {
          fail(socket, 'badToken', 'Phones join through the relay, not here.');
          return;
        }

        const subscriber: Subscriber = {
          role: message.role,
          send: (payload) => send(socket, payload),
        };
        connection.subscriber = subscriber;
        show.room.subscribe(subscriber);
        return;
      }

      const show = currentShow();
      const subscriber = connection.subscriber;
      if (!show || !subscriber) {
        fail(socket, 'badMessage', 'Send hello first.');
        return;
      }

      switch (message.type) {
        case 'displayReady':
          show.room.markDisplayReady(
            message.failed !== undefined && message.total !== undefined
              ? { failed: message.failed, total: message.total }
              : undefined,
          );
          return;

        case 'displayProgress':
          show.room.noteDisplayProgress({
            done: message.done,
            total: message.total,
            failed: message.failed,
            ...(message.bytes !== undefined ? { bytes: message.bytes } : {}),
            ...(message.totalBytes !== undefined ? { totalBytes: message.totalBytes } : {}),
          });
          return;

        case 'displayAudio':
          show.room.setAudioUnlocked(message.unlocked);
          return;

        case 'command':
          // Both surfaces may command, and the stage still sends only the keys
          // it has. `DISPLAY_COMMANDS` stopped being a security boundary the
          // moment the far end became a window on this machine — it is now a
          // decision about what belongs on a keyboard at a lectern, enforced
          // in the stage itself. See `tests/control.test.ts`, which is what
          // holds the list and the keys to each other.
          try {
            show.room.handleCommand(message.command);
          } catch (err) {
            fail(socket, 'internal', (err as Error).message, false);
          }
          return;

        case 'vote':
          // A phone's message on the operator's own socket. Nothing sends it.
          fail(socket, 'badToken', 'Votes arrive from the relay, not from here.', false);
          return;
      }
    });

    const cleanup = (): void => {
      if (connection.subscriber) currentShow()?.room.unsubscribe(connection.subscriber);
      connections.delete(connection);
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  // Loopback sockets do not silently rot the way venue wifi does, but the
  // presence count on the board is read as "is the projector there", and a
  // window closed by the window manager rather than by its own script is
  // exactly the case that answers without saying so.
  const heartbeat = setInterval(() => {
    for (const connection of connections) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }, 30_000);
  heartbeat.unref?.();

  return {
    dropAll() {
      for (const connection of connections) connection.socket.close(1000, 'showEnded');
    },
    close() {
      clearInterval(heartbeat);
      wss.close();
    },
  };
}
