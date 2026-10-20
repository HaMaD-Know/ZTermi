# Troubleshooting

Start with `terminia status` (connections, current project, active builds) and `terminia <ios|android|web> configure` (preflight checks with explanations).

## GitHub

| Symptom | Cause and fix |
| --- | --- |
| `401 Bad credentials` | Token expired or revoked. `terminia github login --token` again. |
| `404` on a repository you own | Fine-grained token not granted that repository, or private repository without access. Edit the token's *Repository access*. |
| `403 Resource not accessible by personal access token` | Missing permission - usually *Workflows* (pushing `.github/workflows`) or *Actions* (dispatch, cancel). See [GITHUB-SETUP.md](GITHUB-SETUP.md). |
| `Workflow does not have 'workflow_dispatch' trigger` / workflow not found | The workflow is not on the default branch. `terminia github prepare`. |
| Build stays at *Dispatching* then fails to find the run | The workflow's `run-name` was edited and no longer contains the build id. Restore it (`terminia ci status` shows edited templates; `terminia ci install --force` reinstalls). |
| `Branch moved; review the changes again` | Someone pushed to the branch after the preview. Run the build or `terminia git sync` again. |
| Sync refuses a file | A secret was detected. Remove it, add the path to `.gitignore`, or - only for a false-positive *suspected password* - list it in `.terminia/allow-secrets.txt`. |
| Rate limit | Terminia waits for short limits. For the hourly limit it reports the reset time; wait or use a different token. |
| Artifacts can't be downloaded in the browser | Expected: GitHub's storage has no CORS. Use the iPad app, or download from github.com. |
| Artifact expired | Artifacts are kept 14 days (logs 7). Rebuild. |

## iOS builds

| Symptom | Cause and fix |
| --- | --- |
| *Waiting for signing configuration* | Signed export without all three `IOS_*` secrets. Add them ([SIGNING.md](SIGNING.md)) or build `--export unsigned`. |
| `Xcode 26.x is not installed` | The runner image changed. Set `xcode_version` (`terminia ios configure --xcode 26.4`) or let it fall back. |
| `No such module 'Capacitor'` / package resolution errors | `@capacitor/ios` missing from `package.json`, or the lockfile is out of date. `terminia deps install`. |
| `Provisioning profile … doesn't include signing certificate` | The `.p12` and the profile don't belong together. Export the certificate that the profile lists. |
| Bundle id mismatch | `appId` in `capacitor.config.*` must match the profile's App ID. |
| Scheme not found | Native Xcode projects: share the scheme in Xcode, commit `xcshareddata`. |
| Unsigned IPA won't install | Expected - it must be signed first. |

The full xcodebuild log is in the `terminia-ios-logs-*` artifact (`terminia ios artifacts`).

## Android builds

| Symptom | Cause and fix |
| --- | --- |
| *Waiting for signing configuration* | Release build without the `ANDROID_*` secrets. Add them or build `--variant debug`. |
| `Unsupported class file major version` / `requires Java 21` | `java_version` too old for the Gradle/AGP version. Capacitor 8 needs 21. |
| `SDK location not found` | Native project without `local.properties` is fine on runners (`ANDROID_HOME` is set); on your own host install the SDK. |
| `Keystore was tampered with, or password was incorrect` | Wrong `ANDROID_KEYSTORE_PASSWORD`, or the base64 was wrapped with line breaks (`base64 -w0`). |
| `gradlew: Permission denied` | Handled by the script (`chmod +x`); if it persists, commit the wrapper with the executable bit. |

## Remote host

| Symptom | Cause and fix |
| --- | --- |
| Connection refused | Agent not running, wrong port, or listening on 127.0.0.1 while you connect over the LAN. Use Tailscale serve or `--listen`. |
| `403 Plain HTTP is only accepted from private network addresses` | Use HTTPS (`--tls-cert`/`--tls-key` or Tailscale). |
| `429 Too many failed sign-ins` | Wrong token five times; wait 10 minutes, then `terminia remote token <profile>` with the right one (or rotate it with `terminia-agent token`). |
| Certificate pin mismatch | The agent's certificate changed. `node agent/terminia-agent.mjs fingerprint --tls-cert cert.pem`, then remove and re-add the profile. |
| iOS refuses `http://` | ATS allows HTTP only to local-network addresses; use the LAN IP or HTTPS. Allow *Local Network* in iPad Settings → Terminia. |
| Command never finishes | It is waiting for input (`Read-Host`, a password prompt). Press Stop; use non-interactive flags. |
| `exec … is not in the agent's exec allowlist` | Add the program to `exec` in `~/.terminia-agent/config.json` and restart the agent. |
| `PowerShell 5.1 cannot pass '"'…` | Windows PowerShell 5.1 mangles embedded quotes in native arguments; install PowerShell 7 and `init --powershell pwsh --force`. |

## Files

| Symptom | Cause and fix |
| --- | --- |
| Opened folder shows *Access lost* | The provider (iCloud, a USB drive) revoked access or the folder moved. Open it again from the Files app. |
| *Changed on disk* when saving | Another app changed the file. Choose reload or overwrite. |
| A zip import is refused | It contains unsafe paths or exceeds size/ratio limits. |

## Development

- `npm run verify` runs lint, type check, tests, the template sync check and the iOS project check; `npm run build` builds the web bundle.
- After editing `templates/`, run `npm run sync:templates`.
- After `npx cap add ios` (fresh native project), run `node scripts/wire-ios.mjs` and `npm run check:ios`.
- `UPDATE_DOCS=1 npx vitest run tests/unit/command-docs.test.ts` regenerates `docs/COMMANDS.md`.
