#!/usr/bin/env bash
# Uninstall the kit: restore the latest backup of ~/.config/opencode.
#   ./uninstall.sh            restore the latest backup (if there is one)
#   ./uninstall.sh --list     list backups
set -Eeuo pipefail
umask 077
DEST="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
BIN="${OBSCURA_BIN_DIR:-$HOME/.local/bin}"
STAMP="$(date +%Y%m%d-%H%M%S)"

# unique_path <path>: the path if free, otherwise <path>-1, -2... (two uninstalls in the same
# second must never nest inside each other).
unique_path() {
  local base="$1" cand="$1" n=1
  while [ -e "$cand" ] || [ -L "$cand" ]; do cand="$base-$n"; n=$((n + 1)); done
  printf '%s\n' "$cand"
}

# Backups (the glob is sorted; timestamps sort chronologically,
# and the -N suffix breaks ties between two backups from the same second)
last=""
for b in "$DEST".bak-*; do
  [ -d "$b" ] && last="$b"
done

if [ "${1:-}" = "--list" ]; then
  found=0
  for b in "$DEST".bak-*; do [ -d "$b" ] && { echo "$b"; found=1; }; done
  [ "$found" = 1 ] || echo "(no backup)"
  exit 0
fi

if [ -d "$DEST" ]; then
  removed="$(unique_path "$DEST.removed-$STAMP")"
  mv "$DEST" "$removed"
  chmod -R go-rwx "$removed" 2>/dev/null || true
  echo "📦 Current config moved: $removed"
fi
if [ -n "$last" ]; then
  cp -a "$last" "$DEST"
  chmod -R go-rwx "$DEST" 2>/dev/null || true
  chmod 700 "$DEST" 2>/dev/null || true
  echo "✅ Restored from $last"
else
  echo "ℹ️  No backup: $DEST is now absent (OpenCode will recreate its default config)."
fi
# Remove the block added to ~/.bashrc / ~/.zshrc by --shell-env (tagged or old format)
for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.zshenv"; do
  [ -f "$rc" ] || continue
  grep -q 'opencode-prerequisites' "$rc" || continue
  tmp="$(mktemp)"
  awk '
    /^# >>> opencode-prerequisites >>>$/ { skip=1; next }
    /^# <<< opencode-prerequisites <<<$/ { skip=0; afterend=1; next }
    skip==1 { next }
    afterend==1 && /^$/ { afterend=0; next }   # the empty line the block adds after itself
    /^# opencode-prerequisites$/ { old=1; next }
    old==1 && /^export (PATH|MEMPALACE_ADAPTER_PYTHON)=/ { next }
    { old=0; afterend=0; print }
  ' "$rc" > "$tmp" && cat "$tmp" > "$rc" && echo "🧹 opencode-prerequisites block removed from $rc"
  rm -f "$tmp"
done
# OpenCode Desktop wiring (Linux): only files carrying the kit marker are touched.
# The environment.d block is replaced by a timestamped copy first, then stripped; the file is
# removed only when nothing else was in it. A desktop override is backed up, then the pre-install
# user file is restored when the installer kept one.
DESKTOP_ENV="$HOME/.config/environment.d/90-opencode-prerequisites.conf"
if [ -f "$DESKTOP_ENV" ] && grep -q '^# >>> opencode-prerequisites >>>$' "$DESKTOP_ENV"; then
  env_backup="$(unique_path "$DESKTOP_ENV.removed-$STAMP")"
  cp -p "$DESKTOP_ENV" "$env_backup"
  tmp="$(mktemp)"
  awk '
    /^# >>> opencode-prerequisites >>>$/ { skip=1; next }
    /^# <<< opencode-prerequisites <<<$/ { skip=0; after=1; next }
    skip==1 { next }
    after==1 && /^$/ { after=0; next }
    { after=0; print }
  ' "$DESKTOP_ENV" > "$tmp"
  if grep -qv '^[[:space:]]*$' "$tmp"; then
    cat "$tmp" > "$DESKTOP_ENV"
    echo "🧹 desktop environment block removed: $DESKTOP_ENV (backup: $env_backup)"
  else
    rm -f "$DESKTOP_ENV"
    echo "🧹 desktop environment file removed: $DESKTOP_ENV (backup: $env_backup)"
  fi
  rm -f "$tmp"
fi

for app in ai.opencode.desktop.desktop opencode-desktop.desktop; do
  app_file="$HOME/.local/share/applications/$app"
  [ -f "$app_file" ] || continue
  grep -q '^X-OpenCode-Prerequisites=true$' "$app_file" || continue
  app_backup="$(unique_path "$app_file.removed-$STAMP")"
  cp -p "$app_file" "$app_backup"
  if [ -f "$app_file.bak-opencode-prerequisites" ]; then
    cp -p "$app_file.bak-opencode-prerequisites" "$app_file"
    rm -f "$app_file.bak-opencode-prerequisites"
    echo "♻️  desktop entry restored: $app_file (kit version: $app_backup)"
  else
    rm -f "$app_file"
    echo "🧹 desktop entry removed: $app_file (backup: $app_backup)"
  fi
done

rm -f "$BIN/mempalace" "$BIN/agent-wt" "$BIN/oc-new-rust" "$BIN/oc-new-android" "$BIN/oc-new-web" "$BIN/oc-models" "$BIN/oc-deps" "$BIN/oc-backup" "$BIN/oc-restore" "$BIN/oc-usage" "$BIN/oc-secrets" "$BIN/oc-playwright-mcp" "$BIN/oc-chrome-devtools-mcp" "$BIN/oc-uiux-search" "$BIN/oc-impeccable" "$BIN/oc-terraform-mcp" "$BIN/oc-rea" "$BIN/oc-rea-mcp" "$BIN/oc-semgrep-mcp" "$BIN/oc-android" "$BIN/oc-mobile-mcp" "$BIN/oc-versions" "$BIN/oc-export-claude" && echo "🧹 kit launchers removed from $BIN"
rm -f "$DEST/.opencode-prerequisites.android" 2>/dev/null || true
rm -f "$DEST/.opencode-prerequisites.pentest" 2>/dev/null || true
rm -f "$DEST/.opencode-prerequisites.profile" 2>/dev/null || true
echo "Android module: the Podman image (podman rmi localhost/oc-android) and the emulator data (~/.local/share/oc-android) are not removed."
echo "Untouched: obscura, trivy, nuclei, gitleaks, semgrep, MemPalace (~/.mempalace) and installed pip/npm/uv packages (./install.sh --pentest is no longer remembered, but the binaries remain in $BIN)."
