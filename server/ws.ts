/**
 * WebSocket transport.
 *
 * Every frame arriving here is untrusted. The order is always: validate the
 * shape, authorise the role, then act — never the other way round.
 *
 * Two roles share this socket and neither is told about the other. A **client**
 * is the operator's own process: it announces itself by opening a room with a
 * key, or by resuming one with its token, and everything it may say afterwards
 * is about the question currently in front of the phones. A **player** is a
 * phone: it says hello with a room code and may then vote, and that is the
 * entire surface. Nothing a phone sends can reach a client except as a number
 * in a tally, and nothing the relay sends toward a client is a command.
 */

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import {
  RELAY_PROTOCOL,
  parseRelayInbound,
  type RelayErrorCode,
  type RelayToClient,
  type RelayToPhone,
} from '../shared/relay/protocol.ts';
import { baseUrlFor } from './config.ts';
import { matchKey, type KeyAttempts } from './keys.ts';
import type { Store } from './db.ts';
import { RoomNameInUse, type RelayRegistry } from './rooms.ts';
import type { ClientSink, PlayerSink, RelayRoom } from './relay.ts';

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
  address: string;
  /** The base URL for links, fixed at the handshake from that request. */
  base: string;
  room?: RelayRoom;
  client?: ClientSink;
  player?: PlayerSink;
  limiter: RateLimiter;
  alive: boolean;
};

export type RelayWebSocketOptions = {
  registry: RelayRegistry;
  store: Store;
  attempts: KeyAttempts;
  /**
   * `PUBLIC_URL`, or undefined to derive the join link from the handshake.
   *
   * Passed in rather than read here so the override applies to the link on a
   * projector exactly as it applies to the one on the status page. A socket
   * that ignored it would hand out a working link everywhere except the one
   * deployment the setting exists for.
   */
  publicUrl: string | undefined;
  /** Reports a room opening, so the log records which key did it. */
  onRoomOpened?: (room: RelayRoom) => void;
};

function send(socket: WebSocket, message: RelayToClient | RelayToPhone): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function fail(socket: WebSocket, code: RelayErrorCode, message: string, fatal = true): void {
  send(socket, { type: 'error', code, message, fatal });
  if (fatal) socket.close(1008, code);
}

/**
 * A client taking a room that already exists back over.
 *
 * One builder for the two ways in — resuming with a token, and opening by a
 * name this key already holds — because the two must hand back the same thing.
 * The open question and its ballots are the whole reason this frame is not a
 * `roomOpened`, and a second copy of it would eventually be the one that
 * forgot them.
 */
function resumedFrame(connection: Connection, room: RelayRoom): RelayToClient {
  const open = room.openPoll();
  return {
    type: 'roomResumed',
    room: room.code,
    token: room.token,
    joinUrl: `${connection.base}/join/${room.code}`,
    players: room.playerCount,
    serverNow: Date.now(),
    ...(open
      ? { open: { nodeId: open.nodeId, endsAt: open.endsAt, closed: open.closed, votes: open.votes } }
      : {}),
  };
}

/**
 * Who is guessing, for the key limiter.
 *
 * `x-forwarded-for` first, because behind Cloudflare every connection arrives
 * from the same proxy address and a limiter keyed on that would lock out the
 * world the first time one person fat-fingered a key. Fastify's `trustProxy`
 * does not reach here: a WebSocket upgrade is a raw request, so this is the
 * one place that decision is made twice, and it is made the same way.
 */
function addressOf(request: IncomingMessage): string {
  const forwarded = String(request.headers['x-forwarded-for'] ?? '')
    .split(',')[0]
    ?.trim();
  return forwarded || request.socket.remoteAddress || 'unknown';
}

export function attachRelayWebSocketServer(
  server: Server,
  options: RelayWebSocketOptions,
): WebSocketServer {
  const { registry, store, attempts } = options;
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  const connections = new Set<Connection>();

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const secure = (request.socket as { encrypted?: boolean }).encrypted === true;
    const connection: Connection = {
      socket,
      address: addressOf(request),
      base: baseUrlFor(
        options.publicUrl,
        request.headers as Record<string, unknown>,
        secure ? 'https' : 'http',
      ),
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

      const message = parseRelayInbound(raw.toString());
      if (!message) {
        fail(socket, 'badMessage', 'Unrecognised message.', false);
        return;
      }

      if (message.type === 'ping') {
        send(socket, { type: 'pong', serverNow: Date.now() });
        return;
      }

      // ----------------------------------------------------------- handshake

      if (message.type === 'openRoom') {
        if (connection.room) return fail(socket, 'badMessage', 'Already joined.', false);
        if (message.protocol !== RELAY_PROTOCOL) {
          return fail(
            socket,
            'badProtocol',
            `This relay speaks protocol ${RELAY_PROTOCOL}, the client speaks ${message.protocol}. Update whichever is older.`,
          );
        }
        if (attempts.blocked(connection.address)) {
          return fail(socket, 'rateLimited', 'Too many failed keys from this address.');
        }

        // The whole of the authorisation. See `server/keys.ts` for why forty
        // bits is enough with the limiter above it, and why there is no
        // environment variable that could do this instead.
        const live = store.liveKeys();
        const key = matchKey(live, message.key);
        if (!key) {
          attempts.fail(connection.address);
          // A relay that has never issued a key and one whose keys have all
          // been revoked are the same refusal and completely different
          // problems, so they are kept apart by whether any key has *ever*
          // existed. Told otherwise, somebody whose key was withdrawn this
          // morning goes off to check the container's setup.
          return fail(
            socket,
            'badKey',
            store.listKeys().length === 0
              ? 'This relay has no keys yet. Sign into its console and generate one.'
              : 'That key is not valid. It may have been revoked — ask for a new one.',
          );
        }
        attempts.succeed(connection.address);

        // Walking back into a room this key already has open, which is the
        // second thing a name is for and the more valuable one. The show's
        // client died — a laptop that crashed, a process killed mid-vote — and
        // there is no token left anywhere to resume with, because the token
        // lived in the process that went. The key is what is left, and the key
        // is what opened the room.
        //
        // What comes back is a `roomResumed` rather than a `roomOpened`: that
        // is the frame carrying the open question and every ballot cast under
        // it, so a show whose laptop died mid-vote picks the vote back up
        // rather than asking forty people to do it again.
        //
        // Refused when a *different* key holds the name, and that is the whole
        // of the authorisation here. A name is public — it is written on a
        // wall — so without this check the second operator to type ARCTIC
        // would be handed the first one's room and every phone on it.
        if (message.name !== undefined) {
          const existing = registry.get(message.name);
          if (existing && !existing.closed) {
            if (existing.keyId !== key.id) {
              return fail(
                socket,
                'nameTaken',
                `Room ${message.name} is open already and a different key opened it. Pick another name.`,
              );
            }
            store.touchKey(key.id, Date.now());
            attachClient(connection, existing);
            send(socket, resumedFrame(connection, existing));
            return;
          }
        }

        let room: RelayRoom;
        try {
          room = registry.create({
            keyId: key.id,
            ...(message.title !== undefined ? { title: message.title } : {}),
            ...(message.name !== undefined ? { name: message.name } : {}),
          });
        } catch (error) {
          // The name was taken between the check above and here, which needs
          // two clients opening one name in the same tick to happen at all.
          // Reported rather than swallowed, because the alternative is an
          // exception out of a message handler and a socket that simply stops.
          if (error instanceof RoomNameInUse) {
            return fail(socket, 'nameTaken', `Room ${error.code} is already open.`);
          }
          throw error;
        }
        store.touchKey(key.id, Date.now());
        attachClient(connection, room);
        send(socket, {
          type: 'roomOpened',
          room: room.code,
          token: room.token,
          joinUrl: `${connection.base}/join/${room.code}`,
          players: room.playerCount,
          serverNow: Date.now(),
        });
        options.onRoomOpened?.(room);
        return;
      }

      if (message.type === 'resumeRoom') {
        if (connection.room) return fail(socket, 'badMessage', 'Already joined.', false);
        if (message.protocol !== RELAY_PROTOCOL) {
          return fail(
            socket,
            'badProtocol',
            `This relay speaks protocol ${RELAY_PROTOCOL}, the client speaks ${message.protocol}.`,
          );
        }

        const room = registry.resume(message.room, message.token);
        if (!room) {
          // Deliberately one answer for "no such room" and "wrong token": the
          // difference is only ever useful to somebody who has neither.
          return fail(socket, 'badToken', 'That room is not open, or the token is wrong.');
        }

        attachClient(connection, room);
        send(socket, resumedFrame(connection, room));
        return;
      }

      if (message.type === 'hello') {
        if (connection.room) return fail(socket, 'badMessage', 'Already joined.', false);
        const room = registry.get(message.room);
        if (!room || room.closed) return fail(socket, 'badRoom', 'No such room.');

        // The room code alone is the whole authorisation, and always was: it
        // only ever grants the ability to vote.
        const player: PlayerSink = {
          deviceId: message.deviceId,
          send: (payload) => send(socket, payload),
        };
        connection.room = room;
        connection.player = player;
        room.addPlayer(player);
        return;
      }

      // -------------------------------------------------------- past the door

      const room = connection.room;
      if (!room) return fail(socket, 'badMessage', 'Open a room or say hello first.');
      if (room.closed) return fail(socket, 'roomClosed', 'This room has closed.');

      if (message.type === 'vote') {
        if (!connection.player) {
          return fail(socket, 'badToken', 'Only players may vote.', false);
        }
        // A refusal is not worth closing over — the poll may have just closed
        // — so the phone is told where it actually stands instead.
        room.vote(connection.player.deviceId, message.optionKey);
        send(socket, room.playerStateFor(connection.player.deviceId));
        return;
      }

      if (!connection.client) {
        return fail(socket, 'badToken', 'Only the client may drive this room.', false);
      }

      switch (message.type) {
        case 'poll':
          room.publishPoll({
            nodeId: message.nodeId,
            question: message.question,
            ...(message.prompt !== undefined ? { prompt: message.prompt } : {}),
            options: message.options,
            endsAt: message.endsAt,
            closed: false,
          });
          // The board wants a tally immediately, so an empty poll draws as
          // empty bars rather than as nothing having happened yet.
          room.broadcastTally();
          return;

        case 'extendPoll':
          room.extendPoll(message.nodeId, message.endsAt);
          return;

        case 'closePoll':
          room.closePoll(message.nodeId);
          return;

        case 'clear':
          room.clear();
          return;

        case 'closeRoom':
          registry.closeRoom(room.code);
          return;
      }
    });

    const cleanup = (): void => {
      if (connection.room && connection.player) {
        connection.room.removePlayer(connection.player);
      }
      if (connection.room && connection.client) {
        // The room stays open and keeps taking votes. That is the whole reason
        // the relay has a database: a client that dropped mid-poll comes back
        // to every ballot cast while it was gone.
        connection.room.detachClient(connection.client);
      }
      connections.delete(connection);
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  function attachClient(connection: Connection, room: RelayRoom): void {
    const sink: ClientSink = {
      send: (payload) => send(connection.socket, payload),
      evict: (reason) => fail(connection.socket, 'badToken', reason),
    };
    connection.room = room;
    connection.client = sink;
    room.attachClient(sink);
  }

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
