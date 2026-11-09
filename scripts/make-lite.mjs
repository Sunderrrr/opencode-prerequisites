#!/usr/bin/env node
// Builds a reduced profile from the full config, driven by profiles/packs.tsv (single source of
// truth, no drift between the two):   node make-lite.mjs <installed-config-directory>
//                                       [--profile lite|core|full] [--packs a,b] [--android]
// - one argument = lite profile (backward-compatible default)
// - prunes the agents/skills/commands that belong to packs which are not selected
// - commands follow their pack, then are pruned by `agent:` frontmatter or @mention of a removed agent
// - lite: keeps only the context7 and grep_app MCPs, removes npm plugins (mempalace)
// - full without --packs: no-op (the installer passes --packs to apply --without/--pentest)
// - android is a pack in the table but is selected only by --android, never by --packs
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseJsonc, mcpServers } from "./lib/jsonc.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TABLE = path.join(ROOT, "profiles/packs.tsv")
const CONFIG = path.join(ROOT, "config")
const ANDROID_ADDON = path.join(ROOT, "addons/android")
const KINDS = ["agent", "skill", "command", "mcp"]
const USAGE = "usage: make-lite.mjs <config-directory> [--profile lite|core|full] [--packs a,b] [--android]"

function fail(message) {
  if (message) console.error(`make-lite: ${message}`)
  console.error(USAGE)
  process.exit(1)
}

// --- CLI ------------------------------------------------------------------------------------
let dest = null
let profile = "lite"
let packsArg = null
let android = false
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === "-h" || arg === "--help") { console.log(USAGE); process.exit(0) }
  else if (arg === "--profile") { profile = argv[++i] ?? ""; if (!profile) fail("missing value for --profile") }
  else if (arg.startsWith("--profile=")) profile = arg.slice("--profile=".length)
  else if (arg === "--packs") { packsArg = argv[++i] ?? ""; if (!packsArg) fail("missing value for --packs") }
  else if (arg.startsWith("--packs=")) packsArg = arg.slice("--packs=".length)
  else if (arg === "--android") android = true
  else if (arg.startsWith("-")) fail(`unknown option: ${arg}`)
  else if (dest === null) dest = arg
  else fail(`unexpected argument: ${arg}`)
}
if (dest === null) fail("missing config directory")
if (!["lite", "core", "full"].includes(profile)) fail(`unknown profile "${profile}" (expected lite, core or full)`)
try {
  if (!fs.statSync(dest).isDirectory()) fail(`not a directory: ${dest}`)
} catch {
  fail(`config directory not found: ${dest}`)
}

// --- pack table -----------------------------------------------------------------------------
function tableError(line, message) {
  throw new Error(`${path.relative(ROOT, TABLE)}:${line}: ${message}`)
}

function loadPacks() {
  let text
  try {
    text = fs.readFileSync(TABLE, "utf8")
  } catch {
    throw new Error(`cannot read ${path.relative(ROOT, TABLE)}`)
  }
  const packs = new Map()
  const rows = []
  const seen = new Map() // "kind\0item" -> pack, so an item cannot belong to two packs
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue
    const line = index + 1
    const cols = raw.split("\t")
    if (cols.length !== 3) tableError(line, `expected pack<TAB>kind<TAB>item (got ${cols.length} field(s))`)
    const [pack, kind, item] = cols.map((s) => s.trim())
    if (!pack || !kind || !item) tableError(line, "empty field")
    if (!KINDS.includes(kind)) tableError(line, `invalid kind "${kind}" (expected ${KINDS.join(", ")})`)
    if (!/^[a-z][a-z0-9-]*$/.test(pack)) tableError(line, `invalid pack name "${pack}"`)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item)) tableError(line, `invalid item name "${item}"`)
    const key = `${kind}\u0000${item}`
    const previous = seen.get(key)
    if (previous !== undefined) tableError(line, `${kind} "${item}" already listed in pack "${previous}"`)
    seen.set(key, pack)
    if (!packs.has(pack)) packs.set(pack, { agent: new Set(), skill: new Set(), command: new Set(), mcp: new Set() })
    packs.get(pack)[kind].add(item)
    rows.push({ pack, kind, item, line })
  }
  if (!packs.has("core")) throw new Error(`${path.relative(ROOT, TABLE)}: no "core" pack`)
  return { packs, rows }
}

// Every listed item must exist in the kit (agents/skills may come from the Android addon).
function kitMcpNames() {
  const cfg = parseJsonc(fs.readFileSync(path.join(CONFIG, "opencode.jsonc"), "utf8"))
  return new Set(Object.keys(mcpServers(cfg)))
}

function kitHas(kind, item, mcps) {
  switch (kind) {
    case "agent":
      return fs.existsSync(path.join(CONFIG, "agents", `${item}.md`))
        || fs.existsSync(path.join(ANDROID_ADDON, "agents", `${item}.md`))
    case "skill":
      return fs.existsSync(path.join(CONFIG, "skills", item, "SKILL.md"))
        || fs.existsSync(path.join(ANDROID_ADDON, "skills", item, "SKILL.md"))
    case "command":
      return fs.existsSync(path.join(CONFIG, "commands", `${item}.md`))
    case "mcp":
      return mcps.has(item)
    default:
      return false
  }
}

function validateRows(rows) {
  let mcps
  try {
    mcps = kitMcpNames()
  } catch (e) {
    throw new Error(`cannot read config/opencode.jsonc: ${e.message}`)
  }
  for (const row of rows) {
    if (!kitHas(row.kind, row.item, mcps)) tableError(row.line, `${row.kind} "${row.item}" does not exist in the kit`)
  }
}

let packs, rows
try {
  ;({ packs, rows } = loadPacks())
  validateRows(rows)
} catch (e) {
  fail(e.message)
}

// --- selected packs -------------------------------------------------------------------------
let selected
if (packsArg !== null) {
  const requested = packsArg.split(",").map((p) => p.trim()).filter(Boolean)
  if (requested.length === 0) fail("empty --packs list")
  for (const p of requested) {
    if (p === "android") fail("the android pack is selected with --android, not --packs")
    if (!packs.has(p)) fail(`unknown pack "${p}" (known: ${[...packs.keys()].join(", ")})`)
  }
  selected = ["core", ...requested.filter((p) => p !== "core")]
} else if (profile === "full") {
  // Full = every pack (Android included when installed): nothing to prune.
  console.log("Full profile: no change")
  process.exit(0)
} else {
  selected = ["core"]
}
if (android) selected.push("android")
const selectedSet = new Set(selected)

const allowed = { agent: new Set(), skill: new Set(), command: new Set(), mcp: new Set() }
const known = { agent: new Set(), skill: new Set(), command: new Set(), mcp: new Set() }
for (const [pack, items] of packs) {
  for (const kind of KINDS) {
    for (const item of items[kind]) {
      known[kind].add(item)
      if (selectedSet.has(pack)) allowed[kind].add(item)
    }
  }
}

// --- prune agents / skills / commands -------------------------------------------------------
const rm = (p) => fs.rmSync(p, { recursive: true, force: true })
const list = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : [])
const removedAgents = new Set()
const agentsDir = path.join(dest, "agents")
for (const f of list(agentsDir)) {
  if (!f.endsWith(".md")) continue
  const name = f.slice(0, -3)
  if (known.agent.has(name) && !allowed.agent.has(name)) {
    rm(path.join(agentsDir, f))
    removedAgents.add(name)
  }
}

const skillsDir = path.join(dest, "skills")
for (const d of list(skillsDir)) {
  const full = path.join(skillsDir, d)
  let isDir = false
  try { isDir = fs.statSync(full).isDirectory() } catch { /* ignored */ }
  if (isDir && known.skill.has(d) && !allowed.skill.has(d)) rm(full)
}

const mentions = (text) => [...text.matchAll(/(?:^|[\s(`|/])@([a-z][a-z0-9-]+)/g)].map((m) => m[1])
const frontmatterAgent = (text) => {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!frontmatter) return null
  const agent = /^agent:[ \t]*["']?([a-z][a-z0-9-]*)["']?[ \t]*(?:#.*)?$/m.exec(frontmatter[1])
  return agent ? agent[1] : null
}
const cmdDir = path.join(dest, "commands")
for (const f of list(cmdDir)) {
  if (!f.endsWith(".md")) continue
  const name = f.slice(0, -3)
  const full = path.join(cmdDir, f)
  if (known.command.has(name) && !allowed.command.has(name)) { rm(full); continue }
  const text = fs.readFileSync(full, "utf8")
  const agent = frontmatterAgent(text)
  if ((agent && removedAgents.has(agent)) || mentions(text).some((a) => removedAgents.has(a))) rm(full)
}

// --- CEO / AGENTS.md: keep only the selected team and state it ------------------------------
const NOTE_OPEN = "<!-- >>> opencode-prerequisites profile >>> -->"
const NOTE_CLOSE = "<!-- <<< opencode-prerequisites profile <<< -->"
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const stripNote = (text) => text
  .replace(new RegExp(`\\n?${escRe(NOTE_OPEN)}[\\s\\S]*?${escRe(NOTE_CLOSE)}\\n?`, "g"), "\n")
  // Legacy unmarked block appended by older make-lite versions (always at EOF).
  .replace(/\n## Light profile\n(?:Only these agents exist:|Available agents:)[\s\S]*$/, "\n")
  .replace(/\n+$/, "\n")

// Table order (core first, then the selected packs), not alphabetical: the note reads like the team.
const existingAgents = new Set(list(agentsDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)))
const keptAgents = []
for (const [pack, items] of packs) {
  if (!selectedSet.has(pack)) continue
  for (const a of items.agent) if (existingAgents.has(a)) keptAgents.push(a)
}
for (const a of [...existingAgents].sort()) if (!known.agent.has(a)) keptAgents.push(a)

const heading = profile === "lite" ? "## Light profile" : `## Profile: ${profile}`
// Selection-based (stable across runs, so the note is re-appended on a second run). Android is a
// module: its absence alone does not reduce the base team, so it does not trigger the note.
const reduced = [...packs].some(([pack, items]) => pack !== "android" && !selectedSet.has(pack) && items.agent.size > 0)
const fallback = allowed.agent.has("code-simplifier") ? "" : " There is no @code-simplifier: review the diff yourself before @verify-app."

const ceoPath = path.join(agentsDir, "ceo.md")
if (fs.existsSync(ceoPath)) {
  let ceo = stripNote(fs.readFileSync(ceoPath, "utf8"))
  ceo = ceo.split("\n").filter((line) => {
    if (!line.startsWith("|")) return true
    const mentioned = mentions(line.split("|")[1] ?? "")
    return !(mentioned.length && mentioned.every((a) => removedAgents.has(a)))
  }).join("\n")
  if (reduced) {
    const note = `${NOTE_OPEN}\n${heading}\nOnly these agents exist: ${keptAgents.map((a) => "@" + a).join(", ")}. Never call any other name: missing roles (languages other than Rust, devops, docs, database…) are handled by @rust, @backend or @frontend, following the domain checklist in the brief.${fallback}\n${NOTE_CLOSE}\n`
    ceo = `${ceo.replace(/\n+$/, "")}\n\n${note}`
  }
  fs.writeFileSync(ceoPath, ceo)
}

const agentsMdPath = path.join(dest, "AGENTS.md")
if (fs.existsSync(agentsMdPath)) {
  let md = stripNote(fs.readFileSync(agentsMdPath, "utf8"))
  if (reduced) {
    md = `${md.replace(/\n+$/, "")}\n\n${NOTE_OPEN}\n${heading}\nAvailable agents: ${keptAgents.join(", ")}. Ignore any other agent names mentioned above.\n${NOTE_CLOSE}\n`
  }
  fs.writeFileSync(agentsMdPath, md)
}

// --- lite: 2 MCPs, no npm plugin -----------------------------------------------------------
// The table's mcp rows are validated here and consumed by install.sh (mcp_state); only the lite
// profile rewrites opencode.jsonc.
let mcpSummary = "unchanged"
if (profile === "lite") {
  const cfgPath = path.join(dest, "opencode.jsonc")
  if (fs.existsSync(cfgPath)) {
    const cfg = parseJsonc(fs.readFileSync(cfgPath, "utf8"))
    const keepMcp = Object.fromEntries(Object.entries(mcpServers(cfg)).filter(([k]) => ["context7", "grep_app"].includes(k)))
    cfg.mcp = { ...(cfg.mcp?.timeout ? { timeout: cfg.mcp.timeout } : {}), servers: keepMcp }
    delete cfg.plugin
    delete cfg.plugins
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n")
    mcpSummary = Object.keys(keepMcp).join(", ")
  }
  // MemPalace local plugin: OpenCode loads plugins/*/ even without an entry in opencode.jsonc.
  rm(path.join(dest, "plugins", "mempalace"))
  for (const f of ["mempalace.jsonc", "k8s-mcp.toml"]) rm(path.join(dest, f))
}

const label = profile === "lite" ? "Light profile" : profile === "core" ? "Core profile" : `Profile ${profile}`
console.log(`${label}: ${keptAgents.length} agents, MCP ${mcpSummary}`)
