# Security

## Assets

| Asset | Where it lives |
| --- | --- |
| GitHub token | iOS Keychain (browser preview: memory of the tab) |
| Remote agent tokens | iOS Keychain, bound to the agent's origin; the agent stores only a salted SHA-256 hash |
| Signing certificates, profiles, keystores and passwords | GitHub Actions secrets of your build repository - never on the iPad, never in the project |
| Project source | the app's Documents folder or folders you opened; GitHub repositories you chose |

## Threats and controls

**Token theft through the web view** (XSS, malicious project content rendered in the UI, a compromised dependency).
- Tokens are entered in a native secure field, stored in the Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, and attached to requests by `TerminiaHttp`. No plugin method returns a secret.
- Each credential carries the origins it may be sent to (`https://api.github.com`; one agent origin). A request for any other origin goes without it. `Authorization` is removed when a redirect leaves the origin (GitHub's log/artifact storage URLs are pre-signed).
- Content Security Policy: no inline scripts, `connect-src` limited to `https:` and loopback for development. The UI builds DOM nodes with `textContent`, never `innerHTML` with data.

**Secrets committed or exported by accident.**
- `secrets.ts` blocks by name (`.env*`, `*.p12`, `*.pfx`, `*.p8`, `*.mobileprovision`, `*.jks`, `*.keystore`, `key.properties`, `id_rsa*`, `.netrc`, `.npmrc` with tokens…) and by content (private-key blocks, GitHub/npm/AWS/Slack/Google/Stripe token formats, hard-coded passwords). Blocked files are never uploaded or exported; only content-rule *suspicions* can be allowlisted in `.terminia/allow-secrets.txt`.
- Sync shows the destination repository, branch and the exact file list, and needs confirmation. The default `.gitignore` template of new projects excludes secrets and build output.

**Secrets in logs, history or storage.**
- `redact.ts` masks known token formats, `Authorization` headers, `password=` style assignments and every secret value registered at runtime, in terminal output, history, persisted documents (`JsonDocument` redacts on save) and error messages.
- Settings and `.terminia/config.json` hold no secrets (validated). Tokens never appear in URLs.
- Commands that start with a space are not saved in history.

**Malicious workflow inputs / script injection on the runner.**
- Workflow inputs are passed via `env:`; scripts never contain `${{ inputs.* }}` (a unit test enforces this for every template). Inputs are validated again in the scripts with anchored regular expressions (package names, paths without `..`, version strings).
- `permissions: contents: read` for every workflow; GitHub's own actions at current major versions.
- Signing: temporary keychain with a random password (iOS), keystore in `$RUNNER_TEMP` and injected Gradle properties in the runner's user `gradle.properties` (Android); deleted in `if: always()` steps. Secrets never go on a command line.

**Untrusted archives.** Zip import and artifact extraction reject absolute paths, `..`, drive letters and NUL bytes; limit entry count, total size and compression ratio; and verify artifact digests when GitHub provides them.

**Remote agent abuse.** Anyone with the token can run commands as the user who started the agent - treat it like an SSH key.
- Default bind 127.0.0.1. Non-loopback HTTP requires `--allow-lan-http`, and plain-HTTP requests from non-private addresses are refused regardless. TLS 1.2+ with optional pinning by certificate SHA-256.
- 256-bit random tokens, salted SHA-256, constant-time comparison; 5 failures in 10 minutes lock the address out for 10 minutes.
- Structured `exec` uses `AddCommand`/`AddArgument` (no parsing), an allowlist and allowed roots; `.cmd`/`.bat` metacharacters and PS 5.1 quote mangling are refused.
- Body, script, output and session limits; idle sessions closed; no command logging unless asked, and then redacted.
- CORS only for origins you list explicitly.

## Not covered

- A compromised iPad or a compromised host computer.
- A repository collaborator who changes the workflow: anyone who can push to the build repository can use its secrets. Restrict push access or use a protected environment (see [SIGNING.md](SIGNING.md)).
- Malicious dependencies installed during builds - they run on the GitHub runner (or your host for remote installs). Review lockfile changes; Terminia shows the diff before applying them.
- The browser preview is a development tool; tokens there live only in memory but any script on that origin could use them.

## Reporting

Please report vulnerabilities privately to the repository owner instead of opening a public issue.
