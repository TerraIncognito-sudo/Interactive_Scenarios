/**
 * Runtime configuration.
 *
 * A hard constraint of this project is that the same server process runs both
 * on a container host and on a presenter's laptop as an offline fallback. That
 * only stays true if every environment difference is expressed here, as plain
 * environment variables, with no cloud-specific APIs anywhere in server code.
 */

import { join, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';

export type Config = {
  port: number;
  host: string;
  /** Where SQLite and any run artifacts live. */
  dataDir: string;
  /** Where scenario folders are read from. */
  scenariosDir: string;
  /** Built client assets. */
  clientDir: string;
  /**
   * Base URL encoded into the join QR code. Must be what an audience phone can
   * actually reach — a public hostname in production, a LAN IP in local mode.
   */
  publicUrl: string;
  /** True when started with --local: bind all interfaces, advertise LAN IP. */
  local: boolean;
  /** Idle rooms are swept after this long. */
  roomTtlMs: number;
};

/** First non-internal IPv4 address, used to advertise a reachable LAN URL. */
export function lanAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return undefined;
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

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  const local = argv.includes('--local') || process.env.LOCAL_MODE === '1';
  const root = resolve(import.meta.dirname, '..', '..');

  // 8880 rather than the usual 8080: far less likely to collide with something
  // already running, and still on Cloudflare's proxyable HTTP port list so a
  // plain port-forward works as an alternative to a tunnel.
  const port = intFromEnv('PORT', 8880);
  const host = process.env.HOST ?? (local ? '0.0.0.0' : '0.0.0.0');

  let publicUrl = process.env.PUBLIC_URL?.replace(/\/+$/, '');
  if (!publicUrl) {
    const advertised = local ? (lanAddress() ?? 'localhost') : 'localhost';
    publicUrl = `http://${advertised}:${port}`;
  }

  return {
    port,
    host,
    dataDir: resolve(process.env.DATA_DIR ?? join(root, 'data')),
    scenariosDir: resolve(process.env.SCENARIOS_DIR ?? join(root, 'scenarios')),
    clientDir: resolve(process.env.CLIENT_DIR ?? join(root, 'dist', 'client')),
    publicUrl,
    local,
    roomTtlMs: intFromEnv('ROOM_TTL_MINUTES', 240) * 60_000,
  };
}
