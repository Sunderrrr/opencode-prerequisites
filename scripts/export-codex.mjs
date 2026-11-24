#!/usr/bin/env node
// Export the opencode-prerequisites kit to the Codex CLI / Codex app format.
//
//   node scripts/export-codex.mjs --global
//   node scripts/export-codex.mjs --out /tmp/codex-home
//   node scripts/export-codex.mjs --project .
//   node scripts/export-codex.mjs --mcp-only
//
// Node ESM only, no dependency. The generated files are deterministic: the same kit
// sources always produce the same bytes, so a re-export is a no-op diff.
//
// Mapping summary (only the kit sources, never an addon automatically):
//   config/AGENTS.md          -> <out>/AGENTS.md (+ model routing and CEO delegation)
//   config/agents/*.md        -> <out>/agents/<name>.toml
//   config/skills/<name>/     -> ~/.agents/skills/<name>/  (--global)
//                             -> <out>/skills/<name>/      (--out/--project)
//   config/opencode.jsonc     -> <out>/config.toml, [mcp_servers.<name>] tables
//                             -> <out>/fast.config.toml, <out>/deep.config.toml
//                                (layered by `codex --profile fast|deep`)
//
// config.toml is merged, never regenerated: existing sections and keys are preserved,
// only missing MCP server tables and the [agents]/[features] keys are appended. A
// .bak-<timestamp> copy is written before the first modification. A generated file that
// differs from an existing file the exporter does not own is preserved: the new version
// goes to <file>.new, and --force overwrites the target instead.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MANIFEST = ".oc-export-manifest.json"

// Codex model catalog. Checked against `codex debug models` (0.172.0):
//   gpt-6.2-astra  hard reasoning / architecture
//   gpt-6.2-sol    daily coding
//   gpt-6.1-terra  visual / computer use
//   gpt-6-luna     high volume / extraction
const MODEL = {
  astra: "gpt-6.2-astra",
  sol: "gpt-6.2-sol",
  terra: "gpt-6.1-terra",
  luna: "gpt-6-luna",
}

// Kit tier -> Codex model + reasoning effort.
const TIER = {
  opus: { model: MODEL.astra, effort: "high" },
  sonnet: { model: MODEL.sol, effort: "medium" },
  haiku: { model: MODEL.luna, effort: "low" },
}

// Same split as the Claude Code export, with the designer on the visual model.
const OPUS_AGENTS = new Set(["ceo", "architect", "security", "review", "verify-app", "integrator"])
const HAIKU_AGENTS = new Set(["researcher", "web-researcher"])
const TERRA_AGENTS = new Set(["designer"])

const HELP = [
  "Export the opencode-prerequisites kit to Codex CLI / Codex app format.",
  "",
  "Usage:",
  "  oc-export-codex [--out DIR] [--project DIR] [--global] [--force] [--dry-run] [--mcp-only]",
  "",
  "Options:",
  "  --out DIR       target directory (default with --global: ~/.codex)",
  "  --project DIR   project export in DIR/.codex",
  "  --global        user-level export: ~/.codex + ~/.agents/skills",
  "  --force         overwrite files that this exporter did not create (default: keep them, write <file>.new)",
  "  --dry-run       print the plan, write nothing",
  "  --mcp-only      only merge the MCP tables into <out>/config.toml",
  "  --config DIR    read another kit configuration (default: this repository's config/)",
  "  -h, --help      show this help",
  "",
  "Skills are written to ~/.agents/skills with --global (shared with other agent tools),",
  "and to <out>/skills otherwise (visible only through CODEX_HOME=<out>).",
  "",
  "Exit codes: 0 success, 1 export error, 2 usage error.",
].join("\n")

const ROUTING = [
  "## Model routing (Codex)",
  "",
  "The model and reasoning effort are fixed by each `agents/<name>.toml` file. Use the agent",
  "whose file matches the work; do not override the model per call unless the user asks for it.",
  "",
  "| Model | Effort | Use for | Agents |",
  "|---|---|---|---|",
  "| `" + MODEL.astra + "` | `high` | architecture, security, review, arbitration, ambiguous bugs | `ceo`, `architect`, `security`, `review`, `verify-app`, `integrator` |",
  "| `" + MODEL.sol + "` | `medium` | implementation, tests, docs, integration, routine fixes | language and domain specialists |",
  "| `" + MODEL.luna + "` | `low` | extraction, scans, mechanical work, reading, status checks | `researcher`, `web-researcher` |",
  "| `" + MODEL.terra + "` | `high` | visual design, UI/UX, computer and browser work | `designer` |",
  "",
  "Rules:",
  "- Never use astra for mechanical work (renames, formatting, status, simple searches): use luna.",
  "- Never use luna for security, review, architecture or an ambiguous bug: use astra.",
  "- An ambiguous bug starts on sol (`debugger`); escalate to astra when the cause is still unclear after one attempt.",
  "- The designer is terra, not astra: visual judgment uses the visual model.",
  "- The CEO is astra: arbitration and final validation need the hard model.",
  "- Do not run the same task twice at two models to compare: pick one.",
]

const DELEGATION = [
  "## CEO delegation rules (Codex)",
  "",
  "- You are the primary agent (`/root`). Delegate with `spawn_agent` and `agent_type: \"<name>\"`; the",
  "  available names are the files under `~/.codex/agents/` (or `<CODEX_HOME>/agents/`).",
  "- A sub-agent starts without your conversation history: the brief contains the goal, context,",
  "  relevant files, success criterion and forbidden actions. It never asks the user; it proceeds on",
  "  its best assumption and notes it under Questions in its short report.",
  "- Split by module and by file, one owner per file. Start independent sub-agents in parallel and",
  "  keep waves short (~2 minutes): stay reachable while they work and answer the user immediately.",
  "- You never write code, edit a file or run a command. The contract, tests, fixes and validation",
  "  run in sub-agents; only the short plan stays with you.",
  "- Close the loop: `code-simplifier`, then `review` and `security` in parallel, then `verify-app`",
  "  until VALIDATED. `security` is mandatory for auth, personal data, secrets, network and dependencies.",
  "- Specialists work only in the worktree named in their brief and commit locally in small steps.",
  "  They never push; only `integrator` merges, one branch at a time, with the full test suite.",
  "- Routing: astra for arbitration, architecture, security and review; sol for implementation, tests,",
  "  docs and integration; luna for extraction, scans and mechanical work; terra for visual work.",
  "- When a sub-agent returns, verify its evidence (tests run, real output) before accepting the result.",
]

const CODEX_NOTES = [
  "## Codex execution notes",
  "",
  "- You run as a Codex agent in the user's workspace. Work only in the worktree or directory named",
  "  in the brief; do not touch another checkout.",
  "- Commit locally in small steps when the brief asks for it. Never push, stash, reset --hard, check",
  "  out another branch, or rebase shared history.",
  "- Your model and reasoning effort are fixed by this agent file; do not try to switch them.",
]

const CEO_CODEX_NOTES = [
  "## Codex delegation notes",
  "",
  "- Use `spawn_agent` with `agent_type` set to the specialist name. Give each call one task and a",
  "  self-contained brief; independent calls can run in parallel.",
  "- The `default_subagent_model` is `" + MODEL.sol + "`. The per-agent model in each TOML wins for",
  "  that role; do not override it without a reason.",
  "- You cannot edit files or run commands. If a specialist is missing, extend its brief instead of",
  "  doing the work yourself.",
  "- The Codex app and the CLI share this configuration: the same agents, skills and MCP servers.",
]

// --- Small helpers -------------------------------------------------------------------------
function fail(message, code = 2) {
  process.stderr.write("oc-export-codex: " + message + "\n")
  process.exit(code)
}

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir()
}

function expandHome(value) {
  if (value === "~") return homeDir()
  if (value.startsWith("~/")) return path.join(homeDir(), value.slice(2))
  return value
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

function parseArgs(argv) {
  const args = {
    out: null,
    project: null,
    global: false,
    force: false,
    dryRun: false,
    mcpOnly: false,
    config: null,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--out") {
      const v = argv[++i]
      if (!v) fail("--out requires a directory")
      args.out = v
    } else if (a === "--project") {
      const v = argv[++i]
      if (!v) fail("--project requires a directory")
      args.project = v
    } else if (a === "--global") {
      args.global = true
    } else if (a === "--force") {
      args.force = true
    } else if (a === "--dry-run") {
      args.dryRun = true
    } else if (a === "--mcp-only") {
      args.mcpOnly = true
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
  const modes = [args.out ? "out" : null, args.project ? "project" : null, args.global ? "global" : null].filter(Boolean)
  if (modes.length > 1) fail("--out, --project and --global are mutually exclusive")
  if (args.mcpOnly && args.project) fail("--mcp-only is not compatible with --project")
  return args
}

// --- Frontmatter and JSONC readers ---------------------------------------------------------
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

function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md)
  if (!m) return { data: {}, body: md }
  const data = {}
  let top = null
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue
    const nested = /^\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (nested && top) {
      if (typeof data[top] !== "object" || data[top] === null) data[top] = {}
      data[top][nested[1]] = scalar(nested[2])
      continue
    }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    top = kv[1]
    data[top] = kv[2] === "" ? {} : scalar(kv[2])
  }
  return { data, body: md.slice(m[0].length) }
}

function parseJsonc(text) {
  let out = ""
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      out += ch
      i++
      while (i < text.length) {
        const c = text[i]
        out += c
        i++
        if (c === "\\") {
          if (i < text.length) {
            out += text[i]
            i++
          }
        } else if (c === '"') {
          break
        }
      }
      continue
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  out = out.replace(/,\s*([}\]])/g, "$1")
  return JSON.parse(out)
}

function mcpServers(cfg) {
  const m = cfg && cfg.mcp ? cfg.mcp : {}
  if (m.servers && typeof m.servers === "object") return m.servers
  return Object.fromEntries(Object.entries(m).filter(([k, v]) => k !== "timeout" && v && typeof v === "object"))
}

// --- Layout --------------------------------------------------------------------------------
// Repository: <root>/scripts/export-codex.mjs + <root>/config/ + <root>/addons/android/
// Installed:  <config>/libexec/export-codex.mjs (install.sh copies config/ as-is)
function locateConfig(args) {
  if (args.config) {
    const dir = path.resolve(expandHome(args.config))
    if (!exists(path.join(dir, "opencode.jsonc"))) fail("no opencode.jsonc in " + dir, 1)
    return { config: dir, root: path.dirname(dir), installed: false }
  }
  const repo = path.resolve(HERE, "..")
  if (exists(path.join(repo, "config", "opencode.jsonc"))) return { config: path.join(repo, "config"), root: repo, installed: false }
  const installed = path.resolve(HERE, "..")
  if (exists(path.join(installed, "opencode.jsonc"))) return { config: installed, root: path.dirname(installed), installed: true }
  if (exists(path.join(HERE, "opencode.jsonc"))) return { config: HERE, root: path.dirname(HERE), installed: true }
  fail("kit configuration not found (looked for config/opencode.jsonc next to " + HERE + ")", 1)
  return null
}

// --- Agents --------------------------------------------------------------------------------
// Only config/agents/*.md. Addons (Android, ...) are opt-in kit sources: exporting them
// automatically made the agent count depend on which addons the checkout happened to carry.
function collectAgents(layout) {
  const dir = path.join(layout.config, "agents")
  return listMarkdown(dir).map((f) => {
    const file = path.join(dir, f)
    const parsed = parseFrontmatter(read(file))
    return { name: path.basename(f, ".md"), file, fm: parsed.data, body: parsed.body }
  })
}

function modelFor(name) {
  if (TERRA_AGENTS.has(name)) return { model: MODEL.terra, effort: "high" }
  if (OPUS_AGENTS.has(name)) return TIER.opus
  if (HAIKU_AGENTS.has(name)) return TIER.haiku
  return TIER.sonnet
}

function adaptText(text, mentions) {
  // Only real agent names become Codex agent references; `@ts-ignore`, `@version`
  // and similar non-agent mentions survive verbatim.
  return text.replace(/(^|[^A-Za-z0-9_@])@([a-z][a-z0-9-]+)/g, (match, pre, name) => {
    if (!mentions.has(name)) return match
    return pre + "`" + name + "`"
  })
}

function buildAgentBody(agent, mentions) {
  const adapted = adaptText(agent.body.trim(), mentions)
  const notes = CODEX_NOTES.join("\n")
  if (agent.name !== "ceo") return notes + "\n\n" + adapted + "\n"
  const ceoNotes = notes + "\n\n" + CEO_CODEX_NOTES.join("\n") + "\n\n" + ROUTING.join("\n") + "\n\n" + DELEGATION.join("\n")
  return ceoNotes + "\n\n" + adapted + "\n"
}

function tomlString(value) {
  return JSON.stringify(String(value))
}

function tomlMultiline(value) {
  const text = String(value).replace(/\r\n/g, "\n")
  if (!text.includes("'''")) return "'''\n" + text + "'''"
  return '"""\n' + text.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"') + '"""'
}

function renderAgentToml(agent, body) {
  const { model, effort } = modelFor(agent.name)
  const description = String(agent.fm.description || "").trim()
  if (!description) fail("agent " + agent.name + " has no description in its frontmatter", 1)
  return [
    "# Generated by oc-export-codex from " + path.basename(agent.file) + ". Do not edit by hand.",
    "name = " + tomlString(agent.name),
    "description = " + tomlString(description),
    "model = " + tomlString(model),
    "model_reasoning_effort = " + tomlString(effort),
    "developer_instructions = " + tomlMultiline(body),
    "",
  ].join("\n")
}

function buildAgentsMd(kitText) {
  return [
    "<!-- Generated by oc-export-codex from config/AGENTS.md. Do not edit by hand. -->",
    kitText.trim(),
    "",
    ROUTING.join("\n"),
    "",
    DELEGATION.join("\n"),
    "",
    "## Codex specifics",
    "",
    "- Agent definitions live in `~/.codex/agents/<name>.toml` (or `<CODEX_HOME>/agents/`).",
    "- Skills live in `~/.agents/skills/<name>/SKILL.md`; a project export uses `<out>/skills/`.",
    "- MCP servers are `[mcp_servers.<name>]` tables in `~/.codex/config.toml`.",
    "- Profiles: `codex --profile fast` (sol/medium) and `codex --profile deep` (astra/high).",
    "- The CLI and the Codex app share this configuration. Sandbox and approval are session-level:",
    "  Codex has no per-agent sandbox override.",
    "- Prompts are TUI presets (`[tui.presets]`), not agent definitions; the kit does not export them.",
    "",
  ].join("\n")
}

// --- Skills --------------------------------------------------------------------------------
// Only config/skills/*, same rule as the agents: no addon is included implicitly.
function collectSkillDirs(layout) {
  const dirs = []
  const root = path.join(layout.config, "skills")
  for (const d of listDir(root)) {
    const src = path.join(root, d)
    if (!exists(src) || !fs.statSync(src).isDirectory()) continue
    if (!exists(path.join(src, "SKILL.md"))) continue
    dirs.push({ name: d, src })
  }
  return dirs
}

// --- MCP and config.toml -------------------------------------------------------------------
function expandEnv(value) {
  return String(value).replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (name === "HOME") return homeDir()
    return process.env[name] || "${" + name + "}"
  })
}

function expandMap(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) out[k] = expandEnv(v)
  return out
}

function tomlInlineTable(obj) {
  const parts = Object.entries(obj).map(([k, v]) => tomlString(k) + " = " + tomlString(v))
  return parts.length ? "{ " + parts.join(", ") + " }" : "{}"
}

function buildMcp(cfg) {
  const servers = {}
  for (const name of Object.keys(mcpServers(cfg)).sort()) {
    const server = mcpServers(cfg)[name]
    if (!server || server.disabled === true || server.enabled === false) continue
    if (server.type === "remote") {
      const url = expandEnv(server.url || "")
      if (!url) continue
      const entry = { url }
      if (server.headers && typeof server.headers === "object") entry.http_headers = expandMap(server.headers)
      servers[name] = entry
      continue
    }
    const command = Array.isArray(server.command)
      ? server.command.map((part) => expandEnv(part))
      : [expandEnv(server.command || "")]
    if (!command[0]) continue
    const entry = { command: command[0], args: command.slice(1) }
    if (server.environment && typeof server.environment === "object") entry.env = expandMap(server.environment)
    else if (server.env && typeof server.env === "object") entry.env = expandMap(server.env)
    servers[name] = entry
  }
  return servers
}

function renderMcpSection(name, server) {
  const lines = ["[mcp_servers." + name + "]"]
  if (server.url) {
    lines.push("url = " + tomlString(server.url))
    if (server.http_headers) lines.push("http_headers = " + tomlInlineTable(server.http_headers))
    return lines.join("\n")
  }
  lines.push("command = " + tomlString(server.command))
  lines.push("args = [" + (server.args || []).map(tomlString).join(", ") + "]")
  if (server.env && Object.keys(server.env).length) lines.push("env = " + tomlInlineTable(server.env))
  return lines.join("\n")
}

// Line scanner that ignores `[table]` lines inside TOML multiline strings.
function scanSections(text) {
  const lines = text.split(/\r?\n/)
  const sections = []
  let multiline = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (multiline) {
      if (line.includes(multiline)) multiline = null
      continue
    }
    const basic = (line.match(/"""/g) || []).length
    const literal = (line.match(/'''/g) || []).length
    if (basic % 2 === 1) {
      multiline = '"""'
      continue
    }
    if (literal % 2 === 1) {
      multiline = "'''"
      continue
    }
    const m = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line)
    if (m) sections.push({ header: m[1].trim(), start: i })
  }
  for (let i = 0; i < sections.length; i++) sections[i].end = i + 1 < sections.length ? sections[i + 1].start : lines.length
  return { lines, sections }
}

function headerKey(header) {
  return header.replace(/\s+/g, "")
}

function mcpBaseName(header) {
  const key = headerKey(header)
  const m = /^mcp_servers\.(.+)$/.exec(key)
  if (!m) return null
  const rest = m[1]
  const q = /^"((?:[^"\\]|\\.)*)"(?=\.|$)/.exec(rest)
  if (q) return q[1]
  const lit = /^'([^']*)'(?=\.|$)/.exec(rest)
  if (lit) return lit[1]
  return rest.split(".")[0]
}

function existingMcpNames(text) {
  const names = new Set()
  const { lines, sections } = scanSections(text)
  for (const s of sections) {
    const base = mcpBaseName(s.header)
    if (base) names.add(base)
  }
  for (const line of lines) {
    const root = /^\s*mcp_servers\.("?)([A-Za-z0-9_-]+)\1\s*=/.exec(line)
    if (root) names.add(root[2])
  }
  // `[mcp_servers]` with `name = { ... }` inline entries.
  const base = sections.find((s) => headerKey(s.header) === "mcp_servers")
  if (base) {
    for (let i = base.start + 1; i < base.end; i++) {
      const kv = /^\s*("?)([A-Za-z0-9_-]+)\1\s*=/.exec(lines[i])
      if (kv) names.add(kv[2])
    }
  }
  return names
}

function hasInlineRootTable(text, table) {
  return new RegExp("^\\s*" + table + "\\s*=\\s*\\{", "m").test(text)
}

function hasRootDottedKey(text, table, key) {
  return new RegExp("^\\s*" + table + "\\s*\\.\\s*" + key + "\\s*=", "m").test(text)
}

// Ensure `key = value` exists in `[table]`, preserving every user key. Returns
// { text, added, present }. `value` is already a TOML fragment.
function ensureTableKey(text, table, key, value) {
  if (hasRootDottedKey(text, table, key)) return { text, added: false, present: true }
  const { lines, sections } = scanSections(text)
  const sec = sections.find((s) => headerKey(s.header) === table)
  if (sec) {
    for (let i = sec.start + 1; i < sec.end; i++) {
      if (new RegExp("^\\s*" + key + "\\s*=").test(lines[i])) return { text, added: false, present: true }
    }
    lines.splice(sec.start + 1, 0, key + " = " + value)
    return { text: lines.join("\n"), added: true, present: true }
  }
  if (hasInlineRootTable(text, table)) {
    fail("config.toml defines `" + table + "` as an inline table; convert it to a `[" + table + "]` section first", 1)
  }
  const trimmed = text.replace(/\s+$/, "")
  const next = (trimmed ? trimmed + "\n\n" : "") + "[" + table + "]\n" + key + " = " + value + "\n"
  return { text: next, added: true, present: true }
}

function deprecatedConfigNotes(text) {
  const notes = []
  const { lines, sections } = scanSections(text)
  const sec = sections.find((s) => headerKey(s.header) === "features")
  if (!sec) return notes
  for (let i = sec.start + 1; i < sec.end; i++) {
    if (/^\s*multi_agent\s*=/.test(lines[i])) {
      notes.push("config.toml still sets the deprecated [features] multi_agent; remove it (Codex 0.172 uses [agents] enabled)")
      break
    }
  }
  return notes
}

function mergeConfig(text, mcp, { withAgents }) {
  let out = text.replace(/\r\n/g, "\n")
  const notes = deprecatedConfigNotes(out)
  if (withAgents) {
    // Codex 0.172: [agents] enabled replaces the deprecated [features] multi_agent,
    // and features.multi_agent_v2 selects the V2 multi-agent backend.
    for (const [table, key, value] of [
      ["agents", "enabled", "true"],
      ["agents", "default_subagent_model", tomlString(MODEL.sol)],
      ["agents", "default_subagent_reasoning_effort", tomlString("medium")],
      ["features", "multi_agent_v2", "true"],
    ]) {
      const entry = ensureTableKey(out, table, key, value)
      out = entry.text
      if (entry.added) notes.push("[" + table + "] " + key + " = " + value.replace(/^"|"$/g, ""))
    }
  }
  const present = existingMcpNames(out)
  const added = []
  for (const name of Object.keys(mcp).sort()) {
    if (present.has(name)) continue
    const section = renderMcpSection(name, mcp[name])
    out = out.replace(/\s+$/, "") + "\n\n" + section + "\n"
    added.push(name)
  }
  return { text: out, notes, added }
}

function backupPath(file) {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, "0")
  const stamp =
    now.getUTCFullYear() +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    "-" +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds())
  let candidate = file + ".bak-" + stamp
  let i = 1
  while (exists(candidate)) candidate = file + ".bak-" + stamp + "-" + i++
  return candidate
}

function writeAtomic(file, data, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Never loosen the permissions of an existing file (config.toml may be 0600).
  let finalMode = mode
  try {
    if (exists(file)) finalMode = fs.statSync(file).mode & 0o777
  } catch {
    // keep the requested mode
  }
  const tmp = file + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2)
  try {
    fs.writeFileSync(tmp, data, { mode: finalMode })
    fs.chmodSync(tmp, finalMode)
    fs.renameSync(tmp, file)
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // best effort
    }
    throw e
  }
}

// --- Plan, conflicts, manifest -------------------------------------------------------------
function loadManifest(outDir) {
  const file = path.join(outDir, MANIFEST)
  if (!exists(file)) return null
  try {
    return JSON.parse(read(file))
  } catch {
    return null
  }
}

function isOwned(manifest, root, rel) {
  if (!manifest || !Array.isArray(manifest.roots)) return false
  for (const r of manifest.roots) {
    if (!r || !Array.isArray(r.files)) continue
    const sameRoot = path.resolve(r.path) === path.resolve(root)
    if (sameRoot && r.files.includes(rel)) return true
  }
  return false
}

function pruneEmpty(dir, stop) {
  let current = dir
  while (current.startsWith(stop + path.sep) && current !== stop) {
    try {
      if (fs.readdirSync(current).length) return
      fs.rmdirSync(current)
    } catch {
      return
    }
    current = path.dirname(current)
  }
}

function removeStaleNew(file, expected) {
  const alt = file + ".new"
  try {
    if (exists(alt) && fs.statSync(alt).isFile() && fs.readFileSync(alt).equals(expected)) fs.rmSync(alt, { force: true })
  } catch {
    // best effort
  }
}

function applyPlan(plan, outDir, manifest, force, dryRun) {
  const conflicts = new Set()
  for (const entry of plan) {
    const target = path.join(entry.root, entry.rel)
    if (!exists(target)) continue
    if (fs.statSync(target).isDirectory()) fail("target is a directory, not a file: " + target, 1)
    const current = fs.readFileSync(target)
    if (current.equals(entry.data)) continue
    if (!force && !isOwned(manifest, entry.root, entry.rel)) conflicts.add(target)
  }

  let written = 0
  let unchanged = 0
  const preserved = []
  for (const entry of plan) {
    const target = path.join(entry.root, entry.rel)
    if (exists(target) && !fs.statSync(target).isDirectory() && fs.readFileSync(target).equals(entry.data)) {
      unchanged++
      if (!dryRun) removeStaleNew(target, entry.data)
      continue
    }
    if (conflicts.has(target)) {
      // Never overwrite a file this exporter does not own: keep the user version and
      // leave the generated one beside it as <file>.new (same rule as install.sh).
      const alt = target + ".new"
      const current = exists(alt) && fs.statSync(alt).isFile() ? fs.readFileSync(alt) : null
      if (!current || !current.equals(entry.data)) {
        if (!dryRun) writeAtomic(alt, entry.data, entry.mode)
        preserved.push(alt)
      }
      continue
    }
    if (!dryRun) writeAtomic(target, entry.data, entry.mode)
    written++
    if (!dryRun) removeStaleNew(target, entry.data)
  }

  // Remove files owned by the previous export that are no longer generated.
  if (manifest && Array.isArray(manifest.roots) && !dryRun) {
    const keep = new Set(plan.map((e) => path.resolve(e.root) + "\0" + e.rel))
    for (const r of manifest.roots) {
      if (!r || !Array.isArray(r.files) || !r.path) continue
      const root = path.resolve(r.path)
      for (const rel of r.files) {
        if (rel.includes("..") || path.isAbsolute(rel)) continue
        if (keep.has(root + "\0" + rel)) continue
        const target = path.join(root, rel)
        if (exists(target) && fs.statSync(target).isFile()) {
          fs.rmSync(target, { force: true })
          pruneEmpty(path.dirname(target), root)
        }
      }
    }
  }
  return { written, unchanged, preserved }
}

function buildManifest(outDir, plan) {
  const roots = new Map()
  for (const entry of plan) {
    const root = path.resolve(entry.root)
    if (!roots.has(root)) roots.set(root, [])
    roots.get(root).push(entry.rel)
  }
  return {
    generator: "oc-export-codex",
    version: 1,
    out: path.resolve(outDir),
    roots: [...roots.entries()]
      .map(([p, files]) => ({ path: p, files: files.sort() }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  }
}

// --- Main ----------------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP + "\n")
    return
  }

  const layout = locateConfig(args)
  const global = args.global || (!args.out && !args.project)
  const outDir = args.project
    ? path.join(path.resolve(expandHome(args.project)), ".codex")
    : path.resolve(expandHome(args.out || path.join(homeDir(), ".codex")))
  const skillsRoot = global ? path.join(homeDir(), ".agents", "skills") : path.join(outDir, "skills")
  const configFile = path.join(outDir, "config.toml")

  let cfg
  try {
    cfg = parseJsonc(read(path.join(layout.config, "opencode.jsonc")))
  } catch (e) {
    fail("opencode.jsonc unreadable: " + (e instanceof Error ? e.message : String(e)), 1)
  }
  const mcp = buildMcp(cfg)

  const configCurrent = exists(configFile)
    ? read(configFile)
    : "# Generated by oc-export-codex. MCP servers are merged; user keys are preserved.\n"
  const merged = mergeConfig(configCurrent, mcp, { withAgents: !args.mcpOnly })
  const configChanged = merged.text !== configCurrent
  const backup = configChanged && exists(configFile) ? backupPath(configFile) : null

  if (args.mcpOnly) {
    process.stdout.write("Codex MCP merge" + (args.dryRun ? " (dry run)" : "") + "\n")
    process.stdout.write("  config: " + configFile + "\n")
    process.stdout.write("  MCP servers: " + Object.keys(mcp).length + " configured, " + merged.added.length + " added\n")
    for (const name of merged.added) process.stdout.write("  + [mcp_servers." + name + "]\n")
    for (const note of merged.notes) process.stdout.write("  + " + note + "\n")
    if (configChanged && !args.dryRun) {
      if (backup) fs.copyFileSync(configFile, backup)
      writeAtomic(configFile, merged.text)
    }
    if (!configChanged) process.stdout.write("  no change\n")
    else if (backup) process.stdout.write("  backup: " + backup + "\n")
    return
  }

  const agents = collectAgents(layout)
  if (!agents.some((a) => a.name === "ceo")) fail("agents/ceo.md is missing from " + layout.config, 1)
  const mentions = new Set(agents.map((a) => a.name))
  const skills = collectSkillDirs(layout)

  const agentsMdFile = path.join(layout.config, "AGENTS.md")
  const kitAgents = exists(agentsMdFile) ? read(agentsMdFile) : "# Global rules\n\n- Reply in the user's language, short and direct.\n"

  const plan = []
  const add = (root, rel, data, mode = 0o644) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.endsWith("\n") ? data : data + "\n", "utf8")
    plan.push({ root, rel, data: buf, mode })
  }

  add(outDir, "AGENTS.md", buildAgentsMd(kitAgents))
  for (const agent of agents) add(outDir, path.join("agents", agent.name + ".toml"), renderAgentToml(agent, buildAgentBody(agent, mentions)))
  for (const skill of skills) {
    for (const file of walkFiles(skill.src)) {
      add(skillsRoot, path.join(skill.name, file.rel), fs.readFileSync(file.full), file.mode)
    }
  }

  const fast = "model = " + tomlString(MODEL.sol) + "\nmodel_reasoning_effort = \"medium\"\n"
  const deep = "model = " + tomlString(MODEL.astra) + "\nmodel_reasoning_effort = \"high\"\n"
  add(outDir, "fast.config.toml", "# Generated by oc-export-codex: fast profile (codex --profile fast).\n" + fast)
  add(outDir, "deep.config.toml", "# Generated by oc-export-codex: deep profile (codex --profile deep).\n" + deep)

  plan.sort((a, b) => (a.root + "/" + a.rel).localeCompare(b.root + "/" + b.rel))

  if (args.dryRun) {
    process.stdout.write("Codex export (dry run)\n")
    process.stdout.write("  target: " + outDir + "\n")
    process.stdout.write("  skills: " + skillsRoot + "\n")
    process.stdout.write("  agents: " + agents.length + ", skills: " + skills.length + ", MCP: " + Object.keys(mcp).length + "\n")
    for (const entry of plan) process.stdout.write("  + " + path.join(entry.root, entry.rel) + "\n")
    if (merged.added.length) process.stdout.write("  + config: " + merged.added.map((n) => "mcp_servers." + n).join(", ") + "\n")
    for (const note of merged.notes) process.stdout.write("  + config: " + note + "\n")
    if (configChanged) process.stdout.write("  ~ config: " + configFile + " (merged)\n")
    return
  }

  const manifest = loadManifest(outDir)
  const stats = applyPlan(plan, outDir, manifest, args.force, false)
  writeAtomic(path.join(outDir, MANIFEST), JSON.stringify(buildManifest(outDir, plan), null, 2) + "\n")

  if (configChanged) {
    if (backup) fs.copyFileSync(configFile, backup)
    writeAtomic(configFile, merged.text)
  }

  process.stdout.write(
    "Codex export: " + agents.length + " agents, " + skills.length + " skills, " + Object.keys(mcp).length + " MCP servers, 2 profiles\n",
  )
  process.stdout.write("  target: " + outDir + "\n")
  process.stdout.write("  skills: " + skillsRoot + (global ? " (shared user-level skills)" : " (CODEX_HOME only)") + "\n")
  process.stdout.write("  files: " + stats.written + " written, " + stats.unchanged + " unchanged")
  if (stats.preserved.length) process.stdout.write(", " + stats.preserved.length + " preserved as .new")
  process.stdout.write("\n")
  for (const alt of stats.preserved) process.stderr.write("oc-export-codex: preserved " + alt.slice(0, -4) + ", new version in " + alt + "\n")
  if (configChanged) {
    if (merged.added.length) process.stdout.write("  mcp added: " + merged.added.join(", ") + "\n")
    for (const note of merged.notes) process.stdout.write("  config: " + note + "\n")
    if (backup) process.stdout.write("  backup: " + backup + "\n")
  } else {
    process.stdout.write("  config: unchanged\n")
  }
  process.stdout.write("  start: " + (global ? "codex" : "CODEX_HOME=" + outDir + " codex") + " --profile fast\n")
  if (global) process.stdout.write("  note: the Codex app reads the same ~/.codex/config.toml\n")
}

try {
  main()
} catch (e) {
  fail(e instanceof Error ? e.message : String(e), 1)
}
