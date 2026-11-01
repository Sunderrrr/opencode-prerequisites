#!/usr/bin/env bash
# Installe la config OpenCode (AGENTS.md, agents, skills, commandes, MCP) dans ~/.config/opencode
# Sauvegarde automatique de l'existant. Ne touche à aucune clé API.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/config" && pwd)"
DEST="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
STAMP="$(date +%Y%m%d-%H%M%S)"

if ! command -v opencode >/dev/null 2>&1; then
  echo "⚠️  opencode introuvable. Installe-le : curl -fsSL https://opencode.ai/install | bash"
fi

mkdir -p "$DEST"
if [ -n "$(ls -A "$DEST" 2>/dev/null)" ]; then
  cp -a "$DEST" "$DEST.bak-$STAMP"
  echo "💾 Sauvegarde : $DEST.bak-$STAMP"
fi

cp -a "$SRC/." "$DEST/"
echo "✅ Config installée dans $DEST"

# Option : skills complets de Matt Pocock (npx skills add mattpocock/skills)
if [ "${1:-}" = "--with-matt" ]; then
  npx -y skills@latest add mattpocock/skills -a opencode || echo "⚠️  Échec : essaie à la main (voir README du repo)"
fi

cat <<'EOF'

Étapes suivantes :
  1. Lance `opencode`, puis /connect -> OpenCode Go -> colle ta clé (console OpenCode).
  2. /models pour vérifier que les IDs du fichier opencode.jsonc existent encore.
  3. (optionnel) export CONTEXT7_API_KEY=...   # clé gratuite sur context7.com
  4. Dans un projet : lance `opencode` puis /init, ou demande le skill project-onboarding.
  5. Skills communautaires : `npx skills add <repo>` (voir README).
EOF
