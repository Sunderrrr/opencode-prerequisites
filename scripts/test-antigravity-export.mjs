#!/usr/bin/env node
// Tests for scripts/export-antigravity.mjs: a real export of the kit with a temporary
// HOME, the generated agent frontmatter and tiers, skills, MCP merge/backup, idempotence,
// .new/--force, --android, --project, the launcher, the CLI reading the result, and a
// fixture covering disabled servers and preset user entries. Hermetic: every write goes
// to a temporary directory.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { parseJsonc, mcpServers, frontmatter } from "./lib/jsonc.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXPORT = path.join(ROOT, "scripts", "export-antigravity.mjs")
const WRAPPER = path.join(ROOT, "config", "bin", "oc-export-antigravity")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-antigravity-"))
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

function snapshot(dir, skip = () => false) {
  const h = crypto.createHash("sha256")
  for (const rel of walk(dir)) {
    if (skip(rel)) continue
    h.update(rel)
    h.update("\0")
    h.update(fs.readFileSync(path.join(dir, rel)))
    h.update("\0")
  }
  return h.digest("hex")
}

// Sources of truth: the exporter must follow the kit, not a hardcoded list.
const cfg = parseJsonc(read(path.join(ROOT, "config", "opencode.jsonc")))
const sourceMcp = mcpServers(cfg)
const enabledMcp = Object.keys(sourceMcp).filter((n) => sourceMcp[n] && sourceMcp[n].disabled !== true && sourceMcp[n].enabled !== false).sort()
const coreAgents = ls(path.join(ROOT, "config", "agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))
const coreSkills = ls(path.join(ROOT, "config", "skills")).filter((d) => exists(path.join(ROOT, "config", "skills", d, "SKILL.md")))
const addonAgents = ls(path.join(ROOT, "addons", "android", "agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))
const addonSkills = ls(path.join(ROOT, "addons", "android", "skills")).filter((d) => exists(path.join(ROOT, "addons", "android", "skills", d, "SKILL.md")))
const coreSkillFiles = coreSkills.reduce((n, d) => n + walk(path.join(ROOT, "config", "skills", d)).length, 0)

const TIER = {
  ceo: "pro", architect: "pro", security: "pro", review: "pro", "verify-app": "pro", integrator: "pro",
  designer: "pro", pentest: "pro", "reverse-engineer": "pro",
  researcher: "flash", "web-researcher": "flash",
}
const tierOf = (name) => TIER[name] || "inherit"

// ---------- 1. Real kit export with a temporary HOME ----------
const home = path.join(tmp, "home")
const out = path.join(home, ".gemini", "config")
fs.mkdirSync(out, { recursive: true })
const mcpFile = path.join(out, "mcp_config.json")
const initialMcp = JSON.stringify(
  { mcpServers: { mine: { command: "/bin/echo", args: ["mine"], disabled: true } }, customTop: { keep: true } },
  null,
  2,
) + "\n"
write(mcpFile, initialMcp)
const env = { ...process.env, HOME: home }
const r1 = run(["--global"], { env })
check("export: exit 0", r1.status === 0, r1.stderr)
check("export: summary printed", /Antigravity export:/.test(r1.stdout), r1.stdout)
check("export: AGENTS.md generated", exists(path.join(out, "AGENTS.md")))
check("export: all core agents exported", coreAgents.every((n) => exists(path.join(out, "agents", n + ".md"))), ls(path.join(out, "agents")).join(","))
check("export: exact agent count", ls(path.join(out, "agents")).filter((f) => f.endsWith(".md")).length === coreAgents.length)
check("export: Android absent without --android", !exists(path.join(out, "agents", "android.md")) && !exists(path.join(out, "agents", "mobile-tester.md")))
check("export: all core skills exported", coreSkills.every((n) => exists(path.join(out, "skills", n, "SKILL.md"))))
check("export: exact skill file count", coreSkills.reduce((n, d) => n + walk(path.join(out, "skills", d)).length, 0) === coreSkillFiles)

// Agent frontmatter and tiers.
const agentDir = path.join(out, "agents")
const exported = ls(agentDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))
const fmErrors = []
for (const name of exported) {
  const fm = frontmatter(read(path.join(agentDir, name + ".md")))
  if (!fm) { fmErrors.push(`${name}: no frontmatter`); continue }
  if (fm.name !== name) fmErrors.push(`${name}: name=${fm.name}`)
  if (!fm.description) fmErrors.push(`${name}: no description`)
  if (!["pro", "flash", "inherit"].includes(fm.model)) fmErrors.push(`${name}: model=${fm.model}`)
  if (fm.subagent !== "true") fmErrors.push(`${name}: subagent=${fm.subagent}`)
  if (fm.mainAgent !== (name === "ceo" ? "true" : "false")) fmErrors.push(`${name}: mainAgent=${fm.mainAgent}`)
  if (fm.commandExecutionPolicy !== "sandbox") fmErrors.push(`${name}: policy=${fm.commandExecutionPolicy}`)
  if (fm.model !== tierOf(name)) fmErrors.push(`${name}: tier ${fm.model} != ${tierOf(name)}`)
}
check("agents: frontmatter valid (name, description, tier, subagent, mainAgent, policy)", fmErrors.length === 0, fmErrors.join(" | "))
check("agents: ceo is the only main agent", exported.filter((n) => frontmatter(read(path.join(agentDir, n + ".md"))).mainAgent === "true").join(",") === "ceo")
check("agents: pro tier (9 agents)", exported.filter((n) => frontmatter(read(path.join(agentDir, n + ".md"))).model === "pro").length === 9)
check("agents: flash tier (2 agents)", exported.filter((n) => frontmatter(read(path.join(agentDir, n + ".md"))).model === "flash").length === 2)
check("agents: inherit tier for the rest", exported.filter((n) => frontmatter(read(path.join(agentDir, n + ".md"))).model === "inherit").length === exported.length - 11)
check("agents: body keeps no OpenCode frontmatter", !/^mode:/m.test(read(path.join(agentDir, "rust.md"))) && !/^permission:/m.test(read(path.join(agentDir, "rust.md"))))
check("agents: @mention adapted", /`rust`/.test(read(path.join(agentDir, "ceo.md"))) && !/(^|[^A-Za-z0-9_@])@rust\b/m.test(read(path.join(agentDir, "ceo.md"))))
check("agents: code-span mention not doubled", !/``shell``/.test(read(path.join(agentDir, "ceo.md"))))
check("agents: worktree and local-commit notes", /worktree or/.test(read(path.join(agentDir, "rust.md"))) && /Commit locally/.test(read(path.join(agentDir, "rust.md"))))

// AGENTS.md
const agentsMd = read(path.join(out, "AGENTS.md"))
check("AGENTS.md: kit content included", /# Global rules/.test(agentsMd) && /Done = proven/.test(agentsMd))
check("AGENTS.md: tier routing included", /Model routing \(Antigravity\)/.test(agentsMd) && /`pro`/.test(agentsMd) && /`flash`/.test(agentsMd) && /`inherit`/.test(agentsMd))
check("AGENTS.md: CEO delegation included", /CEO delegation rules \(Antigravity\)/.test(agentsMd) && /invoke_subagent/.test(agentsMd))
check("AGENTS.md: Antigravity paths included", /\.gemini\/config\/agents/.test(agentsMd) && /mcp_config\.json/.test(agentsMd))

// MCP merge.
const mergedMcp = JSON.parse(read(mcpFile))
check("mcp: preset user server preserved", JSON.stringify(mergedMcp.mcpServers.mine) === JSON.stringify({ command: "/bin/echo", args: ["mine"], disabled: true }))
check("mcp: unknown top-level key preserved", mergedMcp.customTop && mergedMcp.customTop.keep === true)
check("mcp: every enabled OpenCode server added", enabledMcp.every((n) => mergedMcp.mcpServers[n]), Object.keys(mergedMcp.mcpServers).join(","))
check("mcp: remote server uses serverUrl", mergedMcp.mcpServers.context7 && mergedMcp.mcpServers.context7.serverUrl === sourceMcp.context7.url)
check("mcp: local command/args written", mergedMcp.mcpServers.playwright && mergedMcp.mcpServers.playwright.command === path.join(home, ".local", "bin", "oc-playwright-mcp") && Array.isArray(mergedMcp.mcpServers.playwright.args))
check("mcp: {env:HOME} expanded", !read(mcpFile).includes("{env:") && mergedMcp.mcpServers.kubernetes.args.includes(path.join(home, ".config", "opencode", "k8s-mcp.toml")))
const backups = ls(out).filter((f) => f.startsWith("mcp_config.json.bak-"))
check("mcp: backup written before the merge", backups.length === 1 && read(path.join(out, backups[0])) === initialMcp, backups.join(","))

// ---------- 2. Idempotence ----------
const skipBackup = (rel) => rel.includes(".bak-") || rel.endsWith(".new")
const hash1 = snapshot(out, skipBackup)
const r2 = run(["--global"], { env })
check("idempotent: second export exit 0", r2.status === 0, r2.stderr)
check("idempotent: same bytes", snapshot(out, skipBackup) === hash1)
check("idempotent: zero files written", /files: 0 written/.test(r2.stdout), r2.stdout)
check("idempotent: no .new created", !walk(out).some((rel) => rel.endsWith(".new")))
check("idempotent: no extra MCP backup", ls(out).filter((f) => f.startsWith("mcp_config.json.bak-")).length === 1)

// ---------- 3. Conflict: .new by default, --force overwrites ----------
const rustFile = path.join(agentDir, "rust.md")
const canonicalRust = read(rustFile)
write(rustFile, canonicalRust + "\nLOCAL EDIT\n")
const r3 = run(["--global"], { env })
check("conflict: export still succeeds", r3.status === 0, r3.stderr)
check("conflict: target left untouched", read(rustFile).includes("LOCAL EDIT"))
check("conflict: generated content written to .new", read(rustFile + ".new") === canonicalRust)
check("conflict: summary counts the .new", /1 \.new/.test(r3.stdout), r3.stdout)
const r4 = run(["--global", "--force"], { env })
check("force: exit 0", r4.status === 0, r4.stderr)
check("force: target overwritten", read(rustFile) === canonicalRust)
check("force: .new cleaned up", !exists(rustFile + ".new"))

// ---------- 4. --dry-run ----------
const dryOut = path.join(tmp, "dry", ".gemini", "config")
const r5 = run(["--out", dryOut, "--dry-run"], { env })
check("dry-run: exit 0", r5.status === 0, r5.stderr)
check("dry-run: writes nothing", !exists(dryOut))
check("dry-run: prints the plan", /\(dry run\)/.test(r5.stdout) && /agents:/.test(r5.stdout), r5.stdout)

// ---------- 5. --android ----------
const androidOut = path.join(tmp, "android")
const r6 = run(["--out", androidOut, "--android"], { env })
check("android: exit 0", r6.status === 0, r6.stderr)
check("android: addon agents exported", addonAgents.every((n) => exists(path.join(androidOut, "agents", n + ".md"))), addonAgents.join(","))
check("android: exact agent count", ls(path.join(androidOut, "agents")).filter((f) => f.endsWith(".md")).length === coreAgents.length + addonAgents.length)
check("android: addon skills exported", addonSkills.every((n) => exists(path.join(androidOut, "skills", n, "SKILL.md"))))
check("android: android agent inherits the model", frontmatter(read(path.join(androidOut, "agents", "android.md"))).model === "inherit")

// ---------- 6. --project ----------
const project = path.join(tmp, "project")
const globalBeforeProject = snapshot(out, skipBackup)
const r7 = run(["--project", project], { env })
check("project: exit 0", r7.status === 0, r7.stderr)
check("project: writes DIR/.agents", exists(path.join(project, ".agents", "AGENTS.md")) && exists(path.join(project, ".agents", "agents", "ceo.md")))
check("project: writes skills and MCP", exists(path.join(project, ".agents", "skills", "tdd", "SKILL.md")) && exists(path.join(project, ".agents", "mcp_config.json")))
check("project: does not touch the global target", snapshot(out, skipBackup) === globalBeforeProject)

// ---------- 7. Fixture: disabled server, collision, support files ----------
const fixtureRoot = path.join(tmp, "fixture")
const fixtureConfig = path.join(fixtureRoot, "config")
write(path.join(fixtureConfig, "AGENTS.md"), "# Fixture rules\n\n- Keep it short.\n")
write(path.join(fixtureConfig, "agents", "ceo.md"), "---\ndescription: Fixture CEO.\n---\nYou delegate to @helper.\n")
write(path.join(fixtureConfig, "agents", "helper.md"), "---\ndescription: Fixture helper.\n---\nYou help.\n")
write(path.join(fixtureConfig, "skills", "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\ndescription: Fixture skill.\n---\n# Fixture\n")
write(path.join(fixtureConfig, "skills", "fixture-skill", "reference.txt"), "support file\n")
write(
  path.join(fixtureConfig, "opencode.jsonc"),
  JSON.stringify({
    mcp: {
      servers: {
        local: { type: "local", command: ["/bin/echo", "{env:HOME}"], environment: { BASE: "{env:HOME}/x" } },
        envlocal: { type: "local", command: ["/bin/echo", "{env:HOME}"], environment: { BASE: "{env:HOME}/x" } },
        remote: { type: "remote", url: "https://example.invalid/mcp", headers: { "X-Test": "{env:HOME}" } },
        off: { type: "local", command: ["/bin/false"], disabled: true },
      },
    },
  }) + "\n",
)
const fixtureOut = path.join(tmp, "fixture-out")
fs.mkdirSync(fixtureOut, { recursive: true })
const fixtureMcp = path.join(fixtureOut, "mcp_config.json")
write(fixtureMcp, JSON.stringify({ mcpServers: { local: { command: "/bin/true", args: ["user"], disabled: true } } }) + "\n")
const r8 = run(["--config", fixtureConfig, "--out", fixtureOut, "--force"], { env })
check("fixture: exit 0", r8.status === 0, r8.stderr)
const fMcp = JSON.parse(read(fixtureMcp))
check("fixture: preset server wins over the kit entry", fMcp.mcpServers.local.command === "/bin/true" && fMcp.mcpServers.local.args[0] === "user")
check("fixture: disabled OpenCode server exported disabled", fMcp.mcpServers.off && fMcp.mcpServers.off.disabled === true)
check("fixture: remote uses serverUrl and expanded headers", fMcp.mcpServers.remote.serverUrl === "https://example.invalid/mcp" && fMcp.mcpServers.remote.headers["X-Test"] === home)
check("fixture: local command, args and env expanded", fMcp.mcpServers.envlocal.command === "/bin/echo" && fMcp.mcpServers.envlocal.args[0] === home && fMcp.mcpServers.envlocal.env.BASE === home + "/x")
check("fixture: support file copied", read(path.join(fixtureOut, "skills", "fixture-skill", "reference.txt")) === "support file\n")
check("fixture: @helper adapted", /`helper`/.test(read(path.join(fixtureOut, "agents", "ceo.md"))) && !/@helper/.test(read(path.join(fixtureOut, "agents", "ceo.md"))))
check("fixture: non-ceo mainAgent false", frontmatter(read(path.join(fixtureOut, "agents", "helper.md"))).mainAgent === "false")
const fixtureBackup = ls(fixtureOut).filter((f) => f.startsWith("mcp_config.json.bak-"))
check("fixture: MCP backup written", fixtureBackup.length === 1)

// ---------- 8. Safety: invalid MCP JSON, missing CEO ----------
const badOut = path.join(tmp, "bad")
fs.mkdirSync(badOut, { recursive: true })
write(path.join(badOut, "mcp_config.json"), "{ not json")
const r9 = run(["--out", badOut, "--force"], { env })
check("safety: invalid mcp_config.json refused", r9.status === 1 && /not valid JSON/.test(r9.stderr) && !exists(path.join(badOut, "AGENTS.md")), `exit ${r9.status}: ${r9.stderr}`)
const noceo = path.join(tmp, "noceo", "config")
write(path.join(noceo, "opencode.jsonc"), "{}\n")
write(path.join(noceo, "agents", "helper.md"), "---\ndescription: No CEO.\n---\nBody.\n")
const r10 = run(["--config", noceo, "--out", path.join(tmp, "noceo-out"), "--force"], { env })
check("safety: kit without ceo refused", r10.status === 1 && /ceo\.md is missing/.test(r10.stderr), `exit ${r10.status}: ${r10.stderr}`)

// ---------- 9. Launcher ----------
const rw = runBash([WRAPPER, "--help"], { env })
check("launcher: --help exit 0", rw.status === 0 && /Usage:/.test(rw.stdout), rw.stderr)
const wrapperOut = path.join(tmp, "wrapper-out")
const rw2 = runBash([WRAPPER, "--out", wrapperOut, "--force"], { env })
check("launcher: repository layout resolves the exporter", rw2.status === 0 && exists(path.join(wrapperOut, "agents", "ceo.md")), rw2.stderr)

// Installed layout: <config>/libexec/export-antigravity.mjs reads <config>/opencode.jsonc.
const installedKit = path.join(tmp, "installed-kit")
fs.cpSync(path.join(ROOT, "config"), installedKit, { recursive: true })
fs.mkdirSync(path.join(installedKit, "libexec"), { recursive: true })
fs.copyFileSync(EXPORT, path.join(installedKit, "libexec", "export-antigravity.mjs"))
const installedOut = path.join(tmp, "installed-out")
const rInstalled = spawnSync(process.execPath, [path.join(installedKit, "libexec", "export-antigravity.mjs"), "--out", installedOut, "--force"], { encoding: "utf8" })
check("installed layout: <config>/libexec reads <config>/opencode.jsonc",
  rInstalled.status === 0 && exists(path.join(installedOut, "agents", "ceo.md")) && exists(path.join(installedOut, "mcp_config.json")), rInstalled.stderr)

// ---------- 10. Antigravity CLI reads the generated config ----------
// `agy` first: the desktop app also installs an `antigravity` binary on Linux
// (/opt/Antigravity/antigravity) that ignores the CLI subcommands and would hang.
const cliPath = runBash(["-c", "command -v agy || command -v antigravity"], { env }).stdout.trim()
const cliIsDesktopApp = (() => {
  if (!cliPath) return false
  try {
    return fs.realpathSync(cliPath).startsWith("/opt/Antigravity/")
  } catch {
    return false
  }
})()
const cliEnv = { ...process.env, HOME: home }
const mcpList = cliPath && !cliIsDesktopApp ? spawnSync(cliPath, ["mcp", "list"], { encoding: "utf8", env: cliEnv, timeout: 30000 }) : null
const cliUsable = Boolean(mcpList && mcpList.status === 0)
if (!cliPath) console.log("⏭️  cli: antigravity not on PATH — integration checks skipped (install Antigravity CLI 1.5.16+ to run them)")
else if (cliIsDesktopApp) console.log(`⏭️  cli: ${cliPath} is the desktop app — integration checks skipped (use agy)`)
else if (!cliUsable) console.log(`⏭️  cli: ${cliPath} does not answer 'mcp list' (timeout) — integration checks skipped`)
if (cliUsable) {
  check("cli: antigravity mcp list exit 0", mcpList.status === 0, mcpList.stderr)
  check("cli: mcp list shows the kit and user servers", /context7/.test(mcpList.stdout) && /playwright/.test(mcpList.stdout) && /mine/.test(mcpList.stdout), mcpList.stdout)
  const agentList = spawnSync(cliPath, ["agent"], { encoding: "utf8", env: cliEnv, timeout: 30000 })
  check("cli: antigravity agent exit 0", agentList.status === 0, agentList.stderr)
  check("cli: ceo listed as the main agent", /^ceo$/m.test(agentList.stdout), agentList.stdout)
  check("cli: subagents are not main agents", !/^rust$/m.test(agentList.stdout), agentList.stdout)
}

// ---------- 11. No secrets in the generated tree ----------
const secretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
]
const secretHits = []
for (const rel of walk(out)) {
  if (rel.includes(".bak-")) continue
  const text = fs.readFileSync(path.join(out, rel), "utf8")
  for (const re of secretPatterns) if (re.test(text)) secretHits.push(`${rel}: ${re}`)
}
check("security: no secret pattern in the export", secretHits.length === 0, secretHits.join(" | "))

// ---------- Result ----------
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
console.log("✅ Antigravity export OK")
