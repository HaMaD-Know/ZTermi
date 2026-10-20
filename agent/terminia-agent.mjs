#!/usr/bin/env node
// Terminia agent: gives Terminia on iPad a real PowerShell on this computer.
// Node.js 20+ and PowerShell (7+, or Windows PowerShell 5.1) are required. No npm dependencies.
//
//   node agent/terminia-agent.mjs init      create a configuration and a token
//   node agent/terminia-agent.mjs start     run the agent
//   node agent/terminia-agent.mjs token     replace the token (the old one stops working)
//   node agent/terminia-agent.mjs status    show the configuration (never the token)
import { readFileSync } from 'node:fs';
import { defaultConfigPath, initConfig, loadConfig, parseListen, rotateToken } from './lib/config.mjs';
import { AGENT_VERSION, certificateFingerprint, createAgent } from './lib/server.mjs';
import { resolvePowerShell } from './lib/sessions.mjs';

function parseArgs(argv) {
  const out = { _: [], root: [], 'allow-origin': [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split('=', 2);
    if (['force', 'allow-lan-http', 'log-commands', 'help'].includes(key)) {
      out[key] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value.`);
    if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = value;
  }
  return out;
}

const HELP = `Terminia agent ${AGENT_VERSION}

Usage: node agent/terminia-agent.mjs <command> [options]

Commands:
  init     Create the configuration and print a new token (shown once).
           --listen host:port   (default 127.0.0.1:8765)
           --root <path>        folder sessions may start in (repeatable; default: home)
           --powershell <path>  PowerShell executable (default: pwsh, then powershell.exe)
           --force              replace an existing configuration
  start    Run the agent.
           --listen host:port   override the configured address
           --tls-cert <file> --tls-key <file>   serve HTTPS (prints the certificate fingerprint)
           --allow-lan-http     allow plain HTTP on a non-loopback address (private networks only)
           --allow-origin <url> allow browser requests from an origin (development only)
           --log-commands       log submitted commands (secrets redacted)
  token    Generate a new token; the previous token stops working.
  status   Print the configuration without secrets.
  fingerprint --tls-cert <file>   Print a certificate's SHA-256 fingerprint for pinning.

  --config <file>  configuration file (default ${defaultConfigPath()})

Security: anyone with the token can run commands as the user running the agent.
Keep the token secret, prefer HTTPS or a Tailscale/SSH tunnel, and stop the
agent when you do not need it. See docs/REMOTE-HOST.md.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? 'help';
  const file = args.config ?? defaultConfigPath();
  if (args.help || command === 'help') {
    console.log(HELP);
    return;
  }
  if (command === 'init') {
    const powershell = resolvePowerShell(args.powershell ?? 'auto');
    const { config, token } = initConfig(file, {
      force: args.force,
      listen: args.listen ? parseListen(args.listen) : undefined,
      roots: args.root,
      powershell: args.powershell ?? 'auto',
    });
    console.log(`Configuration written to ${file}`);
    console.log(`PowerShell: ${powershell.edition} ${powershell.version} (${powershell.path})`);
    console.log(`Allowed roots: ${config.roots.join(', ')}`);
    console.log('');
    console.log('Agent token (shown only now - paste it into Terminia when adding this host):');
    console.log('');
    console.log(`    ${token}`);
    console.log('');
    console.log(`Next: node agent/terminia-agent.mjs start`);
    return;
  }
  if (command === 'token') {
    const token = rotateToken(file);
    console.log('New agent token (the previous one no longer works):');
    console.log(`\n    ${token}\n`);
    console.log('In Terminia: remote token <profile>');
    return;
  }
  if (command === 'fingerprint') {
    if (!args['tls-cert']) throw new Error('--tls-cert is required.');
    console.log(certificateFingerprint(readFileSync(args['tls-cert'])));
    return;
  }
  const config = loadConfig(file);
  if (command === 'status') {
    const { tokenHash, tokenSalt, ...rest } = config;
    void tokenHash;
    void tokenSalt;
    console.log(JSON.stringify(rest, null, 2));
    return;
  }
  if (command !== 'start') throw new Error(`Unknown command '${command}'. Run with --help.`);

  if (args['tls-cert'] || args['tls-key']) {
    if (!args['tls-cert'] || !args['tls-key']) throw new Error('--tls-cert and --tls-key go together.');
    config.tls = { cert: args['tls-cert'], key: args['tls-key'] };
  }
  if (args['allow-origin'].length) config.allowedOrigins = args['allow-origin'];
  if (args['log-commands']) config.logCommands = true;
  const listen = args.listen ? parseListen(args.listen) : config.listen;

  const powershell = resolvePowerShell(config.powershell);
  const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
  const agent = createAgent(config, { powershell, log, allowLanHttp: !!args['allow-lan-http'] });
  const address = await agent.listen(listen.host, listen.port);
  const scheme = config.tls ? 'https' : 'http';
  console.log(`Terminia agent ${AGENT_VERSION} listening on ${scheme}://${listen.host}:${address.port}`);
  console.log(`PowerShell ${powershell.edition} ${powershell.version} · roots: ${config.roots.join(', ')} · exec: ${config.exec.join(', ')}`);
  if (agent.fingerprint) console.log(`Certificate SHA-256 (pin this in Terminia): ${agent.fingerprint}`);
  if (!config.tls) console.log('Plain HTTP: connections are only accepted from private network addresses. Prefer TLS or a tunnel.');
  const stop = async () => {
    console.log('Stopping…');
    await agent.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  console.error(`terminia-agent: ${error.message}`);
  process.exit(1);
});
