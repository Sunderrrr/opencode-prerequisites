#!/usr/bin/env bash
# Point d'entrée du conteneur émulateur : crée l'AVD « oc » au premier lancement, ouvre un serveur adb joignable
# depuis les autres conteneurs du réseau, puis lance l'émulateur sans fenêtre.
set -Eeuo pipefail

API="${OC_ANDROID_API:?variable OC_ANDROID_API manquante (image mal construite)}"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-/avd}"
mkdir -p "$ANDROID_AVD_HOME"

if [ ! -d "$ANDROID_AVD_HOME/oc.avd" ]; then
  echo "Création de l'AVD « oc » (API ${API})…"
  echo no | avdmanager create avd -n oc -k "system-images;android-${API};google_apis;x86_64" -d pixel_6 --force
fi

adb kill-server >/dev/null 2>&1 || true
adb -a -P 5037 nodaemon server &
sleep 1

exec emulator -avd oc -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect -accel on
