#!/usr/bin/env bash
# terminia-template: android-build v1
# Builds an Android APK and/or AAB with Gradle and copies them to $TERMINIA_OUT.
#
#   variant=debug    signed with the Android debug key (installable for testing)
#   variant=release  signed with the keystore from GitHub Actions secrets,
#                    injected through Gradle's android.injected.signing.*
#                    properties (the project's build files are not changed)
#
# Environment: TERMINIA_PROJECT_DIR, TERMINIA_KIND, VARIANT, OUTPUT (apk|aab|both),
# MODULE, JAVA_VERSION, GENERATE_NATIVE, TERMINIA_OUT, TERMINIA_BUILD_ID and,
# for release builds, ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD,
# ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD.
set -euo pipefail
source "$(dirname "$0")/common.sh"
cd "${TERMINIA_PROJECT_DIR:?}"

VARIANT="${VARIANT:-debug}"
OUTPUT="${OUTPUT:-apk}"
MODULE="${MODULE:-app}"
JAVA_VERSION="${JAVA_VERSION:-21}"
case "$VARIANT" in debug | release) ;; *) fail "variant must be debug or release (got '$VARIANT')." ;; esac
case "$OUTPUT" in apk | aab | both) ;; *) fail "output must be apk, aab or both (got '$OUTPUT')." ;; esac
MODULE_RE='^[A-Za-z0-9_-]+$'
[[ $MODULE =~ $MODULE_RE ]] || fail "module must be a Gradle module name such as app."
JAVA_RE='^[0-9]{2}$'
[[ $JAVA_VERSION =~ $JAVA_RE ]] || fail "java_version must be a major version such as 21."

# ------------------------------------------------------------------- JDK
# GitHub's runner images expose each preinstalled JDK as JAVA_HOME_<major>_<arch>.
for var in "JAVA_HOME_${JAVA_VERSION}_X64" "JAVA_HOME_${JAVA_VERSION}_arm64" "JAVA_HOME_${JAVA_VERSION}_ARM64"; do
    if [ -n "${!var:-}" ]; then
        export JAVA_HOME="${!var}"
        break
    fi
done
if [ -z "${JAVA_HOME:-}" ] || { [ ! -e "$JAVA_HOME/bin/java" ] && [ ! -e "$JAVA_HOME/bin/java.exe" ]; }; then
    fail "JDK $JAVA_VERSION is not installed on this runner (no JAVA_HOME_${JAVA_VERSION}_X64)."
fi
export PATH="$JAVA_HOME/bin:$PATH"
JAVA_MAJOR=$(java -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | first_line)
[ "$JAVA_MAJOR" = "$JAVA_VERSION" ] || fail "JDK $JAVA_VERSION was requested but $JAVA_HOME is JDK ${JAVA_MAJOR:-unknown}."
java -version 2>&1 | first_line
[ -n "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ] || fail "ANDROID_HOME is not set: the Android SDK is missing on this runner."
export ANDROID_HOME="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"

# ------------------------------------------------------------- Capacitor
GRADLE_DIR="."
if [ "${TERMINIA_KIND:-}" = capacitor ]; then
    if [ -f package.json ] && node -e "process.exit(require('./package.json').scripts && require('./package.json').scripts.build ? 0 : 1)"; then
        run_logged web-build npm run build
    fi
    if [ ! -d android ]; then
        if [ "${GENERATE_NATIVE:-true}" = "true" ]; then
            echo "No android/ folder in the project: generating it with 'npx cap add android' for this build only."
            run_logged cap-add-android npx cap add android
        else
            fail "The project has no android/ folder and generate_native is off. Commit the native Android project, or enable generate_native."
        fi
    fi
    run_logged cap-sync-android npx cap sync android
    GRADLE_DIR="android"
fi
cd "$GRADLE_DIR"
[ -d "$MODULE" ] || fail "Gradle module '$MODULE' does not exist in $GRADLE_DIR."

if [ -f gradlew ]; then
    chmod +x gradlew
    GRADLE=(./gradlew)
elif command -v gradle > /dev/null 2>&1; then
    warn "The project has no Gradle wrapper; using the runner's Gradle ($(gradle --version 2>/dev/null | grep '^Gradle' || echo unknown))."
    GRADLE=(gradle)
else
    fail "No Gradle wrapper (gradlew) in the project and no Gradle on the runner."
fi

# --------------------------------------------------------------- signing
GRADLE_PROPS="${GRADLE_USER_HOME:-$HOME/.gradle}/gradle.properties"
SIGNED_WITH=debug
if [ "$VARIANT" = release ]; then
    if [ -z "${ANDROID_KEYSTORE_BASE64:-}" ] || [ -z "${ANDROID_KEYSTORE_PASSWORD:-}" ] || [ -z "${ANDROID_KEY_ALIAS:-}" ]; then
        fail "Release builds need signing secrets: ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS (and ANDROID_KEY_PASSWORD). Add them in the repository's Settings > Secrets and variables > Actions, or build the debug variant."
    fi
    KEYSTORE="${RUNNER_TEMP:-/tmp}/terminia-release.jks"
    printf '%s' "$ANDROID_KEYSTORE_BASE64" | base64 --decode > "$KEYSTORE" || fail "ANDROID_KEYSTORE_BASE64 is not valid base64."
    chmod 600 "$KEYSTORE"
    mkdir -p "$(dirname "$GRADLE_PROPS")"
    # Properties go into the runner's user-level gradle.properties (removed after the build), not the command line.
    {
        echo "android.injected.signing.store.file=$KEYSTORE"
        echo "android.injected.signing.store.password=$ANDROID_KEYSTORE_PASSWORD"
        echo "android.injected.signing.key.alias=$ANDROID_KEY_ALIAS"
        echo "android.injected.signing.key.password=${ANDROID_KEY_PASSWORD:-$ANDROID_KEYSTORE_PASSWORD}"
    } >> "$GRADLE_PROPS"
    chmod 600 "$GRADLE_PROPS"
    set_env TERMINIA_SIGNING_FILES "$KEYSTORE:$GRADLE_PROPS"
    SIGNED_WITH=release-keystore
fi

# ----------------------------------------------------------------- build
CAP_VARIANT="$(printf '%s' "${VARIANT:0:1}" | tr '[:lower:]' '[:upper:]')${VARIANT:1}"
TASKS=()
case "$OUTPUT" in
    apk) TASKS+=(":$MODULE:assemble$CAP_VARIANT") ;;
    aab) TASKS+=(":$MODULE:bundle$CAP_VARIANT") ;;
    both) TASKS+=(":$MODULE:assemble$CAP_VARIANT" ":$MODULE:bundle$CAP_VARIANT") ;;
esac
run_logged gradle "${GRADLE[@]}" --no-daemon --stacktrace --console=plain "${TASKS[@]}"

# ---------------------------------------------------------------- outputs
BUILD_TOOLS=$(ls -d "$ANDROID_HOME"/build-tools/* 2>/dev/null | sort -V | tail -n 1 || true)
APKSIGNER="$BUILD_TOOLS/apksigner"
AAPT2="$BUILD_TOOLS/aapt2"
[ -x "$APKSIGNER" ] || APKSIGNER="$BUILD_TOOLS/apksigner.bat"
[ -x "$AAPT2" ] || AAPT2="$BUILD_TOOLS/aapt2.exe"

FILES_JSON=""
APP_ID=""
add_file() {
    local path="$1" kind="$2"
    local name
    name="$(basename "$path")"
    local sha size
    sha=$(sha256_of "$path")
    size=$(size_of "$path")
    [ -n "$FILES_JSON" ] && FILES_JSON="$FILES_JSON,"
    FILES_JSON="$FILES_JSON{\"file\":\"$(json_escape "$name")\",\"kind\":\"$kind\",\"size\":$size,\"sha256\":\"$sha\"}"
}

APK_NAME=""
AAB_NAME=""
if [ "$OUTPUT" != aab ]; then
    APK=$(find "$MODULE/build/outputs/apk/$VARIANT" -maxdepth 1 -name '*.apk' 2>/dev/null | head -n 1 || true)
    [ -n "$APK" ] || fail "Gradle finished but no APK was found in $MODULE/build/outputs/apk/$VARIANT."
    # Capture the listing first: 'unzip | grep -q' fails under pipefail when grep exits early (SIGPIPE).
    LISTING=$(unzip -l "$APK")
    grep -q 'AndroidManifest.xml' <<< "$LISTING" || fail "$APK is not a valid APK (no AndroidManifest.xml)."
    grep -Eq 'classes[0-9]*\.dex' <<< "$LISTING" || fail "$APK is not a valid APK (no classes.dex)."
    if [ -e "$APKSIGNER" ]; then
        echo "Signature:"
        SIGNATURE=$("$APKSIGNER" verify --verbose --print-certs "$APK") || fail "apksigner could not verify $APK."
        grep -E 'certificate DN|Verified using .*: true' <<< "$SIGNATURE" || true
    fi
    if [ -e "$AAPT2" ]; then
        APP_ID=$("$AAPT2" dump badging "$APK" 2>/dev/null | sed -n "s/^package: name='\([^']*\)'.*/\1/p" | head -n 1 || true)
    fi
    APK_NAME="$(basename "$APK")"
    cp "$APK" "$TERMINIA_OUT/$APK_NAME"
    add_file "$TERMINIA_OUT/$APK_NAME" apk
    echo "APK: $APK_NAME ($(size_of "$APK") bytes)"
fi
if [ "$OUTPUT" != apk ]; then
    AAB=$(find "$MODULE/build/outputs/bundle/$VARIANT" -maxdepth 1 -name '*.aab' 2>/dev/null | head -n 1 || true)
    [ -n "$AAB" ] || fail "Gradle finished but no AAB was found in $MODULE/build/outputs/bundle/$VARIANT."
    LISTING=$(unzip -l "$AAB")
    grep -q 'base/manifest/AndroidManifest.xml' <<< "$LISTING" || fail "$AAB is not a valid Android App Bundle."
    AAB_NAME="$(basename "$AAB")"
    cp "$AAB" "$TERMINIA_OUT/$AAB_NAME"
    add_file "$TERMINIA_OUT/$AAB_NAME" aab
    echo "AAB: $AAB_NAME ($(size_of "$AAB") bytes)"
fi

set_output apk_name "$APK_NAME"
set_output aab_name "$AAB_NAME"
publish_result "{\"platform\":\"android\",\"buildId\":\"$(json_escape "${TERMINIA_BUILD_ID:-}")\",\"variant\":\"$VARIANT\",\"signedWith\":\"$SIGNED_WITH\",\"applicationId\":\"$(json_escape "$APP_ID")\",\"files\":[$FILES_JSON]}"
