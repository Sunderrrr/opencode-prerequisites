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
#   ./install.sh --android      module Android (option) : agents android et mobile-tester, MCP mobile, toolchain Podman
#                               (image à construire ensuite : oc-android build-image --accept-licenses). Mémorisé ;
#   ./install.sh --no-android   retire le module Android
#   ./install.sh --pentest      outils réels pour sécuriser TES apps (pas juste des MCP) : nuclei et gitleaks
#                               (binaires téléchargés et vérifiés par sha256, comme Trivy), semgrep (via uv tool
#                               install) ; nmap et sqlmap sont indiqués (commande à lancer toi-même, jamais sudo
#                               depuis ce script). Utilisés par l'agent @pentest. Mémorisé ;
#   ./install.sh --no-pentest   oublie ce choix (ne désinstalle pas les binaires déjà posés)
#   (ne lance pas ce script avec sudo : tout irait dans /root au lieu de ton dossier personnel)
#   OPENCODE_CONFIG_DIR=...     autre dossier de destination ; OBSCURA_BIN_DIR=... dossier des binaires
set -Eeuo pipefail

LITE=0; TOOLS=1; MATT=0; MEMONLY=0; ALLOWROOT=0; SHELLENV=0; ANDROID=0; NOANDROID=0; PENTEST=0; NOPENTEST=0
for a in "$@"; do
  case "$a" in
    --lite) LITE=1; TOOLS=0 ;;
    --no-tools) TOOLS=0 ;;
    --memory-only) MEMONLY=1 ;;
    --allow-root) ALLOWROOT=1 ;;
    --android) ANDROID=1 ;;
    --no-android) NOANDROID=1 ;;
    --pentest) PENTEST=1 ;;
    --no-pentest) NOPENTEST=1 ;;
    --shell-env) SHELLENV=1 ;;
    --with-matt) MATT=1 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
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
    pacman:podman) echo "sudo pacman -S --needed podman   (rootless : /etc/subuid et /etc/subgid doivent avoir une plage pour ton utilisateur)" ;;
    apt:podman)    echo "sudo apt install podman" ;;
    dnf:podman)    echo "sudo dnf install podman" ;;
    brew:podman)   echo "brew install podman" ;;
    pacman:android) echo "sudo pacman -S --needed android-tools jdk17-openjdk   + SDK : paquet AUR android-sdk-cmdline-tools-latest (yay -S ...) ou Android Studio" ;;
    apt:android)    echo "sudo apt install adb openjdk-17-jdk   + SDK : outils en ligne de commande depuis https://developer.android.com/studio#command-tools (ou Android Studio)" ;;
    dnf:android)    echo "sudo dnf install android-tools java-17-openjdk-devel   + SDK : outils en ligne de commande depuis https://developer.android.com/studio#command-tools (ou Android Studio)" ;;
    brew:android)   echo "brew install --cask android-platform-tools android-commandlinetools && brew install openjdk@17" ;;
    pacman:chromium) echo "sudo pacman -S --needed chromium" ;;
    apt:chromium)    echo "sudo apt install chromium   (ou laisse Playwright télécharger le sien)" ;;
    dnf:chromium)    echo "sudo dnf install chromium" ;;
    pacman:nmap)   echo "sudo pacman -S --needed nmap" ;;
    apt:nmap)      echo "sudo apt install nmap" ;;
    dnf:nmap)      echo "sudo dnf install nmap" ;;
    brew:nmap)     echo "brew install nmap" ;;
    pacman:sqlmap) echo "sudo pacman -S --needed sqlmap" ;;
    apt:sqlmap)    echo "sudo apt install sqlmap" ;;
    dnf:sqlmap)    echo "sudo dnf install sqlmap   (absent des dépôts RHEL/Rocky : pip install sqlmap --user, ou clone https://github.com/sqlmapproject/sqlmap)" ;;
    brew:sqlmap)   echo "brew install sqlmap" ;;
    pacman:unzip)  echo "sudo pacman -S --needed unzip" ;;
    apt:unzip)     echo "sudo apt install unzip" ;;
    dnf:unzip)     echo "sudo dnf install unzip" ;;
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
      # Le Python géré par uv est rangé AVEC le venv (~/.mempalace/python), pas dans le dossier par défaut d'uv :
      # un « uv python prune » ne peut plus casser le venv.
      UV_PYTHON_INSTALL_DIR="$HOME/.mempalace/python" "$UV" venv --seed --managed-python --python 3.12 "$MEMVENV" || return 1
    fi
  fi
  "$MEMVENV/bin/python" -m pip install -q --upgrade mempalace || return 1

  # Le palais se crée tout seul à la première sauvegarde, là où MemPalace le cherche (~/.config/mempalace/palace).
  # Ancienne version de ce script : « mempalace init » sur ~/.mempalace/palace y laissait un mempalace.yaml orphelin.
  local orphan="$HOME/.mempalace/palace"
  if [ -f "$orphan/mempalace.yaml" ] && [ "$(find "$orphan" -mindepth 1 | wc -l)" -eq 1 ]; then
    rm -rf "$orphan" && echo "🧹 Fichier orphelin retiré : $orphan (MemPalace utilise ~/.config/mempalace)"
  fi

  # Repli pour le plugin : il sait retrouver le bon Python à partir du « shebang » de la commande mempalace du PATH
  mkdir -p "$BIN"
  if [ ! -e "$BIN/mempalace" ] || [ -L "$BIN/mempalace" ]; then ln -sf "$MEMVENV/bin/mempalace" "$BIN/mempalace"; fi
  echo "✅ MemPalace installé dans $MEMVENV (le plugin fixe lui-même MEMPALACE_ADAPTER_PYTHON ; commande : $BIN/mempalace)"
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

# --- Module Android (option) : agents, skill, MCP, toolchain Podman. Mémorisé par un repère dans la config. ---
ANDROID_MARKER="$DEST/.opencode-prerequisites.android"
ANDROID_SHIM_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/oc-android/sdk"
if [ "$ANDROID" = 0 ] && [ "$NOANDROID" = 0 ] && [ -f "$ANDROID_MARKER" ]; then ANDROID=1; fi
if [ "$LITE" = 1 ] && [ "$ANDROID" = 1 ]; then warn "Le profil léger n'inclut pas le module Android : ignoré."; ANDROID=0; fi

# apply_block <fichier> <nom> <source> : (re)met un bloc balisé en fin de fichier, sans doublon
apply_block() {
  local f="$1" name="$2" src="$3" tmp
  [ -f "$f" ] || return 0
  tmp="$(mktemp)"
  awk -v s="<!-- >>> $name >>> -->" -v e="<!-- <<< $name <<< -->" '$0==s{skip=1;next} $0==e{skip=0;next} skip!=1{print}' "$f" > "$tmp"
  { cat "$tmp"; echo ""; echo "<!-- >>> $name >>> -->"; cat "$src"; echo "<!-- <<< $name <<< -->"; } > "$f"
  rm -f "$tmp"
}

install_android_addon() {
  local A="$HERE/addons/android"
  need podman || warn "Podman introuvable : requis pour le module Android. → $(pkg_hint podman)"
  mkdir -p "$DEST/agents" "$DEST/skills" "$DEST/android" "$ANDROID_SHIM_ROOT/platform-tools"
  cp -a "$A/agents/." "$DEST/agents/"
  cp -a "$A/skills/." "$DEST/skills/"
  cp -a "$A/libexec/oc-android/." "$DEST/android/"
  for f in "$A"/bin/*; do install -m 0755 "$f" "$BIN/$(basename "$f")"; done
  install -m 0755 "$A/libexec/oc-android/adb-shim" "$ANDROID_SHIM_ROOT/platform-tools/adb"
  apply_block "$DEST/AGENTS.md" android "$A/AGENTS.android.md"
  apply_block "$DEST/agents/ceo.md" android "$A/ceo.android.md"
  : > "$ANDROID_MARKER"
  echo "✅ Module Android installé (agents android et mobile-tester, skill android-dev, oc-android, faux adb pour mobile-mcp)"
}

remove_android_addon() {
  rm -f "$DEST/agents/android.md" "$DEST/agents/mobile-tester.md" "$BIN/oc-android" "$BIN/oc-mobile-mcp" "$ANDROID_MARKER"
  rm -rf "$DEST/skills/android-dev" "$DEST/android" "$ANDROID_SHIM_ROOT"
}

# --- Outils pentest/appsec (option --pentest) : pour sécuriser TES PROPRES apps avant de les exposer.
# Binaires téléchargés et vérifiés par sha256 (comme Trivy) ; aucun sudo lancé par ce script. ---
PENTEST_MARKER="$DEST/.opencode-prerequisites.pentest"
if [ "$PENTEST" = 0 ] && [ "$NOPENTEST" = 0 ] && [ -f "$PENTEST_MARKER" ]; then PENTEST=1; fi
if [ "$LITE" = 1 ] && [ "$PENTEST" = 1 ]; then warn "Le profil léger n'installe pas les outils pentest : ignoré."; PENTEST=0; fi

sha256_of() {
  if need sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif need shasum; then shasum -a 256 "$1" | awk '{print $1}'
  else echo ""; fi
}

extract_archive() {
  local archive="$1" dest="$2"
  case "$archive" in
    *.zip)
      if need unzip; then unzip -o -q "$archive" -d "$dest"
      elif need bsdtar; then bsdtar -xf "$archive" -C "$dest"
      else return 1; fi ;;
    *.tar.gz|*.tgz) tar -xzf "$archive" -C "$dest" ;;
    *) return 1 ;;
  esac
}

# install_binary_release <commande> <owner/repo> <modèle d'archive> [nom du binaire dans l'archive]
# Sans le 4e argument (ou vide) : l'asset téléchargé EST le binaire (pas d'archive à extraire), ex. osv-scanner.
install_binary_release() {
  local name="$1" repo="$2" template="$3" inner="${4:-}" info archive got
  if need "$name"; then echo "✅ $name déjà installé ($(command -v "$name"))"; return 0; fi
  if ! info="$(node "$HERE/scripts/pentest-discover.mjs" "$repo" "$template" 2>&1)"; then
    warn "$name : découverte de la dernière version impossible — $(printf '%s' "$info" | tail -n 1)"; return 1
  fi
  eval "$info" # VERSION / URL / SHA256 / ASSET (noms fixes, échappés par pentest-discover.mjs)
  archive="$TMP/$ASSET"
  if ! curl -fsSL "$URL" -o "$archive"; then warn "$name : téléchargement échoué ($URL)"; return 1; fi
  got="$(sha256_of "$archive")"
  if [ -z "$got" ]; then warn "$name : ni sha256sum ni shasum, somme non vérifiable — installation annulée."; return 1; fi
  if [ "$got" != "$SHA256" ]; then warn "$name : somme de contrôle invalide (attendu $SHA256, obtenu $got) — installation annulée."; return 1; fi
  if [ -z "$inner" ]; then
    install -m 0755 "$archive" "$BIN/$name"
  else
    mkdir -p "$TMP/$name-extract"
    if ! extract_archive "$archive" "$TMP/$name-extract"; then warn "$name : extraction impossible (unzip/bsdtar manquant). → $(pkg_hint unzip)"; return 1; fi
    if [ ! -f "$TMP/$name-extract/$inner" ]; then warn "$name : binaire \"$inner\" absent de l'archive téléchargée."; return 1; fi
    install -m 0755 "$TMP/$name-extract/$inner" "$BIN/$name"
  fi
  echo "✅ $name $VERSION installé dans $BIN (sha256 vérifié sur la release GitHub)"
}

install_pentest_tools() {
  local os os_pd amd gl_arch UV
  os="linux"; os_pd="linux"; [ "$(uname -s)" = Darwin ] && { os="darwin"; os_pd="macOS"; }
  case "$(uname -m)" in aarch64|arm64) amd=arm64 ;; *) amd=amd64 ;; esac
  gl_arch="x64"; [ "$amd" = arm64 ] && gl_arch="arm64"

  # --- Sur ton code (toujours permis, aucune cible réseau) ---
  # gitleaks (MIT) : secrets/clés oubliés dans le code ou l'historique git
  install_binary_release gitleaks "gitleaks/gitleaks" "gitleaks_{v}_${os}_${gl_arch}.tar.gz" gitleaks || true
  # semgrep (SAST, LGPL-2.1/MIT) : CLI via uv tool install (même uv que MemPalace), pas de sudo
  if need semgrep; then
    echo "✅ semgrep déjà installé ($(command -v semgrep))"
  elif UV="$(get_uv)" && "$UV" tool install semgrep --quiet; then
    echo "✅ semgrep installé via uv (SAST, dans $BIN)"
  else
    warn "Installation de semgrep échouée : installe uv (https://docs.astral.sh/uv/) puis relance ./install.sh --pentest"
  fi

  # --- Sur une cible que tu contrôles (app en local/staging, CTF, scope écrit) ---
  # nuclei/httpx utilisent "macOS" (majuscule) pour Darwin, pas "darwin" : attention si tu réutilises ce modèle.
  install_binary_release nuclei "projectdiscovery/nuclei" "nuclei_{v}_${os_pd}_${amd}.zip" nuclei || true
  install_binary_release httpx  "projectdiscovery/httpx"  "httpx_{v}_${os_pd}_${amd}.zip"  httpx  || true
  install_binary_release ffuf   "ffuf/ffuf"                "ffuf_{v}_${os_pd}_${amd}.tar.gz" ffuf  || true
  # osv-scanner (Google, Apache-2.0) : vulnérabilités connues dans les dépendances (base OSV, complète Trivy).
  # Asset non versionné et non compressé : le binaire téléchargé EST osv-scanner (pas de 4e argument).
  install_binary_release osv-scanner "google/osv-scanner" "osv-scanner_${os}_${amd}" || true

  # nmap / sqlmap : paquets système courants, jamais installés avec sudo par ce script
  need nmap   || warn "nmap absent (ports ouverts, services exposés de ton app). → $(pkg_hint nmap)"
  need sqlmap || warn "sqlmap absent (test d'injection SQL ciblé sur ton app). → $(pkg_hint sqlmap)"

  : > "$PENTEST_MARKER"
  echo "✅ Outils pentest/appsec pour sécuriser tes apps (sha256 vérifié sur chaque release) : gitleaks, semgrep, nuclei, httpx, ffuf, osv-scanner ; nmap/sqlmap via le gestionnaire de paquets si absents."
}

remove_pentest_tools() {
  rm -f "$PENTEST_MARKER"
}

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
echo "✅ Config installée dans $DEST ; lanceurs (agent-wt, oc-new-rust, oc-models, oc-playwright-mcp, oc-terraform-mcp, oc-rea-mcp, oc-semgrep-mcp) dans $BIN"

# 3. Profil léger
if [ "$LITE" = 1 ]; then
  node "$HERE/scripts/make-lite.mjs" "$DEST"
fi

# 2b. Module Android (option)
if [ "$ANDROID" = 1 ]; then
  install_android_addon
else
  remove_android_addon   # idempotent : nettoie aussi d'anciennes installations
fi

# 2c. Outils pentest/appsec (option --pentest)
if [ "$PENTEST" = 1 ]; then
  install_pentest_tools
else
  remove_pentest_tools   # retire seulement le repère : les binaires déjà posés ne sont pas supprimés
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

# 3d. MCP mobile : actif seulement avec le module Android (et Podman) ; sinon désactivé proprement
if [ "$LITE" = 0 ] && [ -f "$DEST/opencode.jsonc" ] && grep -q '"mobile": {' "$DEST/opencode.jsonc"; then
  if [ "$ANDROID" = 1 ] && "$BIN/oc-mobile-mcp" --check >/dev/null 2>&1; then
    echo "✅ MCP mobile (mobile-mcp 1.0.15) activé (adb de l'émulateur Podman)"
  else
    sed -i.bak 's|"mobile": {|"mobile": {\n        "disabled": true, // module Android non installé (./install.sh --android) ou Podman absent|' "$DEST/opencode.jsonc" \
      && rm -f "$DEST/opencode.jsonc.bak"
    if [ "$ANDROID" = 1 ]; then warn "MCP mobile désactivé : Podman introuvable. → $(pkg_hint podman)"; fi
  fi
fi

# 3e. MCP semgrep (SAST, agents pentest/security) : exige uv (uvx) ou pipx ; sinon désactivé proprement
if [ "$LITE" = 0 ] && [ -f "$DEST/opencode.jsonc" ] && grep -q '"semgrep": {' "$DEST/opencode.jsonc"; then
  if "$BIN/oc-semgrep-mcp" --check >/dev/null 2>&1; then
    echo "✅ MCP semgrep activé (uvx/pipx détecté)"
  else
    sed -i.bak 's|"semgrep": {|"semgrep": {\n        "disabled": true, // uv (uvx) et pipx absents : retire cette ligne apres avoir installe un des deux|' "$DEST/opencode.jsonc" \
      && rm -f "$DEST/opencode.jsonc.bak"
    echo "ℹ️  MCP semgrep désactivé : installe uv (curl -LsSf https://astral.sh/uv/install.sh | sh), déjà requis pour MemPalace."
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
# - ~/.local/bin est ajouté EN FIN de PATH, jamais en tête (en tête, il peut faire boucler les shims mise/asdf).
# - Le bloc est écrit TOUT EN HAUT de ~/.bashrc (avant le « return » des shells non interactifs) et dans ~/.zshenv pour zsh
#   (lu par tous les zsh, contrairement à ~/.zshrc) : il est ainsi visible des commandes lancées sans terminal.
# - Un service lancé par systemd ne lit aucun de ces fichiers : le plugin MemPalace fixe donc lui-même son Python.
strip_env_block() {  # fichier → stdout, sans notre bloc (balisé, ou ancien format sans balises)
  awk '
    /^# >>> opencode-prerequisites >>>$/ { skip=1; next }
    /^# <<< opencode-prerequisites <<<$/ { skip=0; afterend=1; next }
    skip==1 { next }
    afterend==1 && /^$/ { afterend=0; next }   # la ligne vide que le bloc ajoute après lui
    /^# opencode-prerequisites$/ { old=1; next }
    old==1 && /^export (PATH|MEMPALACE_ADAPTER_PYTHON)=/ { next }
    { old=0; afterend=0; print }
  ' "$1"
}
write_env_block() {  # fichier
  local rc="$1" first head_line=""
  if [ -e "$rc" ] && [ ! -e "$rc.bak-opencode-prerequisites" ]; then cp -p "$rc" "$rc.bak-opencode-prerequisites"; fi
  if [ -f "$rc" ]; then strip_env_block "$rc" > "$TMP/rc.rest"; else : > "$TMP/rc.rest"; fi
  first="$(head -n 1 "$TMP/rc.rest")"
  case "$first" in
    "#!"*) head_line="$first"; tail -n +2 "$TMP/rc.rest" > "$TMP/rc.tail" ;;   # un éventuel shebang reste en première ligne
    *) cp "$TMP/rc.rest" "$TMP/rc.tail" ;;
  esac
  {
    if [ -n "$head_line" ]; then echo "$head_line"; fi
    echo "# >>> opencode-prerequisites >>>"
    echo "case \":\$PATH:\" in *\":$BIN:\"*) ;; *) export PATH=\"\$PATH:$BIN\" ;; esac"
    if [ -x "$MEMVENV/bin/python" ]; then echo "export MEMPALACE_ADAPTER_PYTHON=\"$MEMVENV/bin/python\""; fi
    echo "# <<< opencode-prerequisites <<<"
    echo ""
    cat "$TMP/rc.tail"
  } > "$TMP/rc.out"
  cat "$TMP/rc.out" > "$rc"   # cat > : conserve les droits et les liens symboliques (dotfiles)
  echo "✅ Bloc PATH (en fin) + MEMPALACE_ADAPTER_PYTHON écrit en haut de $rc"
}
if [ "$SHELLENV" = 1 ]; then
  if [ -f "$HOME/.bashrc" ]; then write_env_block "$HOME/.bashrc"; fi
  if [ -f "$HOME/.zshrc" ] || [ -f "$HOME/.zshenv" ]; then
    write_env_block "$HOME/.zshenv"
    # nettoie d'anciens blocs laissés dans ~/.zshrc (non lu hors terminal interactif)
    if [ -f "$HOME/.zshrc" ] && grep -q 'opencode-prerequisites' "$HOME/.zshrc"; then
      strip_env_block "$HOME/.zshrc" > "$TMP/zshrc.clean" && cat "$TMP/zshrc.clean" > "$HOME/.zshrc"
    fi
  fi
  echo "   (ouvre un nouveau terminal ; sauvegardes : <fichier>.bak-opencode-prerequisites)"
fi

# 5. Skills de Matt Pocock (optionnel)
if [ "$MATT" = 1 ]; then
  npx -y skills@latest add mattpocock/skills -a opencode || warn "Échec : voir le README du dépôt mattpocock/skills."
fi

# Repère de fin d'installation : le diagnostic ignore les lignes de journal antérieures
: > "$DEST/.opencode-prerequisites.installed"

if [ "$ANDROID" = 1 ]; then
  cat <<MSG

Module Android — dernières étapes :
  1. Podman rootless : oc-android doctor
  2. Construire l'image (plusieurs Go, 10 à 20 min ; tu acceptes les licences du SDK Android) :
       oc-android build-image --accept-licenses
  3. Émulateur (exige /dev/kvm ; groupe kvm) : depuis ton projet, oc-android emulator start --wait
MSG
fi

cat <<'MSG'

Si OpenCode tourne déjà (y compris son service en arrière-plan), REDÉMARRE-LE : un serveur déjà lancé ne relit
ni les plugins ni l'environnement (d'après ton retour : opencode service restart ; sinon ferme toutes les fenêtres OpenCode).

Étapes suivantes :
  1. Lance `opencode`, puis /connect → OpenCode Go → colle ta clé (console OpenCode).
     Console › Settings › Privacy › Regions : choisis « Global » (requis pour les modèles DeepSeek).
  2. ./doctor.sh   (vérifie la config, les outils et les MCP ; /models pour les IDs de modèles)
  3. (optionnel) export CONTEXT7_API_KEY=...   # clé gratuite sur context7.com
  4. Nouveau projet Rust : oc-new-rust <nom>.  Projet existant : skill project-onboarding.
  5. Annuler : ./uninstall.sh
MSG
