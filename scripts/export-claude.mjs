#!/usr/bin/env node
// Export the opencode-prerequisites kit to Claude Code format.
//
//   node scripts/export-claude.mjs --out .claude
//   node scripts/export-claude.mjs --global --force
//   node scripts/export-claude.mjs --android --out /tmp/claude-android
//
// Node ESM only, no dependency. The output is deterministic: the same kit sources
// always produce the same tree, so a re-export with --force is a no-op diff.
//
// Mapping summary:
//   config/agents/*.md        -> .claude/agents/<name>.md (frontmatter + adapted body)
//   config/skills/<name>/     -> .claude/skills/<name>/ (copied verbatim)
//   config/commands/*.md      -> .claude/commands/*.md (agent -> context: fork + agent)
//   config/AGENTS.md          -> .claude/CLAUDE.md (+ model routing)
//   config/opencode.jsonc     -> <project>/.mcp.json (enabled servers only; root, not .claude/)
//                             -> .claude/settings.json (permissions + hooks)
//   --global                  -> ~/.claude/.mcp.json (not read by Claude Code: see the printed note)
//   generated                 -> .claude/hooks/guard.mjs, .claude/hooks/notify.mjs
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MANIFEST = ".oc-export-manifest.json"

// Model tiers of the kit. The CEO is opus; the rest is a deliberate split:
// opus for judgment, haiku for reading, sonnet for everything that produces code.
const OPUS_AGENTS = new Set(["ceo", "architect", "security", "review", "verify-app", "integrator", "designer"])
const HAIKU_AGENTS = new Set(["researcher", "web-researcher"])

// Fixed variants: a tier that survives a forgotten per-call `model:` alias.
const VARIANTS = [
  { name: "rust-haiku", base: "rust", model: "haiku" },
  { name: "review-opus", base: "review", model: "opus" },
  { name: "architect-opus", base: "architect", model: "opus" },
]

// Claude Code built-in agents referenced by the CEO prompt. Names are case-sensitive:
// the built-ins are `Explore` and `general-purpose` (not the OpenCode `explore`/`general`).
const BUILTIN_AGENTS = ["Explore", "general-purpose"]
const BUILTIN_MENTIONS = { explore: "Explore", general: "general-purpose" }

const HELP = [
  "Export the opencode-prerequisites kit to Claude Code format.",
  "",
  "Usage:",
  "  oc-export-claude [--out DIR] [--mcp-out FILE] [--global] [--android] [--force] [--dry-run]",
  "",
  "Options:",
  "  --out DIR     target directory (default: ./.claude)",
  "  --mcp-out FILE  write the MCP file there (default: project root <out>/../.mcp.json;",
  "                  with --global: ~/.claude/.mcp.json)",
  "  --global      write to ~/.claude (user-level agents, skills, commands, settings)",
  "  --android     include the Android module agents and skills",
  "  --force       overwrite an existing export (required when the target is not empty)",
  "  --dry-run     print the files that would be written, write nothing",
  "  --config DIR  read another kit configuration (default: this repository's config/)",
  "  -h, --help    show this help",
  "",
  "Exit codes: 0 success, 1 export error, 2 usage error.",
].join("\n")

const ROUTING_LINES = [
  "## Model routing (mandatory)",
  "",
  "Every `Agent` call MUST pass an explicit `model` alias. The alias chosen at call time",
  "wins over the agent frontmatter, so this is how work is routed.",
  "",
  "| Model | Use for | Examples |",
  "|---|---|---|",
  "| `haiku` | reading, mechanical edits, status checks, simple searches | `researcher`, `web-researcher`, `rust-haiku` |",
  "| `sonnet` | implementation, tests, docs, integration, routine fixes | `rust`, `backend`, `frontend`, `database`, `devops`, `qa`, `debugger`, `docs` |",
  "| `opus` | architecture, security, review, arbitration, ambiguous bugs | `architect`, `security`, `review`, `verify-app`, `integrator`, `designer` |",
  "",
  "Rules:",
  '- Pass `model: "haiku"`, `model: "sonnet"` or `model: "opus"` on EVERY `Agent` call. No exception.',
  "- Never use `opus` for mechanical work (renames, formatting, status, simple searches): use `haiku`.",
  "- Never use `haiku` for security, review, architecture or an ambiguous bug: use `opus`.",
  "- An ambiguous bug starts on `sonnet` (`debugger`); escalate to `opus` when the cause is still unclear after one attempt.",
  "- The fixed variants `rust-haiku`, `review-opus` and `architect-opus` guarantee a tier even if a call forgets `model:`.",
  "- Do not run the same task twice at two tiers to compare: pick one.",
]

function fail(message, code = 2) {
  process.stderr.write("oc-export-claude: " + message + "\n")
  process.exit(code)
}

function parseArgs(argv) {
  const args = { out: null, mcpOut: null, global: false, android: false, force: false, dryRun: false, config: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--out") {
      const v = argv[++i]
      if (!v) fail("--out requires a directory")
      args.out = v
    } else if (a === "--mcp-out") {
      const v = argv[++i]
      if (!v) fail("--mcp-out requires a file")
      args.mcpOut = v
    } else if (a === "--global") {
      args.global = true
    } else if (a === "--android") {
      args.android = true
    } else if (a === "--force") {
      args.force = true
    } else if (a === "--dry-run") {
      args.dryRun = true
    } else if (a === "--config") {
      const v = argv[++i]
      if (!v) fail("--config requires a directory")
      args.config = v
    } else if (a === "-h" || a === "--help") {
      args.help = true
    } else {
      fail("unknown option: " + a)
    }
  }
  if (args.global && args.out) fail("--global and --out are mutually exclusive")
  return args
}

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir()
}

function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir).sort()
  } catch {
    return []
  }
}

function listMarkdown(dir) {
  return listDir(dir).filter((f) => f.endsWith(".md"))
}

function read(p) {
  return fs.readFileSync(p, "utf8")
}

// --- Minimal YAML frontmatter reader (top-level scalars + one nested level). ---------------
function scalar(value) {
  const v = value.trim()
  if (v === "true") return true
  if (v === "false") return false
  if (/^-?\d+$/.test(v)) return Number(v)
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v)
    } catch {
      return v.slice(1, -1)
    }
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1)
  return v
}

function unquoteKey(key) {
  const k = key.trim()
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) return k.slice(1, -1)
  return k
}

function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md)
  if (!m) return { data: {}, body: md }
  const data = {}
  let top = null
  let sub = null
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue
    const indent = (raw.match(/^\s*/) ?? [""])[0].length
    const line = raw.trim()
    const kv = /^([^:]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = unquoteKey(kv[1])
    const value = kv[2]
    if (indent === 0) {
      if (value === "") {
        data[key] = {}
        top = key
        sub = null
      } else {
        data[key] = scalar(value)
        top = null
        sub = null
      }
    } else if (indent <= 2 && top && data[top] && typeof data[top] === "object") {
      if (value === "") {
        data[top][key] = {}
        sub = key
      } else {
        data[top][key] = scalar(value)
        sub = null
      }
    } else if (top && sub && data[top] && typeof data[top][sub] === "object") {
      data[top][sub][key] = scalar(value)
    }
  }
  return { data, body: md.slice(m[0].length) }
}

// --- Minimal JSONC reader: comments and trailing commas, no dependency. -------------------
function parseJsonc(text) {
  let out = ""
  let i = 0
  let inStr = false
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (inStr) {
      out += c
      if (c === "\\") {
        out += n ?? ""
        i += 2
        continue
      }
      if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      i++
      continue
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (c === "/" && n === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  out = out.replace(/,(\s*[}\]])/g, "$1")
  return JSON.parse(out)
}

function mcpServers(cfg) {
  const m = cfg && cfg.mcp ? cfg.mcp : {}
  if (m.servers && typeof m.servers === "object") return m.servers
  return Object.fromEntries(Object.entries(m).filter(([k, v]) => k !== "timeout" && v && typeof v === "object"))
}

// --- Layout discovery ---------------------------------------------------------------------
// Repository:   <root>/scripts/export-claude.mjs  + <root>/config/
// Installed:    <config>/libexec/export-claude.mjs (config/ is copied as-is by install.sh)
function locateConfig(args) {
  if (args.config) {
    const dir = path.resolve(args.config)
    if (!exists(path.join(dir, "opencode.jsonc"))) fail("no opencode.jsonc in " + dir, 1)
    return { config: dir, root: path.dirname(dir), installed: false }
  }
  const repo = path.resolve(HERE, "..")
  if (exists(path.join(repo, "config", "opencode.jsonc"))) return { config: path.join(repo, "config"), root: repo, installed: false }
  const installed = path.resolve(HERE, "..")
  if (exists(path.join(installed, "opencode.jsonc"))) return { config: installed, root: null, installed: true }
  if (exists(path.join(HERE, "opencode.jsonc"))) return { config: HERE, root: path.dirname(HERE), installed: true }
  fail("kit configuration not found (looked for config/opencode.jsonc next to " + HERE + ")", 1)
  return null
}

// --- Agents -------------------------------------------------------------------------------
function collectAgents(layout, android) {
  const agents = []
  const core = path.join(layout.config, "agents")
  for (const f of listMarkdown(core)) {
    const file = path.join(core, f)
    const parsed = parseFrontmatter(read(file))
    agents.push({ name: path.basename(f, ".md"), file, fm: parsed.data, body: parsed.body })
  }
  if (android && layout.root) {
    const addon = path.join(layout.root, "addons", "android", "agents")
    for (const f of listMarkdown(addon)) {
      const file = path.join(addon, f)
      const parsed = parseFrontmatter(read(file))
      agents.push({ name: path.basename(f, ".md"), file, fm: parsed.data, body: parsed.body })
    }
  }
  return agents
}

function modelFor(name) {
  if (OPUS_AGENTS.has(name)) return "opus"
  if (HAIKU_AGENTS.has(name)) return "haiku"
  return "sonnet"
}

function colorFor(model, name) {
  if (name === "ceo") return "red"
  if (model === "opus") return "purple"
  if (model === "haiku") return "cyan"
  return "blue"
}

const TOOL_ORDER = ["Read", "Grep", "Glob", "TodoWrite", "Skill", "WebFetch", "WebSearch", "Bash", "Write", "Edit", "NotebookEdit", "Agent", "Task"]

function toolRank(tool) {
  if (tool.startsWith("Bash(")) return 8
  if (tool.startsWith("mcp__")) return 20
  const i = TOOL_ORDER.indexOf(tool)
  return i === -1 ? 30 : i
}

function sortTools(tools) {
  return [...tools].sort((a, b) => toolRank(a) - toolRank(b) || a.localeCompare(b))
}

// OpenCode permission -> Claude Code tools/disallowedTools.
// Defaults follow the kit's global config: edit, bash, webfetch, websearch and task allowed.
function mapTools(agent) {
  const p = agent.fm.permission && typeof agent.fm.permission === "object" ? agent.fm.permission : {}
  const tools = new Set(["Read", "Grep", "Glob", "TodoWrite", "Skill"])
  const denied = new Set()

  if (p.webfetch === "deny") denied.add("WebFetch")
  else tools.add("WebFetch")
  if (p.websearch === "deny") denied.add("WebSearch")
  else tools.add("WebSearch")

  if (p.edit === "deny") {
    denied.add("Write")
    denied.add("Edit")
    denied.add("NotebookEdit")
  } else {
    tools.add("Write")
    tools.add("Edit")
    tools.add("NotebookEdit")
  }

  if (p.bash === "deny") {
    denied.add("Bash")
  } else if (p.bash && typeof p.bash === "object") {
    if (p.bash["*"] === "allow") tools.add("Bash")
    for (const [pattern, value] of Object.entries(p.bash)) {
      if (pattern === "*" || value !== "allow") continue
      tools.add("Bash(" + pattern + ")")
    }
  } else {
    tools.add("Bash")
  }

  if (p.task === "deny") {
    denied.add("Agent")
    denied.add("Task")
  } else {
    tools.add("Agent")
  }

  // MCP wildcards: "chrome-devtools_*": allow -> mcp__chrome-devtools__*.
  // Claude Code requires the trailing `__*` to grant every tool of a server; a bare
  // `mcp__chrome-devtools` would match no tool at all.
  for (const [key, value] of Object.entries(p)) {
    if (!key.endsWith("_*") || value !== "allow") continue
    tools.add("mcp__" + key.slice(0, -2) + "__*")
  }

  return { tools: sortTools(tools), disallowedTools: [...denied].sort() }
}

function maxTurns(agent) {
  const n = Number(agent.fm.steps)
  return Number.isFinite(n) && n > 0 ? n : null
}

function isWriter(agent) {
  const p = agent.fm.permission && typeof agent.fm.permission === "object" ? agent.fm.permission : {}
  return p.edit !== "deny"
}

function renderAgent({ name, description, model, tools, disallowedTools, turns, permissionMode, body }) {
  const lines = [
    "---",
    "name: " + name,
    "description: " + JSON.stringify(String(description)),
    "tools: " + tools,
  ]
  if (disallowedTools && disallowedTools.length) lines.push("disallowedTools: " + disallowedTools.join(", "))
  lines.push("model: " + model)
  lines.push("color: " + colorFor(model, name))
  if (turns) lines.push("maxTurns: " + turns)
  if (permissionMode) lines.push("permissionMode: " + permissionMode)
  lines.push("---", "")
  return lines.join("\n") + body.trimEnd() + "\n"
}

// --- Body adaptation ----------------------------------------------------------------------
// OpenCode specifics are rewritten to Claude Code ones: @agent -> Agent(name),
// the `subagent` tool -> `Agent`, skill({ name }) -> Skill(name), background -> run_in_background.
// `agent-wt` and the `oc-*` launchers are kept: they are shell commands installed in PATH,
// still usable through Bash (see the "Claude Code specifics" section of CLAUDE.md).
//
// Only names in `mentions` are converted: source text also contains `@ts-ignore`,
// `@typescript-eslint` and similar non-agent mentions that must survive verbatim.
function adaptText(text, mentions) {
  return text
    .replace(/\bA subagent\b/g, "An Agent")
    .replace(/\ba subagent\b/g, "an Agent")
    .replace(/\bsubagents\b/g, "Agents")
    .replace(/\bsubagent\b/g, "Agent")
    .replace(/skill\(\{ name: "([a-z0-9-]+)" \}\)/g, "Skill($1)")
    .replace(/background: true/g, "run_in_background: true")
    .replace(/(^|[^A-Za-z0-9_@])@([a-z][a-z0-9-]+)/g, (match, pre, name) => {
      if (Object.hasOwn(BUILTIN_MENTIONS, name)) return pre + "Agent(" + BUILTIN_MENTIONS[name] + ")"
      if (!mentions || !mentions.has(name)) return match
      return pre + "Agent(" + name + ")"
    })
}

function buildAgentFile(agent, override, mentions) {
  const name = override ? override.name : agent.name
  const model = override ? override.model : modelFor(agent.name)
  const mapped = mapTools(agent)
  const description = override
    ? String(agent.fm.description || "") + " Fixed variant: same instructions, model " + model + "."
    : String(agent.fm.description || "")
  return renderAgent({
    name,
    description,
    model,
    tools: mapped.tools.join(", "),
    disallowedTools: mapped.disallowedTools,
    turns: maxTurns(agent),
    permissionMode: isWriter(agent) ? "acceptEdits" : null,
    body: adaptText(agent.body, mentions),
  })
}

function buildCeoFile(agent, agentNames, mentions) {
  const body = adaptText(agent.body, mentions)
  const routing = ROUTING_LINES.join("\n")
  const withRouting = body.includes("## Delegation reflex")
    ? body.replace("## Delegation reflex", routing + "\n\n## Delegation reflex")
    : routing + "\n\n" + body
  const tools = "Agent(" + agentNames.join(", ") + "), Read, Grep, Glob, TodoWrite, Skill"
  return renderAgent({
    name: "ceo",
    description: agent.fm.description || "Director (CEO)",
    model: "opus",
    tools,
    disallowedTools: ["Write", "Edit", "NotebookEdit"],
    turns: maxTurns(agent),
    permissionMode: null,
    body: withRouting,
  })
}

// --- Skills and commands ------------------------------------------------------------------
function collectSkillDirs(layout, android) {
  const dirs = []
  const core = path.join(layout.config, "skills")
  for (const d of listDir(core)) {
    const src = path.join(core, d)
    if (exists(src) && fs.statSync(src).isDirectory()) dirs.push({ name: d, src })
  }
  if (android && layout.root) {
    const addon = path.join(layout.root, "addons", "android", "skills")
    for (const d of listDir(addon)) {
      const src = path.join(addon, d)
      if (exists(src) && fs.statSync(src).isDirectory()) dirs.push({ name: d, src })
    }
  }
  return dirs
}

function walkFiles(dir, base = dir) {
  const out = []
  for (const name of listDir(dir)) {
    const full = path.join(dir, name)
    const st = fs.lstatSync(full)
    if (st.isDirectory()) out.push(...walkFiles(full, base))
    else if (st.isFile()) out.push({ full, rel: path.relative(base, full), mode: st.mode & 0o777 })
  }
  return out
}

function buildCommandFile(file, exportedAgents, mentions) {
  const parsed = parseFrontmatter(read(file))
  const name = path.basename(file, ".md")
  let agent = parsed.data.agent ? String(parsed.data.agent) : null
  // OpenCode built-in "plan" maps to the kit architect.
  if (agent === "plan") agent = "architect"
  if (agent && !exportedAgents.includes(agent)) {
    fail("command " + name + " targets unknown agent " + agent, 1)
  }
  // `subtask: true` runs the command in a subagent even when no agent is named;
  // `context: fork` is the Claude Code equivalent. `agent:` only applies with a fork.
  const fork = parsed.data.subtask === true || Boolean(agent)
  const lines = ["---", "description: " + JSON.stringify(String(parsed.data.description || "Command " + name))]
  if (fork) lines.push("context: fork")
  if (agent) lines.push("agent: " + agent)
  lines.push("---", "")
  return lines.join("\n") + adaptText(parsed.body, mentions).trim() + "\n"
}

// --- MCP ----------------------------------------------------------------------------------
function expandEnv(value) {
  return String(value).replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => "${" + name + "}")
}

function expandMap(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) out[k] = expandEnv(v)
  return out
}

function buildMcp(cfg) {
  const servers = {}
  for (const name of Object.keys(mcpServers(cfg)).sort()) {
    const server = mcpServers(cfg)[name]
    if (!server || server.disabled === true || server.enabled === false) continue
    if (server.type === "remote") {
      const entry = { type: "http", url: expandEnv(server.url || "") }
      if (server.headers && typeof server.headers === "object") entry.headers = expandMap(server.headers)
      servers[name] = entry
      continue
    }
    const command = Array.isArray(server.command)
      ? server.command.map((part) => expandEnv(part))
      : [expandEnv(server.command || "")]
    if (!command[0]) continue
    const entry = { type: "stdio", command: command[0], args: command.slice(1) }
    if (server.environment && typeof server.environment === "object") entry.env = expandMap(server.environment)
    else if (server.env && typeof server.env === "object") entry.env = expandMap(server.env)
    servers[name] = entry
  }
  return { mcpServers: servers }
}

// --- Settings and hooks -------------------------------------------------------------------
function hookCommand(outDir, file, global) {
  if (global) return 'node "$HOME/.claude/hooks/' + file + '"'
  // The default project export: ${CLAUDE_PROJECT_DIR} stays correct when Claude Code
  // is started from a subdirectory of the repository. A custom --out is outside that
  // convention, so it gets an absolute path instead.
  if (path.resolve(outDir) === path.resolve(".claude")) {
    return 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/' + file + '"'
  }
  return "node " + JSON.stringify(path.join(outDir, "hooks", file))
}

function buildSettings(outDir, global) {
  const guard = hookCommand(outDir, "guard.mjs", global)
  const notify = hookCommand(outDir, "notify.mjs", global)
  return {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    agent: "ceo",
    permissions: {
      allow: ["Read", "Grep", "Glob", "WebFetch", "WebSearch"],
      deny: [
        "Bash(git push --force*)",
        "Bash(git push -f*)",
        "Bash(rm -rf /*)",
        "Bash(git reset --hard*)",
        "Bash(git clean -fdx*)",
        "Bash(git stash*)",
      ],
    },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: guard }] },
        { matcher: "Read|Write|Edit|NotebookEdit", hooks: [{ type: "command", command: guard }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: notify, timeout: 10 }] }],
    },
  }
}

// --- CLAUDE.md ----------------------------------------------------------------------------
function buildClaudeMd(agentsMd, mentions) {
  const lines = [
    "# Claude Code project instructions",
    "",
    "> Generated by `oc-export-claude` from the opencode-prerequisites kit. Do not edit by hand:",
    "> change the kit sources and re-export with `--force`.",
    "",
    "## Start here",
    '- Default agent: the CEO. Run `claude --agent ceo` (or keep `"agent": "ceo"` in `.claude/settings.json`).',
    "- Reply in the user's language: match the language of the latest user message, short and direct.",
    "- The CEO delegates; specialists never ask for confirmation and report done / evidence / remaining / questions.",
    "",
    ...ROUTING_LINES,
    "",
    "## Claude Code specifics",
    "- Agents live in `.claude/agents/<name>.md` (project) or `~/.claude/agents/` (global). The `model`",
    "  frontmatter is a default; a per-call `model:` alias on the `Agent` tool overrides it.",
    "- Fixed variants: `rust-haiku` (cheap mechanical Rust), `review-opus` (deep review),",
    "  `architect-opus` (architecture arbitration). Same instructions, fixed tier.",
    "- `--agent ceo` replaces the session system prompt with the CEO agent body; CLAUDE.md still",
    "  loads as project memory.",
    "- Worktrees: one git worktree per parallel task (`git worktree add .worktrees/<task> -b agent/<task>`).",
    "  The kit's `agent-wt` launcher still works from a shell when it is installed.",
    "- Kit launchers (`agent-wt`, `oc-*`) are shell commands in `~/.local/bin`, callable through Bash;",
    "  they are not Claude Code tools.",
    "- Skills: `.claude/skills/<name>/SKILL.md`. Commands: `.claude/commands/*.md` (`$ARGUMENTS`, `!command`).",
    "  A command with `subtask: true` becomes `context: fork`; `agent:` selects the subagent.",
    "- MCP: the project export writes `.mcp.json` at the project root (not inside `.claude/`);",
    "  approve the servers once through `/mcp`. A global export writes `~/.claude/.mcp.json`,",
    "  which Claude Code does not read: add user-scope servers with `claude mcp add -s user`",
    "  (or merge them into `~/.claude.json`).",
    "- MemPalace is an OpenCode plugin: `mempalace_memory` is not available in Claude Code. Skip those",
    "  calls, or configure an equivalent MCP server.",
    "- Hooks: `settings.json` -> `hooks/guard.mjs` (PreToolUse, exit 2 blocks) and `hooks/notify.mjs`",
    "  (Stop). The guard is a textual guardrail, not a security boundary.",
    "- Temperature is not supported by Claude Code: the OpenCode `temperature` values are dropped.",
    "- Per-call model choice is best effort: the harness may fall back when a model is unavailable.",
    "",
    "---",
    "",
    adaptText(agentsMd, mentions).trimEnd(),
    "",
  ]
  return lines.join("\n")
}

// --- Hooks (generated sources; String.raw keeps the backslashes of the regexes) -----------
const GUARD_SOURCE = String.raw`#!/usr/bin/env node
// Claude Code PreToolUse guard, generated by oc-export-claude from the kit guard plugin.
// Reads the hook JSON on stdin, exits 2 with a reason to block the tool call.
// Textual guardrail, not a barrier: it sees neither aliases, nor variables, nor script contents.
import { readFileSync } from "node:fs"

const SECRET_FILES = /(^|\/)(\.env(\..+)?|\.npmrc|\.git-credentials|\.aws\/credentials|id_(rsa|dsa|ecdsa|ed25519)|credentials\.json|.*\.pem)$/i

const DANGEROUS = [
  /\brm\s+-rf?\s+(\/|~|\$HOME)(\s|$)/,
  /\bgit\s+push\b.*--force(?!-with-lease)/,
  /\bgit\s+reset\s+--hard\b.*origin/,
  /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE)\b/i,
  /\bcurl\b[^|]*\|\s*(ba)?sh\b/,
  /\bgit\s+stash\b/,
  /\bgit\s+clean\s+-[a-z]*f[a-z]*x/,
]

const unquote = (s) => s.replace(/["']/g, "")
const segments = (s) => unquote(s).split(/[;&|\n]+/)

const SECRET_PATH = [
  /(?:^|[\s=:(])(?:[^\s;&|<>()]*\/)?\.env(?:\.[\w-]+)?(?=$|[\s;&|<>()])/i,
  /(?:^|[\s=:(])(?:[^\s;&|<>()]*\/)?\.ssh\/id_(?:rsa|dsa|ecdsa|ed25519)\b(?!\.pub)/i,
  /(?:^|[\s=:(])[^\s;&|<>()]*\.aws\/credentials/i,
  /(?:^|[\s=:(])[^\s;&|<>()]*\.npmrc(?=$|[\s;&|<>()])/i,
  /(?:^|[\s=:(])[^\s;&|<>()]*\.git-credentials/i,
]
const SECRET_EXAMPLE = /[^\s;&|<>()]*\.env\.example\b/gi
const hasSecretPath = (s) => SECRET_PATH.some((re) => re.test(s.replace(SECRET_EXAMPLE, "")))

const SECRET_READ_TOOLS = /\b(cat|cp|mv|base64|xxd|strings|tar|zip|scp|rsync)\b/i
const SECRET_READ_EXEMPT = /^(?:(?:sudo|command)\s+)*(?:cp|mv)\s+(?:-[\w-]+\s+)*[^\s;&|]*\.env\.example\s+[^\s;&|]*\.env(?:\.[\w.-]+)?(?:\s+(?:#.*|[012]?>\s*\S+|2>&1))?$/i
const isSecretRead = (command) => segments(command).some((seg) => SECRET_READ_TOOLS.test(seg) && hasSecretPath(seg) && !SECRET_READ_EXEMPT.test(seg.trim()))

const DESTRUCTIVE_TARGETS = new Set(["/", "/*", "~", "~/*", "$HOME", "$HOME/*", "\${HOME}", "\${HOME}/*", "~/.config", "~/.config/*", "~/.ssh", "~/.ssh/*", "$HOME/.config", "$HOME/.config/*", "\${HOME}/.config", "\${HOME}/.config/*", "$HOME/.ssh", "$HOME/.ssh/*", "\${HOME}/.ssh", "\${HOME}/.ssh/*"])
const isDestructiveRm = (command) => segments(command).some((seg) => {
  const m = seg.match(/\brm\b(.*)$/i)
  if (!m) return false
  const rest = m[1]
  const flags = [...rest.matchAll(/(?:^|\s)(--[\w-]+|-[A-Za-z]+)(?=\s|$)/g)].map((x) => x[1].toLowerCase())
  const recursive = flags.some((f) => f === "--recursive" || /^-[a-z]*r/.test(f))
  const force = flags.some((f) => f === "--force" || /^-[a-z]*f/.test(f))
  if (!recursive || !force) return false
  const targets = rest.replace(/(?:^|\s)(?:--[\w-]+|-[A-Za-z]+)(?=\s|$)/g, " ").trim().split(/\s+/).filter(Boolean)
  return targets.some((raw) => {
    const t = raw.replace(/["'\x60]/g, "").replace(/\/+$/, "") || "/"
    return DESTRUCTIVE_TARGETS.has(t) || /^(?:.*\/)?\.git(?:\/\*)?$/.test(t)
  })
})

const isDangerousGit = (command) => segments(command).some((seg) => {
  const s = seg.trim()
  if (/\bgit\s+push\b/.test(s)) {
    if (/(?:^|\s)--force(?!-with-lease)(?:\s|$)/.test(s)) return true
    if (/(?:^|\s)-[a-z]*f(?:\s|$)/i.test(s)) return true
  }
  if (/\bgit\s+reset\b.*?\s--hard(?:\s|$)/.test(s)) return true
  if (/\bgit\s+filter-branch\b/.test(s)) return true
  if (/\bgit\s+clean\b/.test(s)) {
    const flags = [...s.matchAll(/(?:^|\s)(--[\w-]+|-[a-z]+)(?=\s|$)/gi)].map((x) => x[1].toLowerCase())
    const dry = flags.some((f) => f === "--dry-run" || /^-[a-z]*n/.test(f))
    const force = flags.some((f) => f === "--force" || /^-[a-z]*f/.test(f))
    if (!dry && force && flags.some((f) => /[dx]/.test(f))) return true
  }
  return false
})

const DOWNLOAD_EXEC = [
  /\b(?:curl|wget)\b[^|]*\|\s*(?:(?:sudo|env)\s+(?:-\S+\s+)*)*(?:ba)?sh\b/,
  /\bcurl\b[^;&|]*?(?:\s-o\s+|\s--output[=\s]+|\s-O\b|\s>)[^;&|]*?(?:&&|;|\n)[^;&|]*\b(?:ba)?sh\b/,
  /\bwget\b[^;&|]*?(?:&&|;|\n)[^;&|]*\b(?:ba)?sh\b/,
  /\beval\b[^;&|]*(?:\$\(|\x60)[^)]*(?:curl|wget)\b/,
  /\b(?:ba)?sh\b[^;&|]*(?:\$\(|\x60)[^)]*(?:curl|wget)\b/,
  /\b(?:ba)?sh\s+<\(\s*(?:curl|wget)\b/,
  /\b(?:source|\.)\s+<\(\s*(?:curl|wget)\b/,
]
const isDownloadExec = (command) => DOWNLOAD_EXEC.some((re) => re.test(unquote(command)))

function block(reason) {
  process.stderr.write("Blocked by guard: " + reason + "\n")
  process.exit(2)
}

function main() {
  let raw = ""
  try {
    raw = readFileSync(0, "utf8")
  } catch {
    process.exit(0)
  }
  if (!raw.trim()) process.exit(0)
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    process.exit(0)
  }
  const input = data.tool_input || data.input || {}
  const file = String(input.file_path || input.filePath || input.path || "").replace(/\\/g, "/")
  const command = String(input.command || input.cmd || "")
  if (file && SECRET_FILES.test(file) && !file.endsWith(".env.example")) block("secret file " + file)
  if (command) {
    if (DANGEROUS.some((re) => re.test(command)) || isSecretRead(command) || isDestructiveRm(command) || isDangerousGit(command) || isDownloadExec(command)) {
      block(command)
    }
  }
  process.exit(0)
}

main()
`

const NOTIFY_SOURCE = String.raw`#!/usr/bin/env node
// Claude Code Stop hook, generated by oc-export-claude: desktop notification when a turn ends.
// Never disturbs the session: errors are swallowed and the hook always exits 0.
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"

const MESSAGE = "Turn finished (check running tasks)"
const TITLE = "Claude Code"

function payload() {
  try {
    const raw = readFileSync(0, "utf8")
    return raw.trim() ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function launch(cmd, args) {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" })
    child.on("error", () => process.stdout.write("\x07"))
    child.unref()
  } catch {
    process.stdout.write("\x07")
  }
}

const data = payload()
// A Stop hook that is already continuing must not notify again (loop guard).
if (data.stop_hook_active === true) process.exit(0)

if (process.platform === "darwin") {
  launch("osascript", ["-e", 'display notification "' + MESSAGE + '" with title "' + TITLE + '"'])
} else if (process.platform === "win32") {
  const ps = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$x = $t.GetElementsByTagName('text')",
    "$x.Item(0).AppendChild($t.CreateTextNode('" + TITLE + "')) > $null",
    "$x.Item(1).AppendChild($t.CreateTextNode('" + MESSAGE + "')) > $null",
    "$n = [Windows.UI.Notifications.ToastNotification]::new($t)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('" + TITLE + "').Show($n)",
  ].join("; ")
  launch("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps])
} else {
  launch("notify-send", [TITLE, MESSAGE])
}
process.exit(0)
`

// --- Plan, write, manifest ----------------------------------------------------------------
function addFile(plan, rel, data, mode) {
  plan.push({ rel: rel.split(path.sep).join("/"), data, mode })
}

function copySkill(plan, skill) {
  for (const file of walkFiles(skill.src)) {
    const rel = path.join("skills", skill.name, file.rel)
    addFile(plan, rel, fs.readFileSync(file.full), file.mode)
  }
}

function readManifest(outDir) {
  const file = path.join(outDir, MANIFEST)
  if (!exists(file)) return null
  try {
    const data = JSON.parse(read(file))
    return Array.isArray(data.files) ? data.files : null
  } catch {
    return null
  }
}

function pruneEmpty(dir, stop) {
  let current = dir
  while (current.startsWith(stop) && current !== stop) {
    try {
      if (fs.readdirSync(current).length) return
      fs.rmdirSync(current)
    } catch {
      return
    }
    current = path.dirname(current)
  }
}

function writePlan(outDir, plan, force) {
  if (force) {
    const old = readManifest(outDir)
    if (old) {
      const keep = new Set(plan.map((p) => p.rel))
      for (const rel of old) {
        if (keep.has(rel) || rel.includes("..") || path.isAbsolute(rel)) continue
        const target = path.join(outDir, rel)
        if (exists(target)) {
          fs.rmSync(target, { force: true })
          pruneEmpty(path.dirname(target), outDir)
        }
      }
    }
  }
  for (const entry of plan) {
    const target = path.join(outDir, entry.rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, entry.data)
    if (entry.mode) fs.chmodSync(target, entry.mode)
  }
}

// --- Main ---------------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP + "\n")
    return
  }

  const layout = locateConfig(args)
  const outDir = args.global ? path.join(homeDir(), ".claude") : path.resolve(args.out || ".claude")
  // Claude Code reads the project MCP file at <project>/.mcp.json, never inside .claude/.
  // The default is therefore the parent of the export directory; --mcp-out overrides it.
  const mcpFile = args.mcpOut
    ? path.resolve(args.mcpOut)
    : args.global
      ? path.join(outDir, ".mcp.json")
      : path.join(path.dirname(outDir), ".mcp.json")
  if (exists(mcpFile) && fs.statSync(mcpFile).isDirectory()) fail("--mcp-out must be a file, not a directory: " + mcpFile)
  const mcpRel = path.relative(outDir, mcpFile)
  const mcpInside = mcpRel !== "" && !mcpRel.startsWith("..") && !path.isAbsolute(mcpRel)

  const agents = collectAgents(layout, args.android)
  const byName = new Map(agents.map((a) => [a.name, a]))
  if (!byName.has("ceo")) fail("agents/ceo.md is missing from " + layout.config, 1)

  const variants = VARIANTS.filter((v) => byName.has(v.base))
  const variantNames = variants.map((v) => v.name)
  const agentNames = [...agents.map((a) => a.name).filter((n) => n !== "ceo"), ...variantNames, ...BUILTIN_AGENTS]
  // Mentions that must become Agent(...) calls. Anything else (`@ts-ignore`,
  // `@typescript-eslint`, an email address) is left untouched.
  const mentions = new Set([...agents.map((a) => a.name), ...variantNames])

  const skills = collectSkillDirs(layout, args.android)
  const commandDir = path.join(layout.config, "commands")
  const commands = listMarkdown(commandDir)

  let cfg
  try {
    cfg = parseJsonc(read(path.join(layout.config, "opencode.jsonc")))
  } catch (e) {
    fail("opencode.jsonc unreadable: " + (e instanceof Error ? e.message : String(e)), 1)
  }
  const mcp = buildMcp(cfg)

  const agentsMdFile = path.join(layout.config, "AGENTS.md")
  const agentsMd = exists(agentsMdFile)
    ? read(agentsMdFile)
    : "# Global rules\n\n- Reply in the user's language, short and direct.\n"

  const plan = []
  const mcpJson = JSON.stringify(mcp, null, 2) + "\n"
  addFile(plan, "CLAUDE.md", buildClaudeMd(agentsMd, mentions))
  if (mcpInside) addFile(plan, mcpRel, mcpJson)
  addFile(plan, "settings.json", JSON.stringify(buildSettings(outDir, args.global), null, 2) + "\n")
  for (const agent of agents) {
    addFile(plan, path.join("agents", agent.name + ".md"), agent.name === "ceo" ? buildCeoFile(agent, agentNames, mentions) : buildAgentFile(agent, null, mentions))
  }
  for (const variant of variants) {
    addFile(plan, path.join("agents", variant.name + ".md"), buildAgentFile(byName.get(variant.base), variant, mentions))
  }
  for (const skill of skills) copySkill(plan, skill)
  for (const file of commands) {
    addFile(plan, path.join("commands", file), buildCommandFile(path.join(commandDir, file), agentNames, mentions))
  }
  addFile(plan, path.join("hooks", "guard.mjs"), GUARD_SOURCE)
  addFile(plan, path.join("hooks", "notify.mjs"), NOTIFY_SOURCE)

  plan.sort((a, b) => a.rel.localeCompare(b.rel))
  const files = plan.map((p) => p.rel).sort()
  const manifest = { generator: "oc-export-claude", version: 1, files }
  addFile(plan, MANIFEST, JSON.stringify(manifest, null, 2) + "\n")
  plan.sort((a, b) => a.rel.localeCompare(b.rel))

  const existing = exists(outDir) ? listDir(outDir).filter((n) => n !== ".DS_Store") : []
  if (args.dryRun) {
    process.stdout.write("Claude Code export (dry run)\n")
    process.stdout.write("  target: " + outDir + "\n")
    process.stdout.write("  mcp: " + mcpFile + (mcpInside ? "" : " (outside the export tree)") + "\n")
    process.stdout.write("  files: " + plan.length + "\n")
    for (const entry of plan) process.stdout.write("  + " + entry.rel + "\n")
    return
  }
  if (existing.length && !args.force) {
    fail(outDir + " is not empty: use --force to overwrite the previous export", 1)
  }
  // A project .mcp.json may hold hand-written servers: never clobber it silently.
  const mcpCurrent = !mcpInside && exists(mcpFile) ? read(mcpFile) : null
  if (!mcpInside && mcpCurrent !== null && mcpCurrent !== mcpJson && !args.force) {
    fail(mcpFile + " already exists: use --force to overwrite it (or --mcp-out FILE)", 1)
  }

  writePlan(outDir, plan, args.force)
  if (!mcpInside && mcpCurrent !== mcpJson) {
    fs.mkdirSync(path.dirname(mcpFile), { recursive: true })
    fs.writeFileSync(mcpFile, mcpJson)
  }

  const agentCount = agents.length + variants.length
  const mcpCount = Object.keys(mcp.mcpServers).length
  process.stdout.write("Claude Code export: " + agentCount + " agents, " + skills.length + " skills, " + commands.length + " commands, " + mcpCount + " MCP servers\n")
  process.stdout.write("  target: " + outDir + "\n")
  process.stdout.write("  mcp: " + mcpFile + "\n")
  process.stdout.write("  hooks: guard.mjs (PreToolUse), notify.mjs (Stop)\n")
  process.stdout.write("  start: claude --agent ceo\n")
  if (args.global) {
    process.stdout.write("  note: Claude Code does not read ~/.claude/.mcp.json; register the servers at user scope:\n")
    process.stdout.write("        claude mcp add -s user <name> -- <command> [args...]\n")
    process.stdout.write("        or merge " + mcpFile + " into ~/.claude.json (mcpServers)\n")
  } else {
    process.stdout.write("  note: approve the project .mcp.json servers once through /mcp\n")
  }
}

try {
  main()
} catch (e) {
  fail(e instanceof Error ? e.message : String(e), 1)
}
