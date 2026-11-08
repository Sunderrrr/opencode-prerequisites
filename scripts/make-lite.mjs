#!/usr/bin/env node
// Builds the lightweight profile from the full config (no drift between the two):
//   node make-lite.mjs <installed-config-directory>
// - keeps only the agents listed in profiles/lite-agents.txt
// - keeps only the context7 and grep_app MCPs, removes npm plugins (mempalace)
// - drops skills and commands tied to removed agents (frontmatter `agent:` or @mention)
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseJsonc, mcpServers } from "./lib/jsonc.mjs"

const dest = process.argv[2]
if (!dest) { console.error("usage: make-lite.mjs <config-directory>"); process.exit(1) }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const keep = new Set(fs.readFileSync(path.join(ROOT, "profiles/lite-agents.txt"), "utf8")
  .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")))

const agentsDir = path.join(dest, "agents")
const removed = new Set()
for (const f of fs.readdirSync(agentsDir)) {
  if (f.endsWith(".md") && !keep.has(f.slice(0, -3))) { removed.add(f.slice(0, -3)); fs.rmSync(path.join(agentsDir, f)) }
}
const mentions = (text) => [...text.matchAll(/(?:^|[\s(`|/])@([a-z][a-z0-9-]+)/g)].map((m) => m[1])

// Skills tied to agents/MCPs absent from the lightweight profile
for (const skill of ["reverse-engineer-anything", "android-dev", "ui-ux-pro-max", "impeccable"]) fs.rmSync(path.join(dest, "skills", skill), { recursive: true, force: true })

// Commands that target a removed agent: frontmatter `agent:` or an @mention in the body
const frontmatterAgent = (text) => {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!frontmatter) return null
  const agent = /^agent:[ \t]*["']?([a-z][a-z0-9-]*)["']?[ \t]*(?:#.*)?$/m.exec(frontmatter[1])
  return agent ? agent[1] : null
}
const cmdDir = path.join(dest, "commands")
for (const f of fs.existsSync(cmdDir) ? fs.readdirSync(cmdDir) : []) {
  const t = fs.readFileSync(path.join(cmdDir, f), "utf8")
  const agent = frontmatterAgent(t)
  if ((agent && removed.has(agent)) || mentions(t).some((a) => removed.has(a))) fs.rmSync(path.join(cmdDir, f))
}

// CEO: drop team-table rows that only target removed agents, and state the real team
const ceoPath = path.join(agentsDir, "ceo.md")
let ceo = fs.readFileSync(ceoPath, "utf8")
ceo = ceo.split("\n").filter((l) => {
  if (!l.startsWith("|")) return true
  const m = mentions(l.split("|")[1] ?? "")
  return !(m.length && m.every((a) => removed.has(a)))
}).join("\n")
ceo += `\n## Light profile\nOnly these agents exist: ${[...keep].map((a) => "@" + a).join(", ")}. Never call any other name: missing roles (languages other than Rust, devops, docs, database…) are handled by @rust, @backend or @frontend, following the domain checklist in the brief. There is no @code-simplifier: review the diff yourself before @verify-app.\n`
fs.writeFileSync(ceoPath, ceo)

// AGENTS.md: state the real list
fs.appendFileSync(path.join(dest, "AGENTS.md"), `\n## Light profile\nAvailable agents: ${[...keep].join(", ")}. Ignore any other agent names mentioned above.\n`)
const cfgPath = path.join(dest, "opencode.jsonc")
const cfg = parseJsonc(fs.readFileSync(cfgPath, "utf8"))
const keepMcp = Object.fromEntries(Object.entries(mcpServers(cfg)).filter(([k]) => ["context7", "grep_app"].includes(k)))
cfg.mcp = { ...(cfg.mcp?.timeout ? { timeout: cfg.mcp.timeout } : {}), servers: keepMcp }
delete cfg.plugin
delete cfg.plugins
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n")
// MemPalace local plugin: OpenCode loads plugins/*/ even without an entry in opencode.jsonc. Remove it here,
// otherwise the lightweight profile keeps memory even though mempalace.jsonc was deleted.
fs.rmSync(path.join(dest, "plugins", "mempalace"), { recursive: true, force: true })
for (const f of ["mempalace.jsonc", "k8s-mcp.toml"]) fs.rmSync(path.join(dest, f), { force: true })
console.log(`Light profile: ${keep.size} agents, MCP ${Object.keys(keepMcp).join(", ")}`)
