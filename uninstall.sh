#!/usr/bin/env bash
# Désinstalle le kit : restaure la dernière sauvegarde de ~/.config/opencode.
#   ./uninstall.sh            restaure la dernière sauvegarde (s'il y en a une)
#   ./uninstall.sh --list     liste les sauvegardes
set -Eeuo pipefail
DEST="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
BIN="${OBSCURA_BIN_DIR:-$HOME/.local/bin}"
STAMP="$(date +%Y%m%d-%H%M%S)"
# Sauvegardes (le glob est trié ; les horodatages se trient dans l'ordre chronologique)
last=""
for b in "$DEST".bak-*; do
  [ -d "$b" ] && last="$b"
done

if [ "${1:-}" = "--list" ]; then
  found=0
  for b in "$DEST".bak-*; do [ -d "$b" ] && { echo "$b"; found=1; }; done
  [ "$found" = 1 ] || echo "(aucune sauvegarde)"
  exit 0
fi

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
# Retire le bloc ajouté à ~/.bashrc / ~/.zshrc par --shell-env (balisé ou ancien format)
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$rc" ] || continue
  grep -q 'opencode-prerequisites' "$rc" || continue
  tmp="$(mktemp)"
  awk '
    /^# >>> opencode-prerequisites >>>$/ { skip=1; next }
    /^# <<< opencode-prerequisites <<<$/ { skip=0; next }
    skip==1 { next }
    /^# opencode-prerequisites$/ { old=1; next }
    old==1 && /^export (PATH|MEMPALACE_ADAPTER_PYTHON)=/ { next }
    { old=0; print }
  ' "$rc" > "$tmp" && cat "$tmp" > "$rc" && echo "🧹 Bloc opencode-prerequisites retiré de $rc"
  rm -f "$tmp"
done
rm -f "$BIN/agent-wt" "$BIN/oc-new-rust" && echo "🧹 agent-wt et oc-new-rust retirés de $BIN"
echo "Non touchés : obscura, trivy, MemPalace (~/.mempalace) et les paquets pip/npm installés."
