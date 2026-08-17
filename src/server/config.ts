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

/**
 * Picking the address to put in a QR code.
 *
 * Taking the first non-internal IPv4 is wrong on any real machine: WSL, Docker,
 * Hyper-V and VPN adapters all present private addresses that an audience phone
 * cannot reach, and they frequently sort first. Handing a room a QR code
 * pointing at 10.5.0.2 is exactly the kind of failure this project exists to
 * avoid, so candidates are ranked rather than guessed.
 */

const VIRTUAL_INTERFACE =
  /(wsl|docker|hyper-?v|vethernet|vmware|virtualbox|vbox|tailscale|zerotier|radmin|nordlynx|wireguard|openvpn|proton|mullvad|utun|tun\d|tap\d|loopback|bluetooth)/i;

export type LanCandidate = {
  address: string;
  iface: string;
  score: number;
};

type InterfaceMap = Record<string, { family: string; address: string; internal: boolean }[] | undefined>;

/** Ranking split out from the OS call so it can be tested against real-world shapes. */
export function rankCandidates(interfaces: InterfaceMap): LanCandidate[] {
  const candidates: LanCandidate[] = [];

  for (const [iface, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;

      let score = 0;
      // Home and office LANs are overwhelmingly 192.168/16, which is also the
      // range a venue's guest wifi is most likely to hand out.
      if (address.address.startsWith('192.168.')) score += 100;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address.address)) score += 60;
      else if (address.address.startsWith('10.')) score += 40;

      // Link-local means DHCP failed; it is never the right answer.
      if (address.address.startsWith('169.254.')) score -= 200;
      if (VIRTUAL_INTERFACE.test(iface)) score -= 150;

      candidates.push({ address: address.address, iface, score });
    }
  }

  // Ties keep declaration order, so the result is stable across restarts.
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => b.candidate.score - a.candidate.score || a.index - b.index)
    .map(({ candidate }) => candidate);
}

/** Every usable IPv4 address on this machine, best first. */
export function lanCandidates(): LanCandidate[] {
  return rankCandidates(networkInterfaces() as InterfaceMap);
}

/** Best guess at the address an audience phone can actually reach. */
export function lanAddress(): string | undefined {
  return lanCandidates()[0]?.address;
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
