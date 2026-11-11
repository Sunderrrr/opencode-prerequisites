#!/usr/bin/env bash
# desktop-env.sh: PATH for OpenCode Desktop on Linux (Electron does not read ~/.bashrc, ~/.zshenv
# or the shell environment: a GUI-launched app sees the systemd user-session PATH only).
# Sourced by the kit launchers (and only by them): it prepends the usual user tool directories,
# keeps everything already present and never creates duplicates. Bash 3.2+, idempotent.
# shellcheck shell=bash

oc_desktop_env_apply() {
  local dir entry skip
  local first=1 joined=""
  local -a desired=() existing=() out=()

  # User tool directories first (mise shims cover node/npx installed with mise), then system dirs.
  if [ -n "${HOME:-}" ]; then
    desired+=(
      "$HOME/.local/bin"
      "$HOME/.local/share/mise/shims"
      "$HOME/.cargo/bin"
      "$HOME/.bun/bin"
      "$HOME/.npm-global/bin"
    )
  fi
  desired+=(/usr/local/bin /usr/bin /bin)

  # Read the current PATH with ':' as separator, without touching the caller's IFS.
  local IFS=':'
  read -r -a existing <<< "${PATH:-}" || true

  # 1. The desired directories, in order, always at the front.
  for dir in "${desired[@]}"; do
    [ -n "$dir" ] || continue
    out+=("$dir")
  done
  # 2. Existing entries that are neither a desired directory nor an earlier entry: order kept.
  for entry in "${existing[@]}"; do
    [ -n "$entry" ] || continue
    skip=0
    for dir in "${desired[@]}"; do
      [ "$dir" = "$entry" ] && { skip=1; break; }
    done
    [ "$skip" = 1 ] && continue
    for dir in "${out[@]}"; do
      [ "$dir" = "$entry" ] && { skip=1; break; }
    done
    [ "$skip" = 1 ] && continue
    out+=("$entry")
  done

  for dir in "${out[@]}"; do
    if [ "$first" = 1 ]; then first=0; else joined="$joined:"; fi
    joined="$joined$dir"
  done
  export PATH="$joined"

  # Absolute paths resolved from the final PATH: launchers and plugins can use them even when
  # another tool replaces PATH later. Only exported when the command actually exists.
  local node_bin npx_bin bash_bin
  node_bin="$(command -v node 2>/dev/null || true)"
  npx_bin="$(command -v npx 2>/dev/null || true)"
  bash_bin="$(command -v bash 2>/dev/null || true)"
  if [ -n "$node_bin" ]; then export OC_NODE_BIN="$node_bin"; fi
  if [ -n "$npx_bin" ]; then export OC_NPX_BIN="$npx_bin"; fi
  if [ -n "$bash_bin" ]; then export OC_BASH_BIN="$bash_bin"; fi
}

oc_desktop_env_apply
