#!/usr/bin/env bash
set -euo pipefail

die() { printf 'Sitenote: %s\n' "$*" >&2; exit 1; }

root="$(cd "$(dirname "$0")/.." && pwd)"
output="$root/dist/Sitenote-Android-arm64.apk"
offline=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --offline) offline=(--offline) ;;
    --output) [[ $# -ge 2 && -n "$2" ]] || die 'Missing value for --output'; output="$2"; shift ;;
    -h|--help) printf 'Usage: bash scripts/build-android-release.sh [--offline] [--output APK]\n'; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
  shift
done
[[ "$output" == /* ]] || output="$PWD/$output"
[[ "$output" == *.apk ]] || die 'The output path must end in .apk.'
[[ "$output" != "$root/android/app/build/outputs/apk/release/app-release.apk" ]] ||
  die 'Choose an output path outside the Gradle release APK.'

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
tools="${sdk}/build-tools/37.0.0"
[[ -n "$sdk" && -x "$tools/apksigner" && -x "$tools/aapt" && -x "$tools/zipalign" ]] ||
  die 'Point ANDROID_HOME to an Android SDK with Build Tools 37.0.0.'
[[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]] || die 'Set JAVA_HOME to a JDK.'
export ANDROID_HOME="$sdk"
export PATH="$JAVA_HOME/bin:$PATH"
command -v node >/dev/null || die 'Install Node.js before building the app.'
[[ -x "$root/node_modules/.bin/expo" ]] || die 'Install the locked JavaScript dependencies with npm ci first.'
command -v unzip >/dev/null || die 'Install unzip to verify the bundled app.'

key="${SITENOTE_ANDROID_KEYSTORE:-$root/.local-signing/sitenote.keystore}"
password_file="${SITENOTE_ANDROID_PASSWORD_FILE:-$root/.local-signing/password}"
[[ -r "$key" && -r "$password_file" ]] || die 'The existing Android signing key and its password file are required.'
certificate=ea34323e1ad5318ad4bb1c055905f5f27d3768d5269ee8471af1e633aa9f3cdd
export EXPO_NO_TELEMETRY=1

if [[ ! -x "$root/android/gradlew" ]]; then
  (cd "$root" && "$root/node_modules/.bin/expo" prebuild --platform android --no-install)
fi

# Refresh the embedded JavaScript bundle and APK while reusing unchanged native objects.
(
  cd "$root/android"
  ./gradlew ${offline[@]+"${offline[@]}"} --no-daemon -PreactNativeArchitectures=arm64-v8a \
    -Pandroid.enableMinifyInReleaseBuilds=true \
    :app:createBundleReleaseJsAndAssets --rerun :app:packageRelease --rerun :app:assembleRelease
)

output_dir="$(dirname "$output")"
mkdir -p -- "$output_dir"
stage="$(mktemp -d "$output_dir/.sitenote-release.XXXXXX")"
candidate="$stage/sitenote.apk"
trap 'rm -f -- "$candidate"; rmdir -- "$stage"' EXIT
"$tools/apksigner" sign --ks "$key" --ks-key-alias sitenote \
  --ks-pass "file:$password_file" --v4-signing-enabled false \
  --out "$candidate" "$root/android/app/build/outputs/apk/release/app-release.apk"

signature="$("$tools/apksigner" verify --verbose --print-certs "$candidate")"
actual="$(printf '%s\n' "$signature" | awk '/certificate SHA-256 digest:/ {print tolower($NF)}' | sort -u)"
[[ "$actual" == "$certificate" ]] || die 'The APK signing certificate does not match the existing SiteNote release.'
badging="$("$tools/aapt" dump badging "$candidate")"
[[ "$badging" == *"package: name='com.sitenote.app'"* && "$badging" != *'application-debuggable'* ]] ||
  die 'The APK is not the SiteNote release package.'
if [[ "$badging" != *"native-code: 'arm64-v8a'"$'\n'* && "$badging" != *"native-code: 'arm64-v8a'" ]]; then
  die 'The APK must contain only ARM64 native libraries.'
fi
unzip -tq "$candidate" assets/index.android.bundle >/dev/null || die 'The APK does not contain an embedded JavaScript bundle.'
"$tools/zipalign" -c -P 16 4 "$candidate" || die 'The APK does not have valid 16 KB alignment.'

mv -f -- "$candidate" "$output"
printf 'Verified Android release: %s\nSigning certificate SHA-256: %s\n' "$output" "$actual"
