#!/usr/bin/env node
// Diagnostic de l'installation : config, agents, MCP, outils, modèles, et vraie lecture par OpenCode.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { parseJsonc, frontmatter } from "./lib/jsonc.mjs"

const HOME = os.homedir()
const DEST = process.env.OPENCODE_CONFIG_DIR || path.join(HOME, ".config", "opencode")
const BIN = process.env.OBSCURA_BIN_DIR || path.join(HOME, ".local", "bin")
const env = { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}` }
let bad = 0, warned = 0
const ok = (m) => console.log(`✅ ${m}`)
const ko = (m) => { bad++; console.log(`❌ ${m}`) }
const wa = (m) => { warned++; console.log(`⚠️  ${m}`) }
const run = (cmd, args, t = 20000) => spawnSync(cmd, args, { encoding: "utf8", timeout: t, env })
const has = (c) => { const r = run(process.platform === "win32" ? "where" : "which", [c], 5000); return r.status === 0 }

console.log(`Dossier de config : ${DEST}\n`)

// Node
const major = Number(process.versions.node.split(".")[0])
major >= 18 ? ok(`Node ${process.versions.node}`) : ko(`Node ${process.versions.node} trop ancien (18+ requis)`)

// OpenCode
let hasOc = has("opencode")
if (hasOc) ok(`opencode ${run("opencode", ["--version"], 8000).stdout.trim()}`)
else ko("opencode introuvable (curl -fsSL https://opencode.ai/install | bash)")

// Config
let cfg
const cfgFile = ["opencode.jsonc", "opencode.json"].map((f) => path.join(DEST, f)).find(fs.existsSync)
if (!cfgFile) ko(`Aucune config dans ${DEST} : lance ./install.sh`)
else {
  try { cfg = parseJsonc(fs.readFileSync(cfgFile, "utf8")); ok(`${path.basename(cfgFile)} lisible`) }
  catch (e) { ko(`${path.basename(cfgFile)} illisible : ${e.message}`) }
}

// Agents
const agents = {}
const adir = path.join(DEST, "agents")
if (fs.existsSync(adir)) for (const f of fs.readdirSync(adir).filter((x) => x.endsWith(".md"))) {
  agents[f.slice(0, -3)] = frontmatter(fs.readFileSync(path.join(adir, f), "utf8")) ?? {}
}
ok(`${Object.keys(agents).length} agents installés`)
if (cfg?.default_agent) {
  agents[cfg.default_agent]?.mode === "primary"
    ? ok(`default_agent "${cfg.default_agent}" présent (primary)`)
    : ko(`default_agent "${cfg.default_agent}" introuvable ou pas primary`)
}
const skills = fs.existsSync(path.join(DEST, "skills")) ? fs.readdirSync(path.join(DEST, "skills")).length : 0
ok(`${skills} skills, ${fs.existsSync(path.join(DEST, "commands")) ? fs.readdirSync(path.join(DEST, "commands")).length : 0} commandes`)

// Outils annexes
for (const [c, why] of [["git", "worktrees (2.5+)"], ["gh", "/pr et recherche GitHub"], ["agent-wt", "worktrees par agent"], ["oc-new-rust", "gabarit Rust"]]) {
  has(c) ? ok(`${c} disponible`) : wa(`${c} introuvable (${why})`)
}
if (has("gh")) run("gh", ["auth", "status"], 8000).status === 0 ? ok("gh connecté") : wa("gh non connecté (gh auth login)")

// MCP activés : vérifie leurs prérequis
console.log("\nMCP activés :")
for (const [name, m] of Object.entries(cfg?.mcp ?? {})) {
  if (m.enabled === false) { console.log(`   · ${name} (désactivé)`); continue }
  if (m.type === "remote") { ok(`${name} → ${m.url}`); continue }
  const bin = m.command?.[0]
  if (!bin) { ko(`${name} : commande absente`); continue }
  if (!has(bin)) { ko(`${name} : "${bin}" introuvable`); continue }
  if (bin === "docker" && run("docker", ["info"], 10000).status !== 0) { wa(`${name} : Docker installé mais le démon ne répond pas`); continue }
  ok(`${name} : ${bin} disponible`)
}

// Plugins
if (cfg?.plugin?.some?.((p) => p.includes("mempalace"))) {
  const py = run(process.env.MEMPALACE_ADAPTER_PYTHON || "python3", ["-c", "import mempalace"], 8000)
  py.status === 0 ? ok("MemPalace importable") : ko("MemPalace non installé (python3 -m pip install --user mempalace)")
}
const pdir = path.join(DEST, "plugins")
if (fs.existsSync(pdir)) ok(`plugins locaux : ${fs.readdirSync(pdir).join(", ")}`)

// Modèles
const wanted = new Set()
const add = (v) => v && /^opencode-go\//.test(v) && wanted.add(v)
add(cfg?.model); add(cfg?.small_model)
Object.values(cfg?.agent ?? {}).forEach((a) => add(a?.model))
Object.values(agents).forEach((a) => add(a.model))
try {
  const res = await fetch("https://opencode.ai/inference/go/v1/models", { signal: AbortSignal.timeout(8000) })
  const data = await res.json()
  const ids = new Set((data.data ?? data).map?.((x) => `opencode-go/${x.id ?? x}`) ?? [])
  if (!ids.size) throw new Error("liste vide")
  for (const m of wanted) ids.has(m) ? ok(`modèle ${m} existe`) : ko(`modèle ${m} INTROUVABLE : corrige-le (/models)`)
} catch (e) {
  wa(`liste des modèles non vérifiable (${e.message}). Modèles utilisés : ${[...wanted].join(", ")}. Vérifie avec /models.`)
}

// Lecture réelle par OpenCode
if (hasOc) {
  console.log("\nLecture par OpenCode :")
  const r = run("opencode", ["debug", "config"], 30000)
  r.status === 0 ? ok("opencode debug config : configuration chargée sans erreur") : ko(`opencode debug config a échoué :\n${(r.stderr || r.stdout).trim().slice(0, 600)}`)
  const m = run("opencode", ["mcp", "list"], 40000)
  console.log((m.stdout || m.stderr || "").trim().split("\n").map((l) => "   " + l).join("\n"))
  if (cfg?.default_agent) {
    const a = run("opencode", ["debug", "agent", cfg.default_agent], 20000)
    a.status === 0 ? ok(`agent ${cfg.default_agent} chargé`) : ko(`agent ${cfg.default_agent} non chargé : ${(a.stderr || "").trim().slice(0, 300)}`)
  }
}

console.log(`\n${bad ? "❌" : "✅"} ${bad} erreur(s), ${warned} avertissement(s)`)
process.exit(bad ? 1 : 0)
