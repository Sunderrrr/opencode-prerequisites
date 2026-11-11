#!/usr/bin/env bash
# OpenCode installation diagnostic (config, agents, MCP, tools, models).
# --offline (or OC_DOCTOR_OFFLINE=1): no network requests. Exit code: 0 = healthy, 1 = error.
# --fix: after the diagnosis, apply safe reversible fixes (re-enable MCPs whose prerequisite is
#        back, tighten config permissions). --fix --dry-run: report only, write nothing.
# --desktop: Linux desktop checks only (GUI PATH, environment.d, .desktop override, node/npx/bash,
#            Wayland note). No network. Exit code: 0 = desktop wiring healthy, 1 = error.
set -Eeuo pipefail
HERE="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

DESKTOP_BAD=0
dok() { printf '✅ %s\n' "$*"; }
dko() { DESKTOP_BAD=$((DESKTOP_BAD + 1)); printf '❌ %s\n' "$*"; }
dwa() { printf '⚠️  %s\n' "$*"; }

desktop_doctor() {
  local DEST ENV_FILE APP_FILE c d f perms version bin=""

  # 1. Desktop app: executable (PATH, system or ~/.local/bin), AppImage, or Electron data dir.
  c="$(command -v opencode-desktop 2>/dev/null || true)"
  if [ -n "$c" ] && [ -x "$c" ]; then bin="$c"; fi
  if [ -z "$bin" ]; then
    for c in /usr/bin/opencode-desktop /usr/local/bin/opencode-desktop "$HOME/.local/bin/opencode-desktop"; do
      if [ -x "$c" ] && [ ! -d "$c" ]; then bin="$c"; break; fi
    done
  fi
  if [ -z "$bin" ]; then
    for d in "$HOME/Applications" "$HOME/Downloads"; do
      [ -d "$d" ] || continue
      for f in "$d"/opencode-desktop*.AppImage; do
        [ -f "$f" ] || continue
        bin="$f"; break 2
      done
    done
  fi
  if [ -n "$bin" ]; then
    dok "OpenCode Desktop found: $bin"
  elif [ -d "$HOME/.config/ai.opencode.desktop" ]; then
    dwa "OpenCode Desktop data directory found, but no opencode-desktop executable or AppImage"
  else
    dko "OpenCode Desktop not found (opencode-desktop, ~/Applications|~/Downloads/opencode-desktop*.AppImage)"
  fi

  # 2. Config path the app reads and the shared desktop-env.sh used by every launcher.
  DEST="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
  if [ -d "$DEST" ]; then dok "Config directory: $DEST"; else dko "Config directory missing: $DEST (run ./install.sh --no-tools)"; fi
  if [ -r "$DEST/libexec/desktop-env.sh" ]; then
    # shellcheck disable=SC1091  # installed path, checked just above
    . "$DEST/libexec/desktop-env.sh"
    dok "desktop-env.sh installed: $DEST/libexec/desktop-env.sh"
  else
    dko "desktop-env.sh missing in $DEST/libexec (run ./install.sh --no-tools)"
  fi

  # 3. environment.d block (systemd user session; applies at the next login).
  ENV_FILE="$HOME/.config/environment.d/90-opencode-prerequisites.conf"
  if [ -f "$ENV_FILE" ]; then
    if grep -Eq '^PATH=.*/\.local/bin' "$ENV_FILE"; then
      dok "environment.d PATH present: $ENV_FILE"
    else
      dko "environment.d file has no PATH with ~/.local/bin: $ENV_FILE"
    fi
    perms="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || true)"
    if [ "$perms" = 600 ]; then dok "environment.d file mode 600"; else dko "environment.d file mode is ${perms:-unknown}, expected 600"; fi
    if grep -q '^MEMPALACE_ADAPTER_PYTHON=' "$ENV_FILE"; then dok "MEMPALACE_ADAPTER_PYTHON exported to the desktop session"; fi
  else
    dko "environment.d file missing: $ENV_FILE (run ./install.sh --desktop)"
  fi

  # 4. User .desktop override, Exec carries the PATH, class and notifications keys.
  APP_FILE=""
  for c in ai.opencode.desktop.desktop opencode-desktop.desktop; do
    if [ -f "$HOME/.local/share/applications/$c" ]; then APP_FILE="$HOME/.local/share/applications/$c"; break; fi
  done
  if [ -n "$APP_FILE" ]; then
    dok "Desktop override: $APP_FILE"
    if grep -Eq '^Exec=env PATH="[^"]*\.local/bin' "$APP_FILE"; then
      dok "Exec starts with env PATH (GUI launches see the kit tools)"
    else
      dko "Exec does not inject PATH in $APP_FILE"
    fi
    if grep -q '^StartupWMClass=ai.opencode.desktop$' "$APP_FILE"; then dok "StartupWMClass=ai.opencode.desktop"; else dko "StartupWMClass=ai.opencode.desktop missing"; fi
    if grep -q '^TryExec=' "$APP_FILE"; then dok "TryExec present"; else dko "TryExec missing"; fi
    if grep -q '^X-GNOME-UsesNotifications=true$' "$APP_FILE"; then dok "X-GNOME-UsesNotifications=true"; else dwa "X-GNOME-UsesNotifications=true missing"; fi
  else
    dko "No user desktop override in $HOME/.local/share/applications (run ./install.sh --desktop)"
  fi

  # 5. Shell tools after desktop-env.sh: the exact commands MCP servers spawn from the GUI.
  for c in node npx bash; do
    if command -v "$c" >/dev/null 2>&1; then dok "$c resolvable: $(command -v "$c")"; else dko "$c not resolvable after desktop-env.sh"; fi
  done
  [ -n "${OC_NODE_BIN:-}" ] && dok "OC_NODE_BIN=$OC_NODE_BIN"
  [ -n "${OC_NPX_BIN:-}" ] && dok "OC_NPX_BIN=$OC_NPX_BIN"

  # 6. Cheap version probe and Wayland hint (never fatal: AppImages may not answer --version).
  if [ -n "$bin" ] && [ -x "$bin" ]; then
    if command -v timeout >/dev/null 2>&1; then
      version="$(timeout 5 "$bin" --version 2>/dev/null | head -n 1 || true)"
    else
      version="$("$bin" --version 2>/dev/null | head -n 1 || true)"
    fi
    if [ -n "$version" ]; then dok "opencode-desktop version: $version"; else dwa "opencode-desktop did not answer --version (not fatal)"; fi
  fi
  if [ "${XDG_SESSION_TYPE:-}" = wayland ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
    if [ "${OC_ALLOW_WAYLAND:-}" = 1 ]; then
      dok "Wayland session with OC_ALLOW_WAYLAND=1"
    else
      dwa "Wayland session: if the window is blank, launch with OC_ALLOW_WAYLAND=1 opencode-desktop"
    fi
  fi

  if [ "$DESKTOP_BAD" -eq 0 ]; then
    echo "✅ OpenCode Desktop support OK"
    return 0
  fi
  echo "❌ OpenCode Desktop support: $DESKTOP_BAD error(s). Run ./install.sh --desktop, fully quit the app, relaunch."
  return 1
}

if [ "${1:-}" = "--desktop" ]; then
  if [ "$#" -ne 1 ]; then
    echo "Usage: ./doctor.sh --desktop   (desktop checks only, no other option)" >&2
    exit 2
  fi
  desktop_doctor
  exit $?
fi

exec node "$HERE/scripts/doctor.mjs" "$@"
