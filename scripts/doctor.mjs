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

// Sortie lisible : fusionne les lignes identiques consécutives (ex. boucles de shim) et tronque.
const squash = (txt, max = 12) => {
  const out = []
  for (const l of (txt ?? "").split("\n").map((x) => x.trimEnd()).filter(Boolean)) {
    const last = out[out.length - 1]
    if (last && last.line === l) last.n++
    else out.push({ line: l, n: 1 })
  }
  const lines = out.map((o) => (o.n > 1 ? `${o.line}  (×${o.n})` : o.line))
  return lines.slice(0, max).join("\n") + (lines.length > max ? `\n… (${lines.length - max} lignes de plus)` : "")
}

// opencode : on appelle le vrai binaire (les shims mise/asdf peuvent boucler hors d'un shell interactif)
// et avec l'environnement d'origine (sans modifier le PATH).
const OC = (() => {
  if (has("mise")) {
    const r = spawnSync("mise", ["which", "opencode"], { encoding: "utf8", timeout: 10000 })
    const p = r.status === 0 ? r.stdout.trim().split("\n").pop() : ""
    if (p && fs.existsSync(p)) return p
  }
  return "opencode"
})()
const runOc = (args, t = 20000) => spawnSync(OC, args, { encoding: "utf8", timeout: t, env: process.env, maxBuffer: 1 << 22 })

let distro = os.platform()
try {
  const rel = fs.readFileSync("/etc/os-release", "utf8")
  distro = rel.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] ?? distro
} catch { /* macOS ou autre */ }
console.log(`Système : ${distro} · Node ${process.versions.node}`)
console.log(`Dossier de config : ${DEST}\n`)
if (!(process.env.PATH ?? "").split(path.delimiter).includes(BIN)) {
  console.log(`⚠️  ${BIN} n'est pas dans ton PATH : ajoute  export PATH="${BIN}:$PATH"  à ton ~/.bashrc / ~/.zshrc (obscura, trivy, agent-wt, oc-new-rust)`)
  warned++
}

// Node
const major = Number(process.versions.node.split(".")[0])
major >= 18 ? ok(`Node ${process.versions.node}`) : ko(`Node ${process.versions.node} trop ancien (18+ requis)`)

// OpenCode
let hasOc = has("opencode")
if (hasOc) {
  const v = runOc(["--version"], 15000)
  const ver = (v.stdout ?? "").match(/\d+\.\d+\.\d+/)?.[0]
  ver ? ok(`opencode ${ver}${OC !== "opencode" ? ` (${OC})` : ""}`) : wa(`opencode répond mais sans numéro de version :\n${squash(v.stdout || v.stderr, 5)}`)
}
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
  const expand = (x) => String(x).replace(/\{env:(\w+)\}/g, (_, k) => process.env[k] ?? "")
  const bin = expand(m.command?.[0] ?? "")
  if (!bin) { ko(`${name} : commande absente`); continue }
  const exists = path.isAbsolute(bin) ? fs.existsSync(bin) : has(bin)
  if (!exists) { ko(`${name} : "${bin}" introuvable${path.isAbsolute(bin) ? " (relance ./install.sh)" : ""}`); continue }

  if (bin.endsWith("oc-terraform-mcp") || bin === "docker") {
    const rt = ["docker", "podman"].find((c) => has(c) && run(c, ["info"], 10000).status === 0)
    const installed = ["docker", "podman"].filter(has)
    rt ? ok(`${name} : ${rt} prêt`)
       : installed.length ? wa(`${name} : ${installed.join("/")} installé mais le démon ne répond pas (Docker : sudo systemctl enable --now docker ; ton utilisateur doit être dans le groupe docker)`)
       : ko(`${name} : ni docker ni podman installé`)
    continue
  }
  if (bin.endsWith("oc-playwright-mcp")) {
    const sys = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "brave-browser", "brave"].find(has)
    const cache = path.join(HOME, ".cache", "ms-playwright")
    sys ? ok(`${name} : navigateur système (${sys})`)
        : fs.existsSync(cache) ? ok(`${name} : Chromium de Playwright (${cache})`)
        : wa(`${name} : aucun navigateur (installe chromium avec ton gestionnaire de paquets, ou relance ./install.sh)`)
    continue
  }
  ok(`${name} : ${bin} disponible`)
}

// Plugins
if ([...(cfg?.plugins ?? []), ...(cfg?.plugin ?? [])].some((p) => String(Array.isArray(p) ? p[0] : p).includes("mempalace"))) {
  const venvPy = path.join(HOME, ".mempalace", "venv", "bin", "python")
  const envPy = process.env.MEMPALACE_ADAPTER_PYTHON
  const py = envPy || (fs.existsSync(venvPy) ? venvPy : "python3")
  const t = run(py, ["-c", "import mempalace"], 15000)
  if (t.status !== 0) ko(`MemPalace non installé pour ${py} : lance ./install.sh --memory-only (ou retire le plugin de opencode.jsonc)`)
  else if (!envPy && fs.existsSync(venvPy)) wa(`MemPalace est dans ${venvPy} mais MEMPALACE_ADAPTER_PYTHON n'est pas défini : ajoute à ton ~/.bashrc  export MEMPALACE_ADAPTER_PYTHON="${venvPy}"`)
  else ok(`MemPalace importable (${py})`)
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
  const r = runOc(["debug", "config"], 30000)
  r.status === 0 ? ok("opencode debug config : configuration chargée sans erreur") : ko(`opencode debug config a échoué (code ${r.status ?? "timeout"}) :\n${squash(r.stderr || r.stdout)}`)
  const m = runOc(["mcp", "list"], 40000)
  console.log(squash(m.stdout || m.stderr).split("\n").map((l) => "   " + l).join("\n"))
  if (cfg?.default_agent) {
    const a = runOc(["debug", "agent", cfg.default_agent], 20000)
    a.status === 0 ? ok(`agent ${cfg.default_agent} chargé`) : ko(`agent ${cfg.default_agent} non chargé (code ${a.status ?? "timeout"}) :\n${squash(a.stderr || a.stdout)}`)
  }
}

console.log(`\n${bad ? "❌" : "✅"} ${bad} erreur(s), ${warned} avertissement(s)`)
process.exit(bad ? 1 : 0)
