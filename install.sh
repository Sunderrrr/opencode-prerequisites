#!/usr/bin/env bash
# Installs the OpenCode kit into ~/.config/opencode (existing config is backed up automatically).
# Never touches API keys.
#
#   ./install.sh                full install (tools included)
#   ./install.sh --lite         lightweight profile: 12 agents, context7 + grep_app MCPs, no heavy tools
#   ./install.sh --no-tools     copy the config only (no tool download/installation)
#   ./install.sh --memory-only  only (re)try installing MemPalace, without copying anything
#   ./install.sh --force-config overwrite kit files you have modified (otherwise, starting with the
#                               first install that writes sha256 fingerprints, they are preserved
#                               and the kit version is written to <file>.new; an old manifest
#                               without fingerprints is reported before copying)
#   ./install.sh --shell-env    add PATH and MEMPALACE_ADAPTER_PYTHON to ~/.bashrc / ~/.zshrc (once)
#   ./install.sh --with-matt    + full Matt Pocock skills
#   ./install.sh --android      Android module (optional): android and mobile-tester agents, mobile MCP, Podman toolchain
#                               (image still to be built: oc-android build-image --accept-licenses). Remembered;
#   ./install.sh --no-android   remove the Android module
#   ./install.sh --pentest      real tools to secure YOUR apps (not just MCPs): nuclei and gitleaks
#                               (binaries downloaded and sha256-verified, like Trivy), semgrep (via uv tool
#                               install); nmap and sqlmap are reported (run the command yourself, never sudo
#                               from this script). Used by the @pentest agent. Remembered;
#   ./install.sh --no-pentest   forget this choice (does not uninstall binaries already installed)
#   (do not run this script with sudo: everything would go to /root instead of your home directory)
#   OPENCODE_CONFIG_DIR=...     alternate destination directory; OBSCURA_BIN_DIR=... binary directory
set -Eeuo pipefail
# The config may contain server names, paths and personal choices: nothing this script creates
# should be readable by other local accounts.
umask 077

# --- Pinned versions of downloaded tools: no "latest" or "main" URLs.
# Overridable (OC_*_VERSION) to track a specific release or for hermetic tests.
# Defaults verified on the authoring machine; uv = latest stable release at audit time.
OC_TRIVY_VERSION="${OC_TRIVY_VERSION:-0.76.1}"
OC_TRIVY_MCP_VERSION="${OC_TRIVY_MCP_VERSION:-v0.0.20}"
OC_OBSCURA_VERSION="${OC_OBSCURA_VERSION:-0.2.6}"
OC_UV_VERSION="${OC_UV_VERSION:-0.13.7}"
OC_MEMPALACE_VERSION="${OC_MEMPALACE_VERSION:-3.11.0}"
OC_SEMGREP_VERSION="${OC_SEMGREP_VERSION:-1.183.0}"
OC_PLAYWRIGHT_VERSION="${OC_PLAYWRIGHT_VERSION:-1.64.1}"
OC_SKILLS_VERSION="${OC_SKILLS_VERSION:-1.7.6}"

LITE=0; TOOLS=1; MATT=0; MEMONLY=0; ALLOWROOT=0; SHELLENV=0; ANDROID=0; NOANDROID=0; PENTEST=0; NOPENTEST=0; PENTEST_EXPLICIT=0; FORCE_CONFIG=0
for a in "$@"; do
  case "$a" in
    --lite) LITE=1; TOOLS=0 ;;
    --no-tools) TOOLS=0 ;;
    --memory-only) MEMONLY=1 ;;
    --force-config) FORCE_CONFIG=1 ;;
    --allow-root) ALLOWROOT=1 ;;
    --android) ANDROID=1 ;;
    --no-android) NOANDROID=1 ;;
    --pentest) PENTEST=1; PENTEST_EXPLICIT=1; NOPENTEST=0 ;;
    --no-pentest) NOPENTEST=1; PENTEST=0; PENTEST_EXPLICIT=0 ;;
    --shell-env) SHELLENV=1 ;;
    --with-matt) MATT=1 ;;
    -h|--help) awk 'NR > 1 && /^set -/ { exit } NR > 1 { print }' "$0"; exit 0 ;;
    *) echo "Unknown option: $a" >&2; exit 1 ;;
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

# An overridable version must never be able to inject a URL or an option.
for v in "$OC_TRIVY_VERSION" "$OC_TRIVY_MCP_VERSION" "$OC_OBSCURA_VERSION" "$OC_UV_VERSION" \
         "$OC_MEMPALACE_VERSION" "$OC_SEMGREP_VERSION" "$OC_PLAYWRIGHT_VERSION" "$OC_SKILLS_VERSION"; do
  if [[ ! "$v" =~ ^[0-9A-Za-z._-]+$ ]]; then die "Invalid version: $v"; fi
done

sha256_of() {
  if need sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif need shasum; then shasum -a 256 "$1" | awk '{print $1}'
  elif need node; then node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$1"
  else echo ""; fi
}

# fetch_verified <url> <destination> <expected sha256> <label>
# Download, then refuse to continue if the checksum is missing or different (fail closed).
fetch_verified() {
  local url="$1" dest="$2" want="$3" label="$4" got
  if ! curl -fsSL --retry 2 --connect-timeout 15 "$url" -o "$dest"; then
    warn "$label: download failed ($url)"; return 1
  fi
  got="$(sha256_of "$dest")"
  if [ -z "$got" ]; then
    warn "$label: neither sha256sum nor shasum available — checksum cannot be verified, installation cancelled."; return 1
  fi
  if [ "$got" != "$want" ]; then
    die "$label: invalid checksum (expected $want, got $got) — installation cancelled."
  fi
}

# unique_path <path>: the path if free, otherwise <path>-1, -2... (two installs in the same
# second must never copy over each other).
unique_path() {
  local base="$1" cand="$1" n=1
  while [ -e "$cand" ] || [ -L "$cand" ]; do cand="$base-$n"; n=$((n + 1)); done
  printf '%s\n' "$cand"
}

# --- Distribution (Omarchy/Arch, Debian/Ubuntu, Fedora/RHEL, macOS): used for install hints ---
DISTRO="unknown"; PM=""
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

# pkg_hint <tool>: install command for the current distribution
pkg_hint() {
  local t="$1"
  case "$PM:$t" in
    pacman:docker) echo "sudo pacman -S --needed docker && sudo systemctl enable --now docker && sudo usermod -aG docker \$USER   (or: sudo pacman -S podman)" ;;
    apt:docker)    echo "sudo apt install docker.io   (or: sudo apt install podman)" ;;
    dnf:docker)    echo "sudo dnf install podman   (or Docker CE: https://docs.docker.com/engine/install/)" ;;
    brew:docker)   echo "brew install --cask docker" ;;
    pacman:gh)     echo "sudo pacman -S --needed github-cli" ;;
    apt:gh)        echo "sudo apt install gh   (otherwise: https://github.com/cli/cli/blob/trunk/docs/install_linux.md)" ;;
    dnf:gh)        echo "sudo dnf install gh" ;;
    brew:gh)       echo "brew install gh" ;;
    pacman:node)   echo "sudo pacman -S --needed nodejs npm   (or: mise use -g node)" ;;
    apt:node)      echo "sudo apt install nodejs npm   (or: https://nodejs.org)" ;;
    dnf:node)      echo "sudo dnf install nodejs npm" ;;
    brew:node)     echo "brew install node" ;;
    apt:venv)      echo "sudo apt install python3-venv" ;;
    pacman:podman) echo "sudo pacman -S --needed podman   (rootless: /etc/subuid and /etc/subgid must have a range for your user)" ;;
    apt:podman)    echo "sudo apt install podman" ;;
    dnf:podman)    echo "sudo dnf install podman" ;;
    brew:podman)   echo "brew install podman" ;;
    pacman:android) echo "sudo pacman -S --needed android-tools jdk17-openjdk   + SDK: AUR package android-sdk-cmdline-tools-latest (yay -S ...) or Android Studio" ;;
    apt:android)    echo "sudo apt install adb openjdk-17-jdk   + SDK: command-line tools from https://developer.android.com/studio#command-tools (or Android Studio)" ;;
    dnf:android)    echo "sudo dnf install android-tools java-17-openjdk-devel   + SDK: command-line tools from https://developer.android.com/studio#command-tools (or Android Studio)" ;;
    brew:android)   echo "brew install --cask android-platform-tools android-commandlinetools && brew install openjdk@17" ;;
    pacman:chromium) echo "sudo pacman -S --needed chromium" ;;
    apt:chromium)    echo "sudo apt install chromium   (or let Playwright download its own)" ;;
    dnf:chromium)    echo "sudo dnf install chromium" ;;
    pacman:nmap)   echo "sudo pacman -S --needed nmap" ;;
    apt:nmap)      echo "sudo apt install nmap" ;;
    dnf:nmap)      echo "sudo dnf install nmap" ;;
    brew:nmap)     echo "brew install nmap" ;;
    pacman:sqlmap) echo "sudo pacman -S --needed sqlmap" ;;
    apt:sqlmap)    echo "sudo apt install sqlmap" ;;
    dnf:sqlmap)    echo "sudo dnf install sqlmap   (not in RHEL/Rocky repositories: pip install sqlmap --user, or clone https://github.com/sqlmapproject/sqlmap)" ;;
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
    *) echo "see the ${t} documentation for ${DISTRO}" ;;
  esac
}

# get_uv: find uv or download the official static binary (no python3-venv package required).
# Pinned version and .sha256 file published next to the archive, verified before extraction.
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
    warn "uv $OC_UV_VERSION: .sha256 file not found ($base/$uv_asset.sha256) — installation cancelled."
    return 1
  fi
  want="$(awk '{print $1; exit}' "$sumfile")"
  if ! [[ "$want" =~ ^[0-9a-f]{64}$ ]]; then
    warn "uv: unreadable sha256 in $uv_asset.sha256 — installation cancelled."
    return 1
  fi
  mkdir -p "$TMP/uvbin"
  fetch_verified "$base/$uv_asset" "$TMP/uv.tgz" "$want" "uv $OC_UV_VERSION" || return 1
  if ! tar -xzf "$TMP/uv.tgz" -C "$TMP/uvbin" --strip-components=1; then
    warn "uv: could not extract the archive."; return 1
  fi
  if [ ! -x "$TMP/uvbin/uv" ]; then
    warn "uv: binary \"uv\" missing from the extracted archive."; return 1
  fi
  echo "$TMP/uvbin/uv"
}

# Run via sudo: $HOME would be root's home (config, tools and MemPalace installed in the wrong place)
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$ALLOWROOT" != 1 ]; then
  die "Do not run this script with sudo (it would install everything into $HOME, not $SUDO_USER's home). Just run: ./install.sh"
fi


# MemPalace in a dedicated venv (avoids PEP 668 errors and Python versions too recent to have onnxruntime wheels)
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
      if "$py" -m venv "$MEMVENV" 2>/dev/null; then made=1; else rm -rf "$MEMVENV"; warn "venv failed with $py ($(pkg_hint venv)): falling back to uv."; fi
    else
      echo "   No Python 3.10–3.13 found ($(python3 --version 2>&1)): using uv to download Python 3.12."
    fi
    if [ "$made" = 0 ]; then
      local UV
      UV="$(get_uv)" || { warn "uv unavailable: install it (https://docs.astral.sh/uv/) then rerun ./install.sh --memory-only"; return 1; }
      # The uv-managed Python lives WITH the venv (~/.mempalace/python), not in uv's default directory:
      # a "uv python prune" can no longer break the venv.
      UV_PYTHON_INSTALL_DIR="$HOME/.mempalace/python" "$UV" venv --seed --managed-python --python 3.12 "$MEMVENV" || return 1
    fi
  fi
  # Pinned version: no implicit "-U", reinstalling does not drift to a newer version.
  "$MEMVENV/bin/python" -m pip install -q "mempalace==$OC_MEMPALACE_VERSION" || return 1

  # The palace creates itself on first save, where MemPalace looks for it (~/.config/mempalace/palace).
  # Older version of this script: "mempalace init" on ~/.mempalace/palace left an orphan mempalace.yaml there.
  local orphan="$HOME/.mempalace/palace"
  if [ -f "$orphan/mempalace.yaml" ] && [ "$(find "$orphan" -mindepth 1 | wc -l)" -eq 1 ]; then
    rm -rf "$orphan" && echo "🧹 Orphan file removed: $orphan (MemPalace uses ~/.config/mempalace)"
  fi

  # Fallback for the plugin: it can find the right Python from the "shebang" of the mempalace command on PATH
  mkdir -p "$BIN"
  if [ ! -e "$BIN/mempalace" ] || [ -L "$BIN/mempalace" ]; then ln -sf "$MEMVENV/bin/mempalace" "$BIN/mempalace"; fi
  echo "✅ MemPalace installed in $MEMVENV (the plugin sets MEMPALACE_ADAPTER_PYTHON itself; command: $BIN/mempalace)"
}

# MemPalace plugin: installed here with --legacy-peer-deps (the package declares peerDependencies
# that are incompatible with each other: the npm install done by OpenCode fails with ERESOLVE), then loaded
# as a local plugin (plugins/mempalace/ directory that re-exports the installed package).
MEMPLUGIN="$HOME/.mempalace/plugin"
install_mempalace_plugin() {
  need npm || { warn "npm not found: MemPalace plugin not installed. → $(pkg_hint node)"; return 1; }
  mkdir -p "$MEMPLUGIN"
  [ -f "$MEMPLUGIN/package.json" ] || echo '{"name":"mempalace-plugin-host","private":true}' > "$MEMPLUGIN/package.json"
  ( cd "$MEMPLUGIN" && npm install @rvboris/opencode-mempalace@2.0.1 --legacy-peer-deps --ignore-scripts --no-audit --no-fund --loglevel=error ) \
    || { warn "npm install of the MemPalace plugin failed"; return 1; }
  local entry="$MEMPLUGIN/node_modules/@rvboris/opencode-mempalace/dist/plugin/index.js"
  [ -f "$entry" ] || { warn "MemPalace plugin not found after installation: $entry"; return 1; }
  mkdir -p "$DEST/plugins/mempalace"
  # The plugin sets MEMPALACE_ADAPTER_PYTHON itself (template libexec/mempalace-plugin.ts.tpl): independent of the launching shell
  sed -e "s|__ROOT__|$MEMPLUGIN|g" -e "s|__PYTHON__|$MEMVENV/bin/python|g" -e "s|__ENTRY__|$entry|g" \
    "$HERE/config/libexec/mempalace-plugin.ts.tpl" > "$DEST/plugins/mempalace/index.ts"
  echo "✅ MemPalace plugin loaded as a local plugin (plugins/mempalace)"
}

drop_mempalace_plugin() {
  # MemPalace unavailable: remove the local plugin so OpenCode starts cleanly
  rm -rf "$DEST/plugins/mempalace"
  warn "MemPalace plugin not enabled (rerun ./install.sh --memory-only once the problem is fixed)."
}

if [ "$MEMONLY" = 1 ]; then
  echo "⬇️  MemPalace..."
  mkdir -p "$DEST"
  chmod 700 "$DEST"
  if ! { setup_mempalace && install_mempalace_plugin; }; then
    die "MemPalace could not be installed."
  fi
  # --memory-only copies no configuration: it must never write the .installed
  # marker (doctor would take it for a fresh install and wrongly report
  # an outdated OpenCode).
  exit 0
fi

# --- Android module (optional): agents, skill, MCP, Podman toolchain. Remembered by a marker in the config. ---
ANDROID_MARKER="$DEST/.opencode-prerequisites.android"
ANDROID_SHIM_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/oc-android/sdk"
if [ "$ANDROID" = 0 ] && [ "$NOANDROID" = 0 ] && [ -f "$ANDROID_MARKER" ]; then ANDROID=1; fi
if [ "$LITE" = 1 ] && [ "$ANDROID" = 1 ]; then warn "The lightweight profile does not include the Android module: ignored."; ANDROID=0; fi

# apply_block <file> <name> <source>: (re)append a tagged block at the end of a file, without duplicates
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
  need podman || warn "Podman not found: required for the Android module. → $(pkg_hint podman)"
  mkdir -p "$DEST/agents" "$DEST/skills" "$DEST/android" "$ANDROID_SHIM_ROOT/platform-tools"
  cp -a "$A/agents/." "$DEST/agents/"
  cp -a "$A/skills/." "$DEST/skills/"
  cp -a "$A/libexec/oc-android/." "$DEST/android/"
  for f in "$A"/bin/*; do install -m 0755 "$f" "$BIN/$(basename "$f")"; done
  install -m 0755 "$A/libexec/oc-android/adb-shim" "$ANDROID_SHIM_ROOT/platform-tools/adb"
  apply_block "$DEST/AGENTS.md" android "$A/AGENTS.android.md"
  apply_block "$DEST/agents/ceo.md" android "$A/ceo.android.md"
  : > "$ANDROID_MARKER"
  chmod 600 "$ANDROID_MARKER"
  echo "✅ Android module installed (android and mobile-tester agents, android-dev skill, oc-android, fake adb for mobile-mcp)"
}

remove_android_addon() {
  rm -f "$DEST/agents/android.md" "$DEST/agents/mobile-tester.md" "$BIN/oc-android" "$BIN/oc-mobile-mcp" "$ANDROID_MARKER"
  rm -rf "$DEST/skills/android-dev" "$DEST/android" "$ANDROID_SHIM_ROOT"
}

# --- Pentest/appsec tools (--pentest option): to secure YOUR OWN apps before exposing them.
# Binaries downloaded and sha256-verified (like Trivy); no sudo run by this script. ---
PENTEST_MARKER="$DEST/.opencode-prerequisites.pentest"
# Remembering: only for a tools install (TOOLS=1) or an explicit --pentest.
# --no-tools must download nothing, even if the --pentest choice was remembered.
if [ "$PENTEST" = 0 ] && [ "$NOPENTEST" = 0 ] && [ -f "$PENTEST_MARKER" ]; then
  if [ "$TOOLS" = 1 ] || [ "$PENTEST_EXPLICIT" = 1 ]; then PENTEST=1; fi
fi
if [ "$LITE" = 1 ] && [ "$PENTEST" = 1 ]; then warn "The lightweight profile does not install pentest tools: ignored."; PENTEST=0; fi

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

# install_binary_release <command> <owner/repo> <archive template> [binary name inside the archive]
# Without the 4th argument (or if empty): the downloaded asset IS the binary (no archive to extract), e.g. osv-scanner.
install_binary_release() {
  local name="$1" repo="$2" template="$3" inner="${4:-}" info archive got
  if need "$name"; then echo "✅ $name already installed ($(command -v "$name"))"; return 0; fi
  if ! info="$(node "$HERE/scripts/pentest-discover.mjs" "$repo" "$template" 2>&1)"; then
    warn "$name: could not discover the latest version — $(printf '%s' "$info" | tail -n 1)"; return 1
  fi
  eval "$info" # VERSION / URL / SHA256 / ASSET (fixed names, escaped by pentest-discover.mjs)
  archive="$TMP/$ASSET"
  if ! curl -fsSL "$URL" -o "$archive"; then warn "$name: download failed ($URL)"; return 1; fi
  got="$(sha256_of "$archive")"
  if [ -z "$got" ]; then warn "$name: neither sha256sum nor shasum available, checksum cannot be verified — installation cancelled."; return 1; fi
  if [ "$got" != "$SHA256" ]; then warn "$name: invalid checksum (expected $SHA256, got $got) — installation cancelled."; return 1; fi
  if [ -z "$inner" ]; then
    install -m 0755 "$archive" "$BIN/$name"
  else
    mkdir -p "$TMP/$name-extract"
    if ! extract_archive "$archive" "$TMP/$name-extract"; then warn "$name: extraction failed (unzip/bsdtar missing). → $(pkg_hint unzip)"; return 1; fi
    if [ ! -f "$TMP/$name-extract/$inner" ]; then warn "$name: binary \"$inner\" missing from the downloaded archive."; return 1; fi
    install -m 0755 "$TMP/$name-extract/$inner" "$BIN/$name"
  fi
  echo "✅ $name $VERSION installed in $BIN (sha256 verified against the GitHub release)"
}

# latest_git_tag <owner/repo>: latest tag (sorted by version, without touching the GitHub API: just git ls-remote)
latest_git_tag() {
  git ls-remote --tags --refs --sort=-v:refname "https://github.com/$1.git" 2>/dev/null | head -n1 | sed 's#.*refs/tags/##'
}

# tag_commit_sha <owner/repo> <tag>: sha of the COMMIT pointed to by this tag, whether annotated or lightweight.
# An annotated tag has two lines in `git ls-remote --tags`: refs/tags/<tag> (sha of the TAG OBJECT, not the commit)
# and refs/tags/<tag>^{} (sha of the commit, the one `git clone`/`rev-parse HEAD` actually returns): we always
# prefer the dereferenced line (^{}) when it exists, otherwise the tag is lightweight and its only line IS the commit.
tag_commit_sha() {
  local out peeled
  out="$(git ls-remote --tags "https://github.com/$1.git" 2>/dev/null)" || return 1
  peeled="$(printf '%s\n' "$out" | awk -v t="refs/tags/$2^{}" '$2==t{print $1; exit}')"
  if [ -n "$peeled" ]; then echo "$peeled"; return 0; fi
  printf '%s\n' "$out" | awk -v t="refs/tags/$2" '$2==t{print $1; exit}'
}

# install_git_tool <command> <owner/repo> <relative entry script> <destination directory>
# This tool has no binary release (testssl.sh, nikto...): clone the latest tag, THEN verify that the
# resulting commit is the one GitHub announces for that tag (avoids a clone altered in transit).
install_git_tool() {
  local name="$1" repo="$2" entry="$3" dest="$4" tag want got
  if need "$name"; then echo "✅ $name already installed ($(command -v "$name"))"; return 0; fi
  need git || { warn "$name: git required to install it. → $(pkg_hint git)"; return 1; }
  tag="$(latest_git_tag "$repo")"
  if [ -z "$tag" ]; then warn "$name: no tag found on https://github.com/$repo (network?)"; return 1; fi
  want="$(tag_commit_sha "$repo" "$tag")"
  rm -rf "$dest"
  if ! git clone --quiet --depth 1 --branch "$tag" "https://github.com/$repo.git" "$dest" 2>/dev/null; then
    warn "$name: clone failed (https://github.com/$repo, tag $tag)"; return 1
  fi
  got="$(git -C "$dest" rev-parse HEAD 2>/dev/null)"
  if [ -z "$want" ] || [ "$got" != "$want" ]; then
    warn "$name: cloned commit ($got) differs from the tag announced by GitHub ($want) — installation cancelled."
    rm -rf "$dest"; return 1
  fi
  chmod +x "$dest/$entry" 2>/dev/null || true
  printf '#!/usr/bin/env bash\nexec "%s/%s" "$@"\n' "$dest" "$entry" > "$BIN/$name"
  chmod +x "$BIN/$name"
  echo "✅ $name $tag installed in $dest (commit verified against the GitHub tag), launcher $BIN/$name"
}

install_pentest_tools() {
  local os os_pd amd gl_arch UV gittools
  os="linux"; os_pd="linux"; [ "$(uname -s)" = Darwin ] && { os="darwin"; os_pd="macOS"; }
  case "$(uname -m)" in aarch64|arm64) amd=arm64 ;; *) amd=amd64 ;; esac
  gl_arch="x64"; [ "$amd" = arm64 ] && gl_arch="arm64"
  gittools="${XDG_DATA_HOME:-$HOME/.local/share}/oc-pentest"

  # --- On your code (always allowed, no network target) ---
  # gitleaks (MIT): secrets/keys forgotten in code or git history
  install_binary_release gitleaks "gitleaks/gitleaks" "gitleaks_{v}_${os}_${gl_arch}.tar.gz" gitleaks || true
  # semgrep (SAST, LGPL-2.1/MIT): CLI via uv tool install (same uv as MemPalace), no sudo
  if need semgrep; then
    echo "✅ semgrep already installed ($(command -v semgrep))"
  elif UV="$(get_uv)" && "$UV" tool install "semgrep==$OC_SEMGREP_VERSION" --quiet; then
    echo "✅ semgrep installed via uv (SAST, in $BIN)"
  else
    warn "semgrep installation failed: install uv (https://docs.astral.sh/uv/) then rerun ./install.sh --pentest"
  fi

  # --- On a target you control (app in local/staging, CTF, written scope) ---
  # nuclei/httpx use "macOS" (capitalized) for Darwin, not "darwin": beware if you reuse this template.
  install_binary_release nuclei "projectdiscovery/nuclei" "nuclei_{v}_${os_pd}_${amd}.zip" nuclei || true
  install_binary_release httpx  "projectdiscovery/httpx"  "httpx_{v}_${os_pd}_${amd}.zip"  httpx  || true
  install_binary_release ffuf   "ffuf/ffuf"                "ffuf_{v}_${os_pd}_${amd}.tar.gz" ffuf  || true
  # osv-scanner (Google, Apache-2.0): known vulnerabilities in dependencies (OSV database, complements Trivy).
  # Unversioned and uncompressed asset: the downloaded binary IS osv-scanner (no 4th argument).
  install_binary_release osv-scanner "google/osv-scanner" "osv-scanner_${os}_${amd}" || true

  # testssl.sh (GPLv2) and nikto (GPLv2): no binary release for these two, clone the latest tag
  # verified against the commit announced by GitHub (see install_git_tool). Nikto needs Perl (almost
  # always present); testssl.sh needs nothing but bash + openssl.
  install_git_tool testssl.sh "testssl/testssl.sh" testssl.sh "$gittools/testssl.sh" || true
  if [ "${OC_PENTEST_NO_PERL:-0}" != 1 ] && need perl; then
    install_git_tool nikto "sullo/nikto" program/nikto.pl "$gittools/nikto" || true
  else
    warn "perl missing: nikto not installed. → $(pkg_hint perl)"
  fi

  # nmap / sqlmap: common system packages, never installed with sudo by this script
  need nmap   || warn "nmap missing (open ports, exposed services in your app). → $(pkg_hint nmap)"
  need sqlmap || warn "sqlmap missing (targeted SQL injection test on your app). → $(pkg_hint sqlmap)"

  : > "$PENTEST_MARKER"
  chmod 600 "$PENTEST_MARKER"
  echo "✅ Pentest/appsec tools to secure your apps (verified downloads): gitleaks, semgrep, nuclei, httpx, ffuf, osv-scanner, testssl.sh, nikto; nmap/sqlmap via the package manager if missing."
}

remove_pentest_tools() {
  rm -f "$PENTEST_MARKER"
}

# --- Trivy: pinned release binary + checksums.txt, never the contrib/install.sh script from "main". ---
install_trivy() {
  local platform trivy_asset base sums want
  if need trivy; then echo "✅ trivy already installed ($(command -v trivy))"; return 0; fi
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)              platform="Linux-64bit" ;;
    Linux-aarch64|Linux-arm64) platform="Linux-ARM64" ;;
    Darwin-x86_64)             platform="macOS-64bit" ;;
    Darwin-arm64)              platform="macOS-ARM64" ;;
    *) warn "trivy: unsupported platform ($(uname -s)-$(uname -m)) — installation cancelled."; return 1 ;;
  esac
  trivy_asset="trivy_${OC_TRIVY_VERSION}_${platform}.tar.gz"
  base="https://github.com/aquasecurity/trivy/releases/download/v${OC_TRIVY_VERSION}"
  sums="$TMP/trivy-checksums.txt"
  if ! curl -fsSL --retry 2 --connect-timeout 15 "$base/trivy_${OC_TRIVY_VERSION}_checksums.txt" -o "$sums"; then
    warn "trivy $OC_TRIVY_VERSION: checksums.txt not found ($base/trivy_${OC_TRIVY_VERSION}_checksums.txt) — installation cancelled."
    return 1
  fi
  want="$(awk -v a="$trivy_asset" '$2==a{print $1; exit}' "$sums")"
  if ! [[ "$want" =~ ^[0-9a-f]{64}$ ]]; then
    warn "trivy: asset \"$trivy_asset\" missing from the checksums for version v$OC_TRIVY_VERSION — installation cancelled (version or platform not published?)."
    return 1
  fi
  fetch_verified "$base/$trivy_asset" "$TMP/trivy.tgz" "$want" "trivy $OC_TRIVY_VERSION" || return 1
  mkdir -p "$TMP/trivy-extract"
  if ! tar -xzf "$TMP/trivy.tgz" -C "$TMP/trivy-extract" trivy 2>/dev/null; then
    warn "trivy: unreadable archive or binary \"trivy\" missing."; return 1
  fi
  if [ ! -f "$TMP/trivy-extract/trivy" ]; then
    warn "trivy: binary \"trivy\" missing from the extracted archive."; return 1
  fi
  install -m 0755 "$TMP/trivy-extract/trivy" "$BIN/trivy"
  echo "✅ trivy $OC_TRIVY_VERSION installed in $BIN (sha256 verified against checksums.txt)"
}

# --- Obscura: pinned version; sha256 taken from the GitHub API (asset digest) or from a published
# checksums file. No "latest" asset, no installation without a checksum. ---
install_obscura() {
  local platform rel obscura_asset obscura_asset_nr meta url sha sums_url sums want f src
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)              platform="x86_64-linux" ;;
    Linux-aarch64|Linux-arm64) platform="aarch64-linux" ;;
    Darwin-arm64)              platform="aarch64-macos" ;;
    Darwin-x86_64)             platform="x86_64-macos" ;;
    *) warn "obscura: unsupported platform ($(uname -s)-$(uname -m)) (on Windows, use WSL)."; return 1 ;;
  esac
  rel="$TMP/obscura-release.json"
  if ! curl -fsSL --retry 2 --connect-timeout 15 "https://api.github.com/repos/h4ckf0r0day/obscura/releases/tags/v${OC_OBSCURA_VERSION}" -o "$rel"; then
    warn "obscura $OC_OBSCURA_VERSION: release not found — installation cancelled."
    return 1
  fi
  obscura_asset="obscura-$platform.tar.gz"
  obscura_asset_nr="obscura-$platform-no-render.tar.gz"
  # shellcheck disable=SC2016  # JS script in single quotes: no shell expansion intended
  mapfile -t meta < <(node -e '
const fs = require("fs");
const [file, ...names] = process.argv.slice(1);
const assets = JSON.parse(fs.readFileSync(file, "utf8")).assets || [];
let found;
for (const n of names) { found = assets.find((a) => a.name === n); if (found) break; }
if (!found) {
  console.error(`assets missing (${names.join(" or ")}); available: ${assets.map((a) => a.name).join(", ")}`);
  process.exit(1);
}
const sums = assets.find((a) => /checksums|sha256sums/i.test(a.name) && !/\.sig(st|store)?/i.test(a.name));
console.log(found.browser_download_url);
console.log(String(found.digest || "").replace(/^sha256:/, ""));
console.log(sums ? sums.browser_download_url : "");
' "$rel" "$obscura_asset" "$obscura_asset_nr")
  url="${meta[0]:-}"; sha="${meta[1]:-}"; sums_url="${meta[2]:-}"
  if [ -z "$url" ]; then
    warn "obscura: asset \"$obscura_asset\" or \"$obscura_asset_nr\" missing from release v$OC_OBSCURA_VERSION — installation cancelled."
    return 1
  fi
  if [ -z "$sha" ] && [ -n "$sums_url" ]; then
    sums="$TMP/obscura-checksums.txt"
    if ! curl -fsSL --retry 2 --connect-timeout 15 "$sums_url" -o "$sums"; then
      warn "obscura: checksums file not found ($sums_url) — installation cancelled."
      return 1
    fi
    want="$(awk -v a="$(basename "$url")" '$2==a{print $1; exit}' "$sums")"
    sha="$want"
  fi
  if ! [[ "$sha" =~ ^[0-9a-f]{64}$ ]]; then
    warn "obscura: no sha256 published for \"$(basename "$url")\" — installation cancelled."
    return 1
  fi
  fetch_verified "$url" "$TMP/obscura.tgz" "$sha" "obscura $OC_OBSCURA_VERSION" || return 1
  mkdir -p "$TMP/obscura-extract"
  if ! tar -xzf "$TMP/obscura.tgz" -C "$TMP/obscura-extract"; then
    warn "obscura: unreadable archive."; return 1
  fi
  for f in obscura obscura-worker; do
    src="$(find "$TMP/obscura-extract" -type f -name "$f" | head -n 1)"
    if [ -z "$src" ]; then
      if [ "$f" = obscura ]; then warn "obscura: binary \"obscura\" missing from the archive."; return 1; fi
      continue
    fi
    if ! install -m 0755 "$src" "$BIN/.$f.new" || ! mv -f "$BIN/.$f.new" "$BIN/$f"; then
      warn "obscura: could not install $f."; return 1
    fi
  done
  if "$BIN/obscura" --help >/dev/null 2>&1; then
    echo "✅ obscura $OC_OBSCURA_VERSION installed in $BIN (sha256 verified)"
  else
    warn "obscura does not answer --help: check it manually (disable the obscura MCP otherwise)."
  fi
}

# Library mode for scripts/test-supply-chain.mjs: loads the functions (fetch_verified,
# get_uv, install_trivy, install_obscura) without copying or installing anything.
if [ "${OC_INSTALL_LIB:-0}" = 1 ]; then
  [ "${BASH_SOURCE[0]}" != "$0" ] && return 0
  exit 0
fi

need node || die "Node.js is required (validation, lightweight profile, MCPs). → $(pkg_hint node)"
need opencode || warn "opencode not found. Install it: curl -fsSL https://opencode.ai/install | bash"

# 1. Validate the kit before copying anything
node "$HERE/scripts/validate-kit.mjs" || die "The kit is invalid: nothing was installed."

# 2. Backup + transactional configuration phase --------------------------------
# Everything that touches the configuration (copy, lightweight profile, Android module, models, MCPs)
# runs in a single phase: on the first failure, the previous state is restored and the
# .installed marker is not written. Network tools (section 5) remain best-effort.

MANIFEST="$DEST/.opencode-prerequisites.manifest"
MCP_STATE="$HERE/scripts/lib/mcp-state.mjs"

# secure_tree <directory>: directories 700, files 600, executables 700. Removes all group/other
# permissions without losing the owner's executable bit.
secure_tree() {
  local d="$1"
  [ -d "$d" ] || return 0
  chmod -R go-rwx "$d" 2>/dev/null || true
}

# manifest_hash <manifest> <path>: sha256 hash recorded for this file, empty if
# missing or if the manifest uses the legacy format (list of paths without hashes).
manifest_hash() {
  local man="$1" want="$2" line h p
  [ -f "$man" ] || return 0
  while IFS= read -r line; do
    case "$line" in
      *$'\t'*)
        h="${line%%$'\t'*}"; p="${line#*$'\t'}"
        if [ "$p" = "$want" ] && [[ "$h" =~ ^[0-9a-f]{64}$ ]]; then printf '%s\n' "$h"; return 0; fi
        ;;
    esac
  done < "$man"
}

# manifest_paths <manifest>: paths, whatever the format (hash<TAB>path or path alone).
manifest_paths() {
  local man="$1" line p
  [ -f "$man" ] || return 0
  while IFS= read -r line; do
    case "$line" in
      *$'\t'*) p="${line#*$'\t'}"; [ -n "$p" ] && printf '%s\n' "$p" ;;
      "") ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$man"
}

# manifest_has_hashes <manifest>: true if at least one sha256 fingerprint is present.
# A legacy manifest (bare paths) cannot detect customizations.
manifest_has_hashes() {
  [ -f "$1" ] && grep -Eq $'^[0-9a-f]{64}\t' "$1"
}

# is_modified <relative path>: does the installed file differ from the manifest hash?
is_modified() {
  local rel="$1" old cur
  old="$(manifest_hash "$MANIFEST" "$rel")"
  [ -n "$old" ] || return 1          # no known hash (first run/legacy manifest)
  [ -f "$DEST/$rel" ] || return 1    # missing: nothing to preserve
  cur="$(sha256_of "$DEST/$rel")"
  [ -n "$cur" ] && [ "$cur" != "$old" ]
}

DEST_EXISTED=0; [ -d "$DEST" ] && DEST_EXISTED=1
BIN_EXISTED=0; [ -d "$BIN" ] && BIN_EXISTED=1
mkdir -p "$DEST"
chmod 700 "$DEST"
mkdir -p "$BIN"

BAK=""
if [ -n "$(ls -A "$DEST" 2>/dev/null)" ]; then
  BAK="$(unique_path "$DEST.bak-$STAMP")"
  cp -a "$DEST" "$BAK"
  secure_tree "$BAK"
  echo "💾 Backup: $BAK"
fi

# Without reliable fingerprints, a kit file cannot be distinguished from a customization:
# warn BEFORE copying instead of implying a preservation that will not happen.
# The full backup always contains the user's version.
MANIFEST_EXISTED=0
if [ -f "$MANIFEST" ]; then MANIFEST_EXISTED=1; fi
if [ -n "$BAK" ]; then
  if [ "$MANIFEST_EXISTED" = 1 ] && ! manifest_has_hashes "$MANIFEST"; then
    warn "Legacy manifest without fingerprints: cannot detect your modifications; full backup in $BAK. Check opencode.jsonc and AGENTS.md, or use --force-config."
  elif [ "$MANIFEST_EXISTED" = 0 ]; then
    warn "Existing OpenCode configuration without a manifest: cannot detect your modifications; full backup in $BAK. Check opencode.jsonc and AGENTS.md, or use --force-config."
  fi
fi

# Back up the launchers this install may replace or remove (rollback).
mkdir -p "$TMP/bin.saved"
{
  for f in "$SRC"/bin/*; do [ -e "$f" ] && basename "$f"; done
  printf '%s\n' "oc-new-rust"
  for f in "$HERE"/addons/android/bin/*; do [ -e "$f" ] && basename "$f"; done
} | sort -u > "$TMP/bin.names"
: > "$TMP/bin.state"
while IFS= read -r name; do
  case "$name" in ""|*/*|..|.) continue ;; esac
  if [ -e "$BIN/$name" ] || [ -L "$BIN/$name" ]; then
    cp -a "$BIN/$name" "$TMP/bin.saved/$name"
    printf '%s\t%s\n' "$name" present >> "$TMP/bin.state"
  else
    printf '%s\t%s\n' "$name" absent >> "$TMP/bin.state"
  fi
done < "$TMP/bin.names"

# Fake adb from the Android module (outside $DEST): backed up for an exact rollback.
ANDROID_ADB="$ANDROID_SHIM_ROOT/platform-tools/adb"
ANDROID_ADB_EXISTED=0
if [ -e "$ANDROID_ADB" ] || [ -L "$ANDROID_ADB" ]; then
  ANDROID_ADB_EXISTED=1
  cp -a "$ANDROID_ADB" "$TMP/adb.saved"
fi

restore_bin_state() {
  local name state
  [ -f "$TMP/bin.state" ] || return 0
  while IFS=$'\t' read -r name state; do
    case "$state" in
      present) cp -a "$TMP/bin.saved/$name" "$BIN/$name" 2>/dev/null || warn "Rollback: $BIN/$name could not be restored." ;;
      absent) rm -f "$BIN/$name" ;;
    esac
  done < "$TMP/bin.state"
  if [ "$BIN_EXISTED" = 0 ] && [ -d "$BIN" ] && [ -z "$(ls -A "$BIN" 2>/dev/null)" ]; then rmdir "$BIN" 2>/dev/null || true; fi
}

restore_android_adb() {
  if [ "$ANDROID_ADB_EXISTED" = 1 ]; then
    mkdir -p "$ANDROID_SHIM_ROOT/platform-tools"
    cp -a "$TMP/adb.saved" "$ANDROID_ADB" 2>/dev/null || warn "Rollback: $ANDROID_ADB could not be restored."
  else
    rm -f "$ANDROID_ADB"
    rmdir "$ANDROID_SHIM_ROOT/platform-tools" "$ANDROID_SHIM_ROOT" 2>/dev/null || true
  fi
}

rollback_config() {
  if [ -n "$BAK" ] && [ -d "$BAK" ]; then
    rm -rf "$DEST"
    if cp -a "$BAK" "$DEST"; then
      secure_tree "$DEST"
      warn "Previous state restored from $BAK"
    else
      warn "Incomplete rollback: the backup is still available in $BAK."
    fi
  elif [ "$DEST_EXISTED" = 1 ]; then
    find "$DEST" -mindepth 1 -delete 2>/dev/null || true
    chmod 700 "$DEST"
    warn "Created files removed ($DEST was empty before installation)"
  else
    rm -rf "$DEST"
    warn "Created files removed ($DEST did not exist before installation)"
  fi
  restore_bin_state
  restore_android_adb
}

# List of kit files + customization detection BEFORE any copy.
( cd "$SRC" && find . -type f ! -path './bin/*' | sed 's|^\./||' | sort ) > "$TMP/new.paths"
: > "$TMP/preserved.paths"
mkdir -p "$TMP/preserved" "$TMP/kitfinal"
while IFS= read -r rel; do
  if [ "$FORCE_CONFIG" = 0 ] && is_modified "$rel"; then
    printf '%s\n' "$rel" >> "$TMP/preserved.paths"
    mkdir -p "$TMP/preserved/$(dirname "$rel")"
    cp -a "$DEST/$rel" "$TMP/preserved/$rel"
  fi
done < "$TMP/new.paths"

# This whole block runs under set -e in a subshell: the first error cancels the phase.
config_phase() {
  local rel f oldh curh h mode
  cp -a "$SRC/." "$DEST/"

  # Remove files the kit used to install and that no longer exist (e.g. plugins/auto-compact.js),
  # without touching personal files: based on the list of files already installed by the kit.
  # The "legacy" list is only applied from the 2nd install onward (manifest present).
  : > "$TMP/old.paths"
  if [ -f "$MANIFEST" ]; then
    { manifest_paths "$MANIFEST"; printf "%s\n" "plugins/auto-compact.js" "plugins/guard.js" "plugins/notify.js"; } | sort -u > "$TMP/old.paths"
  fi
  comm -23 "$TMP/old.paths" "$TMP/new.paths" | while IFS= read -r f; do
    case "$f" in ""|*..*|/*) continue ;; esac
    [ -e "$DEST/$f" ] || continue
    oldh="$(manifest_hash "$MANIFEST" "$f")"
    curh="$(sha256_of "$DEST/$f")"
    if [ -n "$oldh" ] && [ -n "$curh" ] && [ "$oldh" != "$curh" ]; then
      warn "Modified file preserved (no longer in the kit): $f"
    else
      rm -f "$DEST/$f" && echo "🧹 Removed (no longer in the kit): $f"
    fi
  done

  for f in "$SRC"/bin/*; do install -m 0755 "$f" "$BIN/$(basename "$f")"; done
  install -m 0755 "$HERE/scripts/new-rust-project.sh" "$BIN/oc-new-rust"
  mkdir -p "$DEST/templates"
  cp -a "$HERE/templates/." "$DEST/templates/"

  # Lightweight profile
  if [ "$LITE" = 1 ]; then
    node "$HERE/scripts/make-lite.mjs" "$DEST"
  fi

  # Android module (optional) — idempotent in both directions
  if [ "$ANDROID" = 1 ]; then
    install_android_addon
  else
    remove_android_addon
  fi

  if [ "$NOPENTEST" = 1 ]; then
    remove_pentest_tools   # removes the marker only: binaries already installed stay
  fi

  # Your model choices (oc-models set ...) survive updates
  if [ -f "$DEST/oc-models.json" ]; then
    OPENCODE_CONFIG_DIR="$DEST" node "$DEST/libexec/oc-models.mjs" apply && echo "✅ Custom models reapplied ($DEST/oc-models.json)"
  fi

  # State of conditional MCPs: Node helper (macOS/Linux portable, no sed -i), idempotent,
  # preserves comments and checks that the file remains valid JSONC.
  mcp_state() {  # disable|enable <server> [reason] — exit code 2: server missing from the file
    local action="$1" server="$2" why="${3:-}"
    case "$action" in
      disable) node "$MCP_STATE" disable "$DEST/opencode.jsonc" "$server" "$why" ;;
      enable)  node "$MCP_STATE" enable "$DEST/opencode.jsonc" "$server" ;;
      *) return 1 ;;
    esac
  }

  # Kubernetes: the MCP server exits at startup if there is no kubectl context
  if [ "$LITE" = 0 ] && [ -f "$DEST/opencode.jsonc" ]; then
    kc="${KUBECONFIG:-$HOME/.kube/config}"
    if grep -qs '^current-context: *[^ ]' "${kc%%:*}"; then
      if mcp_state enable kubernetes; then
        echo "✅ kubernetes MCP enabled (kubectl context detected)"
      fi
    elif mcp_state disable kubernetes "no kubectl context: remove this line once you have a cluster"; then
      echo "ℹ️  kubernetes MCP disabled (no kubectl context in ${kc%%:*}): remove the \"disabled\" line from opencode.jsonc once you have a cluster."
    else
      warn "kubernetes MCP: opencode.jsonc could not be updated (block missing or invalid JSONC)."
    fi
  fi

  # REA requires Node >= 26.12.1 (or 24.22.1 / 22.23.4); otherwise disable it cleanly
  if [ "$LITE" = 0 ] && [ -f "$DEST/opencode.jsonc" ] && grep -q '"rea": {' "$DEST/opencode.jsonc"; then
    if rea_msg="$("$BIN/oc-rea-mcp" --check 2>&1)"; then
      if mcp_state enable rea; then
        echo "✅ rea MCP (REA 6.8.0) enabled: Node ${OC_REA_NODE_VERSION:-$(node -p 'process.versions.node')} is suitable"
      fi
    else
      if mcp_state disable rea "Node too old for REA: remove this line after updating Node"; then
        echo "ℹ️  rea MCP disabled: $(printf '%s' "$rea_msg" | head -n 1)"
      fi
      echo "    Update Node (mise use -g node@26.12.1) then rerun ./install.sh --no-tools: the reverse-engineer agent will use the CLI meanwhile."
    fi
  fi

  # mobile MCP: active only with the Android module (and Podman)
  if [ "$LITE" = 0 ] && [ -f "$DEST/opencode.jsonc" ] && grep -q '"mobile": {' "$DEST/opencode.jsonc"; then
    if [ "$ANDROID" = 1 ] && "$BIN/oc-mobile-mcp" --check >/dev/null 2>&1; then
      if mcp_state enable mobile; then
        echo "✅ mobile MCP (mobile-mcp 1.0.15) enabled (adb from the Podman emulator)"
      fi
    else
      if mcp_state disable mobile "Android module not installed (./install.sh --android) or Podman missing"; then :; fi
      if [ "$ANDROID" = 1 ]; then warn "mobile MCP disabled: Podman not found. → $(pkg_hint podman)"; fi
    fi
  fi

  # semgrep MCP: requires uv (uvx) or pipx; otherwise disabled cleanly.
  # --check is a REAL MCP handshake (it may download ~50 MB on first run):
  # reserved for tools installation. With --no-tools, --check-quick only checks for
  # uvx/pipx without starting a process or touching the network.
  if [ "$LITE" = 0 ] && [ -f "$DEST/opencode.jsonc" ] && grep -q '"semgrep": {' "$DEST/opencode.jsonc"; then
    if [ "$TOOLS" = 1 ]; then semgrep_check=--check; else semgrep_check=--check-quick; fi
    if "$BIN/oc-semgrep-mcp" "$semgrep_check" >/dev/null 2>&1; then
      if mcp_state enable semgrep; then
        if [ "$TOOLS" = 1 ]; then
          echo "✅ semgrep MCP enabled (server verified at startup)"
        else
          echo "✅ semgrep MCP enabled (uvx/pipx detected; startup verified on the next full install)"
        fi
      fi
    else
      if mcp_state disable semgrep "uv (uvx) and pipx missing: remove this line after installing either one"; then
        echo "ℹ️  semgrep MCP disabled: install uv (curl -LsSf https://astral.sh/uv/install.sh | sh), already required for MemPalace."
      fi
    fi
  fi

  # Customizations: keep the user's version and write the final kit version
  # (after lightweight profile / Android / MCPs) to .new. The manifest records this kit
  # version, not the user's, so their changes can still be detected.
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    mkdir -p "$TMP/kitfinal/$(dirname "$rel")"
    if [ -f "$DEST/$rel" ]; then cp -a "$DEST/$rel" "$TMP/kitfinal/$rel"; fi
    cp -a "$TMP/preserved/$rel" "$DEST/$rel"
    if [ -f "$TMP/kitfinal/$rel" ]; then
      mode=0600; [ -x "$TMP/kitfinal/$rel" ] && mode=0700
      install -m "$mode" "$TMP/kitfinal/$rel" "$DEST/$rel.new"
      warn "Modified file preserved, new version in $rel.new"
    else
      warn "Modified file preserved: no kit version in this profile for $rel"
    fi
  done < "$TMP/preserved.paths"

  # Manifest: hash of the final installed state (or of the kit version for a preserved file).
  : > "$MANIFEST"
  while IFS= read -r rel; do
    if grep -Fxq "$rel" "$TMP/preserved.paths"; then
      if [ -f "$TMP/kitfinal/$rel" ]; then h="$(sha256_of "$TMP/kitfinal/$rel")"; else h="$(sha256_of "$SRC/$rel")"; fi
    elif [ -f "$DEST/$rel" ]; then
      h="$(sha256_of "$DEST/$rel")"
    else
      h="$(sha256_of "$SRC/$rel")"
    fi
    printf '%s\t%s\n' "${h:--}" "$rel" >> "$MANIFEST"
  done < "$TMP/new.paths"
  chmod 600 "$MANIFEST"

  secure_tree "$DEST"
}

set +e
( set -e; config_phase )
CFG_RC=$?
set -e
if [ "$CFG_RC" -ne 0 ]; then
  warn "Configuration phase failed (code $CFG_RC): no partial changes will be kept."
  rollback_config
  die "Installation cancelled: no partial changes were kept."
fi

# The configuration is complete: this is what doctor checks. The marker is written here,
# before the tools: those are best-effort and do not condition the config installation.
: > "$DEST/.opencode-prerequisites.installed"
chmod 600 "$DEST/.opencode-prerequisites.installed"
secure_tree "$DEST"
echo "✅ Config installed in $DEST; launchers (agent-wt, oc-new-rust, oc-new-android, oc-models, oc-deps, oc-playwright-mcp, oc-terraform-mcp, oc-rea-mcp, oc-semgrep-mcp, oc-versions) in $BIN"

# 4. Pentest/appsec tools (--pentest option) — best-effort, like the other tools.
if [ "$PENTEST" = 1 ]; then
  install_pentest_tools || warn "Pentest tools: partial installation (see messages above)."
fi

# 5. Tools (full profile only)
if [ "$TOOLS" = 1 ]; then
  need npx || die "npx (Node.js) is required for context7/playwright."
  SYSBROWSER=""
  for c in chromium chromium-browser google-chrome-stable google-chrome brave-browser brave; do
    if need "$c"; then SYSBROWSER="$(command -v "$c")"; break; fi
  done
  if [ -n "$SYSBROWSER" ]; then
    echo "✅ System browser detected ($SYSBROWSER): the Playwright MCP will use it, no download needed."
  else
    echo "⬇️  Playwright: installing Chromium (no system browser found)..."
    npx -y "playwright@$OC_PLAYWRIGHT_VERSION" install chromium || warn "Chromium not installed. On ${DISTRO}: $(pkg_hint chromium)"
    case "$PM" in
      apt) echo "   If Chromium does not start (missing libraries): sudo npx playwright install-deps chromium" ;;
      pacman|dnf) echo "   Playwright does not officially support ${DISTRO}: the simplest option is the system Chromium → $(pkg_hint chromium)" ;;
    esac
  fi

  echo "⬇️  Obscura $OC_OBSCURA_VERSION..."
  install_obscura || warn "Obscura not installed (download or verification failed)."

  echo "⬇️  Trivy $OC_TRIVY_VERSION..."
  install_trivy || warn "Trivy not installed: https://trivy.dev/latest/getting-started/installation/"
  if PATH="$BIN:$PATH" command -v trivy >/dev/null 2>&1; then
    if ! PATH="$BIN:$PATH" trivy plugin install "github.com/aquasecurity/trivy-plugin-mcp@$OC_TRIVY_MCP_VERSION"; then
      warn "Trivy MCP plugin $OC_TRIVY_MCP_VERSION not installed: rerun \"trivy plugin install\" manually."
    fi
  else
    warn "Trivy MCP plugin not installed: trivy missing."
  fi

  echo "⬇️  MemPalace..."
  if ! { setup_mempalace && install_mempalace_plugin; }; then
    drop_mempalace_plugin
  fi
fi

# --no-tools: copy the config only, no download/installation (no pentest binaries,
# no MemPalace plugin). --memory-only remains the explicit way to (re)install MemPalace.

echo "ℹ️  System: $DISTRO (package manager: ${PM:-none recognized})"
if ! need docker && ! need podman; then
  warn "Neither Docker nor Podman: required for the terraform MCP (or set \"enabled\": false). → $(pkg_hint docker)"
fi
need gh || warn "gh (GitHub CLI) not found: required for /pr and GitHub search. → $(pkg_hint gh)"
[ "$BIN" = "$HOME/.local/bin" ] || warn "The playwright and terraform MCPs point to \$HOME/.local/bin (oc-* launchers): copy them from $BIN or keep the default directory."
case ":$PATH:" in *":$BIN:"*) ;; *) warn "Add $BIN to your PATH: export PATH=\"$BIN:\$PATH\"" ;; esac

# Shell environment variables (opt-in). Tagged block, replaced on every run (no duplicates).
# - ~/.local/bin is added at the END of PATH, never first (first, it can make mise/asdf shims loop).
# - The block is written at the TOP of ~/.bashrc (before the "return" of non-interactive shells) and in ~/.zshenv for zsh
#   (read by all zsh, unlike ~/.zshrc): it is thus visible to commands started without a terminal.
# - A systemd service reads none of these files: the MemPalace plugin therefore sets its Python itself.
strip_env_block() {  # file → stdout, without our block (tagged, or old untagged format)
  awk '
    /^# >>> opencode-prerequisites >>>$/ { skip=1; next }
    /^# <<< opencode-prerequisites <<<$/ { skip=0; afterend=1; next }
    skip==1 { next }
    afterend==1 && /^$/ { afterend=0; next }   # the empty line the block adds after itself
    /^# opencode-prerequisites$/ { old=1; next }
    old==1 && /^export (PATH|MEMPALACE_ADAPTER_PYTHON)=/ { next }
    { old=0; afterend=0; print }
  ' "$1"
}
write_env_block() {  # file
  local rc="$1" first head_line=""
  if [ -e "$rc" ] && [ ! -e "$rc.bak-opencode-prerequisites" ]; then cp -p "$rc" "$rc.bak-opencode-prerequisites"; fi
  if [ -f "$rc" ]; then strip_env_block "$rc" > "$TMP/rc.rest"; else : > "$TMP/rc.rest"; fi
  first="$(head -n 1 "$TMP/rc.rest")"
  case "$first" in
    "#!"*) head_line="$first"; tail -n +2 "$TMP/rc.rest" > "$TMP/rc.tail" ;;   # a shebang, if any, stays on the first line
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
  cat "$TMP/rc.out" > "$rc"   # cat >: preserves permissions and symlinks (dotfiles)
  echo "✅ PATH block (at the end) + MEMPALACE_ADAPTER_PYTHON written at the top of $rc"
}
if [ "$SHELLENV" = 1 ]; then
  if [ -f "$HOME/.bashrc" ]; then write_env_block "$HOME/.bashrc"; fi
  if [ -f "$HOME/.zshrc" ] || [ -f "$HOME/.zshenv" ]; then
    write_env_block "$HOME/.zshenv"
    # clean up old blocks left in ~/.zshrc (not read outside interactive terminals)
    if [ -f "$HOME/.zshrc" ] && grep -q 'opencode-prerequisites' "$HOME/.zshrc"; then
      strip_env_block "$HOME/.zshrc" > "$TMP/zshrc.clean" && cat "$TMP/zshrc.clean" > "$HOME/.zshrc"
    fi
  fi
  echo "   (open a new terminal; backups: <file>.bak-opencode-prerequisites)"
fi

# 5. Matt Pocock skills (optional)
if [ "$MATT" = 1 ]; then
  npx -y "skills@$OC_SKILLS_VERSION" add mattpocock/skills -a opencode || warn "Failed: see the README of the mattpocock/skills repository."
fi

if [ "$ANDROID" = 1 ]; then
  cat <<MSG

Android module — final steps:
  1. Rootless Podman: oc-android doctor
  2. Build the image (several GB, 10 to 20 min; you accept the Android SDK licenses):
       oc-android build-image --accept-licenses
  3. Emulator (requires /dev/kvm; kvm group): from your project, oc-android emulator start --wait
MSG
fi

cat <<'MSG'

If OpenCode is already running (including its background service), RESTART IT: an already running server
does not reload plugins or the environment (per your feedback: opencode service restart; otherwise close all OpenCode windows).

Next steps:
  1. Run `opencode`, then /connect → OpenCode Go → paste your key (OpenCode console).
     Console › Settings › Privacy › Regions: choose "Global" (required for DeepSeek models).
  2. ./doctor.sh   (checks the config, tools and MCPs; /models for model IDs)
  3. (optional) export CONTEXT7_API_KEY=...   # free key at context7.com
  4. New Rust project: oc-new-rust <name>.  Existing project: project-onboarding skill.
  5. Undo: ./uninstall.sh
MSG
