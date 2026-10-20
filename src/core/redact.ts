/**
 * Secret redaction for everything Terminia prints, stores or logs: terminal
 * output, build logs, persisted history, error messages and diagnostics.
 *
 * Redaction is defensive. Terminia's own design keeps tokens out of JavaScript
 * (the native vault injects them into requests), but build logs, remote
 * command output and pasted text can still contain credentials.
 */

export const REDACTED = '[REDACTED]';

interface Rule {
  name: string;
  pattern: RegExp;
  /** Replacement; `$1` etc. keep a non-secret prefix such as "password=". */
  replace: string;
}

const RULES: Rule[] = [
  {
    name: 'private-key',
    pattern: /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g,
    replace: `-----BEGIN $1PRIVATE KEY----- ${REDACTED} -----END $1PRIVATE KEY-----`,
  },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,255}\b/g, replace: REDACTED },
  { name: 'github-fine-grained', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g, replace: REDACTED },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: REDACTED },
  { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: REDACTED },
  { name: 'stripe-key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g, replace: REDACTED },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: REDACTED },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: REDACTED },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: REDACTED },
  {
    name: 'auth-header',
    pattern: /\b(authorization\s*[:=]\s*["']?(?:bearer|token|basic)\s+)[^\s"',;]+/gi,
    replace: `$1${REDACTED}`,
  },
  { name: 'bearer', pattern: /\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, replace: `$1${REDACTED}` },
  { name: 'url-credentials', pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, replace: `$1${REDACTED}@` },
  {
    name: 'url-secret-params',
    pattern: /([?&](?:access_token|token|sig|signature|client_secret|password|code|X-Amz-Signature|X-Amz-Credential)=)[^&\s"']+/gi,
    replace: `$1${REDACTED}`,
  },
  {
    name: 'assignment',
    pattern:
      /\b((?:password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|store[_-]?password|key[_-]?password)["']?\s*[:=]\s*["']?)(?!\[REDACTED\])([^\s"',;]{4,})/gi,
    replace: `$1${REDACTED}`,
  },
];

const extraSecrets = new Set<string>();

/** Registers a literal secret value (at least 6 characters) that must never be printed. */
export function registerSecret(value: string): void {
  if (value && value.length >= 6) extraSecrets.add(value);
}

export function clearRegisteredSecrets(): void {
  extraSecrets.clear();
}

export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const secret of extraSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, rule.replace);
  }
  return out;
}

/** Redacts every string inside a JSON-like value (used for diagnostics exports). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = /token|secret|password|authorization|credential/i.test(key) && typeof item === 'string' ? REDACTED : redactDeep(item);
    }
    return out as T;
  }
  return value;
}

/** Names of the rules that matched (for tests and the secret scanner). */
export function matchingRules(text: string): string[] {
  const names: string[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) names.push(rule.name);
  }
  return names;
}
