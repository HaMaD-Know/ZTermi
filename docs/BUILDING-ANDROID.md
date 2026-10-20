# Building Android apps (APK / AAB)

Android builds run on GitHub-hosted **Linux runners** (`ubuntu-24.04`) with the `terminia-android.yml` workflow, using the runner's preinstalled JDK and Android SDK and your project's Gradle wrapper.

```text
terminia android configure
terminia android build --variant debug
terminia android build --variant release --output both
terminia android status | logs | artifacts | download | cancel | history
```

## What the workflow does

1. Checks out the synced commit and detects the project: Capacitor, or an Android Gradle project (`settings.gradle(.kts)` / `build.gradle(.kts)` with `com.android.application`).
2. Installs JavaScript dependencies (Capacitor projects) with the project's package manager and lockfile.
3. Selects the JDK from the runner's `JAVA_HOME_<version>_X64` (input `java_version`, default 21 - Capacitor 8 requires 21) and checks that it really is that version.
4. Capacitor: web build if there is a `build` script, `npx cap add android` when there is no `android/` folder (`generate_native`), `npx cap sync android`.
5. Release builds: decodes the keystore from secrets into a temporary file and writes `android.injected.signing.*` properties to the runner's user-level `gradle.properties` (not on the command line, not in your project); both are deleted in an `always()` step.
6. Runs `./gradlew --no-daemon --stacktrace :<module>:assemble<Variant>` and/or `bundle<Variant>`.
7. Verifies the outputs: the APK must contain `AndroidManifest.xml` and `classes*.dex` and pass `apksigner verify`; the AAB must contain `base/manifest/AndroidManifest.xml`. Reads the application id with `aapt2`.
8. Uploads the APK/AAB **unzipped** (`archive: false`), plus `terminia-android-logs-*`. Gradle caches are kept between runs with `actions/cache@v6`.

### Inputs

| Input | Values | Default |
| --- | --- | --- |
| `terminia_build_id` | set by Terminia | `manual` |
| `project_path` | folder in the repository | `.` |
| `variant` | `debug`, `release` | `debug` |
| `output` | `apk`, `aab`, `both` | `apk` |
| `module` | Gradle application module | `app` |
| `java_version` | JDK major version on the runner | `21` |
| `generate_native` | `npx cap add android` when `android/` is missing | `true` |

## Debug and release

- **debug** - signed with the Android debug key generated on the runner. Installable on Android devices that allow apps from unknown sources; not for Google Play.
- **release** - needs `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` (see [SIGNING.md](SIGNING.md)). Without them Terminia stops before starting the run (*Waiting for signing configuration*), and the workflow refuses too.
- **AAB** is the format for Google Play uploads; it is not directly installable.

## The APK and the iPad

An APK is an Android application package. **It cannot be installed or run on an iPad.** Terminia downloads it to **On My iPad › Terminia › Artifacts**; move it to an Android phone or tablet (cloud drive, AirDrop to a Mac and then USB/`adb install`, a messaging app) and install it there.

## Verified locally

The Android scripts were run on Windows against a project created from Terminia's Capacitor template (JDK 21, Android SDK build-tools 37): `cap add android`, `cap sync`, Gradle `assembleDebug` + `bundleDebug`, APK/AAB verification and the result annotation all completed - see [VERIFICATION-REPORT.md](VERIFICATION-REPORT.md). That run found and fixed a real bug (pipelines into `grep -q` failing under `pipefail`).
