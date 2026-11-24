#!/usr/bin/env node
// Tests for scripts/export-codex.mjs: a real export of the kit into a temporary
// HOME/CODEX_HOME, the 30 agent TOMLs and their model/effort mapping, skills copied
// byte-for-byte (including executable bits), MCP merge/backup, the fast/deep profiles,
// idempotence, .new preservation, --force, --dry-run, --mcp-only, --global, a fixture
// with disabled/remote/local MCP servers, the launcher, and the Codex CLI reading the
// exported config (`mcp list`, `doctor`, `debug prompt-input`).
// Hermetic: every write goes to a temporary directory, never to the real ~/.codex.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { parseJsonc, mcpServers, frontmatter } from "./lib/jsonc.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXPORT = path.join(ROOT, "scripts", "export-codex.mjs")
const WRAPPER = path.join(ROOT, "config", "bin", "oc-export-codex")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-codex-"))
let passed = 0
let failed = 0

const check = (name, cond, detail = "") => {
  cond ? passed++ : failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`)
}
const read = (f) => fs.readFileSync(f, "utf8")
const readBuf = (f) => fs.readFileSync(f)
const exists = (f) => fs.existsSync(f)
const ls = (d) => (exists(d) ? fs.readdirSync(d).sort() : [])
const run = (args, opts = {}) => spawnSync(process.execPath, [EXPORT, ...args], { encoding: "utf8", ...opts })
const runBash = (args, opts = {}) => spawnSync("bash", args, { encoding: "utf8", ...opts })
const write = (f, text) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, text)
}

function walk(dir, base = dir) {
  const out = []
  for (const name of ls(dir)) {
    const full = path.join(dir, name)
    const st = fs.lstatSync(full)
    if (st.isDirectory()) out.push(...walk(full, base))
    else if (st.isFile()) out.push(path.relative(base, full))
  }
  return out.sort()
}

function snapshot(dir, skip = () => false) {
  const h = crypto.createHash("sha256")
  for (const rel of walk(dir)) {
    if (skip(rel)) continue
    const st = fs.lstatSync(path.join(dir, rel))
    h.update(rel)
    h.update("\0")
    h.update(String(st.mode & 0o777))
    h.update("\0")
    h.update(fs.readFileSync(path.join(dir, rel)))
    h.update("\0")
  }
  return h.digest("hex")
}

function bodyOf(text) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return (m ? text.slice(m[0].length) : text).trim()
}

function parseJsonOutput(text, label) {
  const start = text.search(/[\[{]/)
  if (start < 0) throw new Error(`${label}: no JSON in stdout: ${text.slice(0, 200)}`)
  return JSON.parse(text.slice(start))
}

// Header keys of the generated agent TOML (name/description/model/effort) plus the
// developer_instructions block. The exporter uses a literal multiline string unless
// the body itself contains '''; both forms are accepted here.
function parseAgentToml(text) {
  const cut = text.indexOf("developer_instructions = ")
  const head = cut >= 0 ? text.slice(0, cut) : text
  const rest = cut >= 0 ? text.slice(cut) : ""
  const str = (key) => {
    const m = new RegExp("^" + key + " = (\".*\")\\s*$", "m").exec(head)
    return m ? JSON.parse(m[1]) : null
  }
  let instructions = null
  const literal = /^developer_instructions = '''\n([\s\S]*?)'''\s*$/m.exec(rest)
  if (literal) instructions = literal[1]
  else {
    const basic = /^developer_instructions = """\n([\s\S]*?)"""\s*$/m.exec(rest)
    if (basic) instructions = basic[1]
  }
  return {
    name: str("name"),
    description: str("description"),
    model: str("model"),
    effort: str("model_reasoning_effort"),
    instructions,
  }
}

function tomlTables(text) {
  const out = {}
  let current = null
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const m = /^\[([^\]]+)\]$/.exec(line)
    if (m) {
      current = m[1]
      out[current] = []
    } else if (current) {
      out[current].push(line)
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join("\n")]))
}

// Source of truth: the exporter must follow the kit, not a hardcoded list.
const cfg = parseJsonc(read(path.join(ROOT, "config", "opencode.jsonc")))
const sourceMcp = mcpServers(cfg)
const enabledMcp = Object.keys(sourceMcp)
  .filter((n) => sourceMcp[n] && sourceMcp[n].disabled !== true && sourceMcp[n].enabled !== false)
  .sort()
const agentSrc = path.join(ROOT, "config", "agents")
const coreAgents = ls(agentSrc).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))
const coreSkills = ls(path.join(ROOT, "config", "skills")).filter((d) => exists(path.join(ROOT, "config", "skills", d, "SKILL.md")))
const coreSkillFiles = coreSkills.reduce((n, d) => n + walk(path.join(ROOT, "config", "skills", d)).length, 0)

const MODEL = { astra: "gpt-6.2-astra", sol: "gpt-6.2-sol", terra: "gpt-6.1-terra", luna: "gpt-6-luna" }
const ASTRA = ["ceo", "architect", "security", "review", "verify-app", "integrator"]
const LUNA = ["researcher", "web-researcher"]
const TERRA = ["designer"]
const expected = (name) => {
  if (TERRA.includes(name)) return { model: MODEL.terra, effort: "high" }
  if (ASTRA.includes(name)) return { model: MODEL.astra, effort: "high" }
  if (LUNA.includes(name)) return { model: MODEL.luna, effort: "low" }
  return { model: MODEL.sol, effort: "medium" }
}

// ---------- 1. Real kit export with a temporary HOME / CODEX_HOME ----------
const home = path.join(tmp, "home")
const out = path.join(home, ".codex")
fs.mkdirSync(home, { recursive: true })
const env = { ...process.env, HOME: home, CODEX_HOME: out, OPENAI_API_KEY: "sk-test-dummy" }
const r1 = run(["--out", out], { env })
check("export: exit 0", r1.status === 0, r1.stderr)
check("export: summary printed", /Codex export: 30 agents, \d+ skills, \d+ MCP servers, 2 profiles/.test(r1.stdout), r1.stdout)
check("export: target exists", exists(out))
check("export: AGENTS.md generated", exists(path.join(out, "AGENTS.md")))
check("export: manifest generated", exists(path.join(out, ".oc-export-manifest.json")))
check("export: fast/deep profiles generated", exists(path.join(out, "fast.config.toml")) && exists(path.join(out, "deep.config.toml")))

// Agents: exactly one TOML per config/agents/*.md.
const agentDir = path.join(out, "agents")
const exportedAgents = ls(agentDir).filter((f) => f.endsWith(".toml")).map((f) => f.slice(0, -5))
check("agents: exact count (one TOML per agent markdown)", exportedAgents.length === coreAgents.length, `${exportedAgents.length} vs ${coreAgents.length}`)
check("agents: every core agent exported", coreAgents.every((n) => exportedAgents.includes(n)), coreAgents.filter((n) => !exportedAgents.includes(n)).join(","))
check("agents: no unexpected agent file", exportedAgents.every((n) => coreAgents.includes(n)), exportedAgents.filter((n) => !coreAgents.includes(n)).join(","))

const toml = {}
const agentErrors = []
for (const name of coreAgents) {
  const file = path.join(agentDir, name + ".toml")
  if (!exists(file)) {
    agentErrors.push(`${name}: missing`)
    continue
  }
  const t = parseAgentToml(read(file))
  toml[name] = t
  const src = read(path.join(agentSrc, name + ".md"))
  const fm = frontmatter(src) || {}
  if (t.name !== name) agentErrors.push(`${name}: name=${t.name}`)
  if ((t.description || "") !== String(fm.description || "").trim()) agentErrors.push(`${name}: description`)
  if (!t.model) agentErrors.push(`${name}: no model`)
  if (!["high", "medium", "low"].includes(t.effort)) agentErrors.push(`${name}: effort=${t.effort}`)
  if (!t.instructions || t.instructions.length < 100) agentErrors.push(`${name}: empty instructions`)
  else if (/^(mode|temperature|permission|steps):/m.test(t.instructions)) agentErrors.push(`${name}: OpenCode frontmatter leaked`)
  else {
    const firstLine = bodyOf(src).split("\n").find((l) => l.trim()).trim()
    if (!t.instructions.includes(firstLine)) agentErrors.push(`${name}: source body missing`)
    if (!/^## Codex execution notes/m.test(t.instructions)) agentErrors.push(`${name}: Codex notes missing`)
    if (!/Commit locally/.test(t.instructions)) agentErrors.push(`${name}: commit rule missing`)
  }
}
check("agents: TOML fields valid (name, description, model, effort, instructions)", agentErrors.length === 0, agentErrors.slice(0, 6).join(" | "))

const modelErrors = []
for (const name of coreAgents) {
  const t = toml[name]
  const want = expected(name)
  if (!t || t.model !== want.model || t.effort !== want.effort) {
    modelErrors.push(`${name}: ${t && t.model}/${t && t.effort} != ${want.model}/${want.effort}`)
  }
}
check("model: every agent follows the tier mapping", modelErrors.length === 0, modelErrors.slice(0, 6).join(" | "))
check(`model: ceo = ${MODEL.astra}/high`, toml.ceo && toml.ceo.model === MODEL.astra && toml.ceo.effort === "high")
check(`model: researcher = ${MODEL.luna}/low`, toml.researcher && toml.researcher.model === MODEL.luna && toml.researcher.effort === "low")
check(`model: designer = ${MODEL.terra}/high`, toml.designer && toml.designer.model === MODEL.terra && toml.designer.effort === "high")
check(`model: default (rust/docs/codex) = ${MODEL.sol}/medium`, ["rust", "docs", "codex"].every((n) => toml[n] && toml[n].model === MODEL.sol && toml[n].effort === "medium"))
check("model: astra/high count", coreAgents.filter((n) => toml[n] && toml[n].model === MODEL.astra && toml[n].effort === "high").length === ASTRA.length, String(ASTRA.length))
check("model: luna/low count", coreAgents.filter((n) => toml[n] && toml[n].model === MODEL.luna && toml[n].effort === "low").length === LUNA.length, String(LUNA.length))
check("model: terra/high count", coreAgents.filter((n) => toml[n] && toml[n].model === MODEL.terra && toml[n].effort === "high").length === TERRA.length, String(TERRA.length))
check("model: sol/medium count", coreAgents.filter((n) => toml[n] && toml[n].model === MODEL.sol && toml[n].effort === "medium").length === coreAgents.length - ASTRA.length - LUNA.length - TERRA.length)

// CEO-specific sections and @mention adaptation.
const ceoToml = toml.ceo ? toml.ceo.instructions : ""
check("ceo: model routing section", /## Model routing \(Codex\)/.test(ceoToml) && /gpt-6\.2-astra/.test(ceoToml))
check("ceo: delegation section", /## CEO delegation rules \(Codex\)/.test(ceoToml) && /spawn_agent/.test(ceoToml))
check("ceo: @mentions adapted to code spans", /`architect`/.test(ceoToml) && !/(^|[^A-Za-z0-9_@])@architect\b/.test(ceoToml))
check("agents: @ts-ignore preserved verbatim", /@ts-ignore/.test(toml.typescript ? toml.typescript.instructions : "") && !/`ts-ignore`/.test(toml.typescript ? toml.typescript.instructions : ""))

// AGENTS.md
const agentsMd = read(path.join(out, "AGENTS.md"))
check("AGENTS.md: kit content included", /# Global rules/.test(agentsMd) && /Done = proven/.test(agentsMd))
check("AGENTS.md: model routing table", /## Model routing \(Codex\)/.test(agentsMd) && new RegExp(MODEL.astra).test(agentsMd) && new RegExp(MODEL.luna).test(agentsMd))
check("AGENTS.md: CEO delegation", /## CEO delegation rules \(Codex\)/.test(agentsMd) && /spawn_agent/.test(agentsMd))
check("AGENTS.md: paths and profiles", /~\/\.codex\/agents/.test(agentsMd) && /~\/\.agents\/skills/.test(agentsMd) && /codex --profile fast/.test(agentsMd))
check("AGENTS.md: Codex limitations documented", /no per-agent sandbox/.test(agentsMd) && /TUI presets/.test(agentsMd))

// Skills: byte-for-byte, mode preserved.
const skillsDir = path.join(out, "skills")
const skillErrors = []
for (const skill of coreSkills) {
  for (const rel of walk(path.join(ROOT, "config", "skills", skill))) {
    const src = path.join(ROOT, "config", "skills", skill, rel)
    const dst = path.join(skillsDir, skill, rel)
    if (!exists(dst)) {
      skillErrors.push(`${skill}/${rel}: missing`)
      continue
    }
    if (!readBuf(src).equals(readBuf(dst))) skillErrors.push(`${skill}/${rel}: bytes differ`)
    if ((fs.statSync(src).mode & 0o777) !== (fs.statSync(dst).mode & 0o777)) skillErrors.push(`${skill}/${rel}: mode`)
  }
}
check("skills: every core skill exported", coreSkills.every((n) => exists(path.join(skillsDir, n, "SKILL.md"))), ls(skillsDir).join(","))
check("skills: exact file count", coreSkills.reduce((n, d) => n + walk(path.join(skillsDir, d)).length, 0) === coreSkillFiles, `${coreSkillFiles} expected`)
check("skills: content and mode byte-identical", skillErrors.length === 0, skillErrors.slice(0, 6).join(" | "))
const executableSkills = coreSkills.flatMap((skill) =>
  walk(path.join(ROOT, "config", "skills", skill))
    .filter((rel) => (fs.statSync(path.join(ROOT, "config", "skills", skill, rel)).mode & 0o111) !== 0)
    .map((rel) => ({ skill, rel })),
)
check("skills: an executable source file exists", executableSkills.length > 0, executableSkills.map((x) => `${x.skill}/${x.rel}`).join(","))
for (const { skill, rel } of executableSkills.slice(0, 3)) {
  const src = path.join(ROOT, "config", "skills", skill, rel)
  const dst = path.join(skillsDir, skill, rel)
  check(`skills: executable bit preserved (${skill}/${rel})`, (fs.statSync(dst).mode & 0o777) === (fs.statSync(src).mode & 0o777) && (fs.statSync(dst).mode & 0o111) !== 0)
}

// MCP config.toml: [agents], [features], [mcp_servers.*].
const config = read(path.join(out, "config.toml"))
const tables = tomlTables(config)
check("config: every enabled OpenCode server exported", enabledMcp.every((n) => tables["mcp_servers." + n]), enabledMcp.filter((n) => !tables["mcp_servers." + n]).join(","))
check("config: remote server is [mcp_servers.context7] with url", /url = "https:\/\/mcp\.context7\.com\/mcp"/.test(tables["mcp_servers.context7"] || ""))
check("config: local server has command and args", new RegExp('command = "' + path.join(home, ".local", "bin", "oc-playwright-mcp").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"').test(tables["mcp_servers.playwright"] || "") && /args = \[\]/.test(tables["mcp_servers.playwright"] || ""))
check("config: {env:HOME} expanded and no template left", !/\{env:/.test(config) && config.includes(path.join(home, ".local", "bin")))
check("config: [agents] enabled + default subagent model/effort", /enabled = true/.test(tables.agents || "") && /default_subagent_model = "gpt-6\.2-sol"/.test(tables.agents || "") && /default_subagent_reasoning_effort = "medium"/.test(tables.agents || ""))
check("config: [features] multi_agent_v2 enabled", /multi_agent_v2 = true/.test(tables.features || ""))
check("config: no generated .new on a clean export", !walk(out).some((rel) => rel.endsWith(".new")))

// Profiles.
const fast = read(path.join(out, "fast.config.toml"))
const deep = read(path.join(out, "deep.config.toml"))
check("profile fast: sol/medium", new RegExp(`model = "${MODEL.sol}"`).test(fast) && /model_reasoning_effort = "medium"/.test(fast))
check("profile deep: astra/high", new RegExp(`model = "${MODEL.astra}"`).test(deep) && /model_reasoning_effort = "high"/.test(deep))

// ---------- 2. Idempotence ----------
const skipVolatile = (rel) => rel.includes(".bak-") || rel.endsWith(".new")
const hash1 = snapshot(out, skipVolatile)
const r2 = run(["--out", out], { env })
check("idempotence: second export exit 0", r2.status === 0, r2.stderr)
check("idempotence: tree byte-identical", snapshot(out, skipVolatile) === hash1)
check("idempotence: 0 written", /files: 0 written, \d+ unchanged/.test(r2.stdout), r2.stdout)
check("idempotence: no .new created", !walk(out).some((rel) => rel.endsWith(".new")))

// ---------- 3. Conflict: .new by default, --force overwrites ----------
const conflictOut = path.join(tmp, "conflict")
write(path.join(conflictOut, "AGENTS.md"), "LOCAL AGENTS CONTENT\n")
const r3 = run(["--out", conflictOut], { env })
check("conflict: export exits 0", r3.status === 0, r3.stderr)
check("conflict: foreign target preserved", read(path.join(conflictOut, "AGENTS.md")) === "LOCAL AGENTS CONTENT\n")
check("conflict: generated version written to .new", exists(path.join(conflictOut, "AGENTS.md.new")) && read(path.join(conflictOut, "AGENTS.md.new")) === agentsMd)
check("conflict: summary counts the .new", /1 preserved as \.new/.test(r3.stdout), r3.stdout)
const r4 = run(["--out", conflictOut, "--force"], { env })
check("force: exit 0", r4.status === 0, r4.stderr)
check("force: target overwritten with the generated version", read(path.join(conflictOut, "AGENTS.md")) === agentsMd)
check("force: .new cleaned up", !exists(path.join(conflictOut, "AGENTS.md.new")))

// ---------- 4. --dry-run ----------
const dryOut = path.join(tmp, "dry")
const r5 = run(["--out", dryOut, "--dry-run"], { env })
check("dry-run: exit 0", r5.status === 0, r5.stderr)
check("dry-run: writes nothing", !exists(dryOut))
check("dry-run: prints the plan", /Codex export \(dry run\)/.test(r5.stdout) && /agents: 30, skills: \d+, MCP: \d+/.test(r5.stdout), r5.stdout.slice(0, 300))
check("dry-run: lists an agent TOML and the config merge", /agents\/ceo\.toml/.test(r5.stdout) && /config: .*mcp_servers\./.test(r5.stdout))

// ---------- 5. --mcp-only ----------
const mcpOnlyOut = path.join(tmp, "mcp-only")
const r6 = run(["--out", mcpOnlyOut, "--mcp-only"], { env })
check("mcp-only: exit 0", r6.status === 0, r6.stderr)
check("mcp-only: config.toml written", exists(path.join(mcpOnlyOut, "config.toml")))
check("mcp-only: no agents, AGENTS.md, skills or profiles", !exists(path.join(mcpOnlyOut, "agents")) && !exists(path.join(mcpOnlyOut, "AGENTS.md")) && !exists(path.join(mcpOnlyOut, "skills")) && !exists(path.join(mcpOnlyOut, "fast.config.toml")))
const mcpOnlyTables = tomlTables(read(path.join(mcpOnlyOut, "config.toml")))
check("mcp-only: every MCP server merged", enabledMcp.every((n) => mcpOnlyTables["mcp_servers." + n]))
check("mcp-only: [agents] not written", !mcpOnlyTables.agents)
check("mcp-only: summary printed", /Codex MCP merge/.test(r6.stdout) && new RegExp(`MCP servers: ${enabledMcp.length} configured, ${enabledMcp.length} added`).test(r6.stdout), r6.stdout)

// ---------- 6. --global with a temporary HOME ----------
const globalHome = path.join(tmp, "global-home")
const globalEnv = { ...process.env, HOME: globalHome, CODEX_HOME: path.join(globalHome, ".codex"), OPENAI_API_KEY: "sk-test-dummy" }
const r7 = run(["--global"], { env: globalEnv })
check("global: exit 0", r7.status === 0, r7.stderr)
check("global: writes ~/.codex/AGENTS.md and agents", exists(path.join(globalHome, ".codex", "AGENTS.md")) && exists(path.join(globalHome, ".codex", "agents", "ceo.toml")))
check("global: writes ~/.codex/config.toml and profiles", exists(path.join(globalHome, ".codex", "config.toml")) && exists(path.join(globalHome, ".codex", "fast.config.toml")) && exists(path.join(globalHome, ".codex", "deep.config.toml")))
check("global: writes shared ~/.agents/skills", exists(path.join(globalHome, ".agents", "skills", "tdd", "SKILL.md")))
check("global: no duplicate skills inside ~/.codex", !exists(path.join(globalHome, ".codex", "skills")))
check("global: summary points at the shared skills", /shared user-level skills/.test(r7.stdout), r7.stdout)
check("global: mentions the Codex app sharing config", /Codex app reads the same/.test(r7.stdout), r7.stdout)

// ---------- 7. Fixture: executable skill, disabled/remote/local MCP, merge/backup ----------
const fixture = path.join(tmp, "fixture")
const fixtureCfg = path.join(fixture, "config")
write(path.join(fixtureCfg, "AGENTS.md"), "# Fixture rules\n\n- Reply in the user's language.\n")
write(path.join(fixtureCfg, "agents", "ceo.md"), "---\ndescription: Fixture CEO.\nmode: primary\n---\nYou delegate to @helper.\n")
write(path.join(fixtureCfg, "agents", "helper.md"), "---\ndescription: Fixture helper.\n---\nYou help.\n")
write(path.join(fixtureCfg, "skills", "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\ndescription: Fixture skill.\n---\n# Fixture\n")
write(path.join(fixtureCfg, "skills", "fixture-skill", "scripts", "run.sh"), "#!/bin/sh\necho fixture\n")
fs.chmodSync(path.join(fixtureCfg, "skills", "fixture-skill", "scripts", "run.sh"), 0o755)
write(path.join(fixtureCfg, "skills", "fixture-skill", "reference.txt"), "support file\n")
write(
  path.join(fixtureCfg, "opencode.jsonc"),
  JSON.stringify({
    mcp: {
      servers: {
        local: { type: "local", command: ["/bin/echo", "{env:HOME}/fixture"], environment: { BASE: "{env:HOME}/x" } },
        remote: { type: "remote", url: "https://example.invalid/mcp", headers: { "X-Test": "{env:HOME}" } },
        off: { type: "local", command: ["/bin/false"], disabled: true },
      },
    },
  }) + "\n",
)
const fixtureOut = path.join(tmp, "fixture-out")
fs.mkdirSync(fixtureOut, { recursive: true })
const fixtureInitialConfig = "# user config\nmodel = \"fixture-model\"\n\n[mcp_servers.local]\ncommand = \"/bin/true\"\nargs = [\"user\"]\n\n[features]\nmulti_agent_v2 = false\n"
write(path.join(fixtureOut, "config.toml"), fixtureInitialConfig)
const r8 = run(["--config", fixtureCfg, "--out", fixtureOut, "--force"], { env })
check("fixture: exit 0", r8.status === 0, r8.stderr)
const fConfig = read(path.join(fixtureOut, "config.toml"))
const fTables = tomlTables(fConfig)
check("fixture: user config key preserved", /^model = "fixture-model"$/m.test(fConfig), fConfig.slice(0, 120))
check("fixture: user MCP server wins", /command = "\/bin\/true"/.test(fTables["mcp_servers.local"] || "") && /args = \["user"\]/.test(fTables["mcp_servers.local"] || ""))
check("fixture: remote server url and headers", /url = "https:\/\/example\.invalid\/mcp"/.test(fTables["mcp_servers.remote"] || "") && new RegExp(`http_headers = \\{ "X-Test" = "${home}" \\}`).test(fTables["mcp_servers.remote"] || ""))
check("fixture: disabled server omitted", !fTables["mcp_servers.off"])
check("fixture: user feature flag preserved", /multi_agent_v2 = false/.test(fTables.features || ""))
check("fixture: [agents] added", /enabled = true/.test(fTables.agents || ""))
const fixtureBackups = ls(fixtureOut).filter((f) => f.startsWith("config.toml.bak-"))
check("fixture: config.toml backup written before the merge", fixtureBackups.length === 1 && read(path.join(fixtureOut, fixtureBackups[0])) === fixtureInitialConfig, fixtureBackups.join(","))
const fixtureScript = path.join(fixtureOut, "skills", "fixture-skill", "scripts", "run.sh")
check("fixture: executable skill copied byte-for-byte", exists(fixtureScript) && read(fixtureScript) === "#!/bin/sh\necho fixture\n")
check("fixture: executable bit preserved (0755)", (fs.statSync(fixtureScript).mode & 0o777) === 0o755, String((fs.statSync(fixtureScript).mode & 0o777).toString(8)))
check("fixture: support file copied", read(path.join(fixtureOut, "skills", "fixture-skill", "reference.txt")) === "support file\n")
const fixtureCeo = parseAgentToml(read(path.join(fixtureOut, "agents", "ceo.toml")))
const fixtureHelper = parseAgentToml(read(path.join(fixtureOut, "agents", "helper.toml")))
check("fixture: @helper adapted", fixtureCeo.instructions.includes("`helper`") && !/@helper\b/.test(fixtureCeo.instructions))
check("fixture: ceo keeps the astra/high tier", fixtureCeo.model === MODEL.astra && fixtureCeo.effort === "high")
check("fixture: default model sol/medium (helper)", fixtureHelper.model === MODEL.sol && fixtureHelper.effort === "medium")
check("fixture: manifest generated", exists(path.join(fixtureOut, ".oc-export-manifest.json")))

// ---------- 8. CLI arguments ----------
check("usage: --out and --global are exclusive", run(["--out", path.join(tmp, "x"), "--global"]).status === 2)
check("usage: --mcp-only and --project are exclusive", run(["--mcp-only", "--project", tmp]).status === 2)
check("usage: unknown option exits 2", run(["--nope"]).status === 2)
const rw = runBash([WRAPPER, "--help"], { env })
check("launcher: --help exit 0", rw.status === 0 && /Usage:/.test(rw.stdout), rw.stderr)
const wrapperOut = path.join(tmp, "wrapper-out")
const rw2 = runBash([WRAPPER, "--out", wrapperOut], { env })
check("launcher: repository layout resolves the exporter", rw2.status === 0 && exists(path.join(wrapperOut, "agents", "ceo.toml")), rw2.stderr)

// ---------- 9. Codex CLI reads the generated configuration ----------
const codexPath = runBash(["-c", "command -v codex"]).stdout.trim()
if (!codexPath) console.log("⏭️  cli: codex not on PATH — integration checks skipped (install Codex CLI 0.172+ to run them)")
if (codexPath) {
  // Work on a copy so the doctor/prompt-input state files never pollute the export tree.
  const cliHome = path.join(tmp, "cli-home")
  fs.cpSync(out, cliHome, { recursive: true })
  const cliEnv = { ...process.env, HOME: home, CODEX_HOME: cliHome, OPENAI_API_KEY: "sk-test-dummy" }
  const cli = (args) => spawnSync(codexPath, args, { encoding: "utf8", env: cliEnv, cwd: tmp })

  const rMcp = cli(["mcp", "list", "--json"])
  check("cli: mcp list --json exit 0", rMcp.status === 0, rMcp.stderr)
  let mcpList = null
  try {
    mcpList = parseJsonOutput(rMcp.stdout, "mcp list")
  } catch (e) {
    check("cli: mcp list JSON parses", false, e.message)
  }
  if (mcpList) {
    check("cli: mcp list parses every entry", Array.isArray(mcpList) && mcpList.every((s) => s.name && s.transport))
    check("cli: every enabled MCP server is visible", JSON.stringify(mcpList.map((s) => s.name).sort()) === JSON.stringify(enabledMcp), mcpList.map((s) => s.name).join(","))
    const ctx7 = mcpList.find((s) => s.name === "context7")
    check("cli: remote server is streamable_http", ctx7 && ctx7.transport.type === "streamable_http" && ctx7.transport.url === "https://mcp.context7.com/mcp", ctx7 && ctx7.transport.type)
    const pw = mcpList.find((s) => s.name === "playwright")
    check("cli: local server is stdio with the expanded command", pw && pw.transport.type === "stdio" && pw.transport.command === path.join(home, ".local", "bin", "oc-playwright-mcp"), pw && pw.transport.command)
  }

  const rFast = cli(["-p", "fast", "mcp", "list", "--json"])
  const rDeep = cli(["-p", "deep", "mcp", "list", "--json"])
  check("cli: fast profile loads", rFast.status === 0, rFast.stderr)
  check("cli: deep profile loads", rDeep.status === 0, rDeep.stderr)

  const rDoc = cli(["doctor", "--json"])
  check("cli: doctor --json exit 0", rDoc.status === 0, rDoc.stderr)
  let doc = null
  try {
    doc = parseJsonOutput(rDoc.stdout, "doctor")
  } catch (e) {
    check("cli: doctor JSON parses", false, e.message)
  }
  if (doc && doc.checks) {
    check("cli: doctor loads the generated config", doc.checks["config.load"] && doc.checks["config.load"].status === "ok", doc.checks["config.load"] && doc.checks["config.load"].summary)
    check("cli: doctor sees all MCP servers", doc.checks["mcp.config"] && String(doc.checks["mcp.config"].details["configured servers"]) === String(enabledMcp.length), doc.checks["mcp.config"] && doc.checks["mcp.config"].details["configured servers"])
    check("cli: doctor reports the dummy key as env auth", doc.checks["auth.credentials"] && doc.checks["auth.credentials"].status === "ok", doc.checks["auth.credentials"] && doc.checks["auth.credentials"].summary)
  }

  const rPrompt = cli(["debug", "prompt-input", "Reply with OK"])
  check("cli: debug prompt-input exit 0", rPrompt.status === 0, rPrompt.stderr)
  let prompt = null
  try {
    prompt = parseJsonOutput(rPrompt.stdout, "prompt-input")
  } catch (e) {
    check("cli: prompt-input JSON parses", false, e.message)
  }
  if (Array.isArray(prompt)) {
    const itemText = (item) => {
      if (typeof item.content === "string") return item.content
      if (Array.isArray(item.content)) return item.content.map((c) => c.text || "").join("\n")
      return ""
    }
    const visibleText = prompt.map(itemText).join("\n")
    const allTools = []
    const collect = (tools) => {
      for (const t of tools || []) {
        if (t.name) allTools.push(t)
        if (t.tools) collect(t.tools)
      }
    }
    for (const item of prompt) if (item.type === "additional_tools") collect(item.tools)
    const spawn = allTools.find((t) => t.name === "spawn_agent")
    const roleDesc = (spawn && spawn.parameters && spawn.parameters.properties && spawn.parameters.properties.agent_type && spawn.parameters.properties.agent_type.description) || ""
    const roleNames = [...roleDesc.matchAll(/^([a-z][a-z0-9-]+): \{/gm)].map((m) => m[1])
    const kitRoles = roleNames.filter((n) => coreAgents.includes(n))
    const builtins = roleNames.filter((n) => !coreAgents.includes(n))
    check("cli: prompt-input exposes the 30 kit roles", kitRoles.length === coreAgents.length, `${kitRoles.length}/${coreAgents.length}: ${coreAgents.filter((n) => !kitRoles.includes(n)).join(",")}`)
    check("cli: prompt-input also lists Codex built-in roles", builtins.length >= 3 && ["default", "explorer", "worker"].every((n) => builtins.includes(n)), builtins.join(","))
    const roleBlock = (name) => {
      const m = new RegExp("^" + name + ": \\{\\n([\\s\\S]*?)\\n\\}", "m").exec(roleDesc)
      return m ? m[1] : ""
    }
    for (const [name, want] of Object.entries({ ceo: expected("ceo"), researcher: expected("researcher"), designer: expected("designer"), rust: expected("rust") })) {
      const block = roleBlock(name)
      check(`cli: role ${name} = ${want.model}/${want.effort}`, block.includes(want.model) && block.includes("`" + want.effort + "`"), block.slice(0, 160))
    }
    check("cli: prompt-input reads the generated AGENTS.md", /Generated by oc-export-codex/.test(visibleText) && /## Model routing \(Codex\)/.test(visibleText) && /<multi_agent_role>/.test(visibleText))
    check("cli: prompt-input discovers the exported skills", visibleText.includes(path.join(cliHome, "skills")) && /tdd/.test(visibleText), `missing ${path.join(cliHome, "skills")}`)
  }
}

// ---------- 10. No secrets in the generated tree ----------
const secretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bOPENAI_API_KEY\s*=\s*\S+/,
  /sk-test-dummy/,
]
const secretHits = []
for (const rel of walk(out)) {
  if (rel.includes(".bak-") || rel.endsWith(".new")) continue
  const text = read(path.join(out, rel))
  for (const re of secretPatterns) if (re.test(text)) secretHits.push(`${rel}: ${re}`)
}
check("security: no secret pattern in the export", secretHits.length === 0, secretHits.slice(0, 4).join(" | "))
check("security: the dummy API key never reaches config.toml", !config.includes("sk-test-dummy") && !config.includes("OPENAI_API_KEY"))

// ---------- Result ----------
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) {
  console.log(`ℹ️  temporary tree kept for inspection: ${tmp}`)
  process.exit(1)
}
console.log("✅ Codex export OK")
