#!/usr/bin/env bash
# Creates an OpenCode-ready Rust project (AGENTS.md, CI, sample tests, git).
#   oc-new-rust <name> [parent-directory]
set -Eeuo pipefail

name="${1:-}"; parent="${2:-.}"
[[ "$name" =~ ^[a-z][a-z0-9_-]*$ ]] || { echo "Usage: oc-new-rust <name> [parent-directory]  (name: lowercase, digits, - _)" >&2; exit 1; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for c in "$here/../templates/rust-project" "${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/templates/rust-project"; do
  [ -d "$c" ] && { tpl="$c"; break; }
done
[ -n "${tpl:-}" ] || { echo "Template not found: rerun ./install.sh" >&2; exit 1; }

dest="$parent/$name"
[ ! -e "$dest" ] || { echo "$dest already exists" >&2; exit 1; }
cp -a "$tpl" "$dest"

ident="${name//-/_}"
grep -rIl '{{name' "$dest" | while read -r f; do
  sed -i.bak -e "s/{{name_ident}}/$ident/g" -e "s/{{name}}/$name/g" "$f" && rm -f "$f.bak"
done

git -C "$dest" init -q -b main
git -C "$dest" add -A
git -C "$dest" -c user.name="${GIT_AUTHOR_NAME:-$(git config user.name || echo dev)}" \
               -c user.email="${GIT_AUTHOR_EMAIL:-$(git config user.email || echo dev@localhost)}" \
               commit -q -m "Initial commit"
echo "✅ Project created: $dest"
echo "   cd $dest && cargo test && opencode"
