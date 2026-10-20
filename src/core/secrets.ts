import { basename, extname } from './paths';

/**
 * Secret detection run before Terminia uploads anything (repository sync,
 * project export). Two levels:
 *
 *  - "blocked": files that must never leave the device through Terminia,
 *    whatever the user says - environment files, signing keys, keystores,
 *    provisioning profiles, private keys, credential stores, or text that
 *    contains a high-confidence token or private-key block.
 *  - "suspicious": likely hard-coded passwords. Also excluded, unless the
 *    project lists the path in .terminia/allow-secrets.txt after review.
 */

export type SecretSeverity = 'blocked' | 'suspicious';

export interface SecretFinding {
  path: string;
  severity: SecretSeverity;
  reason: string;
  line?: number;
}

const ENV_ALLOWED = new Set(['.env.example', '.env.sample', '.env.template', '.env.defaults']);

const BLOCKED_NAMES = new Map<string, string>([
  ['id_rsa', 'SSH private key'],
  ['id_dsa', 'SSH private key'],
  ['id_ecdsa', 'SSH private key'],
  ['id_ed25519', 'SSH private key'],
  ['.netrc', 'credential store'],
  ['_netrc', 'credential store'],
  ['.git-credentials', 'Git credential store'],
  ['.pypirc', 'PyPI credentials'],
  ['credentials', 'credential file'],
  ['keystore.properties', 'Android signing configuration'],
  ['key.properties', 'Android signing configuration'],
  ['signing.properties', 'Android signing configuration'],
]);

const BLOCKED_EXTENSIONS = new Map<string, string>([
  ['.p12', 'certificate with private key (PKCS#12)'],
  ['.pfx', 'certificate with private key (PKCS#12)'],
  ['.mobileprovision', 'Apple provisioning profile'],
  ['.provisionprofile', 'Apple provisioning profile'],
  ['.p8', 'App Store Connect / APNs private key'],
  ['.jks', 'Java keystore (Android signing key)'],
  ['.keystore', 'Android keystore (signing key)'],
  ['.ppk', 'PuTTY private key'],
  ['.kdbx', 'password database'],
]);

/** Extensions that are only secret when their content is a private key. */
const KEY_CONTENT_EXTENSIONS = new Set(['.pem', '.key']);

const CONTENT_RULES: { reason: string; severity: SecretSeverity; pattern: RegExp }[] = [
  { reason: 'private key block', severity: 'blocked', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { reason: 'GitHub token', severity: 'blocked', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { reason: 'npm access token', severity: 'blocked', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { reason: 'npm auth token in .npmrc', severity: 'blocked', pattern: /_authToken\s*=\s*(?!\$\{)\S+/ },
  { reason: 'AWS access key', severity: 'blocked', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { reason: 'AWS secret key', severity: 'blocked', pattern: /aws_secret_access_key\s*[=:]\s*\S{20,}/i },
  { reason: 'Slack token', severity: 'blocked', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { reason: 'Stripe live key', severity: 'blocked', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
  { reason: 'Google API key', severity: 'suspicious', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    reason: 'hard-coded password',
    severity: 'suspicious',
    pattern: /\b(?:password|passwd|pwd|secret|client_secret|api_?key|storePassword|keyPassword)["']?\s*[:=]\s*["'][^"'\s$]{6,}["']/i,
  },
];

const MAX_SCAN_BYTES = 1024 * 1024;

/** Checks the file name alone. Returns a finding when the name itself is a secret. */
export function checkSecretFileName(path: string): SecretFinding | null {
  const name = basename(path);
  const lower = name.toLowerCase();
  if ((lower === '.env' || lower.startsWith('.env.')) && !ENV_ALLOWED.has(lower)) {
    return { path, severity: 'blocked', reason: 'environment file (.env)' };
  }
  const byName = BLOCKED_NAMES.get(lower);
  if (byName && !(lower === 'credentials' && !path.includes('.aws/'))) {
    return { path, severity: 'blocked', reason: byName };
  }
  const byExt = BLOCKED_EXTENSIONS.get(extname(lower));
  if (byExt) return { path, severity: 'blocked', reason: byExt };
  return null;
}

/** True when the file content should be scanned (text-like and small enough). */
export function shouldScanContent(path: string, size: number): boolean {
  if (size > MAX_SCAN_BYTES) return false;
  const ext = extname(path);
  return !BINARY_EXTENSIONS.has(ext);
}

/** Scans file content. `text` should be the UTF-8 decoding of the file. */
export function scanSecretContent(path: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const ext = extname(path);
  const lines = text.split(/\r?\n/);
  // Type declarations such as `password: string` never match the password rule:
  // it requires a quoted literal value.
  for (const rule of CONTENT_RULES) {
    for (let i = 0; i < lines.length; i++) {
      if (rule.pattern.test(lines[i]!)) {
        findings.push({ path, severity: rule.severity, reason: rule.reason, line: i + 1 });
        break;
      }
    }
  }
  if (KEY_CONTENT_EXTENSIONS.has(ext) && findings.some((f) => f.reason === 'private key block')) {
    return findings.map((f) => ({ ...f, reason: `private key file (${ext})` }));
  }
  return findings;
}

/** Combines name and content checks for one file. */
export function scanFile(path: string, content: Uint8Array | null): SecretFinding[] {
  const byName = checkSecretFileName(path);
  if (byName) return [byName];
  if (!content || !shouldScanContent(path, content.byteLength)) return [];
  if (isLockFile(path)) return [];
  const text = new TextDecoder('utf-8', { fatal: false }).decode(content);
  return scanSecretContent(path, text);
}

function isLockFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === 'package-lock.json' || name === 'yarn.lock' || name === 'pnpm-lock.yaml' || name === 'podfile.lock' || name.endsWith('.lock');
}

/** Parses .terminia/allow-secrets.txt: one path per line, '#' comments. */
export function parseSecretAllowlist(text: string): Set<string> {
  const allowed = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) allowed.add(line.replace(/^\.\//, ''));
  }
  return allowed;
}

/** Applies the allowlist: only "suspicious" findings can be allowed, never "blocked" ones. */
export function applyAllowlist(findings: SecretFinding[], allowed: Set<string>): SecretFinding[] {
  return findings.filter((f) => f.severity === 'blocked' || !allowed.has(f.path));
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz',
  '.7z', '.rar', '.jar', '.aar', '.apk', '.aab', '.ipa', '.so', '.dylib', '.a', '.o', '.class', '.dex',
  '.wasm', '.ttf', '.otf', '.woff', '.woff2', '.mp3', '.mp4', '.mov', '.wav', '.car', '.heic', '.psd',
]);

export function isProbablyBinary(path: string, content?: Uint8Array): boolean {
  if (BINARY_EXTENSIONS.has(extname(path))) return true;
  if (!content) return false;
  const sample = content.subarray(0, Math.min(content.byteLength, 8000));
  for (const byte of sample) if (byte === 0) return true;
  return false;
}
