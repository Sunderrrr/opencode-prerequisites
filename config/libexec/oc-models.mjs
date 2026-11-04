#!/usr/bin/env node
// oc-models: choose each agent's model without editing files by hand.
// Your choices are stored in <config>/oc-models.json and reapplied on every ./install.sh.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DEST = process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode")
const STORE = path.join(DEST, "oc-models.json")
const CFG = path.join(DEST, "opencode.jsonc")
const AGENTS = path.join(DEST, "agents")
const PROVIDER = "opencode-go"
const ID_RE = /^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/

const die = (m) => { console.error(`❌ ${m}`); process.exit(1) }
const readStore = () => { try { return JSON.parse(fs.readFileSync(STORE, "utf8")) } catch { return {} } }
const writeStore = (s) => {
  if (!s.default && !s.small && !Object.keys(s.agents ?? {}).length) { fs.rmSync(STORE, { force: true }); return }
  fs.writeFileSync(STORE, JSON.stringify(s, null, 2) + "\n")
}
const agentNames = () => (fs.existsSync(AGENTS) ? fs.readdirSync(AGENTS).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort() : [])
const normalize = (id) => { const m = id.includes("/") ? id : `${PROVIDER}/${id}`; if (!ID_RE.test(m)) die(`Invalid model identifier: "${id}" (expected: provider/model, e.g. ${PROVIDER}/deepseek-v4.1-flash)`); return m }

// --- reading / writing config files ---
function cfgValue(key) {
  if (!fs.existsSync(CFG)) return undefined
  return fs.readFileSync(CFG, "utf8").match(new RegExp(`^\\s*"${key}"\\s*:\\s*"([^"]*)"`, "m"))?.[1]
}
function setCfgValue(key, value) {
  if (!fs.existsSync(CFG)) die(`${CFG} not found: run ./install.sh first`)
  const t = fs.readFileSync(CFG, "utf8")
  const re = new RegExp(`^(\\s*"${key}"\\s*:\\s*)"[^"]*"`, "m")
  if (!re.test(t)) die(`key "${key}" not found in ${CFG}`)
  fs.writeFileSync(CFG, t.replace(re, `$1"${value}"`))
}
function agentModel(name) {
  const f = path.join(AGENTS, `${name}.md`)
  const m = fs.readFileSync(f, "utf8").match(/^---\n([\s\S]*?)\n---\n/)
  return m?.[1].split("\n").find((l) => /^model:\s*/.test(l))?.replace(/^model:\s*/, "").trim()
}
function setAgentModel(name, model) {
  const f = path.join(AGENTS, `${name}.md`)
  const t = fs.readFileSync(f, "utf8")
  const m = t.match(/^---\n([\s\S]*?)\n---\n/)
  if (!m) die(`${f}: frontmatter not found`)
  const lines = m[1].split("\n").filter((l) => !/^model:\s*/.test(l))
  if (model) { const i = lines.findIndex((l) => /^mode:/.test(l)); lines.splice(i >= 0 ? i + 1 : lines.length, 0, `model: ${model}`) }
  fs.writeFileSync(f, t.replace(m[0], `---\n${lines.join("\n")}\n---\n`))
}

// --- optional check against the online list ---
async function knownModels() {
  if (process.env.OC_MODELS_OFFLINE) return null
  try {
    const res = await fetch(`https://opencode.ai/inference/go/v1/models`, { signal: AbortSignal.timeout(6000) })
    const j = await res.json()
    return new Set((j.data ?? j).map((x) => `${PROVIDER}/${x.id ?? x}`))
  } catch { return null }
}
async function warnIfUnknown(model) {
  if (!model.startsWith(`${PROVIDER}/`)) return
  const known = await knownModels()
  if (known && !known.has(model)) console.log(`⚠️  ${model} is not in the OpenCode Go list (check with: oc-models available). Applied anyway.`)
}

// --- applying oc-models.json to the installed files ---
function apply() {
  const s = readStore()
  const names = agentNames()
  if (s.default) setCfgValue("model", s.default)
  if (s.small) setCfgValue("small_model", s.small)
  for (const [agent, model] of Object.entries(s.agents ?? {})) {
    if (!names.includes(agent)) { console.log(`ℹ️  agent "${agent}" not in this installation (lite profile?): setting ignored`); continue }
    setAgentModel(agent, model)
  }
}

// --- commands ---
function list() {
  const def = cfgValue("model") ?? "(not set)"
  const small = cfgValue("small_model") ?? "(not set)"
  const s = readStore()
  console.log(`Default model: ${def}${s.default ? "  (set by you)" : ""}`)
  console.log(`Small model  : ${small}${s.small ? "  (set by you)" : ""}\n`)
  const names = agentNames()
  const w = Math.max(...names.map((n) => n.length), 5)
  for (const n of names) {
    const own = agentModel(n)
    console.log(`  ${n.padEnd(w)}  ${own ?? def}${own ? "   ◀ own model" : ""}`)
  }
  console.log(`\nChange: oc-models set <agent|default|small|all> <model>   ·   Undo: oc-models reset <agent|all>`)
}

async function set(target, raw) {
  if (!target || !raw) die("usage: oc-models set <agent|default|small|all> <model>")
  const model = normalize(raw)
  await warnIfUnknown(model)
  const s = readStore(); s.agents ??= {}
  if (target === "default") { s.default = model }
  else if (target === "small") { s.small = model }
  else if (target === "all") { s.default = model; s.small = model; s.agents = {}; for (const n of agentNames()) setAgentModel(n, null) }
  else {
    if (!agentNames().includes(target)) die(`unknown agent: "${target}". Agents: ${agentNames().join(", ")}`)
    s.agents[target] = model
  }
  writeStore(s); apply()
  console.log(`✅ ${target} → ${model}${target === "all" ? " (all agents, no per-agent model left)" : ""}`)
  console.log("   Restart OpenCode for this to take effect.")
}

function reset(target) {
  if (!target) die("usage: oc-models reset <agent|all>")
  const s = readStore(); s.agents ??= {}
  if (target === "all") { s.agents = {}; delete s.default; delete s.small; for (const n of agentNames()) setAgentModel(n, null) }
  else if (target === "default" || target === "small") { delete s[target] }
  else {
    if (!agentNames().includes(target)) die(`unknown agent: "${target}"`)
    delete s.agents[target]; setAgentModel(target, null)
  }
  writeStore(s)
  console.log(`✅ ${target}: setting removed (the kit default model applies again after ./install.sh --no-tools)`)
}

async function available() {
  const known = await knownModels()
  if (!known) die("list unavailable (network?)")
  console.log([...known].sort().join("\n"))
}

const [cmd = "list", ...args] = process.argv.slice(2)
if (cmd === "list" || cmd === "ls") list()
else if (cmd === "set") await set(args[0], args[1])
else if (cmd === "reset") reset(args[0])
else if (cmd === "apply") apply()
else if (cmd === "available") await available()
else die(`unknown command: ${cmd}\nUsage: oc-models [list | set <agent|default|small|all> <model> | reset <agent|all> | available]`)
