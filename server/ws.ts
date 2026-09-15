/**
 * WebSocket transport.
 *
 * Every frame arriving here is untrusted. The order is always: validate the
 * shape, authorise the role, then act — never the other way round.
 */

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { Server } from 'node:http';
import { isDisplayCommand, parseClientMessage, type ServerMessage } from '../shared/show/protocol.ts';
import type { RoomRegistry } from './rooms.ts';
import type { Room, Subscriber } from './room.ts';

/** Simple token bucket, so one phone cannot flood the room with votes. */
class RateLimiter {
  private tokens: number;
  private last = Date.now();
  private readonly capacity: number;
  private readonly refillPerSecond: number;

  constructor(capacity: number, refillPerSecond: number) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.tokens = capacity;
  }

  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.last) / 1000) * this.refillPerSecond,
    );
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

type Connection = {
  socket: WebSocket;
  room?: Room;
  subscriber?: Subscriber;
  limiter: RateLimiter;
  alive: boolean;
};

function send(socket: WebSocket, message: ServerMessage | unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function fail(
  socket: WebSocket,
  code: 'badRoom' | 'badToken' | 'badMessage' | 'rateLimited' | 'roomClosed' | 'internal',
  message: string,
  fatal = true,
): void {
  send(socket, { type: 'error', code, message, fatal });
  if (fatal) socket.close(1008, code);
}

export function attachWebSocketServer(server: Server, registry: RoomRegistry): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  const connections = new Set<Connection>();

  wss.on('connection', (socket: WebSocket) => {
    const connection: Connection = {
      socket,
      limiter: new RateLimiter(30, 5),
      alive: true,
    };
    connections.add(connection);

    socket.on('pong', () => {
      connection.alive = true;
    });

    socket.on('message', (raw: RawData) => {
      if (!connection.limiter.take()) {
        fail(socket, 'rateLimited', 'Too many messages.', false);
        return;
      }

      const message = parseClientMessage(raw.toString());
      if (!message) {
        fail(socket, 'badMessage', 'Unrecognised message.', false);
        return;
      }

      if (message.type === 'ping') {
        send(socket, { type: 'pong', serverNow: Date.now() });
        return;
      }

      // Everything past this point requires a completed handshake.
      if (message.type === 'hello') {
        if (connection.room) {
          fail(socket, 'badMessage', 'Already joined.', false);
          return;
        }

        const room = registry.get(message.room);
        if (!room || room.closed) {
          fail(socket, 'badRoom', 'No such room.');
          return;
        }
        if (!registry.authorize(room, message.role, message.token)) {
          fail(socket, 'badToken', 'Not authorised for that role.');
          return;
        }
        if (message.role === 'player' && !message.deviceId) {
          fail(socket, 'badMessage', 'Players must supply a device id.');
          return;
        }

        const subscriber: Subscriber = {
          role: message.role,
          deviceId: message.deviceId,
          send: (payload) => send(socket, payload),
        };
        connection.room = room;
        connection.subscriber = subscriber;
        room.subscribe(subscriber);
        return;
      }

      const room = connection.room;
      const subscriber = connection.subscriber;
      if (!room || !subscriber) {
        fail(socket, 'badMessage', 'Send hello first.');
        return;
      }
      if (room.closed) {
        fail(socket, 'roomClosed', 'This room has closed.');
        return;
      }

      switch (message.type) {
        case 'vote': {
          if (subscriber.role !== 'player' || !subscriber.deviceId) {
            fail(socket, 'badToken', 'Only players may vote.', false);
            return;
          }
          if (!room.castVote(subscriber.deviceId, message.optionKey)) {
            // Not an error worth closing over: the poll may have just closed.
            send(socket, room.playerState(subscriber.deviceId));
            return;
          }
          send(socket, room.playerState(subscriber.deviceId));
          return;
        }

        case 'displayReady': {
          if (subscriber.role !== 'display') {
            fail(socket, 'badToken', 'Only the display may report ready.', false);
            return;
          }
          room.markDisplayReady(
            message.failed !== undefined && message.total !== undefined
              ? { failed: message.failed, total: message.total }
              : undefined,
          );
          return;
        }

        case 'displayProgress': {
          if (subscriber.role !== 'display') {
            fail(socket, 'badToken', 'Only the display may report progress.', false);
            return;
          }
          room.noteDisplayProgress({
            done: message.done,
            total: message.total,
            failed: message.failed,
            ...(message.bytes !== undefined ? { bytes: message.bytes } : {}),
            ...(message.totalBytes !== undefined ? { totalBytes: message.totalBytes } : {}),
          });
          return;
        }

        case 'command': {
          // The projector drives the show too, from its own keyboard, for the
          // presenter who has no second screen to put the console on. It gets
          // the keys it has and no more — `DISPLAY_COMMANDS` is that list, and
          // says why the rest is not on it.
          const allowed =
            subscriber.role === 'host' ||
            (subscriber.role === 'display' && isDisplayCommand(message.command));
          if (!allowed) {
            fail(
              socket,
              'badToken',
              subscriber.role === 'display'
                ? `The display cannot ${message.command.name} — that one is the host console's.`
                : 'Only the host may send commands.',
              false,
            );
            return;
          }
          try {
            room.handleCommand(message.command);
          } catch (err) {
            fail(socket, 'internal', (err as Error).message, false);
          }
          return;
        }
      }
    });

    const cleanup = (): void => {
      if (connection.room && connection.subscriber) {
        connection.room.unsubscribe(connection.subscriber);
      }
      connections.delete(connection);
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  // Drop sockets that have stopped responding, so presence counts stay honest.
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

  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}
