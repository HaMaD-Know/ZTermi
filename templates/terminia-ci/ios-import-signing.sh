#!/usr/bin/env bash
# terminia-template: ios-import-signing v1
# Imports an Apple signing certificate and provisioning profile from GitHub
# Actions secrets into a temporary keychain on the runner. Nothing is written
# to the repository and nothing secret is printed (GitHub also masks secrets).
#
# Required environment (from secrets):
#   IOS_CERTIFICATE_P12_BASE64       base64 of the .p12 (certificate + private key)
#   IOS_CERTIFICATE_PASSWORD         password of the .p12
#   IOS_PROVISIONING_PROFILE_BASE64  base64 of the .mobileprovision
set -euo pipefail
source "$(dirname "$0")/common.sh"

: "${IOS_CERTIFICATE_P12_BASE64:?missing}" "${IOS_CERTIFICATE_PASSWORD:?missing}" "${IOS_PROVISIONING_PROFILE_BASE64:?missing}"

WORK="${RUNNER_TEMP:?}/terminia-signing"
mkdir -p "$WORK"
chmod 700 "$WORK"
KEYCHAIN="$WORK/terminia-build.keychain-db"
KEYCHAIN_PASSWORD="$(openssl rand -base64 24)"
echo "::add-mask::$KEYCHAIN_PASSWORD"

printf '%s' "$IOS_CERTIFICATE_P12_BASE64" | base64 --decode > "$WORK/certificate.p12" || fail "IOS_CERTIFICATE_P12_BASE64 is not valid base64."
printf '%s' "$IOS_PROVISIONING_PROFILE_BASE64" | base64 --decode > "$WORK/profile.mobileprovision" || fail "IOS_PROVISIONING_PROFILE_BASE64 is not valid base64."

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$WORK/certificate.p12" -P "$IOS_CERTIFICATE_PASSWORD" -A -t cert -f pkcs12 -k "$KEYCHAIN" \
    || fail "Could not import the certificate. Check IOS_CERTIFICATE_PASSWORD and that the .p12 contains the private key."
security set-key-partition-list -S apple-tool:,apple: -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" > /dev/null
# shellcheck disable=SC2046
security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')
rm -f "$WORK/certificate.p12"

security cms -D -i "$WORK/profile.mobileprovision" > "$WORK/profile.plist" || fail "The provisioning profile could not be decoded."
UUID=$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$WORK/profile.plist")
NAME=$(/usr/libexec/PlistBuddy -c 'Print :Name' "$WORK/profile.plist")
TEAM=$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$WORK/profile.plist")
APP_ID=$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' "$WORK/profile.plist")
EXPIRES=$(/usr/libexec/PlistBuddy -c 'Print :ExpirationDate' "$WORK/profile.plist" || true)
for DIR in "$HOME/Library/MobileDevice/Provisioning Profiles" "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"; do
    mkdir -p "$DIR"
    cp "$WORK/profile.mobileprovision" "$DIR/$UUID.mobileprovision"
done

IDENTITY=$(security find-identity -v -p codesigning "$KEYCHAIN" | first_line | sed -E 's/.*"(.+)"/\1/')
[ -n "$IDENTITY" ] && [ "$IDENTITY" != "0 valid identities found" ] || fail "The certificate has no valid code-signing identity (expired or missing private key)."

{
    echo "TERMINIA_KEYCHAIN=$KEYCHAIN"
    echo "SIGN_PROFILE_NAME=$NAME"
    echo "SIGN_TEAM_ID=$TEAM"
    echo "SIGN_PROFILE_BUNDLE_ID=${APP_ID#*.}"
    echo "SIGN_IDENTITY=$IDENTITY"
} >> "$GITHUB_ENV"
echo "Imported signing identity '$IDENTITY' and profile '$NAME' (team $TEAM, app id ${APP_ID#*.}, expires $EXPIRES)."
