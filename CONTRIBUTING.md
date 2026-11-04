# Contributing

## Prerequisites

- Node.js 18+ (CI runs on Node 26, see `.nvmrc`), Bash and git.
- Python 3 with `venv` to validate the OpenCode schema.
- ShellCheck for the scripts.

There is no `package.json`: the Node scripts only use the standard library, with no `npm install`.

## Clone and validate

```bash
git clone https://github.com/Sunderrrr/opencode-prerequisites.git
cd opencode-prerequisites

node scripts/validate-kit.mjs
node scripts/test-mcp-state.mjs
node scripts/test-lite.mjs
node scripts/test-doctor.mjs
node scripts/test-deps.mjs
node scripts/test-plugins.mjs
node scripts/test-models.mjs
node scripts/test-versions.mjs
node scripts/test-supply-chain.mjs
node scripts/test-install-env.mjs
node scripts/test-android.mjs
node scripts/test-pentest.mjs
node scripts/test-agent-wt.mjs
node scripts/test-new-android.mjs

python3 -m venv /tmp/schema-venv
/tmp/schema-venv/bin/pip install --quiet 'jsonschema>=4.18'
/tmp/schema-venv/bin/python scripts/validate-schema.py

shellcheck install.sh uninstall.sh doctor.sh scripts/*.sh config/bin/* \
  addons/android/bin/* addons/android/libexec/oc-android/*.sh \
  addons/android/libexec/oc-android/adb-shim
```

This list mirrors `.github/workflows/ci.yml`; the workflow wins if the two diverge.

## Testing an installation without touching your config

`install.sh` reads `OPENCODE_CONFIG_DIR` and `OBSCURA_BIN_DIR`. Point them at temporary directories:

```bash
export OPENCODE_CONFIG_DIR="$(mktemp -d)/full" OBSCURA_BIN_DIR="$(mktemp -d)/bin"
./install.sh --no-tools
test -f "$OPENCODE_CONFIG_DIR/agents/ceo.md"

export OPENCODE_CONFIG_DIR="$(mktemp -d)/lite"
./install.sh --lite
test "$(ls "$OPENCODE_CONFIG_DIR/agents" | wc -l)" -eq 12
```

`--no-tools` downloads nothing. Without the variables, the installation writes to `~/.config/opencode` and `~/.local/bin`.

## Conventions

- Commits in `type(scope): summary` format (feat, fix, docs, refactor, test, chore), 72 characters maximum, imperative. See the `git-commit` skill.
- Documentation and messages in English, without superlatives.
- No secret, token or real `.env` in the repository; `.env.example` only contains variable names.
- Pinned versions: no `latest` or `main` in a download URL or an MCP package.
- A fix comes with a test that fails before and passes after. Do not disable or weaken an existing test.
- Kit files are copied with a sha256 fingerprint: a local modification is kept on reinstall, the kit version arriving as `<file>.new`. `--force-config` overwrites.

## Adding an agent, a skill, a command or an MCP

- **Agent**: `config/agents/<name>.md`, name in `[a-z][a-z0-9-]*`, frontmatter with `description`, `mode` (`primary`, `subagent` or `all`) and a non-empty prompt. An agent mentioned as `@name` in the CEO must exist.
- **Skill**: `config/skills/<name>/SKILL.md`, `name` equal to the folder, description of 1024 characters maximum.
- **Command**: `config/commands/<name>.md` with a `description` in the frontmatter.
- **MCP**: in `mcp.servers` of `config/opencode.jsonc`, `type: local` (with `command` as an array) or `type: remote` (https URL). To disable, `"disabled": true` — `"enabled"` does not exist in OpenCode v2.
- **Module**: `addons/<name>/`; do not modify the base CEO, the module adds its tagged block.

`scripts/validate-kit.mjs` checks these rules and prints the Agents / MCP / Skills / Modules counters.

## Pull request

- Target `main`, one topic per PR.
- Describe the change and cite the commands you ran with their result (not just "tests OK").
- CI must be green.
- No `git push --force` on `main`.

## Reporting a bug

Open an issue with the commit, the distribution, the Node version, the command and the full output. For a vulnerability, follow `SECURITY.md` instead of a public issue.
