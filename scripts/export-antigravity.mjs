#!/usr/bin/env node
// Export the opencode-prerequisites kit to Antigravity CLI / app format.
//
//   node scripts/export-antigravity.mjs --global
//   node scripts/export-antigravity.mjs --out /tmp/antigravity-home/.gemini/config
//   node scripts/export-antigravity.mjs --project .
//   node scripts/export-antigravity.mjs --android --global
//
// Node ESM only, no dependency. The generated files are deterministic: the same kit
// sources always produce the same bytes, so a re-export is a no-op diff.
//
// Mapping summary:
//   config/AGENTS.md          -> <out>/AGENTS.md (+ tier routing and CEO delegation)
//   config/agents/*.md        -> <out>/agents/<name>.md
//   addons/android/agents/*   -> <out>/agents/<name>.md with --android
//   config/skills/<name>/     -> <out>/skills/<name>/ with --android for the addon
//   config/opencode.jsonc     -> <out>/mcp_config.json (merged, existing entries kept)
//
// Antigravity uses two roots: the global ~/.gemini/config (CLI and app) and the
// project <dir>/.agents. The CLI reads `agents/<name>.md`, `skills/<name>/SKILL.md`,
// `AGENTS.md` and the `mcpServers` map of `mcp_config.json` in either root.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))

// Antigravity accepts a tier per agent, not an exact model ID:
//   pro      architecture, security, review, arbitration, ambiguous bugs
//   flash    extraction, scans, mechanical work, reading, status checks
//   inherit  implementation, tests, docs, integration (the session model)
const PRO_AGENTS = new Set([
  "ceo",
  "architect",
  "security",
  "review",
  "verify-app",
  "integrator",
  "designer",
  "pentest",
  "reverse-engineer",
])
const FLASH_AGENTS = new Set(["researcher", "web-researcher"])

const HELP = [
  "Export the opencode-prerequisites kit to Antigravity CLI / app format.",
  "",
  "Usage:",
  "  oc-export-antigravity [--out DIR] [--project DIR] [--global] [--android] [--force] [--dry-run]",
  "",
  "Options:",
  "  --out DIR       target config directory (default: ~/.gemini/config)",
  "  --project DIR   project export in DIR/.agents",
  "  --global        explicit user-level export: ~/.gemini/config",
  "  --android       include the Android addon agents and skills",
  "  --force         overwrite files that differ instead of writing <file>.new",
  "  --dry-run       print the plan, write nothing",
  "  --config DIR    read another kit configuration (default: this repository's config/)",
  "  -h, --help      show this help",
  "",
  "Without --force, a file that differs from the export is left untouched and the",
  "generated version is written next to it as <file>.new. mcp_config.json is always",
  "merged: existing servers are preserved and a .bak-<timestamp> copy is written.",
  "",
  "Exit codes: 0 success, 1 export error, 2 usage error.",
].join("\n")

const ROUTING = [
  "## Model routing (Antigravity)",
  "",
  "Antigravity agent files carry a tier, not an exact model ID: `pro`, `flash` or `inherit`.",
  "Antigravity resolves the tier to a current model (`antigravity models` lists them).",
  "",
  "| Tier | Use for | Agents |",
  "|---|---|---|",
  "| `pro` | architecture, security, review, arbitration, ambiguous bugs, design | `ceo`, `architect`, `security`, `review`, `verify-app`, `integrator`, `designer`, `pentest`, `reverse-engineer` |",
  "| `flash` | extraction, scans, mechanical work, reading, status checks | `researcher`, `web-researcher` |",
  "| `inherit` | implementation, tests, docs, integration, routine fixes | all other language and domain specialists |",
  "",
  "Rules:",
  "- Never use pro for mechanical work (renames, formatting, status, simple searches): use flash.",
  "- Never use flash for security, review, architecture or an ambiguous bug: use pro.",
  "- An ambiguous bug starts on inherit (`debugger`); escalate to pro when the cause is still unclear after one attempt.",
  "- `inherit` follows the session model: it is the default for implementation specialists.",
  "- Do not run the same task twice at two tiers to compare: pick one.",
]

const DELEGATION = [
  "## CEO delegation rules (Antigravity)",
  "",
  "- You are the main agent (`mainAgent: true`). Delegate with `invoke_subagent`, passing the",
  "  `name` of an agent file under `~/.gemini/config/agents/` (or `<project>/.agents/agents/`).",
  "  `manage_subagents` lists or stops the running subagents.",
  "- A subagent starts without your conversation history: the brief contains the goal, context,",
  "  relevant files, success criterion and forbidden actions. It never asks the user; it proceeds",
  "  on its best assumption and notes it under Questions in its short report.",
  "- Split by module and by file, one owner per file. Independent subagents can run concurrently:",
  "  launch one wave at a time and keep it short (~2 minutes), then answer the user immediately.",
  "- You never write code, edit a file or run a command. The contract, tests, fixes and validation",
  "  run in subagents; only the short plan stays with you.",
  "- Close the loop: `code-simplifier`, then `review` and `security` in parallel, then `verify-app`",
  "  until VALIDATED. `security` is mandatory for auth, personal data, secrets, network and dependencies.",
  "- Specialists work only in the worktree named in their brief and commit locally in small steps.",
  "  They never push; only `integrator` merges, one branch at a time, with the full test suite.",
  "- Routing: pro for arbitration, architecture, security, review and design; flash for extraction,",
  "  scans and mechanical work; inherit for implementation, tests, docs and integration.",
  "- When a subagent returns, verify its evidence (tests run, real output) before accepting the result.",
]

const AGENT_NOTES = [
  "## Antigravity execution notes",
  "",
  "- You run as an Antigravity agent in the user's workspace. Work only in the worktree or",
  "  directory named in the brief; do not touch another checkout.",
  "- Commit locally in small steps when the brief asks for it. Never push, stash, reset --hard,",
  "  check out another branch, or rebase shared history.",
  "- Your model tier is fixed by this agent file. Antigravity selects the concrete model; do not",
  "  try to override it per call.",
  "- The Antigravity CLI and app share the same global configuration in `~/.gemini/config`.",
]

const CEO_NOTES = [
  "## Antigravity delegation notes",
  "",
  "- Use `invoke_subagent` with the agent `name`; give each call one task and a self-contained",
  "  brief. Independent calls can run concurrently; `manage_subagents` lists or stops them.",
  "- The per-agent tier in each file wins for that role; do not override it without a reason.",
  "- You cannot edit files or run commands. If a specialist is missing, extend its brief instead",
  "  of doing the work yourself.",
  "- The Antigravity app and the CLI read this same configuration: the same agents, skills and MCP",
  "  servers. Sandbox and approval are session-level settings, not per-agent sandbox overrides.",
]

const AGY_SPECIFICS = [
  "## Antigravity specifics",
  "",
  "- Agent definitions: `~/.gemini/config/agents/<name>.md`, or `<project>/.agents/agents/<name>.md`.",
  "- Global instructions: `~/.gemini/config/AGENTS.md`. Project instructions: `<project>/.agents/AGENTS.md`.",
  "- Skills: `~/.gemini/config/skills/<name>/SKILL.md`, or `<project>/.agents/skills/<name>/SKILL.md`.",
  "- MCP servers: the `mcpServers` map in `~/.gemini/config/mcp_config.json` (project: `.agents/mcp_config.json`).",
  "- CLI settings (theme, trusted workspaces): `~/.gemini/antigravity-cli/settings.json`.",
  "- `antigravity agent` lists the exported agents; `antigravity mcp list` shows the MCP servers.",
]

// --- Small helpers -------------------------------------------------------------------------
function fail(message, code = 2) {
  process.stderr.write("oc-export-antigravity: " + message + "\n")
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
    const st = fs.statSync(full)
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
    android: false,
    force: false,
    dryRun: false,
    config: null,
    help: false,
  }
  const value = (i, option) => {
    const v = argv[i]
    if (!v) fail(option + " requires a directory")
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--out") args.out = value(++i, "--out")
    else if (a === "--project") args.project = value(++i, "--project")
    else if (a === "--config") args.config = value(++i, "--config")
    else if (a === "--global") args.global = true
    else if (a === "--android") args.android = true
    else if (a === "--force") args.force = true
    else if (a === "--dry-run") args.dryRun = true
    else if (a === "-h" || a === "--help") args.help = true
    else fail("unknown option: " + a)
  }
  const modes = [args.out ? "out" : null, args.project ? "project" : null, args.global ? "global" : null].filter(Boolean)
  if (modes.length > 1) fail("--out, --project and --global are mutually exclusive")
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
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (kv) data[kv[1]] = kv[2] === "" ? {} : scalar(kv[2])
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
function locateConfig(args) {
  if (args.config) {
    const dir = path.resolve(expandHome(args.config))
    if (!exists(path.join(dir, "opencode.jsonc"))) fail("no opencode.jsonc in " + dir, 1)
    return { config: dir, root: path.dirname(dir) }
  }
  const repo = path.resolve(HERE, "..")
  if (exists(path.join(repo, "config", "opencode.jsonc"))) return { config: path.join(repo, "config"), root: repo }
  if (exists(path.join(HERE, "opencode.jsonc"))) return { config: HERE, root: path.dirname(HERE) }
  fail("kit configuration not found (looked for config/opencode.jsonc next to " + HERE + ")", 1)
  return null
}

// --- Agents --------------------------------------------------------------------------------
function collectAgents(layout, android) {
  const dirs = [path.join(layout.config, "agents")]
  if (android) dirs.push(path.join(layout.root, "addons", "android", "agents"))
  const agents = []
  const seen = new Set()
  for (const dir of dirs) {
    for (const f of listMarkdown(dir)) {
      const name = path.basename(f, ".md")
      if (seen.has(name)) continue
      seen.add(name)
      const file = path.join(dir, f)
      const parsed = parseFrontmatter(read(file))
      agents.push({ name, file, fm: parsed.data, body: parsed.body })
    }
  }
  return agents
}

function tierFor(name) {
  if (PRO_AGENTS.has(name)) return "pro"
  if (FLASH_AGENTS.has(name)) return "flash"
  return "inherit"
}

function adaptText(text, mentions) {
  // Only real agent names become agent references; `@ts-ignore`, `@version`
  // and similar non-agent mentions survive verbatim. An existing code span
  // keeps its backticks: `@shell` -> `shell`, not ``shell``.
  const adapted = text
    .replace(/`@([a-z][a-z0-9-]+)`/g, (match, name) => (mentions.has(name) ? "`" + name + "`" : match))
    .replace(/(^|[^A-Za-z0-9_@])@([a-z][a-z0-9-]+)/g, (match, pre, name) => {
      if (!mentions.has(name)) return match
      return pre + "`" + name + "`"
    })
  return adapted.replace(/`subagent` tool/g, "`invoke_subagent` tool")
}

function yamlString(value) {
  return JSON.stringify(String(value).trim())
}

function renderAgent(agent, mentions) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(agent.name)) fail("invalid agent name: " + agent.name, 1)
  const description = String(agent.fm.description || "").trim()
  if (!description) fail("agent " + agent.name + " has no description in its frontmatter", 1)
  const body = adaptText(agent.body.trim(), mentions)
  const notes = AGENT_NOTES.join("\n")
  const text = agent.name === "ceo" ? notes + "\n\n" + CEO_NOTES.join("\n") + "\n\n" + body + "\n" : notes + "\n\n" + body + "\n"
  return [
    "---",
    "name: " + agent.name,
    "description: " + yamlString(description),
    "model: " + tierFor(agent.name),
    "subagent: true",
    "mainAgent: " + (agent.name === "ceo" ? "true" : "false"),
    "commandExecutionPolicy: sandbox",
    "---",
    text,
  ].join("\n")
}

function buildAgentsMd(kitText) {
  return [
    "<!-- Generated by oc-export-antigravity from config/AGENTS.md. Do not edit by hand. -->",
    kitText.trim(),
    "",
    ROUTING.join("\n"),
    "",
    DELEGATION.join("\n"),
    "",
    AGY_SPECIFICS.join("\n"),
    "",
  ].join("\n")
}

// --- Skills --------------------------------------------------------------------------------
function collectSkillDirs(layout, android) {
  const roots = [path.join(layout.config, "skills")]
  if (android) roots.push(path.join(layout.root, "addons", "android", "skills"))
  const dirs = []
  const seen = new Set()
  for (const root of roots) {
    for (const name of listDir(root)) {
      const src = path.join(root, name)
      if (seen.has(name) || !exists(path.join(src, "SKILL.md"))) continue
      if (!fs.statSync(src).isDirectory()) continue
      seen.add(name)
      dirs.push({ name, src })
    }
  }
  return dirs
}

// --- MCP and mcp_config.json ---------------------------------------------------------------
function expandEnv(value) {
  return String(value).replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
    if (name === "HOME") return homeDir()
    return process.env[name] || match
  })
}

function expandMap(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) out[k] = expandEnv(v)
  return out
}

function buildMcpEntries(cfg) {
  const servers = {}
  const source = mcpServers(cfg)
  for (const name of Object.keys(source).sort()) {
    const server = source[name]
    if (!server || typeof server !== "object") continue
    const disabled = server.disabled === true || server.enabled === false
    const url = server.serverUrl || server.url
    const command = Array.isArray(server.command) ? server.command : server.command ? [server.command] : []
    if (server.type === "remote" || (!command.length && url)) {
      if (!url) continue
      const entry = { serverUrl: expandEnv(url) }
      if (server.headers && typeof server.headers === "object") entry.headers = expandMap(server.headers)
      if (disabled) entry.disabled = true
      servers[name] = entry
      continue
    }
    const parts = command.map((part) => expandEnv(part))
    if (!parts[0]) continue
    const entry = { command: parts[0], args: parts.slice(1) }
    const environment = server.environment || server.env
    if (environment && typeof environment === "object") entry.env = expandMap(environment)
    if (disabled) entry.disabled = true
    servers[name] = entry
  }
  return servers
}

function mergeMcp(text, entries) {
  let base = {}
  if (text.trim()) {
    try {
      base = JSON.parse(text)
    } catch (e) {
      fail("mcp_config.json is not valid JSON; fix it first (" + (e instanceof Error ? e.message : String(e)) + ")", 1)
    }
    if (!base || typeof base !== "object" || Array.isArray(base)) fail("mcp_config.json must contain a JSON object", 1)
  }
  if (base.mcpServers !== undefined && (typeof base.mcpServers !== "object" || Array.isArray(base.mcpServers) || base.mcpServers === null)) {
    fail("mcp_config.json has a non-object mcpServers value", 1)
  }
  const servers = { ...(base.mcpServers || {}) }
  const added = []
  for (const name of Object.keys(entries)) {
    if (Object.prototype.hasOwnProperty.call(servers, name)) continue
    servers[name] = entries[name]
    added.push(name)
  }
  const changed = added.length > 0 || !text.trim()
  const merged = { ...base, mcpServers: servers }
  return { text: changed ? JSON.stringify(merged, null, 2) + "\n" : text, added, changed }
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
  // Never loosen the permissions of an existing file.
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

// --- Plan and apply ------------------------------------------------------------------------
function applyPlan(plan, force, dryRun) {
  let written = 0
  let unchanged = 0
  let pending = 0
  for (const entry of plan) {
    const target = path.join(entry.root, entry.rel)
    const next = target + ".new"
    if (exists(target) && fs.statSync(target).isDirectory()) fail("target is a directory: " + target, 1)
    if (exists(target)) {
      const current = fs.readFileSync(target)
      if (current.equals(entry.data)) {
        unchanged++
        if (!dryRun && exists(next)) fs.rmSync(next, { force: true })
        continue
      }
      if (!force) {
        pending++
        if (!dryRun) writeAtomic(next, entry.data, entry.mode)
        continue
      }
      if (exists(next)) fs.rmSync(next, { force: true })
    }
    if (!dryRun) writeAtomic(target, entry.data, entry.mode)
    written++
  }
  return { written, unchanged, pending }
}

// --- Main ----------------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP + "\n")
    return
  }

  const layout = locateConfig(args)
  const outDir = args.project
    ? path.join(path.resolve(expandHome(args.project)), ".agents")
    : path.resolve(expandHome(args.out || path.join(homeDir(), ".gemini", "config")))
  const mcpFile = path.join(outDir, "mcp_config.json")

  let cfg
  try {
    cfg = parseJsonc(read(path.join(layout.config, "opencode.jsonc")))
  } catch (e) {
    fail("opencode.jsonc unreadable: " + (e instanceof Error ? e.message : String(e)), 1)
  }
  const mcpEntries = buildMcpEntries(cfg)
  const mcpCurrent = exists(mcpFile) ? read(mcpFile) : ""
  const merged = mergeMcp(mcpCurrent, mcpEntries)
  const mcpBackup = merged.changed && exists(mcpFile) ? backupPath(mcpFile) : null

  const agents = collectAgents(layout, args.android)
  if (!agents.some((a) => a.name === "ceo")) fail("agents/ceo.md is missing from " + layout.config, 1)
  const mentions = new Set(agents.map((a) => a.name))
  const skills = collectSkillDirs(layout, args.android)

  const agentsMdFile = path.join(layout.config, "AGENTS.md")
  const kitAgents = exists(agentsMdFile) ? read(agentsMdFile) : "# Global rules\n\n- Reply in the user's language, short and direct.\n"

  const plan = []
  const add = (root, rel, data, mode = 0o644) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.endsWith("\n") ? data : data + "\n", "utf8")
    plan.push({ root, rel, data: buf, mode })
  }

  add(outDir, "AGENTS.md", buildAgentsMd(kitAgents))
  for (const agent of agents) add(outDir, path.join("agents", agent.name + ".md"), renderAgent(agent, mentions))
  for (const skill of skills) {
    for (const file of walkFiles(skill.src)) {
      add(path.join(outDir, "skills"), path.join(skill.name, file.rel), fs.readFileSync(file.full), file.mode)
    }
  }
  plan.sort((a, b) => (a.root + "/" + a.rel).localeCompare(b.root + "/" + b.rel))

  const tierCounts = { pro: 0, flash: 0, inherit: 0 }
  for (const agent of agents) tierCounts[tierFor(agent.name)]++

  if (args.dryRun) {
    process.stdout.write("Antigravity export (dry run)\n")
    process.stdout.write("  target: " + outDir + "\n")
    process.stdout.write("  agents: " + agents.length + " (pro " + tierCounts.pro + ", flash " + tierCounts.flash + ", inherit " + tierCounts.inherit + "), skills: " + skills.length + ", MCP: " + Object.keys(mcpEntries).length + "\n")
    for (const entry of plan) {
      const target = path.join(entry.root, entry.rel)
      const state = !exists(target) ? "+" : fs.readFileSync(target).equals(entry.data) ? "=" : args.force ? "~" : "?"
      process.stdout.write("  " + state + " " + target + (state === "?" ? " (.new)" : "") + "\n")
    }
    if (merged.changed) process.stdout.write("  ~ " + mcpFile + " (merged" + (mcpBackup ? ", backup " + mcpBackup : "") + ")\n")
    return
  }

  const stats = applyPlan(plan, args.force, false)
  if (merged.changed) {
    if (mcpBackup) fs.copyFileSync(mcpFile, mcpBackup)
    writeAtomic(mcpFile, merged.text)
  }

  process.stdout.write(
    "Antigravity export: " + agents.length + " agents, " + skills.length + " skills, " + Object.keys(mcpEntries).length + " MCP servers\n",
  )
  process.stdout.write("  tiers: pro " + tierCounts.pro + ", flash " + tierCounts.flash + ", inherit " + tierCounts.inherit + "\n")
  process.stdout.write("  target: " + outDir + "\n")
  process.stdout.write("  files: " + stats.written + " written, " + stats.unchanged + " unchanged" + (stats.pending ? ", " + stats.pending + " .new" : "") + "\n")
  if (merged.changed) {
    if (merged.added.length) process.stdout.write("  mcp added: " + merged.added.join(", ") + "\n")
    if (mcpBackup) process.stdout.write("  backup: " + mcpBackup + "\n")
  } else {
    process.stdout.write("  mcp: unchanged\n")
  }
  process.stdout.write("  start: antigravity --agent ceo (or the Antigravity app, same config)\n")
}

try {
  main()
} catch (e) {
  fail(e instanceof Error ? e.message : String(e), 1)
}
