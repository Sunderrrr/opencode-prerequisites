#!/usr/bin/env node
// Génère le profil léger à partir de la config complète (pas de dérive entre les deux) :
//   node make-lite.mjs <dossier-config-installé>
// - garde seulement les agents de profiles/lite-agents.txt
// - garde seulement les MCP context7 et grep_app, retire les plugins npm (mempalace)
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseJsonc, mcpServers } from "./lib/jsonc.mjs"

const dest = process.argv[2]
if (!dest) { console.error("usage : make-lite.mjs <dossier-config>"); process.exit(1) }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const keep = new Set(fs.readFileSync(path.join(ROOT, "profiles/lite-agents.txt"), "utf8")
  .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")))

const agentsDir = path.join(dest, "agents")
const removed = new Set()
for (const f of fs.readdirSync(agentsDir)) {
  if (f.endsWith(".md") && !keep.has(f.slice(0, -3))) { removed.add(f.slice(0, -3)); fs.rmSync(path.join(agentsDir, f)) }
}
const mentions = (text) => [...text.matchAll(/(?:^|[\s(`|/])@([a-z][a-z0-9-]+)/g)].map((m) => m[1])

// Skills liés à des agents/MCP absents du profil léger
for (const skill of ["reverse-engineer-anything"]) fs.rmSync(path.join(dest, "skills", skill), { recursive: true, force: true })

// Commandes qui appellent un agent supprimé
const cmdDir = path.join(dest, "commands")
for (const f of fs.existsSync(cmdDir) ? fs.readdirSync(cmdDir) : []) {
  const t = fs.readFileSync(path.join(cmdDir, f), "utf8")
  if (mentions(t).some((a) => removed.has(a))) fs.rmSync(path.join(cmdDir, f))
}

// CEO : retire les lignes de la table d'équipe qui ne visent que des agents supprimés, et précise l'équipe réelle
const ceoPath = path.join(agentsDir, "ceo.md")
let ceo = fs.readFileSync(ceoPath, "utf8")
ceo = ceo.split("\n").filter((l) => {
  if (!l.startsWith("|")) return true
  const m = mentions(l.split("|")[1] ?? "")
  return !(m.length && m.every((a) => removed.has(a)))
}).join("\n")
ceo += `\n## Profil léger\nSeuls ces agents existent : ${[...keep].map((a) => "@" + a).join(", ")}. N'appelle jamais un autre nom : les rôles manquants (langages autres que Rust, devops, docs, base de données…) sont repris par @rust, @backend ou @frontend, en suivant la checklist du domaine dans le brief. Il n'y a pas de @code-simplifier : relis toi-même le diff avant @verify-app.\n`
fs.writeFileSync(ceoPath, ceo)

// AGENTS.md : précise la liste réelle
fs.appendFileSync(path.join(dest, "AGENTS.md"), `\n## Profil léger\nAgents disponibles : ${[...keep].join(", ")}. Ignore les autres noms d'agents cités plus haut.\n`)
const cfgPath = path.join(dest, "opencode.jsonc")
const cfg = parseJsonc(fs.readFileSync(cfgPath, "utf8"))
const keepMcp = Object.fromEntries(Object.entries(mcpServers(cfg)).filter(([k]) => ["context7", "grep_app"].includes(k)))
cfg.mcp = { ...(cfg.mcp?.timeout ? { timeout: cfg.mcp.timeout } : {}), servers: keepMcp }
delete cfg.plugin
delete cfg.plugins
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n")
for (const f of ["mempalace.jsonc", "k8s-mcp.toml"]) fs.rmSync(path.join(dest, f), { force: true })
console.log(`Profil léger : ${keep.size} agents, MCP ${Object.keys(keepMcp).join(", ")}`)
