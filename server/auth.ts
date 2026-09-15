/**
 * The gate on creating sessions.
 *
 * Deliberately rudimentary: one shared password, a signed cookie, no accounts.
 * It exists to stop a stranger who finds the server from spawning rooms — not
 * to protect anything sensitive. Room tokens, not this, are what keep an
 * audience member from driving somebody else's show.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const ADMIN_COOKIE = 'scenario_admin';
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Constant-time string compare that does not leak length via early return. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so timing does not distinguish wrong-length
    // from wrong-value guesses.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Issues a token valid for TOKEN_TTL_MS. */
export function issueToken(secret: string): string {
  const payload = `${Date.now() + TOKEN_TTL_MS}.${randomBytes(8).toString('base64url')}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload, secret)}`;
}

export function verifyToken(token: string | undefined, secret: string): boolean {
  if (!token) return false;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return false;

  const encoded = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  let payload: string;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return false;
  }

  if (!safeEqual(signature, sign(payload, secret))) return false;

  const expiry = Number(payload.split('.')[0]);
  return Number.isFinite(expiry) && expiry > Date.now();
}

/** Minimal cookie parsing, to avoid a dependency for one header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return undefined;
}

export function buildCookie(name: string, value: string, secure: boolean): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}`,
  ];
  // Only mark Secure over HTTPS; doing so on plain HTTP would make the cookie
  // silently unusable on a LAN deployment.
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
