# Signing

Signing keys never go into a project, a repository, the Terminia app or a log. They are stored as **GitHub Actions secrets** of the build repository, used on the runner in a temporary keychain or temporary file, and deleted at the end of the job. GitHub masks secret values in logs.

Add secrets on github.com: repository → **Settings → Secrets and variables → Actions → New repository secret**.

## Encoding files as base64

The certificate, profile and keystore are binary files; secrets hold text, so encode them:

```bash
base64 -i Certificates.p12 | pbcopy
```
macOS: copies the base64 to the clipboard.

```bash
base64 -w0 release.jks > release.jks.b64
```
Linux.

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("release.jks")) | Set-Clipboard
```
Windows PowerShell.

Delete any `.b64` file afterwards.

## iOS

| Secret | Contents |
| --- | --- |
| `IOS_CERTIFICATE_P12_BASE64` | base64 of a `.p12` containing the signing certificate **and its private key** |
| `IOS_CERTIFICATE_PASSWORD` | the password you chose when exporting the `.p12` |
| `IOS_PROVISIONING_PROFILE_BASE64` | base64 of the `.mobileprovision` |

Getting them (Apple Developer Program membership required):

1. Create a certificate at developer.apple.com → Certificates: **Apple Development** (for `development`) or **Apple Distribution** (for `ad-hoc`, `app-store`). Enterprise accounts: In-House.
2. Install it on a Mac, open Keychain Access, find the certificate with its private key, **Export** as `.p12` with a password.
3. Register the App ID with your bundle identifier, then create a **provisioning profile** of the matching type (Development, Ad Hoc - with your devices' UDIDs, App Store, or In-House) and download it.
4. Encode and add the three secrets.

The export method must match the profile: development ↔ Development profile, ad-hoc ↔ Ad Hoc, app-store ↔ App Store, enterprise ↔ In-House. The profile's App ID must match the app's bundle identifier (a wildcard profile matches any); otherwise the build stops and says which identifiers differ.

### Can I install it on my iPad?

| What you built | Installable? |
| --- | --- |
| Unsigned IPA | **No**, not as is. Sign it first: re-sign with your Apple ID (AltStore, Sideloadly - free accounts give 7-day apps), sign it with a signed Terminia build, or build from Xcode on a Mac. |
| Development IPA | Yes, on devices registered in the development profile (install via Apple Configurator, Xcode, or an MDM/OTA service). |
| Ad hoc IPA | Yes, on the devices in the Ad Hoc profile. |
| App Store IPA | Only through TestFlight / the App Store (upload with Transporter or the App Store Connect API). |
| Enterprise IPA | On devices of your organisation (Apple Developer Enterprise Program). |

iPadOS does not let one app install another, so Terminia gives you the file; installation happens through one of the routes above.

## Android

| Secret | Contents |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | base64 of the keystore (`.jks` / `.keystore`) |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias |
| `ANDROID_KEY_PASSWORD` | key password (defaults to the keystore password if empty) |

Create a release key once and keep a safe backup - losing it means you cannot update your app on Google Play (unless you use Play App Signing):

```bash
keytool -genkeypair -v -keystore release.jks -alias release -keyalg RSA -keysize 4096 -validity 10000
```

Terminia passes the key to Gradle through `android.injected.signing.*` properties in the runner's user-level `gradle.properties`, so your `build.gradle` does not need any signing configuration and nothing is passed on the command line.

## Hardening (optional)

- **Protected environment**: create an environment named, for example, `terminia-signing` (Settings → Environments) with required reviewers, move the signing secrets into it, and add `environment: terminia-signing` to the `build` job in your copy of the workflow. Every signed build then waits for approval; Terminia shows the run as *Queued (waiting for a deployment approval)*. `terminia ci status` will report the workflow as edited.
- Restrict who can push to the build repository: anyone who can push can change the workflow and therefore use the secrets.
- Use separate repositories for experiments and for signed releases.
