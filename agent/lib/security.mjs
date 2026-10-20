// Token handling, address checks and failed-login lockout for the agent.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';

export function generateToken() {
  return `tma_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(salt, token) {
  return createHash('sha256').update(`${salt}:${token}`).digest('hex');
}

export function newSalt() {
  return randomBytes(16).toString('hex');
}

/** Constant-time check of a presented token against the stored salted hash. */
export function verifyToken(config, presented) {
  if (typeof presented !== 'string' || presented.length < 20 || presented.length > 200) return false;
  const expected = Buffer.from(config.tokenHash, 'hex');
  const actual = Buffer.from(hashToken(config.tokenSalt, presented), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function bearer(header) {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match ? match[1] : null;
}

/** Loopback, RFC 1918, CGNAT 100.64/10 (Tailscale), link-local and unique-local IPv6. */
export function isPrivateAddress(address) {
  if (!address) return false;
  let a = address.toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || a === 'localhost') return true;
  if (/^fe80:/.test(a) || /^f[cd][0-9a-f]{2}:/.test(a)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a);
  if (!m) return false;
  const first = Number(m[1]);
  const second = Number(m[2]);
  return (
    first === 127 ||
    first === 10 ||
    (first === 192 && second === 168) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254)
  );
}

export function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/** Blocks an address for a while after repeated failed sign-ins. */
export class Lockout {
  constructor({ maxFailures = 5, windowMs = 10 * 60_000, lockMs = 10 * 60_000, now = Date.now } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.lockMs = lockMs;
    this.now = now;
    this.entries = new Map();
  }

  isLocked(address) {
    const entry = this.entries.get(address);
    return !!entry && entry.lockedUntil > this.now();
  }

  fail(address) {
    const now = this.now();
    let entry = this.entries.get(address);
    if (!entry || now - entry.firstAt > this.windowMs) entry = { count: 0, firstAt: now, lockedUntil: 0 };
    entry.count++;
    if (entry.count >= this.maxFailures) entry.lockedUntil = now + this.lockMs;
    this.entries.set(address, entry);
    return entry.lockedUntil > now;
  }

  succeed(address) {
    this.entries.delete(address);
  }
}

/** Resolves `candidate` and checks it is one of the configured roots or inside one. */
export function insideRoots(candidate, roots) {
  let resolved;
  try {
    resolved = realpathSync(candidate);
  } catch {
    return null;
  }
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  for (const root of roots) {
    let r;
    try {
      r = realpathSync(root);
    } catch {
      continue;
    }
    const rel = path.relative(norm(r), norm(resolved));
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return resolved;
  }
  return null;
}

const SECRET_PATTERNS = [/\btma_[A-Za-z0-9_-]{20,}/g, /\bgh[pousr]_[A-Za-z0-9]{30,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g, /(password|token|secret)\s*[=:]\s*\S+/gi];

export function redact(text) {
  let out = String(text);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, (m) => (m.includes('=') || m.includes(':') ? m.replace(/([=:]\s*)\S+$/, '$1[REDACTED]') : '[REDACTED]'));
  return out;
}
