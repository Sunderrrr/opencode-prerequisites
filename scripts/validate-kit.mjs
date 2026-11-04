#!/usr/bin/env node
// Validates the kit: config, agents, skills, commands, plugins, MCP, secrets. Used by CI and doctor.
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

// 1. Main config
let cfg
try { cfg = parseJsonc(read(path.join(C, "opencode.jsonc"))) } catch (e) { err(`opencode.jsonc unreadable: ${e.message}`) }
if (cfg) {
  if (cfg.mcp && !cfg.mcp.servers) err('mcp: servers must live under "mcp.servers" (OpenCode 2.x does not read the flat form)')
  for (const [name, m] of Object.entries(mcpServers(cfg))) {
    if ("enabled" in m) err(`mcp.servers.${name}: "enabled" does not exist in v2, use "disabled": true`)
    if (m.type === "local" && !(Array.isArray(m.command) && m.command.length)) err(`mcp.${name}: command (array) required`)
    else if (m.type === "remote" && !/^https:\/\//.test(m.url ?? "")) err(`mcp.${name}: https url required`)
    else if (m.type !== "local" && m.type !== "remote") err(`mcp.${name}: type must be local or remote`)
  }
  for (const k of ["model", "small_model"]) {
    if (cfg[k] && !/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(cfg[k])) err(`${k}: invalid provider/model format (${cfg[k]})`)
  }
}

// 2. Agents (core + addons/* modules)
const agents = {}
const addonDirs = ls(path.join(ROOT, "addons")).map((d) => path.join(ROOT, "addons", d)).filter((d) => fs.statSync(d).isDirectory())
const agentDirs = [path.join(C, "agents"), ...addonDirs.map((d) => path.join(d, "agents"))]
for (const dir of agentDirs) for (const f of ls(dir).filter((x) => x.endsWith(".md"))) {
  const name = f.slice(0, -3)
  const rel = path.relative(ROOT, path.join(dir, f))
  const md = read(path.join(dir, f))
  const fm = frontmatter(md)
  if (!fm) { err(`${rel}: missing frontmatter`); continue }
  if (agents[name]) err(`${rel}: agent "${name}" defined twice`)
  agents[name] = fm
  if (!fm.description) err(`${rel}: missing description`)
  else if (fm.description.length > 320) warn(`${rel}: long description (${fm.description.length} chars): costs context on every session`)
  if (!["primary", "subagent", "all"].includes(fm.mode)) err(`${rel}: invalid mode (${fm.mode})`)
  if (!/^[a-z][a-z0-9-]*$/.test(name)) err(`${rel}: invalid name`)
  if (!md.split(/^---$/m)[2]?.trim()) err(`${rel}: empty prompt`)
}
if (cfg?.default_agent) {
  if (!agents[cfg.default_agent]) err(`default_agent "${cfg.default_agent}": file agents/${cfg.default_agent}.md not found`)
  else if (agents[cfg.default_agent].mode !== "primary") err(`default_agent "${cfg.default_agent}" must have mode: primary`)
}
// @agent mentions in the CEO and in the blocks that modules add to it
const builtin = new Set(["explore", "general", "plan", "build"])
const ceoFiles = [path.join(C, "agents", "ceo.md"), ...addonDirs.flatMap((d) => ls(d).filter((x) => /^ceo\..*\.md$/.test(x)).map((x) => path.join(d, x)))]
for (const f of ceoFiles.filter(fs.existsSync)) {
  for (const m of read(f).matchAll(/(?:^|[\s(`|/])@([a-z][a-z0-9-]+)/g)) {
    if (!agents[m[1]] && !builtin.has(m[1])) err(`${path.relative(ROOT, f)} mentions @${m[1]} but no agent with that name exists`)
  }
}

// 3. Skills (core + modules)
for (const base of [path.join(C, "skills"), ...addonDirs.map((d) => path.join(d, "skills"))]) for (const d of ls(base)) {
  const f = path.join(base, d, "SKILL.md")
  const rel = path.relative(ROOT, path.join(base, d))
  if (!fs.existsSync(f)) { err(`${rel}: missing SKILL.md`); continue }
  const fm = frontmatter(read(f))
  if (!fm) { err(`${rel}/SKILL.md: missing frontmatter`); continue }
  if (fm.name !== d) err(`${rel}: name ("${fm.name}") must match the directory`)
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name ?? "")) err(`${rel}: invalid name`)
  if (!fm.description || fm.description.length > 1024) err(`${rel}: description missing or > 1024`)
}

// 4. Commands
for (const f of ls(path.join(C, "commands")).filter((x) => x.endsWith(".md"))) {
  const fm = frontmatter(read(path.join(C, "commands", f)))
  if (!fm?.description) err(`commands/${f}: missing description`)
}

// 5. OpenCode v2 local plugins: one DIRECTORY per plugin, default export Plugin.define({ id, setup })
for (const f of ls(path.join(C, "plugins"))) {
  const full = path.join(C, "plugins", f)
  if (!fs.statSync(full).isDirectory()) { err(`plugins/${f}: in v2 a local plugin must be a directory (plugins/<name>/index.ts), not a file`); continue }
  const entry = ["index.ts", "index.js", "index.mjs"].map((x) => path.join(full, x)).find(fs.existsSync)
  if (!entry) { err(`plugins/${f}: missing index.ts`); continue }
  const src = read(entry)
  if (!/export\s+default\s+Plugin\.define\(/.test(src)) err(`plugins/${f}: expected "export default Plugin.define({ id, setup })" (v2 format)`)
  if (!/\bid:\s*["'][^"']+["']/.test(src)) err(`plugins/${f}: missing stable id`)
  if (/export\s+const\s+\w+\s*=\s*async\s*\(/.test(src)) err(`plugins/${f}: v1 format detected (named async export): does not run in v2`)
  // Syntax: the source must remain valid JS (no type annotations), checked as an .mjs module
  const tmp = path.join(os.tmpdir(), `oc-plugin-${process.pid}-${f}.mjs`)
  try {
    fs.writeFileSync(tmp, src)
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" })
  } catch (e) { err(`plugins/${f}: syntax error\n${e.stderr}`) }
  finally { fs.rmSync(tmp, { force: true }) }
}

// 5b. Node scripts in config/libexec (syntax)
for (const f of ls(path.join(C, "libexec")).filter((x) => x.endsWith(".mjs"))) {
  try { execFileSync(process.execPath, ["--check", path.join(C, "libexec", f)], { stdio: "pipe" }) }
  catch (e) { err(`libexec/${f}: syntax error\n${e.stderr}`) }
}

// 5c. Modules: shell scripts, Node scripts, Containerfile
for (const d of addonDirs) {
  const shellFiles = [...ls(path.join(d, "bin")).map((x) => path.join(d, "bin", x)), ...ls(path.join(d, "libexec")).flatMap((sub) => {
    const full = path.join(d, "libexec", sub)
    return fs.statSync(full).isDirectory() ? ls(full).map((x) => path.join(full, x)) : [full]
  })]
  for (const f of shellFiles) {
    const rel = path.relative(ROOT, f)
    if (f.endsWith(".mjs")) { try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }) } catch (e) { err(`${rel}: syntax error\n${e.stderr}`) } }
    else if (/^#!.*\b(ba)?sh\b/.test(read(f).split("\n")[0] ?? "")) { try { execFileSync("bash", ["-n", f], { stdio: "pipe" }) } catch (e) { err(`${rel}: bash syntax error\n${e.stderr}`) } }
  }
  const cf = path.join(d, "libexec", "oc-android", "Containerfile")
  if (path.basename(d) === "android") {
    if (!fs.existsSync(cf)) err("addons/android: missing Containerfile")
    else {
      const t = read(cf)
      if (!/ARG ACCEPT_ANDROID_LICENSES/.test(t) || !/ACCEPT_ANDROID_LICENSES.*=\s*"yes"/.test(t)) err("Android Containerfile: license acceptance guard is missing")
      if (!/sha1sum -c/.test(t) || !/sha256sum -c/.test(t)) err("Android Containerfile: downloads must be verified by checksum")
      if (/:latest\b/.test(t.split("\n").filter((l) => /^FROM /.test(l)).join("\n"))) err("Android Containerfile: base image not pinned (:latest)")
    }
  }
}

// 6. Secrets: every text file in the repo (.git, demo/, node_modules and .worktrees excluded).
// A binary is detected by a NUL byte. .env* files are scanned except .env.example,
// including files without an extension (Containerfile, config/bin/oc-*) and backups.
// Limitation: an encoded (base64, hex) or multi-line secret is not detected.
const SECRET = [
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "fine-grained GitHub token", re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { name: "GitLab token", re: /\bglpat[-_][A-Za-z0-9_-]{20,}\b/ },
  { name: "npm token", re: /\bnpm_[A-Za-z0-9]{30,}\b/ },
  { name: "API key (sk-)", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "AWS key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "private key", re: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/ },
  { name: "plaintext password", re: /\bpassword\s*=\s*["']?(?!\$\{?|process\.env|os\.environ|os\.getenv|env\(|getenv|\.\.\.|<)[^\s"'\x60#]{8,}/i },
]
const SKIP_DIRS = new Set([".git", "node_modules", ".worktrees", "demo"])
const walk = (d) => ls(d).flatMap((x) => {
  if (SKIP_DIRS.has(x)) return []
  const p = path.join(d, x)
  const st = fs.lstatSync(p)
  if (st.isSymbolicLink()) return []
  return st.isDirectory() ? walk(p) : [p]
})
for (const f of walk(ROOT)) {
  if (path.basename(f) === ".env.example") continue
  let buf
  try { buf = fs.readFileSync(f) } catch { continue }
  if (buf.includes(0)) continue // plain binary
  const t = buf.toString("utf8")
  for (const { name, re } of SECRET) if (re.test(t)) err(`${path.relative(ROOT, f)}: secret pattern detected (${name})`)
}

// 7. Shell scripts
for (const f of [...ls(ROOT).filter((x) => x.endsWith(".sh")).map((x) => path.join(ROOT, x)), ...ls(path.join(C, "bin")).map((x) => path.join(C, "bin", x)), ...ls(path.join(ROOT, "scripts")).filter((x) => x.endsWith(".sh")).map((x) => path.join(ROOT, "scripts", x))]) {
  if (!fs.existsSync(f)) continue
  try { execFileSync("bash", ["-n", f], { stdio: "pipe" }) } catch (e) { err(`${path.relative(ROOT, f)}: bash syntax error\n${e.stderr}`) }
}

console.log(`Agents: ${Object.keys(agents).length} · MCP: ${Object.keys(mcpServers(cfg)).length} · Skills: ${ls(path.join(C, "skills")).length + addonDirs.reduce((n, d) => n + ls(path.join(d, "skills")).length, 0)} · Modules: ${addonDirs.length}`)
warns.forEach((w) => console.log(`⚠️  ${w}`))
if (errors.length) { errors.forEach((e) => console.error(`❌ ${e}`)); process.exit(1) }
console.log("✅ Kit valid")
