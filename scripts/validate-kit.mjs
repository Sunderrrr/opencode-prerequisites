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

// 2. Agents
const agents = {}
for (const f of ls(path.join(C, "agents")).filter((x) => x.endsWith(".md"))) {
  const name = f.slice(0, -3)
  const md = read(path.join(C, "agents", f))
  const fm = frontmatter(md)
  if (!fm) { err(`agents/${f} : frontmatter manquant`); continue }
  agents[name] = fm
  if (!fm.description) err(`agents/${f} : description manquante`)
  else if (fm.description.length > 320) warn(`agents/${f} : description longue (${fm.description.length} car.) : coûte du contexte à chaque session`)
  if (!["primary", "subagent", "all"].includes(fm.mode)) err(`agents/${f} : mode invalide (${fm.mode})`)
  if (!/^[a-z][a-z0-9-]*$/.test(name)) err(`agents/${f} : nom invalide`)
  if (!md.split(/^---$/m)[2]?.trim()) err(`agents/${f} : prompt vide`)
}
if (cfg?.default_agent) {
  if (!agents[cfg.default_agent]) err(`default_agent "${cfg.default_agent}" : fichier agents/${cfg.default_agent}.md introuvable`)
  else if (agents[cfg.default_agent].mode !== "primary") err(`default_agent "${cfg.default_agent}" doit avoir mode: primary`)
}
// Mentions @agent dans le CEO
const builtin = new Set(["explore", "general", "plan", "build"])
if (fs.existsSync(path.join(C, "agents", "ceo.md"))) {
  const ceo = read(path.join(C, "agents", "ceo.md"))
  for (const m of ceo.matchAll(/(?:^|[\s(`|/])@([a-z][a-z0-9-]+)/g)) {
    if (!agents[m[1]] && !builtin.has(m[1])) err(`ceo.md mentionne @${m[1]} mais agents/${m[1]}.md n'existe pas`)
  }
}

// 3. Skills
for (const d of ls(path.join(C, "skills"))) {
  const f = path.join(C, "skills", d, "SKILL.md")
  if (!fs.existsSync(f)) { err(`skills/${d} : SKILL.md manquant`); continue }
  const fm = frontmatter(read(f))
  if (!fm) { err(`skills/${d}/SKILL.md : frontmatter manquant`); continue }
  if (fm.name !== d) err(`skills/${d} : name ("${fm.name}") doit égaler le dossier`)
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name ?? "")) err(`skills/${d} : name invalide`)
  if (!fm.description || fm.description.length > 1024) err(`skills/${d} : description absente ou > 1024`)
}

// 4. Commandes
for (const f of ls(path.join(C, "commands")).filter((x) => x.endsWith(".md"))) {
  const fm = frontmatter(read(path.join(C, "commands", f)))
  if (!fm?.description) err(`commands/${f} : description manquante`)
}

// 5. Plugins (syntaxe)
for (const f of ls(path.join(C, "plugins")).filter((x) => x.endsWith(".js"))) {
  // Les plugins sont des modules ES : on les vérifie comme .mjs (Node < 22 lit un .js en CommonJS et rejette « export »)
  const tmp = path.join(os.tmpdir(), `oc-plugin-${process.pid}-${f.replace(/\.js$/, "")}.mjs`)
  try {
    fs.writeFileSync(tmp, read(path.join(C, "plugins", f)))
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" })
  } catch (e) { err(`plugins/${f} : erreur de syntaxe\n${e.stderr}`) }
  finally { fs.rmSync(tmp, { force: true }) }
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

console.log(`Agents: ${Object.keys(agents).length} · MCP: ${Object.keys(mcpServers(cfg)).length} · Skills: ${ls(path.join(C, "skills")).length}`)
warns.forEach((w) => console.log(`⚠️  ${w}`))
if (errors.length) { errors.forEach((e) => console.error(`❌ ${e}`)); process.exit(1) }
console.log("✅ Kit valide")
