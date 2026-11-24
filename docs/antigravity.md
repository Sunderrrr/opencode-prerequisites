# Antigravity export

`oc-export-antigravity` converts the kit into the layout read by the Antigravity CLI and the
Antigravity app: custom agents, skills, global rules and MCP servers. The export is generated,
deterministic and idempotent: re-running it on unchanged sources produces the same bytes.

The two surfaces share one configuration root, `~/.gemini/config`, so a single global export
serves both. The app and the CLI also read a project root, `<project>/.agents`, for per-project
customizations.

Prerequisites: Node.js (the exporter is an ESM script) and Antigravity CLI 1.5.16+ on `PATH`
for the checks below. The CLI is authenticated on its first interactive run; the exporter does
not log in, launch the app or start a session.

On Linux the desktop app also installs `/usr/bin/antigravity` (a link to
`/opt/Antigravity/antigravity`). That binary is **not** the CLI: it ignores `agent`, `mcp` and
`models` and can hang. Call the CLI as `agy` (or put its directory before `/usr/bin` in `PATH`);
`oc-antigravity` prefers `agy` and refuses the `/opt/Antigravity` binary with an explicit error.

## Usage

```bash
# Global export for the CLI and the app: ~/.gemini/config
oc-export-antigravity --global --force

# Project export: <dir>/.agents
oc-export-antigravity --project . --force

# Include the Android module (android, mobile-tester, android-dev skill)
oc-export-antigravity --global --android --force

# Custom target (tests, CI artifact, temporary HOME)
oc-export-antigravity --out /tmp/agi/.gemini/config --android --force

# Show the plan without writing anything
oc-export-antigravity --global --android --dry-run
```

| Option | Meaning |
|---|---|
| `--out DIR` | Target config directory (default: `~/.gemini/config`) |
| `--project DIR` | Project export, written to `DIR/.agents` |
| `--global` | Explicit user-level export to `~/.gemini/config` |
| `--android` | Add the Android addon agents and skills |
| `--force` | Overwrite files that differ instead of writing `<file>.new` |
| `--dry-run` | Print the plan, write nothing |
| `--config DIR` | Read another kit configuration (default: this repository's `config/`) |
| `-h`, `--help` | Show the help |

`--out`, `--project` and `--global` are mutually exclusive. Exit codes: `0` success, `1` export
error, `2` usage error.

Without `--force`, an existing file that differs from the generated one is left untouched and
the generated version is written next to it as `<file>.new`. This protects local edits. The MCP
file is the exception: it is always merged (see [MCP servers](#mcp-servers)).

From a repository checkout, run `config/bin/oc-export-antigravity` or
`node scripts/export-antigravity.mjs`. In an installed kit, `oc-export-antigravity` is in
`~/.local/bin` and looks for the exporter in `<config>/libexec/export-antigravity.mjs`;
`install.sh` copies it there. If an older installation predates the exporter, rerun
`./install.sh --no-tools` or use the checkout command above.

Start a session with the CEO as the main agent:

```bash
agy --agent ceo
```

## Generated tree

Global export (`--global`, or no `--out`/`--project`):

```text
~/.gemini/config/
  AGENTS.md                    kit AGENTS.md + tier routing + CEO delegation + Antigravity notes
  agents/<name>.md             one file per agent (ceo included), plus Android with --android
  skills/<name>/SKILL.md       copied with its subdirectories and support files
  mcp_config.json              mcpServers map, merged with the existing file
```

Project export (`--project DIR`):

```text
DIR/.agents/
  AGENTS.md
  agents/<name>.md
  skills/<name>/SKILL.md
  mcp_config.json
```

| Global (app + CLI) | Project (app + CLI) | Source |
|---|---|---|
| `~/.gemini/config/AGENTS.md` | `DIR/.agents/AGENTS.md` | `config/AGENTS.md` |
| `~/.gemini/config/agents/<name>.md` | `DIR/.agents/agents/<name>.md` | `config/agents/<name>.md` |
| `~/.gemini/config/skills/<name>/` | `DIR/.agents/skills/<name>/` | `config/skills/<name>/` |
| `~/.gemini/config/mcp_config.json` | `DIR/.agents/mcp_config.json` | `config/opencode.jsonc` |

`--android` also exports `addons/android/agents/` (`android`, `mobile-tester`) and
`addons/android/skills/android-dev/`. The exporter writes only the files listed above; other
files already present in the target (for example `config.json`, `projects/` or `hooks.json`)
are left untouched.

Antigravity scans customization folders one level deep: a skill folder must sit directly
inside `skills/`. Files nested deeper are copied but are not discovered as a separate skill.

## Model tiers

Antigravity agent files carry a **tier**, not an exact model ID. The exporter assigns one tier
per agent in the generated frontmatter (`model: pro|flash|inherit`); Antigravity resolves the
tier to a current model from the account's catalog.

| Tier | Use for | Agents |
|---|---|---|
| `pro` | architecture, security, review, arbitration, ambiguous bugs, design | `ceo`, `architect`, `security`, `review`, `verify-app`, `integrator`, `designer`, `pentest`, `reverse-engineer` |
| `flash` | extraction, scans, mechanical work, reading, status checks | `researcher`, `web-researcher` |
| `inherit` | implementation, tests, docs, integration, routine fixes | every other language and domain specialist (for example `rust`, `python`, `typescript`, `go`, `shell`, `debugger`, `qa`, `docs`, `database`, `devops`, `android`, `mobile-tester`) |

Rules of thumb:

- Do not spend `pro` on mechanical work (renames, formatting, status, simple searches): use
  `flash`.
- Do not use `flash` for security, review, architecture or an ambiguous bug: use `pro`.
- An ambiguous bug starts on `inherit` (`debugger`); escalate to `pro` when the cause is still
  unclear after one attempt.
- `inherit` follows the session model: it is the default for implementation specialists.

A generated agent file looks like this:

```yaml
---
name: rust
description: "Rust engineer (the project's default language). Use for any development: CLIs, services, libraries, system tools."
model: inherit
subagent: true
mainAgent: false
commandExecutionPolicy: sandbox
---
```

`ceo` is the only agent with `mainAgent: true`. `subagent: true` lets the CEO delegate to every
other agent with `invoke_subagent`; `manage_subagents` lists or stops them.

The exact model is a session choice, not an agent field: use `--model` on the CLI or `/model`
inside a session. `agy models` lists the slugs available to the signed-in account.

## Global rules (`AGENTS.md`)

`config/AGENTS.md` is copied as the global rules file, followed by three generated sections:

- **Model routing (Antigravity)**: the tier table above and the routing rules.
- **CEO delegation rules (Antigravity)**: how the main agent splits work, briefs subagents and
  closes the validation loop.
- **Antigravity specifics**: the configuration paths, the `agy agent` / `agy mcp
  list` checks, and the shared CLI/app root.

The generated header marks the file as generated; edit `config/AGENTS.md` in the kit and
re-export instead of editing the target by hand. Antigravity caps a single rule file at 24 KB
(the kit file is around 12 KB): if you extend it, split rules into `rules/*.md`.

Project rules are inherited from parent folders up to the repository root. Starting the CLI in
`services/api/` loads `services/api/.agents/` and the repository-root `.agents/`, not arbitrary
subfolders below the workspace.

## Skills

Every `config/skills/<name>/` folder is copied whole to `<target>/skills/<name>/`, with
`SKILL.md` and any `scripts/`, `references/`, `examples/` or other support files. The source
files are copied verbatim: skill bodies are not rewritten for Antigravity.

Shared skills (read by both the app and the CLI):

```text
~/.gemini/config/skills/<name>/SKILL.md        global
<workspace>/.agents/skills/<name>/SKILL.md     project
```

The CLI additionally reads two folders that the app does not:

```text
~/.gemini/antigravity-cli/skills/<name>/SKILL.md   CLI global
~/.gemini/skills/<name>/SKILL.md                  CLI shared
```

Skills in those two CLI-only folders take priority over the shared folders on a name collision.
The exporter writes only to `~/.gemini/config/skills` (or `.agents/skills`), the one location
both surfaces read. To keep a skill CLI-only, copy or symlink it into
`~/.gemini/antigravity-cli/skills/` yourself; do not expect `oc-export-antigravity` to manage
that folder.

In the CLI, each skill becomes a slash command (`/tdd`, `/security-audit`, ...). After adding,
editing or removing skills, run `/skills reload` or start a new conversation. The app rereads
rules and skills before each turn; a new conversation is enough to see a changed skill list.

## MCP servers

The exporter reads the `mcp` section of `config/opencode.jsonc` and writes the `mcpServers` map
of `mcp_config.json`:

| OpenCode | Antigravity `mcp_config.json` |
|---|---|
| `command: ["cmd", "arg"]` | `command: "cmd"`, `args: ["arg"]` |
| `environment` / `env` | `env` |
| `type: "remote"` with `url` / `serverUrl` | `serverUrl` |
| `headers` | `headers` |
| `disabled: true` | `disabled: true` |

`mcp_config.json` is always **merged**, never replaced:

- Existing servers in the target are preserved. A kit server with the same name does **not**
  overwrite the user's entry; the user's entry wins.
- Other top-level keys in the file are preserved.
- Before a merge that changes the file, a backup is written next to it as
  `mcp_config.json.bak-<UTC timestamp>` (for example `mcp_config.json.bak-20261124-081500`).
  An unchanged file gets no backup and is not rewritten.
- Removing a server from the kit does not remove it from `mcp_config.json`: the merge only adds
  missing names. Delete the entry by hand (or with `agy mcp remove`) if you want it gone.

Environment references written as `{env:NAME}` (the OpenCode syntax) are expanded at export
time; `HOME` always resolves to the exporting user's home. A reference to an unset variable is
left as the literal `{env:NAME}`. Antigravity does not expand shell-style `${NAME}` either, so
do not rely on runtime substitution: put literal paths in the file, or provide values through
the environment of the MCP process (`env`) rather than embedding secrets.

Check what Antigravity loaded:

```bash
agy mcp list
```

## CLI and app share the same configuration

Both surfaces read the same personal customizations from `~/.gemini/config/`:

| Item | Shared path | Notes |
|---|---|---|
| Rules | `~/.gemini/config/AGENTS.md`, `rules/*.md` | Also `~/.gemini/AGENTS.md` and `~/.gemini/GEMINI.md` |
| Agents | `~/.gemini/config/agents/<name>.md` | Main and subagents |
| Skills | `~/.gemini/config/skills/<name>/SKILL.md` | The only global skill folder read by both |
| MCP | `~/.gemini/config/mcp_config.json` | Same `mcpServers` schema |
| Hooks | `~/.gemini/config/hooks.json` | Not written by the exporter |
| Plugins | `~/.gemini/config/plugins/` | Not written by the exporter |

The CLI has its own runtime settings and data in `~/.gemini/antigravity-cli/`
(`settings.json`, `keybindings.json`, conversations, caches). The app has its own settings.
Those files are not generated or modified by the exporter.

Changes to agents or MCP servers are picked up by a new conversation; a running app may need a
new conversation or a restart, and the CLI needs `/skills reload` for skill changes. The app is
never launched or restarted by the exporter.

## Limitations

- **One tier per agent, no exact model.** An agent file can only say `pro`, `flash` or
  `inherit`; it cannot pin `gemini-3.8-flash-high`, `claude-opus-4-6-thinking` or another slug.
  Pick the exact model per session with `--model` / `/model`.
- **No per-agent sandbox.** The kit's `permission:` blocks (`edit: deny`, `bash: deny`,
  `task: allow`, ...) are not exported. Every generated agent gets
  `commandExecutionPolicy: sandbox`, but the real sandbox, approval mode and permission rules
  are session-level settings (CLI: `--sandbox`, `--mode`, and `toolPermission` in
  `~/.gemini/antigravity-cli/settings.json`; the app has its own permission UI). The CEO's
  "cannot edit or run commands" constraint is carried by its instructions and delegation model,
  not enforced by the CLI.
- **The app is not launched.** The exporter writes files and exits; it never starts the CLI or
  the Antigravity app, never restarts a running app, and never signs in. Start the app or a CLI
  session yourself.
- **No `${VAR}` substitution.** Only OpenCode's `{env:NAME}` is expanded, at export time.
  `${NAME}`, `$NAME` and unset `{env:NAME}` references stay literal; Antigravity does not
  substitute them at runtime. Keep machine-specific paths literal or move the value into the
  MCP server's `env`.
- **MCP merge only adds.** An existing server entry is never updated by a re-export, and a
  server removed from the kit stays in `mcp_config.json`. Use `agy mcp remove` or edit
  the file.
- **No manifest cleanup.** Unlike the Codex export, no manifest tracks generated files: an
  agent or skill removed from the kit stays in `~/.gemini/config`. Delete it by hand (or start
  from a fresh `--out`) when the kit drops a role.
- **No commands, hooks or plugins.** OpenCode commands (`/codex`, `/verify`, ...), the guard
  plugin, notification hooks and plugin bundles are not exported. Only `AGENTS.md`, agents,
  skills and MCP servers are.
- **Skills are copied verbatim.** OpenCode-specific tool names or `@agent` mentions inside a
  skill body are not adapted (agent bodies are adapted; skills are not). Review a skill before
  relying on it under Antigravity.
- **`agy agent` lists main agents only.** With this export it prints `ceo`; the
  specialists are subagents and are visible inside a session through `/agents`, or in the
  `agents/` folder.
- **Bash launcher.** The wrapper is Bash and the exporter needs Node.js; native Windows is not
  covered (use WSL2).

## Validation

Run the real checks after an export:

```bash
# 11 servers in the kit export, exit 0
HOME=/tmp/opencode/antigravity-home agy mcp list

# ceo only (the other agents are subagents), exit 0
HOME=/tmp/opencode/antigravity-home agy agent

# Model slugs available to the account (network, no inference)
HOME=/tmp/opencode/antigravity-home agy models
```

The exporter suite covers frontmatter and tiers, skills, MCP merge and backup, idempotence,
`.new`/`--force`, `--android`, `--project`, the launcher and the CLI reading the result (72
checks at the time of writing):

```bash
node scripts/test-antigravity-export.mjs
```

When you change `config/bin/oc-export-antigravity`, also run:

```bash
shellcheck config/bin/oc-export-antigravity
shfmt -d -i 2 -ci config/bin/oc-export-antigravity
node --check scripts/export-antigravity.mjs
```
