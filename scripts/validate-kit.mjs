#!/usr/bin/env node
// Valide le kit : config, agents, skills, commandes, plugins, MCP, secrets. Utilisé par la CI et doctor.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { parseJsonc, frontmatter, mcpServers } from "./lib/jsonc.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const C = path.join(ROOT, "config")
const errors = [], warns = []
const err = (m) => errors.push(m)
const warn = (m) => warns.push(m)
const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d) : [])
const read = (f) => fs.readFileSync(f, "utf8")

// 1. Config principale
let cfg
try { cfg = parseJsonc(read(path.join(C, "opencode.jsonc"))) } catch (e) { err(`opencode.jsonc illisible : ${e.message}`) }
if (cfg) {
  if (cfg.mcp && !cfg.mcp.servers) err('mcp : les serveurs doivent être dans "mcp.servers" (la forme plate n\'est pas lue par OpenCode 2.x)')
  for (const [name, m] of Object.entries(mcpServers(cfg))) {
    if ("enabled" in m) err(`mcp.servers.${name} : "enabled" n'existe pas en v2, utilise "disabled": true`)
    if (m.type === "local" && !(Array.isArray(m.command) && m.command.length)) err(`mcp.${name} : command (tableau) requis`)
    else if (m.type === "remote" && !/^https:\/\//.test(m.url ?? "")) err(`mcp.${name} : url https requise`)
    else if (m.type !== "local" && m.type !== "remote") err(`mcp.${name} : type doit être local ou remote`)
  }
  for (const k of ["model", "small_model"]) {
    if (cfg[k] && !/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(cfg[k])) err(`${k} : format provider/modèle invalide (${cfg[k]})`)
  }
}

// 2. Agents (noyau + modules addons/*)
const agents = {}
const addonDirs = ls(path.join(ROOT, "addons")).map((d) => path.join(ROOT, "addons", d)).filter((d) => fs.statSync(d).isDirectory())
const agentDirs = [path.join(C, "agents"), ...addonDirs.map((d) => path.join(d, "agents"))]
for (const dir of agentDirs) for (const f of ls(dir).filter((x) => x.endsWith(".md"))) {
  const name = f.slice(0, -3)
  const rel = path.relative(ROOT, path.join(dir, f))
  const md = read(path.join(dir, f))
  const fm = frontmatter(md)
  if (!fm) { err(`${rel} : frontmatter manquant`); continue }
  if (agents[name]) err(`${rel} : agent "${name}" défini deux fois`)
  agents[name] = fm
  if (!fm.description) err(`${rel} : description manquante`)
  else if (fm.description.length > 320) warn(`${rel} : description longue (${fm.description.length} car.) : coûte du contexte à chaque session`)
  if (!["primary", "subagent", "all"].includes(fm.mode)) err(`${rel} : mode invalide (${fm.mode})`)
  if (!/^[a-z][a-z0-9-]*$/.test(name)) err(`${rel} : nom invalide`)
  if (!md.split(/^---$/m)[2]?.trim()) err(`${rel} : prompt vide`)
}
if (cfg?.default_agent) {
  if (!agents[cfg.default_agent]) err(`default_agent "${cfg.default_agent}" : fichier agents/${cfg.default_agent}.md introuvable`)
  else if (agents[cfg.default_agent].mode !== "primary") err(`default_agent "${cfg.default_agent}" doit avoir mode: primary`)
}
// Mentions @agent dans le CEO et dans les blocs que les modules y ajoutent
const builtin = new Set(["explore", "general", "plan", "build"])
const ceoFiles = [path.join(C, "agents", "ceo.md"), ...addonDirs.flatMap((d) => ls(d).filter((x) => /^ceo\..*\.md$/.test(x)).map((x) => path.join(d, x)))]
for (const f of ceoFiles.filter(fs.existsSync)) {
  for (const m of read(f).matchAll(/(?:^|[\s(`|/])@([a-z][a-z0-9-]+)/g)) {
    if (!agents[m[1]] && !builtin.has(m[1])) err(`${path.relative(ROOT, f)} mentionne @${m[1]} mais aucun agent de ce nom n'existe`)
  }
}

// 3. Skills (noyau + modules)
for (const base of [path.join(C, "skills"), ...addonDirs.map((d) => path.join(d, "skills"))]) for (const d of ls(base)) {
  const f = path.join(base, d, "SKILL.md")
  const rel = path.relative(ROOT, path.join(base, d))
  if (!fs.existsSync(f)) { err(`${rel} : SKILL.md manquant`); continue }
  const fm = frontmatter(read(f))
  if (!fm) { err(`${rel}/SKILL.md : frontmatter manquant`); continue }
  if (fm.name !== d) err(`${rel} : name ("${fm.name}") doit égaler le dossier`)
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name ?? "")) err(`${rel} : name invalide`)
  if (!fm.description || fm.description.length > 1024) err(`${rel} : description absente ou > 1024`)
}

// 4. Commandes
for (const f of ls(path.join(C, "commands")).filter((x) => x.endsWith(".md"))) {
  const fm = frontmatter(read(path.join(C, "commands", f)))
  if (!fm?.description) err(`commands/${f} : description manquante`)
}

// 5. Plugins locaux OpenCode v2 : un DOSSIER par plugin, export par défaut Plugin.define({ id, setup })
for (const f of ls(path.join(C, "plugins"))) {
  const full = path.join(C, "plugins", f)
  if (!fs.statSync(full).isDirectory()) { err(`plugins/${f} : en v2 un plugin local doit être un dossier (plugins/<nom>/index.ts), pas un fichier`); continue }
  const entry = ["index.ts", "index.js", "index.mjs"].map((x) => path.join(full, x)).find(fs.existsSync)
  if (!entry) { err(`plugins/${f} : index.ts manquant`); continue }
  const src = read(entry)
  if (!/export\s+default\s+Plugin\.define\(/.test(src)) err(`plugins/${f} : "export default Plugin.define({ id, setup })" attendu (format v2)`)
  if (!/\bid:\s*["'][^"']+["']/.test(src)) err(`plugins/${f} : id stable manquant`)
  if (/export\s+const\s+\w+\s*=\s*async\s*\(/.test(src)) err(`plugins/${f} : format v1 détecté (export nommé async) : ne tourne pas en v2`)
  // Syntaxe : le source reste du JS valide (pas d'annotations de types), vérifié comme module .mjs
  const tmp = path.join(os.tmpdir(), `oc-plugin-${process.pid}-${f}.mjs`)
  try {
    fs.writeFileSync(tmp, src)
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" })
  } catch (e) { err(`plugins/${f} : erreur de syntaxe\n${e.stderr}`) }
  finally { fs.rmSync(tmp, { force: true }) }
}

// 5b. Scripts Node de config/libexec (syntaxe)
for (const f of ls(path.join(C, "libexec")).filter((x) => x.endsWith(".mjs"))) {
  try { execFileSync(process.execPath, ["--check", path.join(C, "libexec", f)], { stdio: "pipe" }) }
  catch (e) { err(`libexec/${f} : erreur de syntaxe\n${e.stderr}`) }
}

// 5c. Modules : scripts shell, scripts Node, Containerfile
for (const d of addonDirs) {
  const shellFiles = [...ls(path.join(d, "bin")).map((x) => path.join(d, "bin", x)), ...ls(path.join(d, "libexec")).flatMap((sub) => {
    const full = path.join(d, "libexec", sub)
    return fs.statSync(full).isDirectory() ? ls(full).map((x) => path.join(full, x)) : [full]
  })]
  for (const f of shellFiles) {
    const rel = path.relative(ROOT, f)
    if (f.endsWith(".mjs")) { try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }) } catch (e) { err(`${rel} : erreur de syntaxe\n${e.stderr}`) } }
    else if (/^#!.*\b(ba)?sh\b/.test(read(f).split("\n")[0] ?? "")) { try { execFileSync("bash", ["-n", f], { stdio: "pipe" }) } catch (e) { err(`${rel} : erreur de syntaxe bash\n${e.stderr}`) } }
  }
  const cf = path.join(d, "libexec", "oc-android", "Containerfile")
  if (path.basename(d) === "android") {
    if (!fs.existsSync(cf)) err("addons/android : Containerfile manquant")
    else {
      const t = read(cf)
      if (!/ARG ACCEPT_ANDROID_LICENSES/.test(t) || !/ACCEPT_ANDROID_LICENSES.*=\s*"yes"/.test(t)) err("Containerfile Android : la garde d'acceptation des licences est absente")
      if (!/sha1sum -c/.test(t) || !/sha256sum -c/.test(t)) err("Containerfile Android : les téléchargements doivent être vérifiés par somme de contrôle")
      if (/:latest\b/.test(t.split("\n").filter((l) => /^FROM /.test(l)).join("\n"))) err("Containerfile Android : image de base non épinglée (:latest)")
    }
  }
}

// 6. Secrets
const SECRET = [/sk-[A-Za-z0-9]{20,}/, /ghp_[A-Za-z0-9]{30,}/, /gho_[A-Za-z0-9]{30,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[bap]-[A-Za-z0-9-]{10,}/]
const walk = (d) => ls(d).flatMap((x) => {
  if ([".git", "node_modules", ".worktrees"].includes(x)) return []
  const p = path.join(d, x)
  return fs.statSync(p).isDirectory() ? walk(p) : [p]
})
for (const f of walk(ROOT)) {
  if (!/\.(md|jsonc?|js|mjs|sh|toml|yml|yaml|txt)$/.test(f) && !f.endsWith("agent-wt")) continue
  const t = read(f)
  for (const re of SECRET) if (re.test(t)) err(`${path.relative(ROOT, f)} : motif de secret détecté (${re})`)
}

// 7. Scripts shell
for (const f of [...ls(ROOT).filter((x) => x.endsWith(".sh")).map((x) => path.join(ROOT, x)), ...ls(path.join(C, "bin")).map((x) => path.join(C, "bin", x)), ...ls(path.join(ROOT, "scripts")).filter((x) => x.endsWith(".sh")).map((x) => path.join(ROOT, "scripts", x))]) {
  if (!fs.existsSync(f)) continue
  try { execFileSync("bash", ["-n", f], { stdio: "pipe" }) } catch (e) { err(`${path.relative(ROOT, f)} : erreur de syntaxe bash\n${e.stderr}`) }
}

console.log(`Agents: ${Object.keys(agents).length} · MCP: ${Object.keys(mcpServers(cfg)).length} · Skills: ${ls(path.join(C, "skills")).length + addonDirs.reduce((n, d) => n + ls(path.join(d, "skills")).length, 0)} · Modules: ${addonDirs.length}`)
warns.forEach((w) => console.log(`⚠️  ${w}`))
if (errors.length) { errors.forEach((e) => console.error(`❌ ${e}`)); process.exit(1) }
console.log("✅ Kit valide")
