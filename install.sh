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

# --- Outils MCP obligatoires : playwright (Microsoft) + obscura ---
BIN="${OBSCURA_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN"

if ! command -v node >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1; then
  echo "❌ Node.js (npx) est requis pour context7/playwright. Installe-le : https://nodejs.org" >&2
  exit 1
fi
echo "⬇️  Playwright : installation de Chromium..."
npx -y playwright install chromium

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  PLAT="x86_64-linux" ;;
  Linux-aarch64|Linux-arm64) PLAT="aarch64-linux" ;;
  Darwin-arm64)  PLAT="aarch64-macos" ;;
  Darwin-x86_64) PLAT="x86_64-macos" ;;
  *) echo "❌ Plateforme non supportée pour obscura : $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BASE="https://github.com/h4ckf0r0day/obscura/releases/latest/download"
echo "⬇️  Obscura ($PLAT)..."
if ! curl -fsSL "$BASE/obscura-$PLAT.tar.gz" -o "$TMP/o.tgz"; then
  curl -fsSL "$BASE/obscura-$PLAT-no-render.tar.gz" -o "$TMP/o.tgz"
fi
tar -xzf "$TMP/o.tgz" -C "$TMP"
# obscura et obscura-worker doivent rester dans le même dossier
find "$TMP" -type f \( -name obscura -o -name obscura-worker \) -exec cp {} "$BIN/" \;
chmod +x "$BIN/obscura" "$BIN/obscura-worker" 2>/dev/null || true
"$BIN/obscura" --help >/dev/null 2>&1 && echo "✅ Obscura installé dans $BIN" || { echo "❌ obscura ne démarre pas" >&2; exit 1; }
case ":$PATH:" in *":$BIN:"*) ;; *) echo "⚠️  Ajoute $BIN à ton PATH : export PATH=\"$BIN:\$PATH\"" ;; esac

# --- Trivy (scan sécurité) + plugin MCP ---
if ! command -v trivy >/dev/null 2>&1; then
  echo "⬇️  Trivy : installation dans $BIN..."
  curl -fsSL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh -o "$TMP/trivy-install.sh" \
    && sh "$TMP/trivy-install.sh" -b "$BIN" \
    || { echo "❌ Installation de Trivy échouée : https://trivy.dev/latest/getting-started/installation/" >&2; exit 1; }
fi
PATH="$BIN:$PATH" trivy plugin install mcp || echo "⚠️  trivy plugin install mcp a échoué : relance-le à la main."

# --- Docker (requis pour le MCP terraform) ---
command -v docker >/dev/null 2>&1 || echo "⚠️  Docker introuvable : le MCP terraform en a besoin (https://docs.docker.com/get-docker/)."
command -v gh >/dev/null 2>&1 || echo "⚠️  gh (GitHub CLI) introuvable : requis pour /pr et la recherche GitHub (https://cli.github.com)."

# --- Outil git multi-agents : agent-wt ---
BIN="${OBSCURA_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN"
install -m 0755 "$SRC/bin/agent-wt" "$BIN/agent-wt"
echo "✅ agent-wt installé dans $BIN"

# --- Mémoire : MemPalace (plugin opencode-mempalace) ---
if ! command -v python3 >/dev/null 2>&1; then
  echo "❌ Python 3.10+ est requis pour MemPalace." >&2; exit 1
fi
echo "⬇️  MemPalace : installation..."
python3 -m pip install --user --upgrade mempalace \
  || { echo "❌ pip a échoué. Essaie : python3 -m venv ~/.mempalace/venv && ~/.mempalace/venv/bin/pip install mempalace, puis export MEMPALACE_ADAPTER_PYTHON=~/.mempalace/venv/bin/python" >&2; exit 1; }
if [ ! -d "$HOME/.mempalace/palace" ]; then
  python3 -m mempalace init "$HOME/.mempalace/palace" 2>/dev/null \
    || mempalace init "$HOME/.mempalace/palace" \
    || echo "⚠️  Initialisation à faire à la main : mempalace init ~/.mempalace/palace"
fi

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
