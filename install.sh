#!/usr/bin/env bash
# Installe le kit OpenCode dans ~/.config/opencode (sauvegarde automatique de l'existant).
# Ne touche à aucune clé API.
#
#   ./install.sh                installation complète (outils inclus)
#   ./install.sh --lite         profil léger : 12 agents, MCP context7 + grep_app, sans outils lourds
#   ./install.sh --no-tools     copie la config seulement (aucun téléchargement/installation d'outil)
#   ./install.sh --with-matt    + skills complets de Matt Pocock
#   OPENCODE_CONFIG_DIR=...     autre dossier de destination ; OBSCURA_BIN_DIR=... dossier des binaires
set -Eeuo pipefail

LITE=0; TOOLS=1; MATT=0
for a in "$@"; do
  case "$a" in
    --lite) LITE=1; TOOLS=0 ;;
    --no-tools) TOOLS=0 ;;
    --with-matt) MATT=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Option inconnue : $a" >&2; exit 1 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/config"
DEST="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
BIN="${OBSCURA_BIN_DIR:-$HOME/.local/bin}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

need() { command -v "$1" >/dev/null 2>&1; }
warn() { echo "⚠️  $*" >&2; }
die()  { echo "❌ $*" >&2; exit 1; }

need node || die "Node.js est requis (validation, profil léger, MCP) : https://nodejs.org"
need opencode || warn "opencode introuvable. Installe-le : curl -fsSL https://opencode.ai/install | bash"

# 1. Validation du kit avant toute copie
node "$HERE/scripts/validate-kit.mjs" || die "Le kit est invalide : rien n'a été installé."

# 2. Sauvegarde + copie
mkdir -p "$DEST"
if [ -n "$(ls -A "$DEST" 2>/dev/null)" ]; then
  cp -a "$DEST" "$DEST.bak-$STAMP"
  echo "💾 Sauvegarde : $DEST.bak-$STAMP"
fi
cp -a "$SRC/." "$DEST/"
mkdir -p "$BIN"
install -m 0755 "$SRC/bin/agent-wt" "$BIN/agent-wt"
install -m 0755 "$HERE/scripts/new-rust-project.sh" "$BIN/oc-new-rust"
cp -a "$HERE/templates" "$DEST/templates"
echo "✅ Config installée dans $DEST ; agent-wt et oc-new-rust dans $BIN"

# 3. Profil léger
if [ "$LITE" = 1 ]; then
  node "$HERE/scripts/make-lite.mjs" "$DEST"
fi

# 4. Outils (profil complet seulement)
if [ "$TOOLS" = 1 ]; then
  need npx || die "npx (Node.js) est requis pour context7/playwright."
  echo "⬇️  Playwright : installation de Chromium..."
  npx -y playwright install chromium

  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) PLAT="x86_64-linux" ;;
    Linux-aarch64|Linux-arm64) PLAT="aarch64-linux" ;;
    Darwin-arm64) PLAT="aarch64-macos" ;;
    Darwin-x86_64) PLAT="x86_64-macos" ;;
    *) die "Plateforme non supportée pour obscura : $(uname -s)-$(uname -m) (sous Windows, utilise WSL)." ;;
  esac
  echo "⬇️  Obscura ($PLAT)..."
  BASE="https://github.com/h4ckf0r0day/obscura/releases/latest/download"
  curl -fsSL "$BASE/obscura-$PLAT.tar.gz" -o "$TMP/o.tgz" \
    || curl -fsSL "$BASE/obscura-$PLAT-no-render.tar.gz" -o "$TMP/o.tgz" \
    || die "Téléchargement d'obscura échoué."
  mkdir -p "$TMP/obscura" && tar -xzf "$TMP/o.tgz" -C "$TMP/obscura"
  find "$TMP/obscura" -type f \( -name obscura -o -name obscura-worker \) -exec cp {} "$BIN/" \;
  chmod +x "$BIN/obscura" "$BIN/obscura-worker" 2>/dev/null || true
  "$BIN/obscura" --help >/dev/null 2>&1 && echo "✅ Obscura installé dans $BIN" \
    || warn "obscura ne répond pas à --help : vérifie-le à la main (MCP obscura à désactiver sinon)."

  if ! need trivy; then
    echo "⬇️  Trivy : installation dans $BIN..."
    curl -fsSL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh -o "$TMP/trivy-install.sh" \
      && sh "$TMP/trivy-install.sh" -b "$BIN" \
      || warn "Installation de Trivy échouée : https://trivy.dev/latest/getting-started/installation/"
  fi
  PATH="$BIN:$PATH" trivy plugin install mcp || warn "trivy plugin install mcp a échoué : relance-le à la main."

  need python3 || die "Python 3.10+ est requis pour MemPalace."
  echo "⬇️  MemPalace : installation..."
  python3 -m pip install --user --upgrade mempalace \
    || die "pip a échoué. Essaie : python3 -m venv ~/.mempalace/venv && ~/.mempalace/venv/bin/pip install mempalace puis export MEMPALACE_ADAPTER_PYTHON=~/.mempalace/venv/bin/python"
  [ -d "$HOME/.mempalace/palace" ] || python3 -m mempalace init "$HOME/.mempalace/palace" 2>/dev/null \
    || mempalace init "$HOME/.mempalace/palace" || warn "Initialise à la main : mempalace init ~/.mempalace/palace"
fi

need docker || warn "Docker introuvable : requis pour le MCP terraform (désactive-le sinon)."
need gh || warn "gh (GitHub CLI) introuvable : requis pour /pr et la recherche GitHub (https://cli.github.com)."
case ":$PATH:" in *":$BIN:"*) ;; *) warn "Ajoute $BIN à ton PATH : export PATH=\"$BIN:\$PATH\"" ;; esac

# 5. Skills de Matt Pocock (optionnel)
if [ "$MATT" = 1 ]; then
  npx -y skills@latest add mattpocock/skills -a opencode || warn "Échec : voir le README du dépôt mattpocock/skills."
fi

cat <<'MSG'

Étapes suivantes :
  1. Lance `opencode`, puis /connect → OpenCode Go → colle ta clé (console OpenCode).
     Console › Settings › Privacy › Regions : choisis « Global » (requis pour les modèles DeepSeek).
  2. ./doctor.sh   (vérifie la config, les outils et les MCP ; /models pour les IDs de modèles)
  3. (optionnel) export CONTEXT7_API_KEY=...   # clé gratuite sur context7.com
  4. Nouveau projet Rust : oc-new-rust <nom>.  Projet existant : skill project-onboarding.
  5. Annuler : ./uninstall.sh
MSG
