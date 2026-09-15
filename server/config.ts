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
import { randomBytes } from 'node:crypto';

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
   * Explicit override for the base URL in generated links.
   *
   * Left undefined, links are derived from the incoming request instead, which
   * is right almost always: browse to http://192.168.1.149:8880 and you get
   * links back to that same address. Only set this when the address the
   * audience uses differs from the one the server sees — behind a proxy that
   * does not forward Host, for example.
   */
  publicUrl: string | undefined;
  /** True when started with --local: bind all interfaces, advertise LAN IP. */
  local: boolean;
  /** Idle rooms are swept after this long. */
  roomTtlMs: number;
  /**
   * Gate on creating sessions, so a stranger who finds the server cannot spawn
   * rooms. Generated and logged at startup when unset, rather than defaulting
   * to open.
   */
  adminPassword: string;
  /** True when the password was generated rather than configured. */
  adminPasswordGenerated: boolean;
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
 * A readable throwaway password for when ADMIN_PASSWORD is not configured.
 * Words rather than hex, because the operator has to type it on a phone.
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

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  const local = argv.includes('--local') || process.env.LOCAL_MODE === '1';
  const root = resolve(import.meta.dirname, '..');

  // 8880 rather than the usual 8080: far less likely to collide with something
  // already running, and still on Cloudflare's proxyable HTTP port list so a
  // plain port-forward works as an alternative to a tunnel.
  const port = intFromEnv('PORT', 8880);
  const host = process.env.HOST ?? (local ? '0.0.0.0' : '0.0.0.0');

  // An empty PUBLIC_URL used to fall back to localhost, which is the worst
  // possible default: links looked valid and pointed at the operator's own
  // machine rather than the server. Undefined now means "derive from the
  // request", and only local mode fixes an address up front.
  let publicUrl = normalizePublicUrl(process.env.PUBLIC_URL);
  if (!publicUrl && local) {
    publicUrl = `http://${lanAddress() ?? 'localhost'}:${port}`;
  }

  const configuredPassword = process.env.ADMIN_PASSWORD?.trim();
  const adminPassword = configuredPassword || generatePassword();

  return {
    adminPassword,
    adminPasswordGenerated: !configuredPassword,
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
