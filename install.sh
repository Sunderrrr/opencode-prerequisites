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

# --- Versions épinglées des outils téléchargés : aucune URL « latest » ni « main ».
# Surchargeables (OC_*_VERSION) pour suivre une release précise ou pour les tests hermétiques.
# Valeurs par défaut vérifiées sur la machine d'écriture ; uv = dernière release stable au moment de l'audit.
OC_TRIVY_VERSION="${OC_TRIVY_VERSION:-0.76.1}"
OC_TRIVY_MCP_VERSION="${OC_TRIVY_MCP_VERSION:-v0.0.20}"
OC_OBSCURA_VERSION="${OC_OBSCURA_VERSION:-0.2.6}"
OC_UV_VERSION="${OC_UV_VERSION:-0.13.7}"
OC_MEMPALACE_VERSION="${OC_MEMPALACE_VERSION:-3.11.0}"
OC_SEMGREP_VERSION="${OC_SEMGREP_VERSION:-1.183.0}"
OC_PLAYWRIGHT_VERSION="${OC_PLAYWRIGHT_VERSION:-1.64.1}"
OC_SKILLS_VERSION="${OC_SKILLS_VERSION:-1.7.6}"

LITE=0; TOOLS=1; MATT=0; MEMONLY=0; ALLOWROOT=0; SHELLENV=0; ANDROID=0; NOANDROID=0; PENTEST=0; NOPENTEST=0; PENTEST_EXPLICIT=0
for a in "$@"; do
  case "$a" in
    --lite) LITE=1; TOOLS=0 ;;
    --no-tools) TOOLS=0 ;;
    --memory-only) MEMONLY=1 ;;
    --allow-root) ALLOWROOT=1 ;;
    --android) ANDROID=1 ;;
    --no-android) NOANDROID=1 ;;
    --pentest) PENTEST=1; PENTEST_EXPLICIT=1; NOPENTEST=0 ;;
    --no-pentest) NOPENTEST=1; PENTEST=0; PENTEST_EXPLICIT=0 ;;
    --shell-env) SHELLENV=1 ;;
    --with-matt) MATT=1 ;;
    -h|--help) awk 'NR > 1 && /^set -/ { exit } NR > 1 { print }' "$0"; exit 0 ;;
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

# Une version surchargeable ne doit jamais pouvoir injecter une URL ou une option.
for v in "$OC_TRIVY_VERSION" "$OC_TRIVY_MCP_VERSION" "$OC_OBSCURA_VERSION" "$OC_UV_VERSION" \
         "$OC_MEMPALACE_VERSION" "$OC_SEMGREP_VERSION" "$OC_PLAYWRIGHT_VERSION" "$OC_SKILLS_VERSION"; do
  if [[ ! "$v" =~ ^[0-9A-Za-z._-]+$ ]]; then die "Version invalide : $v"; fi
done

sha256_of() {
  if need sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif need shasum; then shasum -a 256 "$1" | awk '{print $1}'
  else echo ""; fi
}

# fetch_verified <url> <destination> <sha256 attendu> <libellé>
# Télécharge puis refuse d'aller plus loin si la somme est absente ou différente (échec fermé).
fetch_verified() {
  local url="$1" dest="$2" want="$3" label="$4" got
  if ! curl -fsSL --retry 2 --connect-timeout 15 "$url" -o "$dest"; then
    warn "$label : téléchargement échoué ($url)"; return 1
  fi
  got="$(sha256_of "$dest")"
  if [ -z "$got" ]; then
    warn "$label : ni sha256sum ni shasum — somme non vérifiable, installation annulée."; return 1
  fi
  if [ "$got" != "$want" ]; then
    die "$label : somme de contrôle invalide (attendu $want, obtenu $got) — installation annulée."
  fi
}

# unique_path <chemin> : le chemin s'il est libre, sinon <chemin>-1, -2... (deux installations
# dans la même seconde ne doivent jamais se copier l'une dans l'autre).
unique_path() {
  local base="$1" cand="$1" n=1
  while [ -e "$cand" ] || [ -L "$cand" ]; do cand="$base-$n"; n=$((n + 1)); done
  printf '%s\n' "$cand"
}

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
    pacman:perl)   echo "sudo pacman -S --needed perl" ;;
    apt:perl)      echo "sudo apt install perl" ;;
    dnf:perl)      echo "sudo dnf install perl" ;;
    brew:perl)     echo "brew install perl" ;;
    pacman:git)    echo "sudo pacman -S --needed git" ;;
    apt:git)       echo "sudo apt install git" ;;
    dnf:git)       echo "sudo dnf install git" ;;
    brew:git)      echo "brew install git" ;;
    *) echo "voir la documentation de ${t} pour ${DISTRO}" ;;
  esac
}

# get_uv : trouve uv ou télécharge le binaire statique officiel (aucun paquet python3-venv requis).
# Version épinglée et somme .sha256 publiée à côté de l'archive, vérifiée avant extraction.
get_uv() {
  if need uv; then echo uv; return 0; fi
  local arch os uv_asset base sumfile want
  case "$(uname -m)" in x86_64) arch=x86_64 ;; aarch64|arm64) arch=aarch64 ;; *) return 1 ;; esac
  case "$(uname -s)" in
    Linux)  os="unknown-linux-musl" ;;
    Darwin) os="apple-darwin" ;;
    *) return 1 ;;
  esac
  uv_asset="uv-$arch-$os.tar.gz"
  base="https://github.com/astral-sh/uv/releases/download/$OC_UV_VERSION"
  sumfile="$TMP/uv.sha256"
  if ! curl -fsSL --retry 2 --connect-timeout 15 "$base/$uv_asset.sha256" -o "$sumfile"; then
    warn "uv $OC_UV_VERSION : fichier .sha256 introuvable ($base/$uv_asset.sha256) — installation annulée."
    return 1
  fi
  want="$(awk '{print $1; exit}' "$sumfile")"
  if ! [[ "$want" =~ ^[0-9a-f]{64}$ ]]; then
    warn "uv : somme sha256 illisible dans $uv_asset.sha256 — installation annulée."
    return 1
  fi
  mkdir -p "$TMP/uvbin"
  fetch_verified "$base/$uv_asset" "$TMP/uv.tgz" "$want" "uv $OC_UV_VERSION" || return 1
  if ! tar -xzf "$TMP/uv.tgz" -C "$TMP/uvbin" --strip-components=1; then
    warn "uv : extraction de l'archive impossible."; return 1
  fi
  if [ ! -x "$TMP/uvbin/uv" ]; then
    warn "uv : binaire \"uv\" absent de l'archive extraite."; return 1
  fi
  echo "$TMP/uvbin/uv"
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
  # Version épinglée : pas de « -U » implicite, une réinstallation ne fait pas dériver la version.
  "$MEMVENV/bin/python" -m pip install -q "mempalace==$OC_MEMPALACE_VERSION" || return 1

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
# Mémorisation : seulement pour une installation d'outils (TOOLS=1) ou un --pentest explicite.
# --no-tools ne doit rien télécharger, même si le choix --pentest a été mémorisé.
if [ "$PENTEST" = 0 ] && [ "$NOPENTEST" = 0 ] && [ -f "$PENTEST_MARKER" ]; then
  if [ "$TOOLS" = 1 ] || [ "$PENTEST_EXPLICIT" = 1 ]; then PENTEST=1; fi
fi
if [ "$LITE" = 1 ] && [ "$PENTEST" = 1 ]; then warn "Le profil léger n'installe pas les outils pentest : ignoré."; PENTEST=0; fi

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

# latest_git_tag <owner/repo> : dernier tag (triés par version, sans toucher à l'API GitHub : juste git ls-remote)
latest_git_tag() {
  git ls-remote --tags --refs --sort=-v:refname "https://github.com/$1.git" 2>/dev/null | head -n1 | sed 's#.*refs/tags/##'
}

# tag_commit_sha <owner/repo> <tag> : sha du COMMIT pointé par ce tag, qu'il soit annoté ou léger.
# Un tag annoté a deux lignes dans `git ls-remote --tags` : refs/tags/<tag> (sha de l'OBJET tag, pas du commit)
# et refs/tags/<tag>^{} (sha du commit, celui que `git clone`/`rev-parse HEAD` donnent réellement) : on préfère
# toujours la ligne déréférencée (^{}) quand elle existe, sinon le tag est léger et sa seule ligne EST le commit.
tag_commit_sha() {
  local out peeled
  out="$(git ls-remote --tags "https://github.com/$1.git" 2>/dev/null)" || return 1
  peeled="$(printf '%s\n' "$out" | awk -v t="refs/tags/$2^{}" '$2==t{print $1; exit}')"
  if [ -n "$peeled" ]; then echo "$peeled"; return 0; fi
  printf '%s\n' "$out" | awk -v t="refs/tags/$2" '$2==t{print $1; exit}'
}

# install_git_tool <commande> <owner/repo> <script d'entrée relatif> <dossier de destination>
# Pas de release binaire chez cet outil (testssl.sh, nikto...) : on clone le dernier tag, PUIS on vérifie que le
# commit obtenu est bien celui que GitHub annonce pour ce tag (évite un clone altéré en cours de route).
install_git_tool() {
  local name="$1" repo="$2" entry="$3" dest="$4" tag want got
  if need "$name"; then echo "✅ $name déjà installé ($(command -v "$name"))"; return 0; fi
  need git || { warn "$name : git requis pour l'installer. → $(pkg_hint git)"; return 1; }
  tag="$(latest_git_tag "$repo")"
  if [ -z "$tag" ]; then warn "$name : aucun tag trouvé sur https://github.com/$repo (réseau ?)"; return 1; fi
  want="$(tag_commit_sha "$repo" "$tag")"
  rm -rf "$dest"
  if ! git clone --quiet --depth 1 --branch "$tag" "https://github.com/$repo.git" "$dest" 2>/dev/null; then
    warn "$name : clone échoué (https://github.com/$repo, tag $tag)"; return 1
  fi
  got="$(git -C "$dest" rev-parse HEAD 2>/dev/null)"
  if [ -z "$want" ] || [ "$got" != "$want" ]; then
    warn "$name : commit cloné ($got) différent du tag annoncé par GitHub ($want) — installation annulée."
    rm -rf "$dest"; return 1
  fi
  chmod +x "$dest/$entry" 2>/dev/null || true
  printf '#!/usr/bin/env bash\nexec "%s/%s" "$@"\n' "$dest" "$entry" > "$BIN/$name"
  chmod +x "$BIN/$name"
  echo "✅ $name $tag installé dans $dest (commit vérifié contre le tag GitHub), lanceur $BIN/$name"
}

install_pentest_tools() {
  local os os_pd amd gl_arch UV gittools
  os="linux"; os_pd="linux"; [ "$(uname -s)" = Darwin ] && { os="darwin"; os_pd="macOS"; }
  case "$(uname -m)" in aarch64|arm64) amd=arm64 ;; *) amd=amd64 ;; esac
  gl_arch="x64"; [ "$amd" = arm64 ] && gl_arch="arm64"
  gittools="${XDG_DATA_HOME:-$HOME/.local/share}/oc-pentest"

  # --- Sur ton code (toujours permis, aucune cible réseau) ---
  # gitleaks (MIT) : secrets/clés oubliés dans le code ou l'historique git
  install_binary_release gitleaks "gitleaks/gitleaks" "gitleaks_{v}_${os}_${gl_arch}.tar.gz" gitleaks || true
  # semgrep (SAST, LGPL-2.1/MIT) : CLI via uv tool install (même uv que MemPalace), pas de sudo
  if need semgrep; then
    echo "✅ semgrep déjà installé ($(command -v semgrep))"
  elif UV="$(get_uv)" && "$UV" tool install "semgrep==$OC_SEMGREP_VERSION" --quiet; then
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

  # testssl.sh (GPLv2) et nikto (GPLv2) : pas de release binaire chez ces deux-là, clone du dernier tag
  # vérifié contre le commit annoncé par GitHub (voir install_git_tool). Nikto a besoin de Perl (presque
  # toujours présent) ; testssl.sh n'a besoin de rien d'autre que bash + openssl.
  install_git_tool testssl.sh "testssl/testssl.sh" testssl.sh "$gittools/testssl.sh" || true
  if [ "${OC_PENTEST_NO_PERL:-0}" != 1 ] && need perl; then
    install_git_tool nikto "sullo/nikto" program/nikto.pl "$gittools/nikto" || true
  else
    warn "perl absent : nikto non installé. → $(pkg_hint perl)"
  fi

  # nmap / sqlmap : paquets système courants, jamais installés avec sudo par ce script
  need nmap   || warn "nmap absent (ports ouverts, services exposés de ton app). → $(pkg_hint nmap)"
  need sqlmap || warn "sqlmap absent (test d'injection SQL ciblé sur ton app). → $(pkg_hint sqlmap)"

  : > "$PENTEST_MARKER"
  echo "✅ Outils pentest/appsec pour sécuriser tes apps (téléchargement vérifié) : gitleaks, semgrep, nuclei, httpx, ffuf, osv-scanner, testssl.sh, nikto ; nmap/sqlmap via le gestionnaire de paquets si absents."
}

remove_pentest_tools() {
  rm -f "$PENTEST_MARKER"
}

# --- Trivy : binaire de release épinglé + checksums.txt, jamais le script contrib/install.sh de « main ». ---
install_trivy() {
  local plat trivy_asset base sums want
  if need trivy; then echo "✅ trivy déjà installé ($(command -v trivy))"; return 0; fi
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)              plat="Linux-64bit" ;;
    Linux-aarch64|Linux-arm64) plat="Linux-ARM64" ;;
    Darwin-x86_64)             plat="macOS-64bit" ;;
    Darwin-arm64)              plat="macOS-ARM64" ;;
    *) warn "trivy : plateforme non supportée ($(uname -s)-$(uname -m)) — installation annulée."; return 1 ;;
  esac
  trivy_asset="trivy_${OC_TRIVY_VERSION}_${plat}.tar.gz"
  base="https://github.com/aquasecurity/trivy/releases/download/v${OC_TRIVY_VERSION}"
  sums="$TMP/trivy-checksums.txt"
  if ! curl -fsSL --retry 2 --connect-timeout 15 "$base/trivy_${OC_TRIVY_VERSION}_checksums.txt" -o "$sums"; then
    warn "trivy $OC_TRIVY_VERSION : checksums.txt introuvable ($base/trivy_${OC_TRIVY_VERSION}_checksums.txt) — installation annulée."
    return 1
  fi
  want="$(awk -v a="$trivy_asset" '$2==a{print $1; exit}' "$sums")"
  if ! [[ "$want" =~ ^[0-9a-f]{64}$ ]]; then
    warn "trivy : asset \"$trivy_asset\" absent des sommes de la version v$OC_TRIVY_VERSION — installation annulée (version ou plateforme non publiée ?)."
    return 1
  fi
  fetch_verified "$base/$trivy_asset" "$TMP/trivy.tgz" "$want" "trivy $OC_TRIVY_VERSION" || return 1
  mkdir -p "$TMP/trivy-extract"
  if ! tar -xzf "$TMP/trivy.tgz" -C "$TMP/trivy-extract" trivy 2>/dev/null; then
    warn "trivy : archive illisible ou binaire \"trivy\" absent."; return 1
  fi
  if [ ! -f "$TMP/trivy-extract/trivy" ]; then
    warn "trivy : binaire \"trivy\" absent de l'archive extraite."; return 1
  fi
  install -m 0755 "$TMP/trivy-extract/trivy" "$BIN/trivy"
  echo "✅ trivy $OC_TRIVY_VERSION installé dans $BIN (sha256 vérifié sur checksums.txt)"
}

# --- Obscura : version épinglée ; sha256 pris dans l'API GitHub (digest de l'asset) ou dans un
# fichier de sommes publié. Aucun asset « latest », aucune installation sans somme. ---
install_obscura() {
  local plat rel obscura_asset obscura_asset_nr meta url sha sums_url sums want f src
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)              plat="x86_64-linux" ;;
    Linux-aarch64|Linux-arm64) plat="aarch64-linux" ;;
    Darwin-arm64)              plat="aarch64-macos" ;;
    Darwin-x86_64)             plat="x86_64-macos" ;;
    *) warn "obscura : plateforme non supportée ($(uname -s)-$(uname -m)) (sous Windows, utilise WSL)."; return 1 ;;
  esac
  rel="$TMP/obscura-release.json"
  if ! curl -fsSL --retry 2 --connect-timeout 15 "https://api.github.com/repos/h4ckf0r0day/obscura/releases/tags/v${OC_OBSCURA_VERSION}" -o "$rel"; then
    warn "obscura $OC_OBSCURA_VERSION : release introuvable — installation annulée."
    return 1
  fi
  obscura_asset="obscura-$plat.tar.gz"
  obscura_asset_nr="obscura-$plat-no-render.tar.gz"
  # shellcheck disable=SC2016  # script JS entre apostrophes : aucune expansion shell voulue
  mapfile -t meta < <(node -e '
const fs = require("fs");
const [file, ...names] = process.argv.slice(1);
const assets = JSON.parse(fs.readFileSync(file, "utf8")).assets || [];
let found;
for (const n of names) { found = assets.find((a) => a.name === n); if (found) break; }
if (!found) {
  console.error(`assets absents (${names.join(" ou ")}) ; disponibles : ${assets.map((a) => a.name).join(", ")}`);
  process.exit(1);
}
const sums = assets.find((a) => /checksums|sha256sums/i.test(a.name) && !/\.sig(st|store)?/i.test(a.name));
console.log(found.browser_download_url);
console.log(String(found.digest || "").replace(/^sha256:/, ""));
console.log(sums ? sums.browser_download_url : "");
' "$rel" "$obscura_asset" "$obscura_asset_nr")
  url="${meta[0]:-}"; sha="${meta[1]:-}"; sums_url="${meta[2]:-}"
  if [ -z "$url" ]; then
    warn "obscura : asset \"$obscura_asset\" ou \"$obscura_asset_nr\" absent de la release v$OC_OBSCURA_VERSION — installation annulée."
    return 1
  fi
  if [ -z "$sha" ] && [ -n "$sums_url" ]; then
    sums="$TMP/obscura-checksums.txt"
    if ! curl -fsSL --retry 2 --connect-timeout 15 "$sums_url" -o "$sums"; then
      warn "obscura : fichier de sommes introuvable ($sums_url) — installation annulée."
      return 1
    fi
    want="$(awk -v a="$(basename "$url")" '$2==a{print $1; exit}' "$sums")"
    sha="$want"
  fi
  if ! [[ "$sha" =~ ^[0-9a-f]{64}$ ]]; then
    warn "obscura : aucun sha256 publié pour \"$(basename "$url")\" — installation annulée."
    return 1
  fi
  fetch_verified "$url" "$TMP/obscura.tgz" "$sha" "obscura $OC_OBSCURA_VERSION" || return 1
  mkdir -p "$TMP/obscura-extract"
  if ! tar -xzf "$TMP/obscura.tgz" -C "$TMP/obscura-extract"; then
    warn "obscura : archive illisible."; return 1
  fi
  for f in obscura obscura-worker; do
    src="$(find "$TMP/obscura-extract" -type f -name "$f" | head -n 1)"
    if [ -z "$src" ]; then
      if [ "$f" = obscura ]; then warn "obscura : binaire \"obscura\" absent de l'archive."; return 1; fi
      continue
    fi
    if ! install -m 0755 "$src" "$BIN/.$f.new" || ! mv -f "$BIN/.$f.new" "$BIN/$f"; then
      warn "obscura : installation de $f impossible."; return 1
    fi
  done
  if "$BIN/obscura" --help >/dev/null 2>&1; then
    echo "✅ obscura $OC_OBSCURA_VERSION installé dans $BIN (sha256 vérifié)"
  else
    warn "obscura ne répond pas à --help : vérifie-le à la main (MCP obscura à désactiver sinon)."
  fi
}

# Mode bibliothèque pour scripts/test-supply-chain.mjs : charge les fonctions (fetch_verified,
# get_uv, install_trivy, install_obscura) sans rien copier ni installer.
if [ "${OC_INSTALL_LIB:-0}" = 1 ]; then
  [ "${BASH_SOURCE[0]}" != "$0" ] && return 0
  exit 0
fi

need node || die "Node.js est requis (validation, profil léger, MCP). → $(pkg_hint node)"
need opencode || warn "opencode introuvable. Installe-le : curl -fsSL https://opencode.ai/install | bash"

# 1. Validation du kit avant toute copie
node "$HERE/scripts/validate-kit.mjs" || die "Le kit est invalide : rien n'a été installé."

# 2. Sauvegarde + copie
mkdir -p "$DEST"
if [ -n "$(ls -A "$DEST" 2>/dev/null)" ]; then
  BAK="$(unique_path "$DEST.bak-$STAMP")"
  cp -a "$DEST" "$BAK"
  echo "💾 Sauvegarde : $BAK"
fi
cp -a "$SRC/." "$DEST/"
mkdir -p "$BIN"
# Retire les fichiers que le kit installait avant et qui n'existent plus (ex. plugins/auto-compact.js),
# sans toucher à tes propres fichiers : on se base sur la liste des fichiers déjà installés par le kit.
# La liste « legacy » n'est appliquée qu'à partir de la 2e installation (manifeste du kit présent) :
# au premier passage, un plugins/guard.js personnel ne doit jamais être supprimé.
MANIFEST="$DEST/.opencode-prerequisites.manifest"
( cd "$SRC" && find . -type f ! -path './bin/*' | sed 's|^\./||' | sort ) > "$TMP/new.manifest"
: > "$TMP/old.manifest"
if [ -f "$MANIFEST" ]; then
  { cat "$MANIFEST"; printf "%s\n" "plugins/auto-compact.js" "plugins/guard.js" "plugins/notify.js"; } | sort -u > "$TMP/old.manifest"
fi
comm -23 "$TMP/old.manifest" "$TMP/new.manifest" | while IFS= read -r f; do
  case "$f" in ""|*..*|/*) continue ;; esac
  if [ -e "$DEST/$f" ]; then rm -f "$DEST/$f" && echo "🧹 Retiré (n'existe plus dans le kit) : $f"; fi
done
cp "$TMP/new.manifest" "$MANIFEST"

for f in "$SRC"/bin/*; do install -m 0755 "$f" "$BIN/$(basename "$f")"; done
install -m 0755 "$HERE/scripts/new-rust-project.sh" "$BIN/oc-new-rust"
mkdir -p "$DEST/templates"
cp -a "$HERE/templates/." "$DEST/templates/"
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
elif [ "$NOPENTEST" = 1 ]; then
  remove_pentest_tools   # retire seulement le repère : les binaires déjà posés ne sont pas supprimés
fi

# 3a. Tes choix de modèles (oc-models set ...) survivent aux mises à jour : on les réapplique après la copie
if [ -f "$DEST/oc-models.json" ]; then
  OPENCODE_CONFIG_DIR="$DEST" node "$DEST/libexec/oc-models.mjs" apply && echo "✅ Modèles personnalisés réappliqués ($DEST/oc-models.json)"
fi

# 3b. État des MCP conditionnels : helper Node (portable macOS/Linux, pas de sed -i), idempotent,
#     conserve les commentaires et vérifie que le fichier reste du JSONC valide.
MCP_STATE="$HERE/scripts/lib/mcp-state.mjs"
mcp_state() {  # disable|enable <serveur> [raison] — code 2 : serveur absent du fichier
  local action="$1" server="$2" why="${3:-}"
  case "$action" in
    disable) node "$MCP_STATE" disable "$DEST/opencode.jsonc" "$server" "$why" ;;
    enable)  node "$MCP_STATE" enable "$DEST/opencode.jsonc" "$server" ;;
    *) return 1 ;;
  esac
}

# 3b. Kubernetes : le serveur MCP quitte au démarrage s'il n'y a aucun contexte kubectl
if [ "$LITE" = 0 ] && [ -f "$DEST/opencode.jsonc" ]; then
  kc="${KUBECONFIG:-$HOME/.kube/config}"
  if grep -qs '^current-context: *[^ ]' "${kc%%:*}"; then
    if mcp_state enable kubernetes; then
      echo "✅ MCP kubernetes activé (contexte kubectl détecté)"
    fi
  elif mcp_state disable kubernetes "aucun contexte kubectl : retire cette ligne quand tu auras un cluster"; then
    echo "ℹ️  MCP kubernetes désactivé (aucun contexte kubectl dans ${kc%%:*}) : retire la ligne \"disabled\" de opencode.jsonc quand tu auras un cluster."
  else
    warn "MCP kubernetes : opencode.jsonc n'a pas pu être mis à jour (bloc introuvable ou JSONC invalide)."
  fi
fi

# 3c. REA (rétro-ingénierie) : le serveur exige Node >= 26.12.1 (ou 24.22.1 / 22.23.4) ; sinon on le désactive proprement
if [ "$LITE" = 0 ] && [ -f "$DEST/opencode.jsonc" ] && grep -q '"rea": {' "$DEST/opencode.jsonc"; then
  if rea_msg="$("$BIN/oc-rea-mcp" --check 2>&1)"; then
    if mcp_state enable rea; then
      echo "✅ MCP rea (REA 6.8.0) activé : Node ${OC_REA_NODE_VERSION:-$(node -p 'process.versions.node')} convient"
    fi
  else
    if mcp_state disable rea "Node trop ancien pour REA : retire cette ligne après avoir mis Node à jour"; then
      echo "ℹ️  MCP rea désactivé : $(printf '%s' "$rea_msg" | head -n 1)"
    fi
    echo "    Mets Node à jour (mise use -g node@26.12.1) puis relance ./install.sh --no-tools : l'agent reverse-engineer utilisera la CLI en attendant."
  fi
fi

# 3d. MCP mobile : actif seulement avec le module Android (et Podman) ; sinon désactivé proprement
if [ "$LITE" = 0 ] && [ -f "$DEST/opencode.jsonc" ] && grep -q '"mobile": {' "$DEST/opencode.jsonc"; then
  if [ "$ANDROID" = 1 ] && "$BIN/oc-mobile-mcp" --check >/dev/null 2>&1; then
    if mcp_state enable mobile; then
      echo "✅ MCP mobile (mobile-mcp 1.0.15) activé (adb de l'émulateur Podman)"
    fi
  else
    if mcp_state disable mobile "module Android non installé (./install.sh --android) ou Podman absent"; then :; fi
    if [ "$ANDROID" = 1 ]; then warn "MCP mobile désactivé : Podman introuvable. → $(pkg_hint podman)"; fi
  fi
fi

# 3e. MCP semgrep (SAST, agents pentest/security) : exige uv (uvx) ou pipx ; sinon désactivé proprement.
#     --check est une VRAIE poignée de main MCP (elle peut télécharger ~50 Mo au premier lancement) :
#     réservée à l'installation d'outils. Avec --no-tools, --check-quick constate seulement la présence
#     de uvx/pipx, sans lancer de processus ni toucher au réseau.
if [ "$LITE" = 0 ] && [ -f "$DEST/opencode.jsonc" ] && grep -q '"semgrep": {' "$DEST/opencode.jsonc"; then
  if [ "$TOOLS" = 1 ]; then semgrep_check=--check; else semgrep_check=--check-quick; fi
  if "$BIN/oc-semgrep-mcp" "$semgrep_check" >/dev/null 2>&1; then
    if mcp_state enable semgrep; then
      if [ "$TOOLS" = 1 ]; then
        echo "✅ MCP semgrep activé (serveur vérifié au démarrage)"
      else
        echo "✅ MCP semgrep activé (uvx/pipx détecté ; démarrage vérifié à la prochaine installation complète)"
      fi
    fi
  else
    if mcp_state disable semgrep "uv (uvx) et pipx absents : retire cette ligne après avoir installé un des deux"; then
      echo "ℹ️  MCP semgrep désactivé : installe uv (curl -LsSf https://astral.sh/uv/install.sh | sh), déjà requis pour MemPalace."
    fi
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
    npx -y "playwright@$OC_PLAYWRIGHT_VERSION" install chromium || warn "Chromium non installé. Sur ${DISTRO} : $(pkg_hint chromium)"
    case "$PM" in
      apt) echo "   Si Chromium ne démarre pas (bibliothèques manquantes) : sudo npx playwright install-deps chromium" ;;
      pacman|dnf) echo "   Playwright ne supporte pas officiellement ${DISTRO} : le plus simple est le Chromium du système → $(pkg_hint chromium)" ;;
    esac
  fi

  echo "⬇️  Obscura $OC_OBSCURA_VERSION..."
  install_obscura || warn "Obscura non installé (téléchargement ou vérification impossible)."

  echo "⬇️  Trivy $OC_TRIVY_VERSION..."
  install_trivy || warn "Trivy non installé : https://trivy.dev/latest/getting-started/installation/"
  if PATH="$BIN:$PATH" command -v trivy >/dev/null 2>&1; then
    if ! PATH="$BIN:$PATH" trivy plugin install "github.com/aquasecurity/trivy-plugin-mcp@$OC_TRIVY_MCP_VERSION"; then
      warn "plugin Trivy MCP $OC_TRIVY_MCP_VERSION non installé : relance « trivy plugin install » à la main."
    fi
  else
    warn "plugin Trivy MCP non installé : trivy absent."
  fi

  echo "⬇️  MemPalace..."
  if ! { setup_mempalace && install_mempalace_plugin; }; then
    drop_mempalace_plugin
  fi
fi

# --no-tools : copie la config seulement, aucun téléchargement/installation (ni binaires pentest,
# ni plugin MemPalace). --memory-only reste le moyen explicite de (ré)installer MemPalace.

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
  npx -y "skills@$OC_SKILLS_VERSION" add mattpocock/skills -a opencode || warn "Échec : voir le README du dépôt mattpocock/skills."
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
