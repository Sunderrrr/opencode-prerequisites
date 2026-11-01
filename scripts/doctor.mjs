#!/usr/bin/env node
// Diagnostic de l'installation : config, agents, MCP, outils, modèles, et vraie lecture par OpenCode.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { parseJsonc, frontmatter, mcpServers } from "./lib/jsonc.mjs"

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
for (const [name, m] of Object.entries(mcpServers(cfg))) {
  if (m.enabled === false || m.disabled === true) { console.log(`   · ${name} (désactivé)`); continue }
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
        : fs.existsSync(cache) ? (() => {
            ok(`${name} : Chromium de Playwright (${cache})`)
            const dirs = fs.readdirSync(cache).filter((d) => /^chromium(_headless_shell)?-/.test(d))
            for (const d of dirs) {
              const base = path.join(cache, d)
              const exe = fs.readdirSync(base).map((x) => path.join(base, x, x.includes("headless") ? "headless_shell" : "chrome")).find(fs.existsSync)
              if (!exe || !has("ldd")) continue
              const missing = (run("ldd", [exe], 15000).stdout ?? "").split("\n").filter((l) => l.includes("not found")).map((l) => l.trim().split(" ")[0])
              if (missing.length) { wa(`${name} : bibliothèques manquantes pour ${d} : ${[...new Set(missing)].slice(0, 8).join(", ")}${missing.length > 8 ? "…" : ""} → le plus simple : un Chromium système (Arch/Omarchy : sudo pacman -S --needed chromium ; Debian/Ubuntu : sudo npx playwright install-deps chromium)`); break }
            }
          })()
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
  if (r.status !== 0) ko(`opencode debug config a échoué (code ${r.status ?? "timeout"}) :\n${squash(r.stderr || r.stdout)}`)
  else {
    ok("opencode debug config : configuration chargée sans erreur")
    // Valeurs retenues par OpenCode : on cherche les clés où qu'elles soient (format de debug config non garanti)
    let rc = null
    for (const parse of [JSON.parse, parseJsonc]) { try { rc = parse(r.stdout); break } catch { /* essai suivant */ } }
    const deepFind = (o, key, depth = 0) => {
      if (!o || typeof o !== "object" || depth > 6) return undefined
      if (key in o) return o[key]
      for (const v of Object.values(o)) { const f = deepFind(v, key, depth + 1); if (f !== undefined) return f }
      return undefined
    }
    if (!rc || typeof rc !== "object") wa(`sortie de debug config non lisible (comparaison impossible) :\n${squash(r.stdout, 4)}`)
    else {
      const da = deepFind(rc, "default_agent") ?? deepFind(rc, "defaultAgent")
      const md = deepFind(rc, "model")
      if (cfg?.default_agent && da !== undefined) da === cfg.default_agent ? ok(`default_agent retenu : ${da}`) : ko(`default_agent attendu "${cfg.default_agent}", OpenCode a "${da}"`)
      if (cfg?.model && md !== undefined && typeof md === "string") md === cfg.model ? ok(`modèle retenu : ${md}`) : wa(`modèle attendu ${cfg.model}, OpenCode a "${md}" (une config projet peut le surcharger)`)
      if (da === undefined && md === undefined) console.log(`   (debug config : clés racine vues → ${Object.keys(rc).slice(0, 15).join(", ")})`)
    }
  }

  // Serveurs MCP : état réel vu par OpenCode (une ligne par serveur)
  const m = runOc(["mcp", "list"], 60000)
  const clean = (t) => (t ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
  const rows = clean(m.stdout || m.stderr).split("\n").map((l) => l.match(/^\s*([✓✗])\s+([\w.-]+)\s+(.*)$/)).filter(Boolean)
  if (!rows.length) console.log(squash(clean(m.stdout || m.stderr)).split("\n").map((l) => "   " + l).join("\n"))
  else {
    const kc = (process.env.KUBECONFIG ?? path.join(HOME, ".kube", "config")).split(path.delimiter)[0]
    const hasKube = fs.existsSync(kc) && /^current-context:\s*\S+/m.test(fs.readFileSync(kc, "utf8"))
    for (const [, mark, name, rest] of rows) {
      const why = rest.replace(/\s+/g, " ").slice(0, 130)
      if (mark === "✓") ok(`MCP ${name} : ${why}`)
      else if (name === "kubernetes" && !hasKube) wa(`MCP kubernetes : aucun contexte kubectl (${kc}) : le serveur quitte au démarrage. Désactive-le ("disabled": true) ou configure un cluster.`)
      else ko(`MCP ${name} : ${why}`)
    }
    const seen = new Set(rows.map((x) => x[2]))
    const missing = Object.entries(mcpServers(cfg)).filter(([k, v]) => !v.disabled && v.enabled !== false && !seen.has(k)).map(([k]) => k)
    if (missing.length) ko(`OpenCode ne liste pas ces MCP : ${missing.join(", ")}`)
  }
  if (cfg?.default_agent) {
    const a = runOc(["debug", "agents"], 20000)
    const txt = `${a.stdout ?? ""}${a.stderr ?? ""}`
    a.status !== 0 ? wa(`opencode debug agents indisponible (code ${a.status ?? "timeout"}) :\n${squash(txt, 4)}`)
      : txt.includes(cfg.default_agent) ? ok(`agent ${cfg.default_agent} connu d'OpenCode`)
      : ko(`agent ${cfg.default_agent} absent de la liste d'OpenCode (debug agents). Vérifie ${path.join(DEST, "agents")}`)
  }
}

console.log(`\n${bad ? "❌" : "✅"} ${bad} erreur(s), ${warned} avertissement(s)`)
process.exit(bad ? 1 : 0)
