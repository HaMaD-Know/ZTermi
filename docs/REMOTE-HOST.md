# Remote host: real PowerShell from the iPad

iPadOS cannot run PowerShell, Node.js package managers, Git, Gradle or Xcode. For those, Terminia connects to a computer you own that runs the **Terminia agent** (`agent/terminia-agent.mjs`). Commands then run in a real PowerShell runspace on that computer, and the terminal shows them in yellow with the host name.

Requirements on the host: **Node.js 20+** and **PowerShell 7+** (`pwsh`, Windows/macOS/Linux) or **Windows PowerShell 5.1**. The agent has no npm dependencies; copy the `agent/` folder or use it from this repository.

## 1. Create the configuration

```bash
node agent/terminia-agent.mjs init --root C:\src --root D:\work
```

- prints a **token once** (`tma_…`). Only a salted SHA-256 hash is stored, in `~/.terminia-agent/config.json` (mode 0600 on macOS/Linux; the user profile's ACL on Windows);
- `--root` limits the folders sessions may start in and `exec` may run in (default: your home folder). This is a convenience boundary, not a sandbox: an interactive PowerShell can still `cd` anywhere the account can;
- `--listen` sets the address (default `127.0.0.1:8765`, loopback only);
- `--powershell` picks the executable (default `pwsh`, then `powershell.exe`).

`token` replaces the token (the old one stops working immediately); `status` shows the configuration without secrets.

## 2. Make it reachable from the iPad - pick one

**A. Tailscale (recommended).** Install Tailscale on the computer and the iPad. Keep the agent on loopback and publish it inside your tailnet with HTTPS:

```bash
tailscale serve --bg --https=8765 http://127.0.0.1:8765
```

The URL is `https://<machine>.<tailnet>.ts.net:8765`; the certificate is a real one, nothing to pin. Not reachable from the internet.

**B. HTTPS on your LAN with your own certificate.**

```bash
node agent/terminia-agent.mjs start --listen 0.0.0.0:8765 --tls-cert cert.pem --tls-key key.pem
```

The agent prints the certificate's SHA-256 fingerprint; give it to `terminia remote add … --fingerprint <sha256>` so Terminia pins it (needed for a self-signed certificate; the native HTTP plugin compares the leaf certificate's fingerprint).

**C. Plain HTTP on a private network** (home LAN only):

```bash
node agent/terminia-agent.mjs start --listen 192.168.1.20:8765 --allow-lan-http
```

The agent refuses plain HTTP from any non-private address, and refuses to bind HTTP to a non-loopback address without `--allow-lan-http`. The token travels unencrypted on the LAN in this mode - use A or B whenever you can. iOS requires the *Local Network* permission (Terminia asks on first use).

**D. SSH tunnel.** Keep the agent on loopback and forward the port with an SSH client app on the iPad that supports local forwarding, then use `http://127.0.0.1:8765`.

**Never** forward the port on your router to the internet.

## 3. Add the host in Terminia

```text
terminia remote add devbox https://devbox.tailnet.ts.net:8765
terminia remote test devbox
terminia remote connect devbox
```

`remote add` asks for the token in a secure field and stores it in the Keychain, bound to that URL's origin - it is only ever sent to that host. Or use **Settings → Remote hosts**.

In a connected terminal tab:

- everything you type runs on the host; variables, functions, modules and the current location persist between commands (one runspace per tab);
- `Tab` completes with PowerShell's own `TabExpansion2`;
- **Stop** (or `Ctrl+C`) stops the pipeline (`BeginStop`), like Ctrl+C in a console;
- output streams keep their colors: errors red, warnings yellow, verbose/debug dimmed;
- prefix a command with `:` to run it in Terminia locally (`:ls`, `:pwd`); `terminia …` commands always run locally; `exit` disconnects.

`terminia remote map devbox C:\src\myapp` links the current project to a folder on the host, so `terminia deps install --on remote --remote devbox` and `terminia remote exec devbox npm test` run there.

## `exec` and the allowlist

`terminia remote exec` and remote dependency jobs do not send a script; they send a program name and an argument list, which the host runs with PowerShell's `AddCommand`/`AddArgument` - no string is ever parsed as PowerShell. Only programs in the allowlist (`npm pnpm yarn pip python python3 git node pod gradle` by default, `exec` in the config file) may run, only inside the roots. On Windows, `.cmd`/`.bat` shims refuse arguments containing `& | < > % "` (cmd.exe would interpret them), and Windows PowerShell 5.1 refuses `"` in any native argument because it does not pass embedded quotes correctly. PowerShell 7.3+ has neither limitation for `.exe` programs.

## Running it permanently (optional)

- **Windows**: Task Scheduler → *At log on* → `node C:\path\agent\terminia-agent.mjs start`.
- **macOS**: a LaunchAgent plist with `ProgramArguments` `node …/terminia-agent.mjs start`.
- **Linux**: a `systemd --user` service.

Run it as your normal user, never as Administrator/root.

## Logs

The agent logs requests (method, path, status, address, duration), session open/close and lockouts. It does **not** log commands unless you start it with `--log-commands`, and then with secrets redacted.

## Limits

4 sessions (`maxSessions`), sessions closed after 30 idle minutes (`idleMinutes`), 200 KB per script, 8 MB of output per command (then truncated), 5 failed sign-ins in 10 minutes lock an address out for 10 minutes.
