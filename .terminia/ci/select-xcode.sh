#!/usr/bin/env bash
# terminia-template: select-xcode v1
# Selects the Xcode used by the build. Capacitor 8 requires Xcode 26 or newer.
#
# XCODE_VERSION (from the workflow input, default 26.5) is used when the runner
# has it. Otherwise the newest installed Xcode with the same major version is
# used and a warning is printed - the build never silently switches majors.
set -euo pipefail
source "$(dirname "$0")/common.sh"

WANTED="${XCODE_VERSION:-26.5}"
VERSION_RE='^[0-9]+(\.[0-9]+){0,2}$'
if ! [[ $WANTED =~ $VERSION_RE ]]; then
    fail "xcode_version must be a version number such as 26.5 (got '$WANTED')."
fi
MAJOR="${WANTED%%.*}"
CANDIDATE="/Applications/Xcode_${WANTED}.app"

if [ ! -d "$CANDIDATE" ]; then
    FALLBACK=$(ls -d /Applications/Xcode_"${MAJOR}"*.app 2>/dev/null | sort -V | tail -n 1 || true)
    if [ -z "$FALLBACK" ]; then
        echo "Installed Xcode versions:"
        ls -d /Applications/Xcode*.app || true
        fail "Xcode $WANTED (or any Xcode $MAJOR.x) is not installed on this runner."
    fi
    warn "Xcode $WANTED is not installed on this runner; using $FALLBACK."
    CANDIDATE="$FALLBACK"
fi

sudo xcode-select --switch "$CANDIDATE/Contents/Developer"
xcodebuild -version
echo "iOS SDK: $(xcrun --sdk iphoneos --show-sdk-version)"
