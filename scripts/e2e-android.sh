#!/usr/bin/env bash
# Android end-to-end test on a KVM host: real rootless Podman, real emulator, real APK.
#
#   1. resolve oc-android / oc-new-android (installed, or this checkout as a fallback)
#   2. check rootless Podman, /dev/kvm and the localhost/oc-android image
#   3. build the image only when OC_ANDROID_ACCEPT_LICENSES=1 (you accept the SDK licenses)
#   4. oc-android doctor
#   5. oc-android emulator start --wait
#   6. oc-new-android <name> in an artifacts directory
#   7. oc-android gradle assembleDebug, then installDebug (local adb proxy)
#   8. am start -W, pidof, logcat -d -s AndroidRuntime:E (must be empty)
#   9. adb exec-out screencap -p (PNG magic + non-empty), then emulator stop
#
# Any failing step aborts the script; a summary and the artifacts path are printed.
# Environment:
#   OC_ANDROID_ACCEPT_LICENSES=1   allow `oc-android build-image --accept-licenses`
#   OC_ANDROID_E2E_ARTIFACTS=DIR   artifacts directory (default: $TMPDIR/opencode/android-e2e-*)
#   OC_ANDROID_E2E_KEEP=1          keep the default artifacts directory after success
#   OC_ANDROID_E2E_PROJECT_NAME    generated project name (default: e2e-demo)
#   OC_ANDROID_E2E_BUILD_TIMEOUT   assembleDebug timeout in seconds (default: 1800)
#   OC_ANDROID_E2E_INSTALL_TIMEOUT installDebug timeout in seconds (default: 600)
#   OC_ANDROID_E2E_LAUNCH_WAIT     seconds to wait after am start (default: 8)
#   OC_ANDROID_IMAGE, OC_ANDROID_KVM, OC_ANDROID_EMU, OC_PODMAN, OPENCODE_CONFIG_DIR
#   are honoured.
#
# Bash 3.2 compatible (macOS /bin/bash): no mapfile, no associative arrays, no ${x,,}.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PROJECT_NAME="${OC_ANDROID_E2E_PROJECT_NAME:-e2e-demo}"
IMAGE="${OC_ANDROID_IMAGE:-localhost/oc-android:latest}"
PODMAN="${OC_PODMAN:-podman}"
KVM="${OC_ANDROID_KVM:-/dev/kvm}"
EMU="${OC_ANDROID_EMU:-oc-android-emu}"
BUILD_TIMEOUT="${OC_ANDROID_E2E_BUILD_TIMEOUT:-1800}"
INSTALL_TIMEOUT="${OC_ANDROID_E2E_INSTALL_TIMEOUT:-600}"
BUILD_IMAGE_TIMEOUT="${OC_ANDROID_E2E_BUILD_IMAGE_TIMEOUT:-2400}"
LAUNCH_WAIT="${OC_ANDROID_E2E_LAUNCH_WAIT:-8}"
KEEP="${OC_ANDROID_E2E_KEEP:-0}"

if [ -n "${OC_ANDROID_E2E_ARTIFACTS:-}" ]; then
  ARTIFACTS="$OC_ANDROID_E2E_ARTIFACTS"
  ARTIFACTS_DEFAULT=0
else
  ARTIFACTS="${TMPDIR:-/tmp}/opencode/android-e2e-$(date +%Y%m%d-%H%M%S)-$$"
  ARTIFACTS_DEFAULT=1
fi
mkdir -p "$ARTIFACTS"

ANDROID_BIN="${OC_ANDROID_BIN:-}"
NEW_ANDROID_BIN="${OC_NEW_ANDROID_BIN:-}"
TMP_CONFIG=""
EMULATOR_STARTED=0
CURRENT_STEP="setup"
STEP_START=0
STEPS=""

fail() {
  printf '❌ %s\n' "$*" >&2
  print_summary
  exit 1
}

begin_step() {
  CURRENT_STEP="$1"
  STEP_START="$(date +%s)"
  printf '\n▶️  %s\n' "$CURRENT_STEP"
}

mark_ok() {
  local now elapsed
  now="$(date +%s)"
  elapsed=$((now - STEP_START))
  STEPS="${STEPS}✅ ${CURRENT_STEP} (${elapsed}s)
"
  printf '✅ %s\n' "$CURRENT_STEP"
}

print_summary() {
  printf '\n── Android E2E summary ──\n'
  if [ -n "$STEPS" ]; then
    printf '%s' "$STEPS"
  fi
  printf 'artifacts: %s\n' "$ARTIFACTS"
}

cleanup() {
  local rc=$?
  set +e
  if [ "$EMULATOR_STARTED" = "1" ] && [ -n "$ANDROID_BIN" ]; then
    "$ANDROID_BIN" emulator stop >/dev/null 2>&1 || true
  fi
  if [ "$ARTIFACTS_DEFAULT" = "1" ] && [ "$KEEP" != "1" ] && [ "$rc" = "0" ]; then
    rm -rf "$ARTIFACTS"
  fi
  exit "$rc"
}
trap cleanup EXIT

on_error() {
  local rc=$?
  set +e
  printf '\n❌ Android E2E failed at step: %s (exit %s)\n' "$CURRENT_STEP" "$rc" >&2
  print_summary
  exit "$rc"
}
trap on_error ERR

with_timeout() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  else
    "$@"
  fi
}

# --- tools: installed first, then this checkout (CI checkout without install.sh) ---------
if [ -z "$ANDROID_BIN" ]; then
  if command -v oc-android >/dev/null 2>&1; then
    ANDROID_BIN="$(command -v oc-android)"
  elif [ -x "$ROOT/addons/android/bin/oc-android" ]; then
    ANDROID_BIN="$ROOT/addons/android/bin/oc-android"
  else
    fail "oc-android not found (install the Android module or set OC_ANDROID_BIN)"
  fi
fi
if [ -z "$NEW_ANDROID_BIN" ]; then
  if command -v oc-new-android >/dev/null 2>&1; then
    NEW_ANDROID_BIN="$(command -v oc-new-android)"
  elif [ -x "$ROOT/config/bin/oc-new-android" ]; then
    NEW_ANDROID_BIN="$ROOT/config/bin/oc-new-android"
  else
    fail "oc-new-android not found (install the kit or set OC_NEW_ANDROID_BIN)"
  fi
fi

# A checkout without installation has no <config>/android: point oc-android at the repo copy.
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
if [ ! -f "$CONFIG_DIR/android/Containerfile" ] && [ -d "$ROOT/addons/android/libexec/oc-android" ]; then
  TMP_CONFIG="$ARTIFACTS/config"
  mkdir -p "$TMP_CONFIG/android"
  cp -a "$ROOT/addons/android/libexec/oc-android/." "$TMP_CONFIG/android/"
  export OPENCODE_CONFIG_DIR="$TMP_CONFIG"
  printf 'ℹ️  Using the repo-local Android context: %s/android\n' "$TMP_CONFIG"
fi

printf 'oc-android     : %s\n' "$ANDROID_BIN"
printf 'oc-new-android : %s\n' "$NEW_ANDROID_BIN"
printf 'image          : %s\n' "$IMAGE"
printf 'artifacts      : %s\n' "$ARTIFACTS"

# --- prerequisites ----------------------------------------------------------------------
if ! command -v "$PODMAN" >/dev/null 2>&1; then
  fail "Podman not found: install rootless Podman first (see docs/android-e2e.md)"
fi
if ! "$PODMAN" info >/dev/null 2>&1; then
  fail "Podman is not responding in rootless mode (check /etc/subuid, /etc/subgid, then log back in)"
fi
if [ ! -r "$KVM" ] || [ ! -w "$KVM" ]; then
  fail "$KVM is not readable/writable: enable virtualization and grant the kvm group (see docs/android-e2e.md)"
fi

# --- image: build only with an explicit license acceptance -------------------------------
if ! "$PODMAN" image exists "$IMAGE" >/dev/null 2>&1; then
  if [ "${OC_ANDROID_ACCEPT_LICENSES:-0}" != "1" ]; then
    fail "image $IMAGE is missing. Set OC_ANDROID_ACCEPT_LICENSES=1 to accept the Android SDK licenses and let this script build it (10-20 min, several GB)."
  fi
  begin_step "build image $IMAGE (licenses accepted via OC_ANDROID_ACCEPT_LICENSES=1)"
  with_timeout "$BUILD_IMAGE_TIMEOUT" "$ANDROID_BIN" build-image --accept-licenses
  mark_ok
fi

# --- doctor -----------------------------------------------------------------------------
begin_step "oc-android doctor"
DOCTOR_OUT="$("$ANDROID_BIN" doctor)"
printf '%s\n' "$DOCTOR_OUT"
case "$DOCTOR_OUT" in
  *"Image $IMAGE present"*) ;;
  *) fail "doctor did not report the image as present" ;;
esac
case "$DOCTOR_OUT" in
  *"$KVM accessible"*) ;;
  *) fail "doctor did not report $KVM as accessible" ;;
esac
mark_ok

# --- emulator ---------------------------------------------------------------------------
begin_step "emulator start --wait"
cd "$ARTIFACTS"
"$ANDROID_BIN" emulator start --wait
EMULATOR_STARTED=1
mark_ok

# --- project ----------------------------------------------------------------------------
begin_step "generate project $PROJECT_NAME"
"$NEW_ANDROID_BIN" "$PROJECT_NAME" "$ARTIFACTS"
PROJECT="$ARTIFACTS/$PROJECT_NAME"
cd "$PROJECT"
mark_ok

# --- build ------------------------------------------------------------------------------
begin_step "gradle assembleDebug"
with_timeout "$BUILD_TIMEOUT" "$ANDROID_BIN" gradle assembleDebug
APK="$PROJECT/app/build/outputs/apk/debug/app-debug.apk"
if [ ! -s "$APK" ]; then
  fail "APK missing or empty: $APK"
fi
printf 'APK: %s (%s bytes)\n' "$APK" "$(wc -c < "$APK" | tr -d ' ')"
mark_ok

# --- install ----------------------------------------------------------------------------
# AGP's ddmlib (installDebug) always connects to 127.0.0.1:5037 and ignores
# ADB_SERVER_SOCKET, while the emulator's adb server listens on the oc-android network.
# Bridge the two with a tiny local proxy, then run the real Gradle install task in the
# same image/mounts as `oc-android gradle` (oc-android exec).
ADB_PROXY="$ARTIFACTS/.oc-adb-proxy.pl"
cat > "$ADB_PROXY" <<'PERL'
#!/usr/bin/perl
use strict;
use warnings;
use IO::Socket::INET;
use IO::Select;

my $listen_port = shift // 5037;
my $target_host = shift // "oc-android-emu";
my $target_port = shift // 5037;

my $listener = IO::Socket::INET->new(
    LocalAddr => "127.0.0.1",
    LocalPort => $listen_port,
    Listen    => 16,
    ReuseAddr => 1,
    Proto     => "tcp",
) or die "proxy: cannot listen on 127.0.0.1:$listen_port: $!\n";

while (1) {
    my $client = $listener->accept or next;
    my $server = IO::Socket::INET->new(
        PeerAddr => $target_host,
        PeerPort => $target_port,
        Proto    => "tcp",
    ) or do { close $client; next };

    my $select = IO::Select->new($client, $server);
    while (1) {
        my @ready = $select->can_read;
        last unless @ready;
        my $done = 0;
        for my $socket (@ready) {
            my $buffer;
            my $read = sysread($socket, $buffer, 65536);
            if (!defined $read || $read == 0) { $done = 1; last; }
            my $peer = ($socket->fileno == $client->fileno) ? $server : $client;
            my $offset = 0;
            while ($offset < $read) {
                my $written = syswrite($peer, $buffer, $read - $offset, $offset);
                last unless defined $written;
                $offset += $written;
            }
            if ($offset < $read) { $done = 1; last; }
        }
        last if $done;
    }
    close $client;
    close $server;
}
PERL

# Runs inside the oc-android image, with the artifacts directory mounted at /workspace.
INSTALL_SCRIPT="$ARTIFACTS/.oc-install-debug.sh"
cat > "$INSTALL_SCRIPT" <<'INSTALL'
#!/usr/bin/env bash
set -Eeuo pipefail
unset ADB_SERVER_SOCKET
perl /workspace/.oc-adb-proxy.pl 5037 "$1" 5037 &
proxy=$!
trap 'kill "$proxy" 2>/dev/null || true' EXIT
sleep 1
kill -0 "$proxy" 2>/dev/null || { echo "adb proxy failed to start" >&2; exit 1; }
cd "/workspace/$2"
./gradlew installDebug
INSTALL

cd "$ARTIFACTS"
begin_step "gradle installDebug (through a local adb proxy)"
with_timeout "$INSTALL_TIMEOUT" "$ANDROID_BIN" exec bash /workspace/.oc-install-debug.sh "$EMU" "$PROJECT_NAME"
mark_ok

PACKAGE="$(sed -n 's/^[[:space:]]*applicationId[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$PROJECT/app/build.gradle.kts" | head -n 1)"
if [ -z "$PACKAGE" ]; then
  fail "cannot read applicationId from $PROJECT/app/build.gradle.kts"
fi

# --- launch -----------------------------------------------------------------------------
begin_step "clear logcat"
"$ANDROID_BIN" adb logcat -c
mark_ok

begin_step "launch $PACKAGE/.MainActivity"
START_OUT="$("$ANDROID_BIN" adb shell am start -W -n "$PACKAGE/.MainActivity")"
printf '%s\n' "$START_OUT"
case "$START_OUT" in
  *"Status: ok"*) ;;
  *) fail "am start did not report Status: ok" ;;
esac
mark_ok

sleep "$LAUNCH_WAIT"

begin_step "app process is running"
PID="$("$ANDROID_BIN" adb shell pidof "$PACKAGE" 2>/dev/null | tr -d '\r\n' || true)"
printf 'pid: %s\n' "${PID:-<none>}"
if [ -z "$PID" ]; then
  fail "process $PACKAGE is not running (the app probably crashed)"
fi
mark_ok

# --- crash log --------------------------------------------------------------------------
begin_step "logcat AndroidRuntime:E is empty"
LOGCAT_RAW="$("$ANDROID_BIN" adb logcat -d -s AndroidRuntime:E || true)"
CRASHES="$(printf '%s\n' "$LOGCAT_RAW" | grep -v '^---------' | grep -v '^[[:space:]]*$' || true)"
if [ -n "$CRASHES" ]; then
  printf '%s\n' "$CRASHES" >&2
  fail "AndroidRuntime errors found after launching $PACKAGE"
fi
mark_ok

# --- screenshot -------------------------------------------------------------------------
begin_step "screencap to PNG"
SHOT="$ARTIFACTS/screenshot.png"
"$ANDROID_BIN" adb exec-out screencap -p > "$SHOT"
if [ ! -s "$SHOT" ]; then
  fail "screenshot is empty: $SHOT"
fi
MAGIC="$(head -c 8 "$SHOT" | od -An -tx1 | tr -d ' \n')"
if [ "$MAGIC" != "89504e470d0a1a0a" ]; then
  fail "screenshot is not a PNG (magic bytes: $MAGIC)"
fi
printf 'screenshot: %s (%s bytes)\n' "$SHOT" "$(wc -c < "$SHOT" | tr -d ' ')"
mark_ok

# --- stop -------------------------------------------------------------------------------
begin_step "emulator stop"
"$ANDROID_BIN" emulator stop
EMULATOR_STARTED=0
mark_ok

CURRENT_STEP="done"
print_summary
printf '\n✅ Android E2E passed: %s\n' "$PROJECT"
