#!/usr/bin/env bash
# terminia-template: ios-build v1
# Builds an iOS app on a macOS runner and produces a real .ipa in $TERMINIA_OUT.
#
#   export_method=unsigned  -> device build with code signing disabled, packaged
#                              as Payload/<App>.app. Such an IPA CANNOT be
#                              installed as is; it must be signed first (see
#                              docs/SIGNING.md).
#   anything else           -> archive + export with the certificate and profile
#                              imported by ios-import-signing.sh.
#
# Environment: TERMINIA_PROJECT_DIR, TERMINIA_KIND, CONFIGURATION, EXPORT_METHOD,
# SCHEME, GENERATE_NATIVE, TERMINIA_OUT, TERMINIA_BUILD_ID.
set -euo pipefail
source "$(dirname "$0")/common.sh"
CI_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${TERMINIA_PROJECT_DIR:?}"

CONFIGURATION="${CONFIGURATION:-release}"
EXPORT_METHOD="${EXPORT_METHOD:-unsigned}"
case "$CONFIGURATION" in
    debug) XC_CONFIG=Debug ;;
    release) XC_CONFIG=Release ;;
    *) fail "configuration must be debug or release (got '$CONFIGURATION')." ;;
esac
# Xcode 15.3+ export method names.
case "$EXPORT_METHOD" in
    unsigned) XC_METHOD="" ;;
    development) XC_METHOD=debugging ;;
    ad-hoc) XC_METHOD=release-testing ;;
    app-store) XC_METHOD=app-store-connect ;;
    enterprise) XC_METHOD=enterprise ;;
    *) fail "Unknown export_method '$EXPORT_METHOD'." ;;
esac

# run_quiet <name> <command...>: full output only in the log file (xcodebuild is very verbose).
run_quiet() {
    local name="$1"
    shift
    local log="$TERMINIA_OUT/logs/$name.log"
    echo "$name: $*"
    set +e
    "$@" > "$log" 2>&1
    local status=$?
    set -e
    grep -E '^\*\* .* \*\*$|warning: .*deprecated' "$log" | tail -n 10 || true
    if [ "$status" -ne 0 ]; then
        echo "----- errors -----"
        grep -E '(error|fatal error):' "$log" | sort -u | sed -n '1,60p' || true
        echo "----- last 120 lines of $name.log -----"
        tail -n 120 "$log"
        local body
        body=$( (grep -E '(error|fatal error):' "$log" | sed "s#${GITHUB_WORKSPACE:-/nonexistent}/##g" | sort -u | sed -n '1,40p'; echo '--- last lines ---'; tail -n 25 "$log") | tail -c 3800)
        echo "::error title=$name failed (exit $status)::$(annotation_escape "$body")"
        exit "$status"
    fi
}

# --------------------------------------------------------------- Capacitor
if [ "${TERMINIA_KIND:-}" = capacitor ]; then
    if [ -f package.json ] && node -e "process.exit(require('./package.json').scripts && require('./package.json').scripts.build ? 0 : 1)"; then
        run_logged web-build npm run build
    fi
    if [ ! -d ios ]; then
        if [ "${GENERATE_NATIVE:-true}" = "true" ]; then
            echo "No ios/ folder in the project: generating it with 'npx cap add ios' for this build only."
            run_logged cap-add-ios npx cap add ios
        else
            fail "The project has no ios/ folder and generate_native is off. Commit the native iOS project, or enable generate_native."
        fi
    fi
    run_logged cap-sync-ios npx cap sync ios
fi

# --------------------------------------------------------- Xcode project
XC_DIR=""
for d in ios/App ios .; do
    [ -d "$d" ] || continue
    if ls "$d"/*.xcodeproj >/dev/null 2>&1; then XC_DIR="$d"; break; fi
done
[ -n "$XC_DIR" ] || fail "No Xcode project (.xcodeproj) found in ios/App, ios or the project root."
PROJ=$(ls -d "$XC_DIR"/*.xcodeproj | first_line)

if [ -f "$XC_DIR/Podfile" ]; then
    if [ ! -d "$XC_DIR/Pods" ]; then
        (cd "$XC_DIR" && run_logged pod-install pod install --repo-update)
    fi
fi
WS=$(ls -d "$XC_DIR"/*.xcworkspace 2>/dev/null | first_line || true)
if [ -n "$WS" ] && [ -f "$XC_DIR/Podfile" ]; then
    XC_ARGS=(-workspace "$WS")
    echo "Workspace: $WS"
else
    XC_ARGS=(-project "$PROJ")
    echo "Project: $PROJ"
fi

SCHEMES=$(xcodebuild -list -json "${XC_ARGS[@]}" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); c=d.get("workspace") or d.get("project") or {}; print("\n".join(c.get("schemes", [])))')
if [ -n "${SCHEME:-}" ]; then
    grep -Fxq "$SCHEME" <<< "$SCHEMES" || fail "Scheme '$SCHEME' does not exist. Available: $(tr '\n' ' ' <<< "$SCHEMES")"
elif grep -Fxq App <<< "$SCHEMES"; then
    SCHEME=App
else
    SCHEME=$(first_line <<< "$SCHEMES")
fi
[ -n "$SCHEME" ] || fail "The Xcode project has no shared scheme. Share a scheme in Xcode (Product > Scheme > Manage Schemes)."
echo "Scheme: $SCHEME, configuration: $XC_CONFIG, export: $EXPORT_METHOD"

run_quiet resolve-packages xcodebuild -resolvePackageDependencies "${XC_ARGS[@]}" -scheme "$SCHEME"

SETTINGS_JSON="$TERMINIA_OUT/logs/build-settings.json"
xcodebuild -showBuildSettings -json "${XC_ARGS[@]}" -scheme "$SCHEME" -configuration "$XC_CONFIG" -sdk iphoneos > "$SETTINGS_JSON" 2>/dev/null || fail "Could not read the build settings of scheme '$SCHEME'."
read -r BUNDLE_ID TARGET_NAME PRODUCT_NAME < <(python3 - "$SETTINGS_JSON" <<'PY'
import json, sys
entries = json.load(open(sys.argv[1]))
for e in entries:
    s = e.get("buildSettings", {})
    if s.get("WRAPPER_EXTENSION") == "app":
        print(s.get("PRODUCT_BUNDLE_IDENTIFIER", "-"), e.get("target", "-").replace(" ", "_"), s.get("PRODUCT_NAME", "App").replace(" ", "_"))
        break
else:
    print("- - -")
PY
)
[ "$BUNDLE_ID" != "-" ] || fail "Scheme '$SCHEME' does not build an iOS application target."
echo "Bundle identifier: $BUNDLE_ID (target $TARGET_NAME)"
SAFE_NAME=$(printf '%s' "$PRODUCT_NAME" | tr -c 'A-Za-z0-9_.-' '_')

# ------------------------------------------------------------------- build
if [ -z "$XC_METHOD" ]; then
    run_quiet xcodebuild-device xcodebuild build "${XC_ARGS[@]}" -scheme "$SCHEME" -configuration "$XC_CONFIG" \
        -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath "$TERMINIA_OUT/derived" \
        CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""
    APP=$(find "$TERMINIA_OUT/derived/Build/Products/${XC_CONFIG}-iphoneos" -maxdepth 1 -name '*.app' -type d | first_line)
    [ -n "$APP" ] || fail "xcodebuild succeeded but no .app bundle was produced."
    IPA_NAME="${SAFE_NAME}-${CONFIGURATION}-unsigned.ipa"
    WORK="$(mktemp -d)"
    mkdir -p "$WORK/Payload"
    ditto "$APP" "$WORK/Payload/$(basename "$APP")"
    rm -f "$TERMINIA_OUT/$IPA_NAME"
    (cd "$WORK" && ditto -c -k --sequesterRsrc --keepParent Payload "$TERMINIA_OUT/$IPA_NAME")
    rm -rf "$WORK"
    SIGNED=false
else
    [ -n "${TERMINIA_KEYCHAIN:-}" ] || fail "Signing material was not imported."
    case "$SIGN_PROFILE_BUNDLE_ID" in
        *'*'*) ;;
        "$BUNDLE_ID") ;;
        *) fail "The provisioning profile is for '$SIGN_PROFILE_BUNDLE_ID' but the app's bundle identifier is '$BUNDLE_ID'. Use a matching profile or change the bundle identifier." ;;
    esac
    TOOLS="${RUNNER_TEMP:-/tmp}/terminia-tools"
    npm install --silent --no-save --no-package-lock --no-audit --no-fund --prefix "$TOOLS" xcode@3.0.1 > /dev/null
    TERMINIA_TOOLS="$TOOLS" node "$CI_DIR/ios-configure-signing.mjs" "$PROJ/project.pbxproj" "$TARGET_NAME" "$XC_CONFIG"
    run_quiet xcodebuild-archive xcodebuild archive "${XC_ARGS[@]}" -scheme "$SCHEME" -configuration "$XC_CONFIG" \
        -destination 'generic/platform=iOS' -archivePath "$TERMINIA_OUT/App.xcarchive" -derivedDataPath "$TERMINIA_OUT/derived"
    cat > "$TERMINIA_OUT/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>${XC_METHOD}</string>
  <key>teamID</key><string>${SIGN_TEAM_ID}</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>${SIGN_IDENTITY}</string>
  <key>provisioningProfiles</key><dict><key>${BUNDLE_ID}</key><string>${SIGN_PROFILE_NAME}</string></dict>
  <key>stripSwiftSymbols</key><true/>
</dict></plist>
EOF
    run_quiet xcodebuild-export xcodebuild -exportArchive -archivePath "$TERMINIA_OUT/App.xcarchive" \
        -exportOptionsPlist "$TERMINIA_OUT/ExportOptions.plist" -exportPath "$TERMINIA_OUT/export"
    EXPORTED=$(find "$TERMINIA_OUT/export" -maxdepth 1 -name '*.ipa' | first_line)
    [ -n "$EXPORTED" ] || fail "The export finished but produced no .ipa."
    IPA_NAME="${SAFE_NAME}-${CONFIGURATION}-${EXPORT_METHOD}.ipa"
    mv "$EXPORTED" "$TERMINIA_OUT/$IPA_NAME"
    codesign -dv --verbose=2 "$TERMINIA_OUT/App.xcarchive/Products/Applications/"*.app 2>&1 | grep -E 'Authority|TeamIdentifier' || true
    SIGNED=true
fi

# ------------------------------------------------------------------ verify
IPA="$TERMINIA_OUT/$IPA_NAME"
[ -s "$IPA" ] || fail "The IPA was not created."
IPA_LISTING=$(unzip -l "$IPA")
grep -Eq 'Payload/[^/]+\.app/Info\.plist' <<< "$IPA_LISTING" || fail "The IPA does not contain Payload/<App>.app/Info.plist."
SHA=$(sha256_of "$IPA")
SIZE=$(size_of "$IPA")
echo "IPA: $IPA_NAME ($SIZE bytes, sha256 $SHA, signed: $SIGNED)"

set_output ipa_name "$IPA_NAME"
publish_result "{\"platform\":\"ios\",\"buildId\":\"$(json_escape "${TERMINIA_BUILD_ID:-}")\",\"file\":\"$(json_escape "$IPA_NAME")\",\"size\":$SIZE,\"sha256\":\"$SHA\",\"bundleId\":\"$(json_escape "$BUNDLE_ID")\",\"configuration\":\"$CONFIGURATION\",\"exportMethod\":\"$EXPORT_METHOD\",\"signed\":$SIGNED}"
