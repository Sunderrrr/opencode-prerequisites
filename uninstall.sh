#!/usr/bin/env bash
# Désinstalle le kit : restaure la dernière sauvegarde de ~/.config/opencode.
#   ./uninstall.sh            restaure la dernière sauvegarde (s'il y en a une)
#   ./uninstall.sh --list     liste les sauvegardes
set -Eeuo pipefail
umask 077
DEST="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
BIN="${OBSCURA_BIN_DIR:-$HOME/.local/bin}"
STAMP="$(date +%Y%m%d-%H%M%S)"

# unique_path <chemin> : le chemin s'il est libre, sinon <chemin>-1, -2... (deux désinstallations
# dans la même seconde ne doivent jamais s'imbriquer).
unique_path() {
  local base="$1" cand="$1" n=1
  while [ -e "$cand" ] || [ -L "$cand" ]; do cand="$base-$n"; n=$((n + 1)); done
  printf '%s\n' "$cand"
}

# Sauvegardes (le glob est trié ; les horodatages se trient dans l'ordre chronologique,
# et le suffixe -N départage deux sauvegardes de la même seconde)
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
  removed="$(unique_path "$DEST.removed-$STAMP")"
  mv "$DEST" "$removed"
  chmod -R go-rwx "$removed" 2>/dev/null || true
  echo "📦 Config actuelle déplacée : $removed"
fi
if [ -n "$last" ]; then
  cp -a "$last" "$DEST"
  chmod -R go-rwx "$DEST" 2>/dev/null || true
  chmod 700 "$DEST" 2>/dev/null || true
  echo "✅ Restauré depuis $last"
else
  echo "ℹ️  Aucune sauvegarde : $DEST est maintenant absent (OpenCode recréera sa config par défaut)."
fi
# Retire le bloc ajouté à ~/.bashrc / ~/.zshrc par --shell-env (balisé ou ancien format)
for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.zshenv"; do
  [ -f "$rc" ] || continue
  grep -q 'opencode-prerequisites' "$rc" || continue
  tmp="$(mktemp)"
  awk '
    /^# >>> opencode-prerequisites >>>$/ { skip=1; next }
    /^# <<< opencode-prerequisites <<<$/ { skip=0; afterend=1; next }
    skip==1 { next }
    afterend==1 && /^$/ { afterend=0; next }   # la ligne vide que le bloc ajoute après lui
    /^# opencode-prerequisites$/ { old=1; next }
    old==1 && /^export (PATH|MEMPALACE_ADAPTER_PYTHON)=/ { next }
    { old=0; afterend=0; print }
  ' "$rc" > "$tmp" && cat "$tmp" > "$rc" && echo "🧹 Bloc opencode-prerequisites retiré de $rc"
  rm -f "$tmp"
done
rm -f "$BIN/mempalace" "$BIN/agent-wt" "$BIN/oc-new-rust" "$BIN/oc-models" "$BIN/oc-playwright-mcp" "$BIN/oc-terraform-mcp" "$BIN/oc-rea-mcp" "$BIN/oc-semgrep-mcp" "$BIN/oc-android" "$BIN/oc-mobile-mcp" && echo "🧹 lanceurs du kit retirés de $BIN"
rm -f "$DEST/.opencode-prerequisites.pentest" 2>/dev/null || true
echo "Module Android : l'image Podman (podman rmi localhost/oc-android) et les données de l'émulateur (~/.local/share/oc-android) ne sont pas supprimées."
echo "Non touchés : obscura, trivy, nuclei, gitleaks, semgrep, MemPalace (~/.mempalace) et les paquets pip/npm/uv installés (./install.sh --pentest n'est plus mémorisé, mais les binaires restent dans $BIN)."
