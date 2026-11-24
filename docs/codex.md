# Codex export

`oc-export-codex` converts the kit into the layout read by the Codex CLI and the Codex app:
global instructions, one TOML agent per role, skills, MCP servers and two model profiles. The
export is generated, deterministic and idempotent: re-exporting unchanged sources produces the
same bytes. A full export writes 30 agents, 18 skills, 11 MCP servers and 2 profiles.

The exporter never logs in to Codex, starts a session or edits a kit source. Authentication
stays in the Codex home (`codex login`), or in the environment when an API key is used.

## Prerequisites

- Node.js 18+ for the exporter (ESM, no dependency).
- Codex CLI 0.172+ on `PATH` for the commands below (`codex --version`). The Codex app uses
  the same configuration but is never launched by the exporter.
- Bash for the `oc-export-codex` launcher. Native Windows can call the Node script directly
  or use WSL2; the launcher itself is Bash-only.

## Install

From a repository checkout:

```bash
config/bin/oc-export-codex --global
# or, without the launcher
node scripts/export-codex.mjs --global
```

From an installed kit, the launcher is `oc-export-codex` in `~/.local/bin`:

```bash
oc-export-codex --global
```

The installed launcher resolves the exporter from `<config>/libexec/export-codex.mjs`
(`~/.config/opencode/libexec` by default). `install.sh` copies it there; if an older
installation predates the exporter, rerun `./install.sh --no-tools` or use the checkout
command above.

Useful forms:

```bash
oc-export-codex --global --force          # overwrite local edits to generated files
oc-export-codex --out /tmp/codex-home     # isolated CODEX_HOME (tests, CI artifact)
oc-export-codex --project .               # <project>/.codex
oc-export-codex --global --dry-run        # print the plan, write nothing
oc-export-codex --mcp-only --out DIR      # merge MCP servers into DIR/config.toml only
```

| Option | Meaning |
|---|---|
| `--out DIR` | Target config directory (default: `~/.codex`) |
| `--project DIR` | Project export, written to `DIR/.codex` |
| `--global` | User-level export: `~/.codex` plus `~/.agents/skills` |
| `--force` | Overwrite files the exporter does not own instead of writing `<file>.new` |
| `--dry-run` | Print the plan, write nothing |
| `--mcp-only` | Only merge MCP tables into `<out>/config.toml` |
| `--config DIR` | Read another kit configuration (default: this repository's `config/`) |
| `-h`, `--help` | Show the help |

`--out`, `--project` and `--global` are mutually exclusive; `--mcp-only` is incompatible with
`--project`. With no target option, the export is global. Exit codes: `0` success, `1` export
error, `2` usage error.

## Paths

Global export (`--global`, or no target):

```text
~/.codex/
  AGENTS.md                    kit AGENTS.md + routing + CEO delegation + Codex notes
  agents/<name>.toml           one file per agent, ceo included
  config.toml                  merged MCP servers, [agents] and [features] keys
  fast.config.toml             profile: sol / medium
  deep.config.toml             profile: astra / high
  .oc-export-manifest.json     files owned by the exporter (idempotence and cleanup)
~/.agents/skills/<name>/       skills, shared with other agent tools
```

`<CODEX_HOME>` defaults to `~/.codex`; use `--out "$CODEX_HOME"` when you run Codex with a
custom home. On Windows the default user home is `%USERPROFILE%\.codex`.

Non-global export (`--out DIR` or `--project DIR`) keeps the tree together:

```text
DIR/ (or DIR/.codex for --project)
  AGENTS.md
  agents/<name>.toml
  skills/<name>/...
  config.toml
  fast.config.toml
  deep.config.toml
  .oc-export-manifest.json
```

A project export is not discovered automatically by Codex. Start it explicitly:

```bash
CODEX_HOME=/path/to/project/.codex codex --profile fast
```

The global export is the one both the CLI and the app read without an extra variable.

## Models and effort

Every agent TOML pins a model and a reasoning effort. Codex does not choose a model per agent
at runtime; the file is the routing decision.

| Tier | Model | Effort | Agents | Use for |
|---|---|---|---|---|
| astra | `gpt-6.2-astra` | `high` | `ceo`, `architect`, `security`, `review`, `verify-app`, `integrator` | architecture, security, review, arbitration, ambiguous bugs |
| sol | `gpt-6.2-sol` | `medium` | all other specialists (`rust`, `backend`, `frontend`, `database`, `devops`, `docker`, `ansible`, `terraform`, `kubernetes`, `qa`, `debugger`, `docs`, `code-simplifier`, `pentest`, `reverse-engineer`, `codex`, `antigravity`, ...) | implementation, tests, docs, integration, routine fixes |
| terra | `gpt-6.1-terra` | `high` | `designer` | visual design, UI/UX, browser and computer work |
| luna | `gpt-6-luna` | `low` | `researcher`, `web-researcher` | extraction, scans, mechanical work, reading, status checks |

The generated `[agents]` table sets the default for subagents that have no explicit model:
`gpt-6.2-sol` at `medium`. `[features] multi_agent_v2 = true` selects the V2 multi-agent
backend (Codex 0.172 replaced the deprecated `[features] multi_agent` key).

Two profiles layer a session default on top of the base config:

```bash
codex --profile fast     # gpt-6.2-sol / medium, for routine work
codex --profile deep     # gpt-6.2-astra / high, for hard reasoning
```

A profile is a starting point, not a replacement for the agent files: an agent's own `model`
and `model_reasoning_effort` still win for that role. The model IDs are the kit's catalog for
Codex 0.172; if your account exposes different slugs, check `codex debug models` and align the
`MODEL` constants in `scripts/export-codex.mjs` before exporting.

Rules encoded in `AGENTS.md` and the TOML files:

- Never use astra for mechanical work (renames, formatting, status, simple searches): use luna.
- Never use luna for security, review, architecture or an ambiguous bug: use astra.
- An ambiguous bug starts on sol (`debugger`) and escalates to astra after one attempt.
- `designer` is terra: visual judgment must not run on the text/reasoning tier.
- Do not run the same task twice on two models to compare: pick one.

## MCP servers

The exporter reads the enabled servers of `config/opencode.jsonc` and writes
`[mcp_servers.<name>]` tables in `config.toml`:

| OpenCode | Codex `config.toml` |
|---|---|
| `type: "remote"`, `url` | `url` |
| `headers` | `http_headers` (inline table) |
| `type: "local"`, `command: ["cmd", "arg"]` | `command = "cmd"`, `args = ["arg"]` |
| `environment` / `env` | `env` (inline table) |
| `disabled: true` | server omitted |

`{env:NAME}` references are expanded at export time. `HOME` always resolves to the exporting
user's home; an unset variable becomes the literal `${NAME}`. Because expansion happens while
writing, do not run an export with a secret in the environment if that secret must not appear
in `config.toml`.

`config.toml` is always **merged**, never regenerated:

- Existing sections, keys and MCP servers are preserved. A kit server with a name that already
  exists does **not** overwrite the user's entry; the user's entry wins.
- The merge only adds missing server names. Removing a server from the kit does not remove it
  from `config.toml`; delete the table by hand, then re-export if needed.
- Before the first change, a backup is written next to the file as
  `config.toml.bak-<UTC timestamp>` (for example `config.toml.bak-20261124-091500`). An
  unchanged file is not rewritten and gets no backup. The existing file mode is preserved
  (a `0600` config stays `0600`).
- The merge adds `[agents] enabled`, `default_subagent_model`,
  `default_subagent_reasoning_effort` and `[features] multi_agent_v2` when absent. If
  `[agents]` is defined as an inline table, the export stops with an error: convert it to a
  `[agents]` section first.
- `--mcp-only` performs this merge and writes nothing else.

### `.new` and `--force`

Every generated file except `config.toml` follows the kit's usual ownership rule:

- A file listed in `.oc-export-manifest.json` is owned by the exporter and is updated on a
  re-export. Files the exporter owns but no longer generates are removed.
- An existing file that differs and is **not** owned is kept. The generated version is written
  beside it as `<file>.new` (for example `AGENTS.md.new`, `agents/rust.toml.new`).
- `--force` overwrites the target instead and removes a stale `.new` when it matches the new
  content. `--dry-run` reports the same plan without writing anything.

`config.toml` is the exception: it is merged in place, never replaced and never written as
`.new`.

## CLI and app

The Codex CLI and the Codex app share the same personal configuration root:

| Item | Shared path | Notes |
|---|---|---|
| Instructions | `~/.codex/AGENTS.md` | Kit rules + Codex routing and delegation |
| Agents | `~/.codex/agents/<name>.toml` | Main and subagents |
| MCP | `~/.codex/config.toml` | Same `[mcp_servers.*]` schema |
| Profiles | `~/.codex/fast.config.toml`, `~/.codex/deep.config.toml` | `codex --profile fast\|deep` |
| Skills | `~/.agents/skills/<name>/SKILL.md` | Shared user-level skill folder |

The app is published for macOS, Windows and Linux and reads the same `~/.codex` tree
(`%USERPROFILE%\.codex` on Windows). This export was validated with the Linux CLI; the app UI
and the Windows path are not exercised by the exporter test suite.

Typical session:

```bash
codex login                 # once, browser or --device-auth on a headless machine
codex --profile fast        # interactive TUI
codex exec "..."            # non-interactive
```

Verify what Codex loaded:

```bash
codex mcp list --json
codex doctor --json
codex debug prompt-input    # JSON: roles, instructions, skills
```

The agent roles come from `agents/*.toml`; `codex mcp list` reads the merged MCP tables; the
doctor reports the config and auth source. The exporter does not store an API key in
`config.toml`; `OPENAI_API_KEY` is read from the environment by Codex.

## Limitations

- **No per-agent sandbox.** The kit's `permission:` blocks (`edit: deny`, `bash: deny`, ...) are
  not exported. Sandbox and approval are session-level: `codex --sandbox
  read-only|workspace-write|danger-full-access`, `--ask-for-approval`, and the profiles. The
  CEO's "cannot edit or run commands" rule is carried by its instructions and delegation model,
  not enforced by Codex.
- **Prompts are TUI presets, not agents.** Reusable prompts live in `[tui.presets]` and are
  selected in the TUI; they are not role definitions and the exporter does not write them. The
  kit's agents are the `agents/*.toml` files.
- **App coverage is partial.** The app shares `~/.codex`, but only the CLI was validated here.
  On Windows the config root is `%USERPROFILE%\.codex`; the Bash launcher needs WSL2, while the
  Node exporter can run natively. A project export needs `CODEX_HOME` even for the CLI.
- **Recursion with the `codex` bridge.** `config/agents/codex.md` is exported like any other
  core agent, so `agents/codex.toml` exists when the external pack is present. That role calls
  `oc-codex`/`codex` again: do not delegate to it from inside a Codex session (it would recurse
  into another Codex process). It is meant for OpenCode or Claude Code. Ignore it, or export
  from a trimmed config that omits `codex.md`.
- **MCP merge only adds.** An existing server entry is never updated by a re-export and a
  server removed from the kit stays in `config.toml`. Edit the table by hand if the kit changes
  a command or URL.
- **No commands, hooks, plugins or Android addon.** Only `AGENTS.md`, agents, skills, MCP
  servers and the two profiles are exported. OpenCode commands (`/codex`, `/verify`, ...), the
  guard plugin and `addons/android` (`android`, `mobile-tester`, `android-dev`) are not part of
  a Codex export.
- **Skills are copied verbatim.** OpenCode-specific tool names or `@agent` mentions inside a
  skill body are not adapted; agent bodies are adapted (real agent mentions become code spans),
  skills are not. Review a skill before relying on it under Codex.
- **Model IDs depend on the account catalog.** `codex debug models` lists the slugs available to
  your account/plan. The exporter writes the kit's current IDs; if one is not available, adjust
  the `MODEL` map and re-export.

## Validation

The exporter suite is hermetic (temporary `HOME`/`CODEX_HOME`, never the real `~/.codex`) and
also drives the real Codex CLI:

```bash
node scripts/test-codex-export.mjs
node scripts/validate-kit.mjs
```

At the time of writing the suite passes 114 checks, including the 30 exported roles, the
model/effort mapping, byte-identical skills, MCP merge/backup, `.new`/`--force`, `--dry-run`,
`--mcp-only`, `--global`, the launcher, `codex mcp list --json`, `codex doctor --json` and
`codex debug prompt-input` with the 30 kit roles. `validate-kit.mjs` reports 30 core agents
(32 with Android), 18 skills and the kit's MCP servers.

When the launcher changes, also run:

```bash
bash -n config/bin/oc-export-codex
shellcheck config/bin/oc-export-codex
node --check scripts/export-codex.mjs
```
