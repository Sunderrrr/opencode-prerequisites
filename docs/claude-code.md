# Claude Code export

`oc-export-claude` converts the kit (agents, skills, commands, MCP servers, guard plugin) into a
Claude Code layout. The export is generated, deterministic and idempotent: re-running it with
`--force` on unchanged sources produces a byte-identical tree.

## Usage

```bash
# Project export (default: ./.claude); MCP file goes to the project root ./.mcp.json
oc-export-claude --out .claude

# Write the MCP file somewhere else (custom layout, CI artifact)
oc-export-claude --out .claude --mcp-out ./ci/mcp.json

# User-level export in ~/.claude (agents, skills, commands, settings, hooks, ~/.claude/.mcp.json)
oc-export-claude --global --force

# Include the Android module (android, mobile-tester, android-dev skill)
oc-export-claude --android --out .claude

# Inspect the plan without writing anything
oc-export-claude --dry-run

# Start Claude Code with the CEO as the session agent
claude --agent ceo
```

Options: `--out DIR`, `--mcp-out FILE`, `--global`, `--android`, `--force`, `--dry-run`,
`--config DIR`, `-h/--help`.
Exit codes: `0` success, `1` export error, `2` usage error. The target must be empty unless
`--force` is given; `--global` and `--out` are mutually exclusive.

From a repository checkout, run the launcher `config/bin/oc-export-claude` (or
`node scripts/export-claude.mjs`). After `install.sh`, `oc-export-claude` is in `~/.local/bin` and
resolves the exporter from `<config>/libexec/export-claude.mjs`.

## Generated tree

```
.claude/
  CLAUDE.md                    project instructions (kit AGENTS.md + model routing)
  agents/<name>.md             one file per agent, plus fixed variants
  skills/<name>/SKILL.md       copied verbatim (subdirectories included)
  commands/<name>.md           agent:/subtask: converted to context: fork
  settings.json                default agent, permissions, hooks
  hooks/guard.mjs              PreToolUse guard (exit 2 blocks)
  hooks/notify.mjs             Stop notification
  .oc-export-manifest.json     list of generated files (idempotence check)
.mcp.json                      project root: MCP servers, read by Claude Code
```

`.mcp.json` is written to the parent of `--out` (the project root): `--out .claude` produces
`./.mcp.json`, not `.claude/.mcp.json`. `--mcp-out FILE` overrides the destination. A `--global`
export writes `~/.claude/.mcp.json` instead (see [MCP servers](#mcp-servers)).

The export never touches the kit sources. `.claude/` and `.oc-export-manifest.json` are ignored by
Git in this repository: generated output is not committed. The root `.mcp.json` is **not** ignored:
it is a normal project file, commit it when the servers are portable (no machine-specific paths),
or add it to the project's own `.gitignore` otherwise.

## Model routing

The `model` frontmatter is a default; a per-call `model:` alias on the `Agent` tool overrides it.
The CEO prompt requires an explicit alias on every call:

| Model | Use for | Agents |
|---|---|---|
| `haiku` | reading, mechanical edits, status checks, simple searches | `researcher`, `web-researcher`, `rust-haiku` |
| `sonnet` | implementation, tests, docs, integration, routine fixes | `rust`, `backend`, `frontend`, `database`, `devops`, `docker`, `ansible`, `terraform`, `kubernetes`, `qa`, `debugger`, `docs`, `code-simplifier`, `pentest`, `reverse-engineer` |
| `opus` | architecture, security, review, arbitration, ambiguous bugs | `ceo`, `architect`, `security`, `review`, `verify-app`, `integrator`, `designer` |

Rules encoded in `CLAUDE.md` and in the CEO agent: never `opus` for mechanical work, never `haiku`
for security/review/architecture, an ambiguous bug starts on `sonnet` (`debugger`) and escalates to
`opus` after one attempt.

### Fixed variants

A variant repeats an existing agent body with a pinned tier, so the tier survives a call that
forgets `model:`:

| Variant | Base agent | Tier |
|---|---|---|
| `rust-haiku` | `rust` | `haiku` |
| `review-opus` | `review` | `opus` |
| `architect-opus` | `architect` | `opus` |

Variants are skipped when their base agent is not exported (for example a reduced configuration
passed with `--config`).

## MCP servers

The MCP file is generated from the enabled servers of `config/opencode.jsonc`: `remote` becomes
`http`, `local` becomes `stdio` with `command`/`args`/`env`, and `{env:VAR}` is rewritten to
`${VAR}` (for example `{env:HOME}` -> `${HOME}`). Disabled servers are omitted.

### Project export

Claude Code reads the **project** file at `<project>/.mcp.json`, at the repository root, not inside
`.claude/`. The exporter therefore writes it to `<out>/../.mcp.json`: with `--out .claude` (the
default) that is `./.mcp.json`, ready to use. `--mcp-out FILE` writes it elsewhere instead:

```bash
oc-export-claude --out .claude                    # MCP file -> ./.mcp.json
oc-export-claude --out .claude --mcp-out mcp.json # explicit path (relative to the cwd)
```

The first session asks for approval of the project servers (`/mcp`). `claude mcp list` shows their
state. An existing root `.mcp.json` that differs from the generated content is never overwritten
silently: the export stops with an error unless `--force` is given, so hand-written servers are not
lost by accident.

### Global export

Claude Code stores **user-scope** servers in `~/.claude.json` (top-level `mcpServers`), not in
`~/.claude/.mcp.json`. A `--global` export writes `~/.claude/.mcp.json` for reference and prints
the same note, but Claude Code does not read that file: register the servers explicitly.

```bash
# One command per server, at user scope (repeat for the servers you need)
claude mcp add --scope user --transport http context7 https://mcp.context7.com/mcp
claude mcp add --scope user --transport stdio playwright -- "$HOME/.local/bin/oc-playwright-mcp"
claude mcp add --scope user --transport stdio kubernetes -- npx -y kubernetes-mcp-server@0.1.1 --config "$HOME/.config/opencode/k8s-mcp.toml"

# Or merge every generated server into ~/.claude.json (back it up first)
cp ~/.claude.json ~/.claude.json.bak
node -e 'const fs=require("fs"),p=require("path"),h=require("os").homedir(),f=p.join(h,".claude.json"),g=JSON.parse(fs.readFileSync(p.join(h,".claude",".mcp.json"),"utf8")),c=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};c.mcpServers={...c.mcpServers,...g.mcpServers};fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")'
```

## Hooks

`settings.json` wires two generated hooks:

- `PreToolUse` (`hooks/guard.mjs`), on `Bash` and on `Read|Write|Edit|NotebookEdit`: reads the hook
  JSON on stdin and exits `2` with a reason to block. It rejects `rm -rf /`/`~`, `git push --force`
  (except `--force-with-lease`), `git reset --hard`, `git clean -fdx`, `git stash`, `curl | sh`,
  and reads of `.env`, `.ssh/id_*`, `.aws/credentials`, `.npmrc`, `.git-credentials`. Malformed
  input fails open. This is a textual guardrail, not a security boundary: it sees neither shell
  aliases, nor variables, nor script contents.
- `Stop` (`hooks/notify.mjs`): desktop notification through `notify-send` (Linux), `osascript`
  (macOS) or PowerShell (Windows), with a `stop_hook_active` loop guard.

`permissions.deny` also blocks the dangerous Git and `rm` commands, and `permissions.allow` opens
`Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`.

## Limits

- **Global MCP needs one explicit step**: the project export writes `<project>/.mcp.json` directly,
  but `--global` cannot register user-scope servers by itself (`~/.claude/.mcp.json` is not read).
  Run `claude mcp add -s user ...` or merge the file into `~/.claude.json`.
- **No temperature**: Claude Code does not support it; the OpenCode `temperature` values are dropped.
- **Per-call model is best effort**: the harness may fall back when a model is unavailable.
- **`--agent ceo` replaces the system prompt**: the session runs the CEO agent body; `CLAUDE.md`
  still loads as project memory.
- **MemPalace is not ported**: `mempalace_memory` is an OpenCode plugin. The exported instructions
  keep the calls; in Claude Code they are unavailable unless an equivalent MCP server is configured.
- **Kit launchers are shell commands**: `agent-wt`, `oc-*` stay in `~/.local/bin` and are callable
  through Bash, not as Claude Code tools.
- **Skills are copied verbatim**: a skill written in French keeps its accents, unlike the generated
  agent/command/CLAUDE.md files.
