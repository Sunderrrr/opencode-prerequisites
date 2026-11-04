#!/usr/bin/env bash
# Emulator container entrypoint: creates the "oc" AVD on first start, opens an adb server reachable from the
# other containers on the network, then starts the emulator headless.
set -Eeuo pipefail

API="${OC_ANDROID_API:?OC_ANDROID_API is not set (badly built image)}"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-/avd}"
mkdir -p "$ANDROID_AVD_HOME"

if [ ! -d "$ANDROID_AVD_HOME/oc.avd" ]; then
  echo "Creating the \"oc\" AVD (API ${API})…"
  echo no | avdmanager create avd -n oc -k "system-images;android-${API};google_apis;x86_64" -d pixel_6 --force
fi

adb kill-server >/dev/null 2>&1 || true
adb -a -P 5037 nodaemon server &
sleep 1

exec emulator -avd oc -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect -accel on
