#!/usr/bin/env bash
# Installe le kit OpenCode dans ~/.config/opencode (sauvegarde automatique de l'existant).
# Ne touche à aucune clé API.
#
#   ./install.sh                installation complète (outils inclus)
#   ./install.sh --lite         profil léger : 12 agents, MCP context7 + grep_app, sans outils lourds
#   ./install.sh --no-tools     copie la config seulement (aucun téléchargement/installation d'outil)
#   ./install.sh --memory-only  (re)tente seulement l'installation de MemPalace, sans rien recopier
#   ./install.sh --shell-env    ajoute PATH et MEMPALACE_ADAPTER_PYTHON à ~/.bashrc / ~/.zshrc (une seule fois)
#   ./install.sh --with-matt    + skills complets de Matt Pocock
#   (ne lance pas ce script avec sudo : tout irait dans /root au lieu de ton dossier personnel)
#   OPENCODE_CONFIG_DIR=...     autre dossier de destination ; OBSCURA_BIN_DIR=... dossier des binaires
set -Eeuo pipefail

LITE=0; TOOLS=1; MATT=0; MEMONLY=0; ALLOWROOT=0; SHELLENV=0
for a in "$@"; do
  case "$a" in
    --lite) LITE=1; TOOLS=0 ;;
    --no-tools) TOOLS=0 ;;
    --memory-only) MEMONLY=1 ;;
    --allow-root) ALLOWROOT=1 ;;
    --shell-env) SHELLENV=1 ;;
    --with-matt) MATT=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
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

# --- Distribution (Omarchy/Arch, Debian/Ubuntu, Fedora/RHEL, macOS) : sert aux conseils d'installation ---
DISTRO="inconnue"; PM=""
if [ "$(uname -s)" = Darwin ]; then
  DISTRO="macOS"; PM="brew"
elif [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  DISTRO="${PRETTY_NAME:-${NAME:-linux}}"
  case " ${ID:-} ${ID_LIKE:-} " in
    *" arch "*|*" archlinux "*|*" omarchy "*) PM="pacman" ;;
    *" debian "*|*" ubuntu "*) PM="apt" ;;
    *" fedora "*|*" rhel "*|*" centos "*|*" rocky "*|*" almalinux "*) PM="dnf" ;;
  esac
fi

# pkg_hint <outil> : commande d'installation adaptée à la distribution
pkg_hint() {
  local t="$1"
  case "$PM:$t" in
    pacman:docker) echo "sudo pacman -S --needed docker && sudo systemctl enable --now docker && sudo usermod -aG docker \$USER   (ou: sudo pacman -S podman)" ;;
    apt:docker)    echo "sudo apt install docker.io   (ou: sudo apt install podman)" ;;
    dnf:docker)    echo "sudo dnf install podman   (ou Docker CE : https://docs.docker.com/engine/install/)" ;;
    brew:docker)   echo "brew install --cask docker" ;;
    pacman:gh)     echo "sudo pacman -S --needed github-cli" ;;
    apt:gh)        echo "sudo apt install gh   (sinon : https://github.com/cli/cli/blob/trunk/docs/install_linux.md)" ;;
    dnf:gh)        echo "sudo dnf install gh" ;;
    brew:gh)       echo "brew install gh" ;;
    pacman:node)   echo "sudo pacman -S --needed nodejs npm   (ou: mise use -g node)" ;;
    apt:node)      echo "sudo apt install nodejs npm   (ou: https://nodejs.org)" ;;
    dnf:node)      echo "sudo dnf install nodejs npm" ;;
    brew:node)     echo "brew install node" ;;
    apt:venv)      echo "sudo apt install python3-venv" ;;
    pacman:android) echo "sudo pacman -S --needed android-tools jdk17-openjdk   + SDK : paquet AUR android-sdk-cmdline-tools-latest (yay -S ...) ou Android Studio" ;;
    apt:android)    echo "sudo apt install adb openjdk-17-jdk   + SDK : outils en ligne de commande depuis https://developer.android.com/studio#command-tools (ou Android Studio)" ;;
    dnf:android)    echo "sudo dnf install android-tools java-17-openjdk-devel   + SDK : outils en ligne de commande depuis https://developer.android.com/studio#command-tools (ou Android Studio)" ;;
    brew:android)   echo "brew install --cask android-platform-tools android-commandlinetools && brew install openjdk@17" ;;
    pacman:chromium) echo "sudo pacman -S --needed chromium" ;;
    apt:chromium)    echo "sudo apt install chromium   (ou laisse Playwright télécharger le sien)" ;;
    dnf:chromium)    echo "sudo dnf install chromium" ;;
    *) echo "voir la documentation de ${t} pour ${DISTRO}" ;;
  esac
}

# get_uv : trouve uv ou télécharge le binaire statique officiel (aucun paquet python3-venv requis)
get_uv() {
  if need uv; then echo uv; return 0; fi
  local arch os
  case "$(uname -m)" in x86_64) arch=x86_64 ;; aarch64|arm64) arch=aarch64 ;; *) return 1 ;; esac
  case "$(uname -s)" in
    Linux)  os="unknown-linux-musl" ;;
    Darwin) os="apple-darwin" ;;
    *) return 1 ;;
  esac
  mkdir -p "$TMP/uvbin"
  curl -fsSL "https://github.com/astral-sh/uv/releases/latest/download/uv-$arch-$os.tar.gz" -o "$TMP/uv.tgz" \
    && tar -xzf "$TMP/uv.tgz" -C "$TMP/uvbin" --strip-components=1 \
    && [ -x "$TMP/uvbin/uv" ] && echo "$TMP/uvbin/uv"
}

# Lancé via sudo : $HOME serait celui de root (config, outils et MemPalace installés au mauvais endroit)
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$ALLOWROOT" != 1 ]; then
  die "Ne lance pas ce script avec sudo (il installerait tout dans $HOME, pas chez $SUDO_USER). Relance simplement : ./install.sh"
fi


# MemPalace dans un venv dédié (évite les erreurs PEP 668 et les Python trop récents sans wheels onnxruntime)
MEMVENV="$HOME/.mempalace/venv"
setup_mempalace() {
  if [ ! -x "$MEMVENV/bin/python" ]; then
    local py="" c made=0
    for c in python3.13 python3.12 python3.11 python3.10; do
      if need "$c"; then py="$c"; break; fi
    done
    mkdir -p "$HOME/.mempalace"
    if [ -n "$py" ]; then
      echo "   Python $py → venv $MEMVENV"
      if "$py" -m venv "$MEMVENV" 2>/dev/null; then made=1; else rm -rf "$MEMVENV"; warn "venv impossible avec $py ($(pkg_hint venv)) : je passe par uv."; fi
    else
      echo "   Aucun Python 3.10–3.13 trouvé ($(python3 --version 2>&1)) : j'utilise uv pour télécharger Python 3.12."
    fi
    if [ "$made" = 0 ]; then
      local UV
      UV="$(get_uv)" || { warn "uv indisponible : installe-le (https://docs.astral.sh/uv/) puis relance ./install.sh --memory-only"; return 1; }
      "$UV" venv --seed --python 3.12 "$MEMVENV" || return 1
    fi
  fi
  "$MEMVENV/bin/python" -m pip install -q --upgrade mempalace || return 1
  if [ ! -f "$HOME/.mempalace/palace/mempalace.yaml" ]; then
    # init attend un dossier existant et pose des questions : on le rend non interactif
    mkdir -p "$HOME/.mempalace/palace"
    "$MEMVENV/bin/mempalace" init "$HOME/.mempalace/palace" --yes --no-llm </dev/null >/dev/null 2>&1 \
      || warn "Initialise à la main : $MEMVENV/bin/mempalace init ~/.mempalace/palace --yes --no-llm"
  fi
  echo "✅ MemPalace installé dans $MEMVENV"
  echo "   ➜ Ajoute à ton ~/.bashrc (ou ~/.zshrc) :  export MEMPALACE_ADAPTER_PYTHON=\"$MEMVENV/bin/python\""
}

# Plugin MemPalace : installé ici avec --legacy-peer-deps (le paquet déclare des peerDependencies
# incompatibles entre elles : l'installation npm faite par OpenCode échoue en ERESOLVE), puis chargé
# comme plugin local (dossier plugins/mempalace/ qui ré-exporte le paquet installé).
MEMPLUGIN="$HOME/.mempalace/plugin"
install_mempalace_plugin() {
  need npm || { warn "npm introuvable : plugin MemPalace non installé. → $(pkg_hint node)"; return 1; }
  mkdir -p "$MEMPLUGIN"
  [ -f "$MEMPLUGIN/package.json" ] || echo '{"name":"mempalace-plugin-host","private":true}' > "$MEMPLUGIN/package.json"
  ( cd "$MEMPLUGIN" && npm install @rvboris/opencode-mempalace@2.0.1 --legacy-peer-deps --ignore-scripts --no-audit --no-fund --loglevel=error ) \
    || { warn "npm install du plugin MemPalace échoué"; return 1; }
  local entry="$MEMPLUGIN/node_modules/@rvboris/opencode-mempalace/dist/plugin/index.js"
  [ -f "$entry" ] || { warn "Plugin MemPalace introuvable après installation : $entry"; return 1; }
  mkdir -p "$DEST/plugins/mempalace"
  # Le plugin fixe lui-même MEMPALACE_ADAPTER_PYTHON (modèle libexec/mempalace-plugin.ts.tpl) : indépendant du shell de lancement
  sed -e "s|__ROOT__|$MEMPLUGIN|g" -e "s|__PYTHON__|$MEMVENV/bin/python|g" -e "s|__ENTRY__|$entry|g" \
    "$HERE/config/libexec/mempalace-plugin.ts.tpl" > "$DEST/plugins/mempalace/index.ts"
  echo "✅ Plugin MemPalace chargé comme plugin local (plugins/mempalace)"
}

drop_mempalace_plugin() {
  # MemPalace indisponible : retire le plugin local pour qu'OpenCode démarre proprement
  rm -rf "$DEST/plugins/mempalace"
  warn "Plugin MemPalace non activé (relance ./install.sh --memory-only quand le problème sera réglé)."
}

if [ "$MEMONLY" = 1 ]; then
  echo "⬇️  MemPalace..."
  mkdir -p "$DEST"
  if ! { setup_mempalace && install_mempalace_plugin; }; then
    die "MemPalace n'a pas pu être installé."
  fi
  : > "$DEST/.opencode-prerequisites.installed"
  exit 0
fi

need node || die "Node.js est requis (validation, profil léger, MCP). → $(pkg_hint node)"
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
# Retire les fichiers que le kit installait avant et qui n'existent plus (ex. plugins/auto-compact.js),
# sans toucher à tes propres fichiers : on se base sur la liste des fichiers déjà installés par le kit.
MANIFEST="$DEST/.opencode-prerequisites.manifest"
( cd "$SRC" && find . -type f ! -path './bin/*' | sed 's|^\./||' | sort ) > "$TMP/new.manifest"
{ [ -f "$MANIFEST" ] && cat "$MANIFEST"; printf "%s\n" "plugins/auto-compact.js" "plugins/guard.js" "plugins/notify.js"; } | sort -u > "$TMP/old.manifest"
comm -23 "$TMP/old.manifest" "$TMP/new.manifest" | while IFS= read -r f; do
  case "$f" in ""|*..*|/*) continue ;; esac
  if [ -e "$DEST/$f" ]; then rm -f "$DEST/$f" && echo "🧹 Retiré (n'existe plus dans le kit) : $f"; fi
done
cp "$TMP/new.manifest" "$MANIFEST"

for f in "$SRC"/bin/*; do install -m 0755 "$f" "$BIN/$(basename "$f")"; done
install -m 0755 "$HERE/scripts/new-rust-project.sh" "$BIN/oc-new-rust"
cp -a "$HERE/templates" "$DEST/templates"
echo "✅ Config installée dans $DEST ; lanceurs (agent-wt, oc-new-rust, oc-models, oc-playwright-mcp, oc-terraform-mcp, oc-rea-mcp, oc-mobile-mcp) dans $BIN"

# 3. Profil léger
if [ "$LITE" = 1 ]; then
  node "$HERE/scripts/make-lite.mjs" "$DEST"
fi

# 3a. Tes choix de modèles (oc-models set ...) survivent aux mises à jour : on les réapplique après la copie
if [ -f "$DEST/oc-models.json" ]; then
  OPENCODE_CONFIG_DIR="$DEST" node "$DEST/libexec/oc-models.mjs" apply && echo "✅ Modèles personnalisés réappliqués ($DEST/oc-models.json)"
fi

# 3b. Kubernetes : le serveur MCP quitte au démarrage s'il n'y a aucun contexte kubectl
if [ "$LITE" = 0 ] && [ -f "$DEST/opencode.jsonc" ]; then
  kc="${KUBECONFIG:-$HOME/.kube/config}"
  if ! grep -qs '^current-context: *[^ ]' "${kc%%:*}"; then
    sed -i.bak 's|"kubernetes": {|"kubernetes": {\n        "disabled": true, // aucun contexte kubectl : retire cette ligne quand tu auras un cluster|' "$DEST/opencode.jsonc" \
      && rm -f "$DEST/opencode.jsonc.bak"
    echo "ℹ️  MCP kubernetes désactivé (aucun contexte kubectl dans ${kc%%:*}) : retire la ligne \"disabled\" de opencode.jsonc quand tu auras un cluster."
  fi
fi

# 3c. REA (rétro-ingénierie) : le serveur exige Node >= 26.12.1 (ou 24.22.1 / 22.23.4) ; sinon on le désactive proprement
if [ "$LITE" = 0 ] && [ -f "$DEST/opencode.jsonc" ] && grep -q '"rea": {' "$DEST/opencode.jsonc"; then
  if rea_msg="$("$BIN/oc-rea-mcp" --check 2>&1)"; then
    echo "✅ MCP rea (REA 6.8.0) activé : Node ${OC_REA_NODE_VERSION:-$(node -p 'process.versions.node')} convient"
  else
    sed -i.bak 's|"rea": {|"rea": {\n        "disabled": true, // Node trop ancien pour REA : retire cette ligne après avoir mis Node à jour|' "$DEST/opencode.jsonc" \
      && rm -f "$DEST/opencode.jsonc.bak"
    echo "ℹ️  MCP rea désactivé : $(printf '%s' "$rea_msg" | head -n 1)"
    echo "    Mets Node à jour (mise use -g node@26.12.1) puis relance ./install.sh --no-tools : l'agent reverse-engineer utilisera la CLI en attendant."
  fi
fi

# 3d. MCP mobile (Android) : il a besoin d'adb ; sinon on le désactive proprement
if [ "$LITE" = 0 ] && [ -f "$DEST/opencode.jsonc" ] && grep -q '"mobile": {' "$DEST/opencode.jsonc"; then
  if "$BIN/oc-mobile-mcp" --check >/dev/null 2>&1; then
    echo "✅ MCP mobile (mobile-mcp 1.0.15) activé : adb trouvé"
  else
    sed -i.bak 's|"mobile": {|"mobile": {\n        "disabled": true, // adb introuvable : retire cette ligne après avoir installé le SDK Android|' "$DEST/opencode.jsonc" \
      && rm -f "$DEST/opencode.jsonc.bak"
    echo "ℹ️  MCP mobile désactivé (adb introuvable). Pour développer en Android : $(pkg_hint android)"
    echo "    puis relance ./install.sh --no-tools (détails : README, section Android)."
  fi
fi

# 4. Outils (profil complet seulement)
if [ "$TOOLS" = 1 ]; then
  need npx || die "npx (Node.js) est requis pour context7/playwright."
  SYSBROWSER=""
  for c in chromium chromium-browser google-chrome-stable google-chrome brave-browser brave; do
    if need "$c"; then SYSBROWSER="$(command -v "$c")"; break; fi
  done
  if [ -n "$SYSBROWSER" ]; then
    echo "✅ Navigateur système détecté ($SYSBROWSER) : le MCP Playwright l'utilisera, pas de téléchargement."
  else
    echo "⬇️  Playwright : installation de Chromium (aucun navigateur système trouvé)..."
    npx -y playwright install chromium || warn "Chromium non installé. Sur ${DISTRO} : $(pkg_hint chromium)"
    case "$PM" in
      apt) echo "   Si Chromium ne démarre pas (bibliothèques manquantes) : sudo npx playwright install-deps chromium" ;;
      pacman|dnf) echo "   Playwright ne supporte pas officiellement ${DISTRO} : le plus simple est le Chromium du système → $(pkg_hint chromium)" ;;
    esac
  fi

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
  # Copie vers un nom temporaire puis renommage : fonctionne même si obscura tourne déjà (« Text file busy »)
  for f in obscura obscura-worker; do
    src="$(find "$TMP/obscura" -type f -name "$f" | head -n 1)"
    [ -n "$src" ] || continue
    cp "$src" "$BIN/.$f.new" && chmod +x "$BIN/.$f.new" && mv -f "$BIN/.$f.new" "$BIN/$f"
  done
  if "$BIN/obscura" --help >/dev/null 2>&1; then
    echo "✅ Obscura installé dans $BIN"
  else
    warn "obscura ne répond pas à --help : vérifie-le à la main (MCP obscura à désactiver sinon)."
  fi

  if ! need trivy; then
    echo "⬇️  Trivy : installation dans $BIN..."
    if curl -fsSL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh -o "$TMP/trivy-install.sh"; then
      sh "$TMP/trivy-install.sh" -b "$BIN" || warn "Installation de Trivy échouée : https://trivy.dev/latest/getting-started/installation/"
    else
      warn "Téléchargement du script Trivy échoué : https://trivy.dev/latest/getting-started/installation/"
    fi
  fi
  PATH="$BIN:$PATH" trivy plugin install mcp || warn "trivy plugin install mcp a échoué : relance-le à la main."

  echo "⬇️  MemPalace..."
  if ! { setup_mempalace && install_mempalace_plugin; }; then
    drop_mempalace_plugin
  fi
fi

# MemPalace déjà installé (venv présent) : (ré)installe seulement son plugin, même avec --no-tools
if [ "$TOOLS" = 0 ] && [ "$LITE" = 0 ] && [ -x "$MEMVENV/bin/python" ]; then
  echo "⬇️  Plugin MemPalace..."
  install_mempalace_plugin || drop_mempalace_plugin
fi

echo "ℹ️  Système : $DISTRO (gestionnaire : ${PM:-aucun reconnu})"
if ! need docker && ! need podman; then
  warn "Ni Docker ni Podman : requis pour le MCP terraform (ou mets \"enabled\": false). → $(pkg_hint docker)"
fi
need gh || warn "gh (GitHub CLI) introuvable : requis pour /pr et la recherche GitHub. → $(pkg_hint gh)"
[ "$BIN" = "$HOME/.local/bin" ] || warn "Les MCP playwright et terraform pointent vers \$HOME/.local/bin (lanceurs oc-*) : copie-les depuis $BIN ou garde le dossier par défaut."
case ":$PATH:" in *":$BIN:"*) ;; *) warn "Ajoute $BIN à ton PATH : export PATH=\"$BIN:\$PATH\"" ;; esac

# Variables d'environnement dans le shell (opt-in). Bloc balisé, remplacé à chaque exécution (pas de doublon).
# IMPORTANT : ~/.local/bin est ajouté EN FIN de PATH, jamais en tête (en tête, il peut faire boucler les shims mise/asdf).
if [ "$SHELLENV" = 1 ]; then
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$rc" ] || continue
    [ -e "$rc.bak-opencode-prerequisites" ] || cp -p "$rc" "$rc.bak-opencode-prerequisites"
    # retire l'ancien bloc (balisé, ou ancien format sans balises) puis écrit le nouveau
    awk '
      /^# >>> opencode-prerequisites >>>$/ { skip=1; next }
      /^# <<< opencode-prerequisites <<<$/ { skip=0; next }
      skip==1 { next }
      /^# opencode-prerequisites$/ { old=1; next }
      old==1 && /^export (PATH|MEMPALACE_ADAPTER_PYTHON)=/ { next }
      { old=0; print }
    ' "$rc" > "$TMP/rc.new"
    {
      cat "$TMP/rc.new"
      echo ""
      echo "# >>> opencode-prerequisites >>>"
      echo "case \":\$PATH:\" in *\":$BIN:\"*) ;; *) export PATH=\"\$PATH:$BIN\" ;; esac"
      [ -x "$MEMVENV/bin/python" ] && echo "export MEMPALACE_ADAPTER_PYTHON=\"$MEMVENV/bin/python\""
      echo "# <<< opencode-prerequisites <<<"
    } > "$TMP/rc.final"
    cat "$TMP/rc.final" > "$rc"   # cat > : conserve les droits et les liens symboliques (dotfiles)
    echo "✅ PATH (en fin) et MEMPALACE_ADAPTER_PYTHON écrits dans $rc (ouvre un nouveau terminal ; sauvegarde : $rc.bak-opencode-prerequisites)"
  done
fi

# 5. Skills de Matt Pocock (optionnel)
if [ "$MATT" = 1 ]; then
  npx -y skills@latest add mattpocock/skills -a opencode || warn "Échec : voir le README du dépôt mattpocock/skills."
fi

# Repère de fin d'installation : le diagnostic ignore les lignes de journal antérieures
: > "$DEST/.opencode-prerequisites.installed"

cat <<'MSG'

Étapes suivantes :
  1. Lance `opencode`, puis /connect → OpenCode Go → colle ta clé (console OpenCode).
     Console › Settings › Privacy › Regions : choisis « Global » (requis pour les modèles DeepSeek).
  2. ./doctor.sh   (vérifie la config, les outils et les MCP ; /models pour les IDs de modèles)
  3. (optionnel) export CONTEXT7_API_KEY=...   # clé gratuite sur context7.com
  4. Nouveau projet Rust : oc-new-rust <nom>.  Projet existant : skill project-onboarding.
  5. Annuler : ./uninstall.sh
MSG
