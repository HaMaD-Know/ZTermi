// HTTP(S) API of the Terminia agent (protocol 1, see docs/REMOTE-PROTOCOL.md).
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { Lockout, bearer, insideRoots, isPrivateAddress, redact, verifyToken } from './security.mjs';
import { SessionManager } from './sessions.mjs';

export const AGENT_VERSION = '1.0.0';
export const PROTOCOL = 1;
const MAX_BODY = 256 * 1024;
const MAX_SCRIPT = 200 * 1024;
const PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
        resolve(value);
      } catch {
        reject(new HttpError(400, 'The body must be a JSON object.'));
      }
    });
    req.on('error', reject);
  });
}

export function certificateFingerprint(certPem) {
  return new X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase();
}

/**
 * Creates the agent server. `config` comes from config.mjs; `powershell` from
 * resolvePowerShell(). Nothing listens until server.listen() is called.
 */
export function createAgent(config, { powershell, log = console.log, allowLanHttp = false }) {
  const tls = config.tls ? { cert: readFileSync(config.tls.cert), key: readFileSync(config.tls.key) } : null;
  const sessions = new SessionManager({ powershell: powershell.path, maxSessions: config.maxSessions, idleMinutes: config.idleMinutes, log });
  const lockout = new Lockout();

  const cwdFor = (requested) => {
    if (!requested) return config.roots[0] ?? os.homedir();
    if (typeof requested !== 'string' || requested.length > 1024) throw new HttpError(400, 'Invalid cwd.');
    const inside = insideRoots(requested, config.roots);
    if (!inside) throw new HttpError(403, `'${requested}' is not inside an allowed root (${config.roots.join(', ')}).`);
    return inside;
  };

  const session = (id) => {
    const s = sessions.get(id);
    if (!s || s.closed) throw new HttpError(404, 'No such session.');
    return s;
  };

  async function route(req, url) {
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method;
    if (parts[0] !== 'v1') throw new HttpError(404, 'Not found.');

    if (method === 'GET' && parts.length === 2 && parts[1] === 'info') {
      return [200, {
        protocol: PROTOCOL,
        agent: 'terminia-agent',
        version: AGENT_VERSION,
        hostname: os.hostname(),
        platform: process.platform,
        powershell: { edition: powershell.edition, version: powershell.version },
        roots: config.roots,
        exec: config.exec,
        sessions: { max: config.maxSessions, active: sessions.list().length },
        tls: !!tls,
      }];
    }
    if (parts[1] === 'sessions' && parts.length === 2) {
      if (method === 'GET') {
        return [200, { sessions: sessions.list().filter((s) => !s.transient).map((s) => ({ id: s.id, cwd: s.cwd, busy: s.busy, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt })) }];
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const s = await sessions.create(cwdFor(body.cwd));
        log(`Session ${s.id.slice(0, 8)} opened in ${s.cwd}`);
        return [201, { id: s.id, cwd: s.cwd, createdAt: s.createdAt }];
      }
    }
    if (parts[1] === 'sessions' && parts.length === 3 && method === 'DELETE') {
      const s = sessions.get(parts[2]);
      if (!s) throw new HttpError(404, 'No such session.');
      s.close();
      return [204, null];
    }
    if (parts[1] === 'sessions' && parts.length === 4 && parts[3] === 'commands' && method === 'POST') {
      const s = session(parts[2]);
      const body = await readBody(req);
      if (typeof body.script !== 'string' || !body.script.trim()) throw new HttpError(400, "'script' is required.");
      if (body.script.length > MAX_SCRIPT) throw new HttpError(413, 'The script is too long.');
      if (config.logCommands) log(`[${s.id.slice(0, 8)}] ${redact(body.script).slice(0, 200)}`);
      const command = s.start('run', { script: body.script });
      return [202, { id: command.id }];
    }
    if (parts[1] === 'sessions' && parts.length === 5 && parts[3] === 'commands' && method === 'GET') {
      const s = sessions.get(parts[2]);
      const command = s?.commands.get(parts[4]);
      if (!command) throw new HttpError(404, 'No such command.');
      const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0);
      const wait = Math.min(25_000, Math.max(0, Number(url.searchParams.get('wait') ?? 0) || 0));
      return [200, await command.wait(after, wait)];
    }
    if (parts[1] === 'sessions' && parts.length === 6 && parts[3] === 'commands' && parts[5] === 'cancel' && method === 'POST') {
      const s = session(parts[2]);
      if (!s.commands.has(parts[4])) throw new HttpError(404, 'No such command.');
      s.cancel(parts[4]);
      return [202, {}];
    }
    if (parts[1] === 'sessions' && parts.length === 4 && parts[3] === 'complete' && method === 'POST') {
      const s = session(parts[2]);
      const body = await readBody(req);
      if (typeof body.input !== 'string' || body.input.length > 4096 || !Number.isInteger(body.cursor)) throw new HttpError(400, 'input and cursor are required.');
      return [200, await s.complete(body.input, Math.max(0, Math.min(body.cursor, body.input.length)))];
    }
    if (parts[1] === 'exec' && parts.length === 2 && method === 'POST') {
      const body = await readBody(req);
      if (typeof body.program !== 'string' || !PROGRAM.test(body.program)) throw new HttpError(400, 'program must be a bare program name.');
      if (!config.exec.includes(body.program)) throw new HttpError(403, `'${body.program}' is not in the agent's exec allowlist (${config.exec.join(', ')}).`);
      if (!Array.isArray(body.args) || body.args.length > 100 || body.args.some((a) => typeof a !== 'string' || a.length > 1000 || /[\r\n\0]/.test(a))) {
        throw new HttpError(400, 'args must be an array of single-line strings.');
      }
      const cwd = cwdFor(body.cwd);
      const s = await sessions.create(cwd, { transient: true });
      log(`exec ${body.program} (${body.args.length} args) in ${cwd}`);
      const command = s.start('exec', { program: body.program, args: body.args, cwd });
      return [202, { sessionId: s.id, commandId: command.id }];
    }
    throw new HttpError(404, 'Not found.');
  }

  async function handler(req, res) {
    const started = Date.now();
    const address = req.socket.remoteAddress ?? '';
    const origin = req.headers.origin;
    const send = (status, body) => {
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (origin && config.allowedOrigins.includes(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
        headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE';
        headers.Vary = 'Origin';
      }
      if (body === null) res.writeHead(status, headers).end();
      else res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
      const path = (req.url ?? '').split('?')[0];
      log(`${req.method} ${path} ${status} ${address} ${Date.now() - started}ms`);
    };
    try {
      if (req.method === 'OPTIONS' && origin && config.allowedOrigins.includes(origin)) return send(204, null);
      if (!tls && !isPrivateAddress(address)) throw new HttpError(403, 'Plain HTTP is only accepted from private network addresses. Configure TLS.');
      if (lockout.isLocked(address)) throw new HttpError(429, 'Too many failed sign-ins. Try again later.');
      if (!verifyToken(config, bearer(req.headers.authorization))) {
        const locked = lockout.fail(address);
        if (locked) log(`Locked out ${address} after repeated failed sign-ins`);
        throw new HttpError(401, 'Invalid or missing token.');
      }
      lockout.succeed(address);
      const url = new URL(req.url ?? '/', 'http://agent');
      const [status, body] = await route(req, url);
      send(status, body);
    } catch (error) {
      const status = error.status ?? 500;
      send(status, { error: status === 500 ? `Internal error: ${redact(error.message)}` : error.message });
    }
  }

  const server = tls ? https.createServer({ cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2' }, handler) : http.createServer(handler);
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;
  const fingerprint = tls ? certificateFingerprint(tls.cert) : null;

  function checkBinding(host) {
    const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
    if (!tls && !loopback && !allowLanHttp) {
      throw new Error(`Refusing to serve plain HTTP on ${host}. Use TLS (--tls-cert/--tls-key), bind to 127.0.0.1 behind an SSH or Tailscale tunnel, or pass --allow-lan-http on a trusted private network.`);
    }
  }

  return {
    server,
    sessions,
    fingerprint,
    listen(host, port) {
      checkBinding(host);
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    async close() {
      const stopped = sessions.closeAll();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      await stopped;
    },
  };
}
