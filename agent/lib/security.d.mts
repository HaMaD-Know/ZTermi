export function generateToken(): string;
export function hashToken(salt: string, token: string): string;
export function verifyToken(config: { tokenHash: string; tokenSalt: string }, presented: string | null): boolean;
export function bearer(header: string | undefined): string | null;
export function isPrivateAddress(address: string): boolean;
export function insideRoots(candidate: string, roots: string[]): string | null;
export function redact(text: string): string;
export class Lockout {
  constructor(options?: { maxFailures?: number; windowMs?: number; lockMs?: number; now?: () => number });
  isLocked(address: string): boolean;
  fail(address: string): boolean;
  succeed(address: string): void;
}
