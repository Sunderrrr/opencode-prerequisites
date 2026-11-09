#!/usr/bin/env node
// Tests for scripts/export-claude.mjs: a real export of the kit to a temporary directory,
// the project-root .mcp.json placement and --mcp-out override, a minimal fixture (disabled MCP
// server, command conversion), the launcher in repository and installed layouts, the generated
// guard hook, idempotence and --global with a temporary HOME.
// Hermetic: nothing outside the OS temporary directory is written.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { parseJsonc, mcpServers } from "./lib/jsonc.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXPORT = path.join(ROOT, "scripts", "export-claude.mjs")
const WRAPPER = path.join(ROOT, "config", "bin", "oc-export-claude")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-claude-"))
let passed = 0
let failed = 0

const check = (name, cond, detail = "") => {
  cond ? passed++ : failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`)
}
const read = (f) => fs.readFileSync(f, "utf8")
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

function treeHash(dir) {
  const h = crypto.createHash("sha256")
  for (const rel of walk(dir)) {
    h.update(rel)
    h.update("\0")
    h.update(fs.readFileSync(path.join(dir, rel)))
    h.update("\0")
  }
  return h.digest("hex")
}

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return null
  const fm = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (kv) fm[kv[1]] = kv[2].trim()
  }
  return fm
}

function bodyOf(text) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return (m ? text.slice(m[0].length) : text).trim()
}

function agentList(fm) {
  const m = /^Agent\(([^)]*)\)/.exec(fm.tools || "")
  return m ? m[1].split(",").map((s) => s.trim()) : []
}

const ACCENTS = /[éèêëàâäçîïôöùûüÿœÉÈÊËÀÂÄÇÎÏÔÖÙÛÜŸŒ]/

// Sources of truth (the exporter must follow the kit, not a hardcoded list).
const cfg = parseJsonc(read(path.join(ROOT, "config", "opencode.jsonc")))
const enabledMcp = Object.entries(mcpServers(cfg))
  .filter(([, s]) => s && s.disabled !== true && s.enabled !== false)
  .map(([name]) => name)
  .sort()
const coreAgents = ls(path.join(ROOT, "config", "agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))
const coreSkills = ls(path.join(ROOT, "config", "skills")).filter((d) => exists(path.join(ROOT, "config", "skills", d, "SKILL.md")))
const coreCommands = ls(path.join(ROOT, "config", "commands")).filter((f) => f.endsWith(".md"))
const VARIANTS = ["rust-haiku", "review-opus", "architect-opus"]

// Only real agent names count as leftover OpenCode mentions: `@ts-ignore` and other
// code directives must survive the export verbatim.
const AGENT_MENTION = new RegExp("(^|[^A-Za-z0-9_@])@(" + [...coreAgents, ...VARIANTS].join("|") + ")(?![A-Za-z0-9-])")

// ---------- 1. Real kit export ----------
const out = path.join(tmp, "project", ".claude")
const rootMcp = path.join(tmp, "project", ".mcp.json")
const r1 = run(["--out", out, "--force"])
check("export: exit 0", r1.status === 0, r1.stderr)
check("export: summary printed", /Claude Code export:/.test(r1.stdout), r1.stdout)
check("export: target exists", exists(out))
check("export: CLAUDE.md generated", exists(path.join(out, "CLAUDE.md")))
check("export: .mcp.json generated at the project root", exists(rootMcp))
check("export: no .mcp.json inside .claude", !exists(path.join(out, ".mcp.json")))
check("export: settings.json generated", exists(path.join(out, "settings.json")))
check("export: hooks generated", exists(path.join(out, "hooks/guard.mjs")) && exists(path.join(out, "hooks/notify.mjs")))
check("export: manifest generated", exists(path.join(out, ".oc-export-manifest.json")))

// Agents
const agentDir = path.join(out, "agents")
const exportedAgents = ls(agentDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))
check("agents: every core agent exported", coreAgents.every((n) => exportedAgents.includes(n)), exportedAgents.join(","))
check("agents: fixed variants exported", VARIANTS.every((n) => exportedAgents.includes(n)))
check("agents: exact count (core + variants)", exportedAgents.length === coreAgents.length + VARIANTS.length, `${exportedAgents.length} vs ${coreAgents.length + VARIANTS.length}`)
check("agents: Android absent without --android", !exportedAgents.includes("android") && !exportedAgents.includes("mobile-tester"))

const agentFm = {}
let frontmatterErrors = []
for (const name of exportedAgents) {
  const text = read(path.join(agentDir, name + ".md"))
  const fm = frontmatter(text)
  if (!fm) { frontmatterErrors.push(`${name}: no frontmatter`); continue }
  agentFm[name] = fm
  if (fm.name !== name) frontmatterErrors.push(`${name}: name=${fm.name}`)
  if (!fm.description) frontmatterErrors.push(`${name}: no description`)
  if (!["opus", "sonnet", "haiku"].includes(fm.model)) frontmatterErrors.push(`${name}: model=${fm.model}`)
  if (!fm.tools) frontmatterErrors.push(`${name}: no tools`)
  if (fm.color && !["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"].includes(fm.color)) frontmatterErrors.push(`${name}: color=${fm.color}`)
}
check("agents: frontmatter valid (name, description, model, tools, color)", frontmatterErrors.length === 0, frontmatterErrors.join(" | "))

const tier = {
  ceo: "opus", architect: "opus", security: "opus", review: "opus", "verify-app": "opus", integrator: "opus", designer: "opus",
  researcher: "haiku", "web-researcher": "haiku",
}
for (const [name, model] of Object.entries(tier)) {
  check(`model: ${name} = ${model}`, agentFm[name] && agentFm[name].model === model, agentFm[name] && agentFm[name].model)
}
const sonnetAgents = ["rust", "backend", "frontend", "database", "devops", "docker", "ansible", "terraform", "kubernetes", "qa", "debugger", "docs", "code-simplifier", "pentest", "reverse-engineer"]
for (const name of sonnetAgents) {
  check(`model: ${name} = sonnet`, agentFm[name] && agentFm[name].model === "sonnet", agentFm[name] && agentFm[name].model)
}
check("model: rust-haiku = haiku", agentFm["rust-haiku"] && agentFm["rust-haiku"].model === "haiku")
check("model: review-opus = opus", agentFm["review-opus"] && agentFm["review-opus"].model === "opus")
check("model: architect-opus = opus", agentFm["architect-opus"] && agentFm["architect-opus"].model === "opus")
check("variants: rust-haiku body identical to rust", bodyOf(read(path.join(agentDir, "rust-haiku.md"))) === bodyOf(read(path.join(agentDir, "rust.md"))))
check("variants: review-opus body identical to review", bodyOf(read(path.join(agentDir, "review-opus.md"))) === bodyOf(read(path.join(agentDir, "review.md"))))
check("variants: architect-opus body identical to architect", bodyOf(read(path.join(agentDir, "architect-opus.md"))) === bodyOf(read(path.join(agentDir, "architect.md"))))

// Tools mapping
const readOnly = ["architect", "review", "security", "researcher", "verify-app"]
for (const name of readOnly) {
  const fm = agentFm[name]
  const tools = (fm && fm.tools ? fm.tools : "").split(",").map((s) => s.trim())
  const disallowed = (fm && fm.disallowedTools ? fm.disallowedTools : "").split(",").map((s) => s.trim())
  check(`tools: ${name} read-only (no Write/Edit/NotebookEdit)`, fm && ["Write", "Edit", "NotebookEdit"].every((t) => !tools.includes(t) && disallowed.includes(t)), fm && fm.tools)
}
check("tools: architect has no Bash", !(agentFm.architect.tools || "").split(",").map((s) => s.trim()).includes("Bash"))
check("tools: docs has no Bash", !(agentFm.docs.tools || "").split(",").map((s) => s.trim()).includes("Bash"))
check("tools: docs disallows Agent and Task", /Agent/.test(agentFm.docs.disallowedTools || "") && /Task/.test(agentFm.docs.disallowedTools || ""))
check("tools: researcher has no Bash", !(agentFm.researcher.tools || "").split(",").map((s) => s.trim()).includes("Bash"))
check("tools: security keeps Bash", (agentFm.security.tools || "").split(",").map((s) => s.trim()).includes("Bash"))
check("tools: review has only git Bash patterns", !(agentFm.review.tools || "").split(",").map((s) => s.trim()).includes("Bash") && /Bash\(git diff\*\)/.test(agentFm.review.tools || "") && /Bash\(git log\*\)/.test(agentFm.review.tools || "") && /Bash\(git status\*\)/.test(agentFm.review.tools || ""))
check("tools: designer and frontend get mcp__chrome-devtools__*", /mcp__chrome-devtools__\*/.test(agentFm.designer.tools) && /mcp__chrome-devtools__\*/.test(agentFm.frontend.tools))
check("tools: pentest gets mcp__semgrep__*", /mcp__semgrep__\*/.test(agentFm.pentest.tools))
check("tools: reverse-engineer gets mcp__rea__*", /mcp__rea__\*/.test(agentFm["reverse-engineer"].tools))
check("tools: writers get permissionMode acceptEdits", agentFm.rust.permissionMode === "acceptEdits" && agentFm.designer.permissionMode === "acceptEdits")
check("tools: read-only agents have no permissionMode", !agentFm.architect.permissionMode && !agentFm.review.permissionMode)
check("tools: maxTurns from steps (rust 40, integrator 60, docs 25)", agentFm.rust.maxTurns === "40" && agentFm.integrator.maxTurns === "60" && agentFm.docs.maxTurns === "25")
check("tools: CEO has no maxTurns", !agentFm.ceo.maxTurns)

// CEO
const ceoTools = agentList(agentFm.ceo)
check("ceo: model opus", agentFm.ceo.model === "opus")
check("ceo: tools use Agent(<agents>)", /^Agent\(/.test(agentFm.ceo.tools || ""), agentFm.ceo.tools)
check("ceo: Agent list contains every exported agent", exportedAgents.filter((n) => n !== "ceo").every((n) => ceoTools.includes(n)), ceoTools.join(","))
check("ceo: Agent list contains the variants", VARIANTS.every((n) => ceoTools.includes(n)))
check("ceo: Agent list contains Claude Code built-ins Explore/general-purpose", ceoTools.includes("Explore") && ceoTools.includes("general-purpose"), ceoTools.join(","))
check("ceo: Agent list does not delegate to itself", !ceoTools.includes("ceo"))
check("ceo: tools include Skill (CEO can load skills)", /(^|, )Skill(,|$)/.test(agentFm.ceo.tools || ""))
check("ceo: disallowedTools blocks Write/Edit/NotebookEdit", ["Write", "Edit", "NotebookEdit"].every((t) => (agentFm.ceo.disallowedTools || "").includes(t)))
const ceoBody = read(path.join(agentDir, "ceo.md"))
check("ceo: mandatory routing section", /## Model routing \(mandatory\)/.test(ceoBody))
check("ceo: routing requires model on every call", /EVERY `Agent` call/i.test(ceoBody) && /model: "haiku"/.test(ceoBody))
check("ceo: never opus for mechanical work", /Never use `opus` for mechanical work/i.test(ceoBody))
check("ceo: never haiku for security/review", /Never use `haiku` for security, review/i.test(ceoBody))
check("ceo: body adapted @mentions to Agent()", /Agent\(architect\)/.test(ceoBody) && /Agent\(verify-app\)/.test(ceoBody))
check("ceo: background delegation adapted", /run_in_background: true/.test(ceoBody))

// Body adaptation
let mentions = []
for (const name of exportedAgents) {
  const text = read(path.join(agentDir, name + ".md"))
  if (AGENT_MENTION.test(text)) mentions.push(name)
}
check("agents: no OpenCode @agent mention left", mentions.length === 0, mentions.join(","))
const typescriptBody = read(path.join(agentDir, "typescript.md"))
check("agents: @ts-ignore preserved verbatim", /@ts-ignore/.test(typescriptBody) && !/Agent\(ts-ignore\)/.test(typescriptBody))
check("agents: @explore mapped to the Claude Code built-in Explore", /Agent\(Explore\)/.test(read(path.join(out, "CLAUDE.md"))))

// Skills
const skillsDir = path.join(out, "skills")
check("skills: every core skill exported with SKILL.md", coreSkills.every((n) => exists(path.join(skillsDir, n, "SKILL.md"))), ls(skillsDir).join(","))
check("skills: android-dev absent without --android", !exists(path.join(skillsDir, "android-dev")))
check("skills: content copied verbatim (tdd)", read(path.join(skillsDir, "tdd", "SKILL.md")) === read(path.join(ROOT, "config", "skills", "tdd", "SKILL.md")))
check("skills: subdirectories copied (impeccable/reference)", exists(path.join(skillsDir, "impeccable", "reference", "critique.md")))

// Commands
const cmdDir = path.join(out, "commands")
const exportedCommands = ls(cmdDir).filter((f) => f.endsWith(".md"))
check("commands: every command exported", coreCommands.every((n) => exportedCommands.includes(n)), exportedCommands.join(","))
let cmdErrors = []
for (const file of exportedCommands) {
  const text = read(path.join(cmdDir, file))
  const fm = frontmatter(text)
  if (!fm || !fm.description) cmdErrors.push(`${file}: no description`)
  if (/^subtask:/m.test(text)) cmdErrors.push(`${file}: subtask left`)
}
check("commands: frontmatter valid, subtask removed", cmdErrors.length === 0, cmdErrors.join(" | "))
const impeccable = frontmatter(read(path.join(cmdDir, "impeccable.md")))
check("commands: agent converted to context fork", impeccable && impeccable.context === "fork" && impeccable.agent === "designer", JSON.stringify(impeccable))
check("commands: plan built-in mapped to architect", frontmatter(read(path.join(cmdDir, "plan-first.md"))).agent === "architect")
check("commands: subtask without agent still forks", frontmatter(read(path.join(cmdDir, "usage.md"))).context === "fork" && !frontmatter(read(path.join(cmdDir, "usage.md"))).agent)
check("commands: $ARGUMENTS preserved", /\$ARGUMENTS/.test(read(path.join(cmdDir, "plan-first.md"))) && /\$ARGUMENTS/.test(read(path.join(cmdDir, "remember.md"))))
check("commands: @mentions adapted", /Agent\(integrator\)/.test(read(path.join(cmdDir, "pr.md"))))
const commandAgents = exportedCommands.map((f) => frontmatter(read(path.join(cmdDir, f))).agent).filter(Boolean)
check("commands: every agent target exists", commandAgents.every((n) => exportedAgents.includes(n)), commandAgents.join(","))

// MCP
const mcp = JSON.parse(read(rootMcp))
check("mcp: servers match enabled OpenCode servers", JSON.stringify(Object.keys(mcp.mcpServers).sort()) === JSON.stringify(enabledMcp), Object.keys(mcp.mcpServers).join(","))
check("mcp: remote converted to http", mcp.mcpServers.context7 && mcp.mcpServers.context7.type === "http" && mcp.mcpServers.context7.url === "https://mcp.context7.com/mcp")
check("mcp: local converted to stdio with args", mcp.mcpServers.playwright && mcp.mcpServers.playwright.type === "stdio" && mcp.mcpServers.playwright.command === "${HOME}/.local/bin/oc-playwright-mcp" && Array.isArray(mcp.mcpServers.playwright.args))
check("mcp: {env:VAR} expanded to ${VAR}", !/\{env:/.test(read(rootMcp)) && /^\$\{HOME\}\//.test(mcp.mcpServers.playwright.command))
check("mcp: every entry has a supported type", Object.values(mcp.mcpServers).every((s) => s.type === "http" || s.type === "stdio"))
check("mcp: manifest excludes the root file (outside the export tree)", !JSON.parse(read(path.join(out, ".oc-export-manifest.json"))).files.includes(".mcp.json"))

// Settings
const settings = JSON.parse(read(path.join(out, "settings.json")))
check("settings: CEO is the default agent", settings.agent === "ceo")
check("settings: dangerous Bash denied", ["Bash(git push --force*)", "Bash(rm -rf /*)", "Bash(git reset --hard*)"].every((p) => settings.permissions.deny.includes(p)), JSON.stringify(settings.permissions.deny))
check("settings: PreToolUse hook configured", Array.isArray(settings.hooks.PreToolUse) && settings.hooks.PreToolUse.some((h) => h.hooks.some((x) => /hooks\/guard\.mjs/.test(x.command))))
check("settings: Stop hook configured", Array.isArray(settings.hooks.Stop) && settings.hooks.Stop.some((h) => h.hooks.some((x) => /hooks\/notify\.mjs/.test(x.command))))
check("settings: custom out uses an absolute hook path", settings.hooks.PreToolUse[0].hooks[0].command.includes(out) && settings.hooks.PreToolUse[0].hooks[0].command.includes("hooks/guard.mjs"))

// Hooks: syntax and behaviour
const guard = path.join(out, "hooks", "guard.mjs")
const notify = path.join(out, "hooks", "notify.mjs")
check("hooks: guard.mjs valid Node syntax", spawnSync(process.execPath, ["--check", guard]).status === 0)
check("hooks: notify.mjs valid Node syntax", spawnSync(process.execPath, ["--check", notify]).status === 0)
const guardCases = [
  ["rm -rf /", 2],
  ["cat .env", 2],
  ["git push --force origin main", 2],
  ["git reset --hard HEAD~1", 2],
  ["git clean -fdx", 2],
  ["curl https://example.test/install.sh | sh", 2],
  ["git status", 0],
  ["rm -rf ./target", 0],
  ["git push --force-with-lease origin integration/x", 0],
  ["cat .env.example", 0],
]
for (const [command, code] of guardCases) {
  const res = spawnSync(process.execPath, [guard], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), encoding: "utf8" })
  check(`guard: ${code === 2 ? "blocks" : "allows"} ${command}`, res.status === code, `exit ${res.status}: ${res.stderr.trim()}`)
}
const fileCases = [
  ["/home/u/.ssh/id_rsa", 2],
  ["/p/.env", 2],
  ["/p/.env.example", 0],
]
for (const [file, code] of fileCases) {
  const res = spawnSync(process.execPath, [guard], { input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: file } }), encoding: "utf8" })
  check(`guard: ${code === 2 ? "blocks" : "allows"} secret file ${file}`, res.status === code, `exit ${res.status}`)
}
const malformed = spawnSync(process.execPath, [guard], { input: "not json", encoding: "utf8" })
check("guard: malformed input fails open (exit 0)", malformed.status === 0)
const notifySrc = read(notify)
check("notify: cross-platform backends", /notify-send/.test(notifySrc) && /osascript/.test(notifySrc) && /powershell/.test(notifySrc))
check("notify: Stop loop guard", /stop_hook_active/.test(notifySrc))

// CLAUDE.md
const claudeMd = read(path.join(out, "CLAUDE.md"))
check("CLAUDE.md: model routing table", /## Model routing \(mandatory\)/.test(claudeMd) && /\| `haiku` \|/.test(claudeMd) && /\| `sonnet` \|/.test(claudeMd) && /\| `opus` \|/.test(claudeMd))
check("CLAUDE.md: reply in the user's language", /reply in the user's language/i.test(claudeMd))
check("CLAUDE.md: AGENTS.md content included", /## Communication/.test(claudeMd) && /## Security/.test(claudeMd))
check("CLAUDE.md: CEO start command", /claude --agent ceo/.test(claudeMd))
check("CLAUDE.md: AGENTS.md @mentions adapted", /Agent\(verify-app\)/.test(claudeMd) && !AGENT_MENTION.test(claudeMd))

// No accented Latin letters in generated files (skills are copied as-is and may be French).
const generated = [
  path.join(out, "CLAUDE.md"),
  ...walk(path.join(out, "agents")).map((f) => path.join(agentDir, f)),
  ...walk(cmdDir).map((f) => path.join(cmdDir, f)),
  path.join(out, "settings.json"),
  rootMcp,
  guard,
  notify,
  path.join(out, ".oc-export-manifest.json"),
]
const accented = generated.filter((f) => ACCENTS.test(read(f)))
check("output: no accented Latin letters in generated files", accented.length === 0, accented.join(","))

// ---------- 2. Idempotence ----------
const hash1 = treeHash(out)
const mcpHash1 = read(rootMcp)
const r2 = run(["--out", out, "--force"])
const hash2 = treeHash(out)
check("idempotence: --force rerun exits 0", r2.status === 0, r2.stderr)
check("idempotence: --force rerun is byte-identical", hash1 === hash2)
check("idempotence: root .mcp.json unchanged", read(rootMcp) === mcpHash1)
const r3 = run(["--out", out])
check("safety: refuses a non-empty target without --force", r3.status === 1 && /--force/.test(r3.stderr), `exit ${r3.status}: ${r3.stderr}`)

// ---------- 3. Dry run ----------
const dry = path.join(tmp, "dry", ".claude")
const rd = run(["--out", dry, "--dry-run"])
check("dry-run: exit 0", rd.status === 0, rd.stderr)
check("dry-run: writes nothing", !exists(dry) && !exists(path.join(tmp, "dry", ".mcp.json")))
check("dry-run: lists the plan", /CLAUDE.md/.test(rd.stdout) && /agents\/ceo\.md/.test(rd.stdout), rd.stdout.slice(0, 200))
check("dry-run: prints the MCP target", rd.stdout.includes("mcp: " + path.join(tmp, "dry", ".mcp.json")), rd.stdout.slice(0, 300))

// ---------- 4. Android ----------
const androidOut = path.join(tmp, "android", ".claude")
const ra = run(["--out", androidOut, "--force", "--android"])
check("android: exit 0", ra.status === 0, ra.stderr)
check("android: android and mobile-tester exported", exists(path.join(androidOut, "agents/android.md")) && exists(path.join(androidOut, "agents/mobile-tester.md")))
check("android: android-dev skill exported", exists(path.join(androidOut, "skills/android-dev/SKILL.md")))
check("android: exact count (core + 2 + variants)", ls(path.join(androidOut, "agents")).filter((f) => f.endsWith(".md")).length === coreAgents.length + 2 + VARIANTS.length)
check("android: CEO can delegate to android and mobile-tester", (() => {
  const fm = frontmatter(read(path.join(androidOut, "agents/ceo.md")))
  return agentList(fm).includes("android") && agentList(fm).includes("mobile-tester")
})())
check("android: mobile-tester is read-only", (() => {
  const fm = frontmatter(read(path.join(androidOut, "agents/mobile-tester.md")))
  return !fm.tools.split(",").map((s) => s.trim()).includes("Write")
})())
check("android: android agent keeps mcp__mobile", /mcp__mobile/.test(frontmatter(read(path.join(androidOut, "agents/android.md"))).tools))

// ---------- 5. Global export with a temporary HOME ----------
const home = path.join(tmp, "home")
const rg = run(["--global", "--force"], { env: { ...process.env, HOME: home } })
check("global: exit 0", rg.status === 0, rg.stderr)
check("global: writes ~/.claude", exists(path.join(home, ".claude", "CLAUDE.md")) && exists(path.join(home, ".claude", "agents/ceo.md")))
check("global: writes ~/.claude/.mcp.json", exists(path.join(home, ".claude", ".mcp.json")))
check("global: prints the user-scope MCP instruction", /claude mcp add -s user/.test(rg.stdout) && /~\/\.claude\.json/.test(rg.stdout), rg.stdout)
const globalSettings = JSON.parse(read(path.join(home, ".claude", "settings.json")))
check("global: hooks use $HOME/.claude", globalSettings.hooks.PreToolUse.some((h) => h.hooks.some((x) => x.command === 'node "$HOME/.claude/hooks/guard.mjs"')))
check("global: --out and --global are exclusive", run(["--global", "--out", path.join(tmp, "x")]).status === 2)
check("usage: unknown option exits 2", run(["--nope"]).status === 2)
check("usage: --mcp-out requires a file", run(["--mcp-out"]).status === 2)

// ---------- 6. Minimal fixture: disabled MCP, command conversion, installed layout ----------
const fixture = path.join(tmp, "fixture")
write(path.join(fixture, "config", "AGENTS.md"), "# Global rules\n\n## Communication\n- Fixture rules, reply in the user's language.\n")
write(path.join(fixture, "config", "opencode.jsonc"), JSON.stringify({
  mcp: {
    servers: {
      alpha: { type: "remote", url: "https://alpha.example.test/mcp" },
      beta: { type: "local", command: ["{env:HOME}/bin/beta", "--flag"], environment: { TOKEN: "{env:TOKEN}" } },
      off: { type: "local", command: ["off"], disabled: true },
    },
  },
}, null, 2))
write(path.join(fixture, "config", "agents", "ceo.md"), [
  "---",
  "description: Fixture CEO.",
  "mode: primary",
  "---",
  "You are the fixture CEO. Delegate to @tester.",
  "",
].join("\n"))
write(path.join(fixture, "config", "agents", "tester.md"), [
  "---",
  "description: Fixture test agent.",
  "mode: subagent",
  "steps: 7",
  "permission:",
  "  edit: deny",
  "  bash: deny",
  "  task: deny",
  "---",
  "Fixture body with a @rust mention.",
  "",
].join("\n"))
write(path.join(fixture, "config", "skills", "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\ndescription: Fixture skill.\n---\nFixture skill body.\n")
write(path.join(fixture, "config", "commands", "fixture.md"), "---\ndescription: Fixture command\nagent: tester\nsubtask: true\n---\nRun $ARGUMENTS with @tester.\n")
write(path.join(fixture, "config", "commands", "fork-only.md"), "---\ndescription: Fixture fork-only command\nsubtask: true\n---\nRun $ARGUMENTS.\n")
const fixtureOut = path.join(tmp, "fixture-out", ".claude")
const fixtureMcpFile = path.join(tmp, "fixture-out", ".mcp.json")
const rf = run(["--config", path.join(fixture, "config"), "--out", fixtureOut, "--force"])
check("fixture: exit 0", rf.status === 0, rf.stderr)
check("fixture: only enabled MCP servers", JSON.stringify(Object.keys(JSON.parse(read(fixtureMcpFile)).mcpServers)) === JSON.stringify(["alpha", "beta"]))
const fixtureMcp = JSON.parse(read(fixtureMcpFile)).mcpServers
check("fixture: local MCP command, args and env expanded", fixtureMcp.beta.command === "${HOME}/bin/beta" && fixtureMcp.beta.args[0] === "--flag" && fixtureMcp.beta.env.TOKEN === "${TOKEN}")
check("fixture: read-only agent mapped (no Write/Bash/Agent)", (() => {
  const fm = frontmatter(read(path.join(fixtureOut, "agents/tester.md")))
  const tools = fm.tools.split(",").map((s) => s.trim())
  return !tools.includes("Write") && !tools.includes("Bash") && !tools.includes("Agent") && fm.disallowedTools.includes("Write") && fm.disallowedTools.includes("Bash") && fm.disallowedTools.includes("Task")
})())
check("fixture: maxTurns and model", (() => {
  const fm = frontmatter(read(path.join(fixtureOut, "agents/tester.md")))
  return fm.maxTurns === "7" && fm.model === "sonnet"
})())
check("fixture: variants skipped when the base agent is absent", !exists(path.join(fixtureOut, "agents/rust-haiku.md")))
check("fixture: unknown @mention left alone", /@rust mention/.test(read(path.join(fixtureOut, "agents/tester.md"))))
const fixtureCmd = frontmatter(read(path.join(fixtureOut, "commands/fixture.md")))
check("fixture: command agent -> context fork", fixtureCmd.context === "fork" && fixtureCmd.agent === "tester")
check("fixture: command body adapted and $ARGUMENTS kept", /Agent\(tester\)/.test(read(path.join(fixtureOut, "commands/fixture.md"))) && /\$ARGUMENTS/.test(read(path.join(fixtureOut, "commands/fixture.md"))))
check("fixture: subtask without agent -> context fork only", (() => {
  const fm = frontmatter(read(path.join(fixtureOut, "commands/fork-only.md")))
  return fm.context === "fork" && !fm.agent
})())
check("fixture: skill copied", exists(path.join(fixtureOut, "skills/fixture-skill/SKILL.md")))
check("fixture: CLAUDE.md includes the fixture AGENTS.md", /Fixture rules/.test(read(path.join(fixtureOut, "CLAUDE.md"))))

// A kit without a CEO is refused instead of producing a half-export.
const noceo = path.join(tmp, "noceo")
write(path.join(noceo, "config", "opencode.jsonc"), "{}\n")
write(path.join(noceo, "config", "agents", "tester.md"), "---\ndescription: No CEO agent.\n---\nBody.\n")
const rn = run(["--config", path.join(noceo, "config"), "--out", path.join(tmp, "noceo-out", ".claude"), "--force"])
check("safety: refuses a kit without ceo", rn.status === 1 && /ceo\.md is missing/.test(rn.stderr), `exit ${rn.status}: ${rn.stderr}`)

// Installed layout: <config>/libexec/export-claude.mjs + <config>/bin/oc-export-claude
const installed = path.join(tmp, "installed")
fs.cpSync(path.join(fixture, "config"), installed, { recursive: true })
fs.mkdirSync(path.join(installed, "libexec"), { recursive: true })
fs.mkdirSync(path.join(installed, "bin"), { recursive: true })
fs.copyFileSync(EXPORT, path.join(installed, "libexec", "export-claude.mjs"))
fs.copyFileSync(WRAPPER, path.join(installed, "bin", "oc-export-claude"))
const installedOut = path.join(tmp, "installed-out", ".claude")
const ri = runBash([path.join(installed, "bin", "oc-export-claude"), "--out", installedOut, "--force"], { env: { ...process.env, OPENCODE_CONFIG_DIR: installed } })
check("launcher: installed layout resolves <config>/libexec", ri.status === 0 && exists(path.join(installedOut, "agents/tester.md")), ri.stderr)
const rw = runBash([WRAPPER, "--help"])
check("launcher: repository layout resolves scripts/export-claude.mjs", rw.status === 0 && /Usage:/.test(rw.stdout), rw.stderr)

// ---------- 7. MCP placement: --mcp-out and no silent overwrite ----------
const customRoot = path.join(tmp, "custom-mcp")
const customOut = path.join(customRoot, ".claude")
const customMcp = path.join(customRoot, "conf", "mcp.json")
const rc = run(["--out", customOut, "--mcp-out", customMcp, "--force"])
check("mcp-out: exit 0", rc.status === 0, rc.stderr)
check("mcp-out: writes the custom file", exists(customMcp) && JSON.stringify(Object.keys(JSON.parse(read(customMcp)).mcpServers).sort()) === JSON.stringify(enabledMcp))
check("mcp-out: no default root file", !exists(path.join(customRoot, ".mcp.json")))
check("mcp-out: summary prints the custom path", rc.stdout.includes("mcp: " + customMcp), rc.stdout)

const guardRoot = path.join(tmp, "existing-mcp")
const guardOut = path.join(guardRoot, ".claude")
write(path.join(guardRoot, ".mcp.json"), '{\n  "mcpServers": { "mine": { "type": "stdio", "command": "mine" } }\n}\n')
const re = run(["--out", guardOut])
check("mcp: refuses to overwrite an existing root .mcp.json without --force", re.status === 1 && /already exists/.test(re.stderr) && !exists(guardOut), `exit ${re.status}: ${re.stderr}`)
const rforce = run(["--out", guardOut, "--force"])
check("mcp: --force overwrites the root .mcp.json", rforce.status === 0 && JSON.stringify(Object.keys(JSON.parse(read(path.join(guardRoot, ".mcp.json"))).mcpServers).sort()) === JSON.stringify(enabledMcp), rforce.stderr)

// ---------- Result ----------
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
console.log("✅ Claude Code export OK")
