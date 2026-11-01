#!/usr/bin/env bash
# Désinstalle le kit : restaure la dernière sauvegarde de ~/.config/opencode.
#   ./uninstall.sh            restaure la dernière sauvegarde (s'il y en a une)
#   ./uninstall.sh --list     liste les sauvegardes
set -Eeuo pipefail
DEST="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
BIN="${OBSCURA_BIN_DIR:-$HOME/.local/bin}"
STAMP="$(date +%Y%m%d-%H%M%S)"
last="$(ls -d "$DEST".bak-* 2>/dev/null | sort | tail -n 1 || true)"

if [ "${1:-}" = "--list" ]; then ls -d "$DEST".bak-* 2>/dev/null | sort || echo "(aucune sauvegarde)"; exit 0; fi

if [ -d "$DEST" ]; then
  mv "$DEST" "$DEST.removed-$STAMP"
  echo "📦 Config actuelle déplacée : $DEST.removed-$STAMP"
fi
if [ -n "$last" ]; then
  cp -a "$last" "$DEST"
  echo "✅ Restauré depuis $last"
else
  echo "ℹ️  Aucune sauvegarde : $DEST est maintenant absent (OpenCode recréera sa config par défaut)."
fi
rm -f "$BIN/agent-wt" "$BIN/oc-new-rust" && echo "🧹 agent-wt et oc-new-rust retirés de $BIN"
echo "Non touchés : obscura, trivy, MemPalace (~/.mempalace) et les paquets pip/npm installés."
