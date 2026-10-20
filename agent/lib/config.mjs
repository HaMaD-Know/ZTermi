// Agent configuration: stored outside any repository (default ~/.terminia-agent/config.json).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateToken, hashToken, newSalt } from './security.mjs';

export const DEFAULT_EXEC = ['npm', 'pnpm', 'yarn', 'pip', 'python', 'python3', 'git', 'node', 'pod', 'gradle'];

export function defaultConfigPath() {
  return path.join(os.homedir(), '.terminia-agent', 'config.json');
}

export function loadConfig(file = defaultConfigPath()) {
  if (!existsSync(file)) {
    throw new Error(`No agent configuration at ${file}. Run "terminia-agent init" first.`);
  }
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (!config.tokenHash || !config.tokenSalt) throw new Error(`${file} has no token. Run "terminia-agent token" to create one.`);
  return {
    listen: { host: '127.0.0.1', port: 8765 },
    roots: [os.homedir()],
    exec: DEFAULT_EXEC,
    powershell: 'auto',
    maxSessions: 4,
    idleMinutes: 30,
    allowedOrigins: [],
    logCommands: false,
    tls: null,
    ...config,
  };
}

export function saveConfig(file, config) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows: the file is in the user's profile, protected by its ACL.
  }
}

/** Creates a configuration with a fresh token. Returns the token - it is never stored in clear text. */
export function initConfig(file, options = {}) {
  if (existsSync(file) && !options.force) throw new Error(`${file} already exists. Use --force to replace it, or "terminia-agent token" to rotate the token.`);
  const token = generateToken();
  const salt = newSalt();
  const config = {
    version: 1,
    tokenSalt: salt,
    tokenHash: hashToken(salt, token),
    listen: options.listen ?? { host: '127.0.0.1', port: 8765 },
    roots: options.roots?.length ? options.roots.map((r) => path.resolve(r)) : [os.homedir()],
    exec: DEFAULT_EXEC,
    powershell: options.powershell ?? 'auto',
    maxSessions: 4,
    idleMinutes: 30,
    allowedOrigins: [],
    logCommands: false,
    tls: null,
  };
  saveConfig(file, config);
  return { config, token };
}

export function rotateToken(file) {
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const token = generateToken();
  config.tokenSalt = newSalt();
  config.tokenHash = hashToken(config.tokenSalt, token);
  saveConfig(file, config);
  return token;
}

export function parseListen(value) {
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(value ?? '');
  if (!match) throw new Error(`--listen expects host:port, got '${value}'.`);
  const port = Number(match[2]);
  if (port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
  return { host: match[1].replace(/^\[|\]$/g, ''), port };
}
