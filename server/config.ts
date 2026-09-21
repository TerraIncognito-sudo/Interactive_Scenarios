/**
 * Runtime configuration.
 *
 * The relay runs in a container behind Cloudflare and, on the night the
 * venue's internet is dead, off `docker compose up` on the operator's own
 * laptop with phones on the venue wifi. That second mode is not a separate
 * program and must never become one: every difference between the two is an
 * environment variable read here, and the join links are derived from the
 * request rather than configured, so a LAN deployment needs no configuration
 * at all.
 */

import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export type Config = {
  port: number;
  host: string;
  /** Where SQLite lives — rooms, votes and keys. */
  dataDir: string;
  /** Built web assets: the player page and the two console pages. */
  webDir: string;
  /**
   * Explicit override for the base URL in generated links.
   *
   * Left undefined, links are derived from the incoming request instead, which
   * is right almost always: browse to http://192.168.1.149:8880 and you get
   * links back to that same address. Only set this when the address the
   * audience uses differs from the one the relay sees — behind a proxy that
   * does not forward Host, for example.
   */
  publicUrl: string | undefined;
  /** Idle rooms are swept after this long. */
  roomTtlMs: number;
  /**
   * The gate on the console, where keys are issued and rooms are ended.
   * Generated and printed at startup when unset, rather than defaulting open.
   */
  adminPassword: string;
  /** True when the password was generated rather than configured. */
  adminPasswordGenerated: boolean;
};

/**
 * Accepts a bare hostname for PUBLIC_URL and supplies the scheme.
 *
 * `PUBLIC_URL=interact.example.com` is the obvious thing to write and the
 * wrong thing to emit: without a scheme it is a relative path, so every link
 * would resolve against the current page instead of the site. Rather than
 * hand out broken links, assume https for a hostname and http for something
 * that is plainly a LAN address.
 */
export function normalizePublicUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim().replace(/\/+$/, '');
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value)) return value;

  const isLocal =
    /^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i.test(value) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(value);
  return `${isLocal ? 'http' : 'https'}://${value}`;
}

/**
 * The base URL for links we hand out.
 *
 * Derived from the request unless explicitly overridden, so browsing to
 * http://192.168.1.149:8880 yields links back to that same address, and a
 * Cloudflare-proxied request yields public ones — with no configuration in
 * either case. The old behaviour, falling back to localhost, produced links
 * that looked perfectly valid and pointed at the operator's own machine.
 *
 * An empty `PUBLIC_URL` means unset. It must never quietly mean localhost.
 *
 * One implementation for both halves that need it: the REST routes build the
 * join link on the status page, and the WebSocket handshake builds the one the
 * client puts on a projector. Two copies would eventually disagree, and the
 * one nobody could check from a browser would be the one on the wall.
 */
export function baseUrlFor(
  publicUrl: string | undefined,
  headers: Record<string, unknown>,
  fallbackProtocol = 'http',
): string {
  if (publicUrl) return publicUrl;

  const forwardedHost = String(headers['x-forwarded-host'] ?? '')
    .split(',')[0]
    ?.trim();
  const forwardedProto = String(headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    ?.trim();
  const host = forwardedHost || String(headers['host'] ?? '') || 'localhost';
  const protocol = forwardedProto || fallbackProtocol;
  return `${protocol}://${host}`;
}

/**
 * A readable throwaway password for when ADMIN_PASSWORD is not configured.
 * Words rather than hex, because the operator has to type it on a phone.
 *
 * Not the same generator as a relay key, and the difference is deliberate:
 * this is printed to a log the operator is already looking at and changed by
 * setting an environment variable, where a key is issued from the console and
 * read out to somebody else. `server/keys.ts` has the arithmetic.
 */
function generatePassword(): string {
  const words = [
    'amber', 'basalt', 'cedar', 'dusk', 'ember', 'fathom', 'garnet', 'harbor',
    'indigo', 'juniper', 'kestrel', 'lantern', 'marrow', 'nimbus', 'onyx',
    'pillar', 'quarry', 'rivet', 'summit', 'tundra', 'umber', 'vellum',
    'willow', 'yarrow', 'zephyr',
  ];
  const bytes = randomBytes(3);
  const pick = (i: number): string => words[bytes[i]! % words.length]!;
  return `${pick(0)}-${pick(1)}-${pick(2)}`;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  }
  return value;
}

export function loadConfig(): Config {
  const root = resolve(import.meta.dirname, '..');

  // 8880 rather than the usual 8080: far less likely to collide with something
  // already running, and still on Cloudflare's proxyable HTTP port list so a
  // plain port-forward works as an alternative to a tunnel.
  const port = intFromEnv('PORT', 8880);

  const configuredPassword = process.env.ADMIN_PASSWORD?.trim();
  const adminPassword = configuredPassword || generatePassword();

  return {
    adminPassword,
    adminPasswordGenerated: !configuredPassword,
    port,
    host: process.env.HOST ?? '0.0.0.0',
    dataDir: resolve(process.env.DATA_DIR ?? join(root, 'data')),
    webDir: resolve(process.env.WEB_DIR ?? join(root, 'dist', 'client')),
    publicUrl: normalizePublicUrl(process.env.PUBLIC_URL),
    roomTtlMs: intFromEnv('ROOM_TTL_MINUTES', 240) * 60_000,
  };
}
