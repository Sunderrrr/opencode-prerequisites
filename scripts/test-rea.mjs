#!/usr/bin/env node
// Hermetic tests for the REA integration: config/bin/oc-rea, config/bin/oc-rea-mcp,
// the reverse-engineer agent, the vendored skill, docs and the doctor check.
// No real npx, no network, no analysis: fake launchers and a temporary HOME/PATH only.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CLI = path.join(ROOT, "config", "bin", "oc-rea")
const MCP = path.join(ROOT, "config", "bin", "oc-rea-mcp")
const AGENT = path.join(ROOT, "config", "agents", "reverse-engineer.md")
const SKILL = path.join(ROOT, "config", "skills", "reverse-engineer-anything")
const DOCS = path.join(ROOT, "docs", "rea.md")
const DOCTOR = path.join(ROOT, "scripts", "doctor.mjs")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oc-rea-test-"))

let checks = 0
let failed = 0
const check = (name, cond, detail = "") => {
  checks++
  if (!cond) failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`)
}
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "")
const write = (f, body, mode = 0o755) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, body, { mode })
}

// Minimal PATH: bash for the launchers, the real Node for the version gate, a fake npx.
const bash = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"].find(fs.existsSync)
if (!bash) throw new Error("bash not found: the launchers cannot be tested")
const sysDir = path.join(TMP, "sys")
fs.mkdirSync(sysDir, { recursive: true })
fs.symlinkSync(bash, path.join(sysDir, "bash"))
const nodeDir = path.dirname(process.execPath)
const fakeBin = path.join(TMP, "bin")
const npxLog = path.join(TMP, "npx.log")
write(path.join(fakeBin, "npx"), `#!/bin/sh
printf '%s\\n' "$*" >> "\${NPX_LOG:-/dev/null}"
printf 'FAKE_NPX %s\\n' "$*"
`)

const cleanEnv = { ...process.env }
for (const key of ["OC_REA_VERSION", "OC_REA_NODE_VERSION", "OPENCODE_CONFIG_DIR", "OBSCURA_BIN_DIR", "NPX_LOG", "OC_DOCTOR_OFFLINE", "NODE_OPTIONS"]) delete cleanEnv[key]
const baseEnv = {
  ...cleanEnv,
  HOME: path.join(TMP, "home"),
  PATH: [fakeBin, nodeDir, sysDir].join(path.delimiter),
  NPX_LOG: npxLog,
}
const resetLog = () => fs.writeFileSync(npxLog, "")
const log = () => read(npxLog)
const run = (file, args = [], env = {}) => spawnSync(file, args, {
  encoding: "utf8",
  env: { ...baseEnv, ...env },
  timeout: 20000,
})

// ---------- 1. launcher files ----------
check("oc-rea exists and is executable", fs.existsSync(CLI) && (fs.statSync(CLI).mode & 0o111) !== 0)
check("oc-rea-mcp exists and is executable", fs.existsSync(MCP) && (fs.statSync(MCP).mode & 0o111) !== 0)
const cliSrc = read(CLI)
check("oc-rea: bash shebang", cliSrc.startsWith("#!/usr/bin/env bash"))
check("oc-rea: strict mode", /^set -Eeuo pipefail$/m.test(cliSrc))
check("oc-rea: pins rea-agents@6.8.0 by default", /OC_REA_VERSION:-6\.8\.0/.test(cliSrc))
check("oc-rea: never runs rea setup", !/\bsetup\b/.test(cliSrc))

// ---------- 2. Node gate (accepted and rejected versions) ----------
const accepted = ["26.12.1", "26.13.0", "27.0.0", "24.22.1", "24.30.0", "22.23.4"]
let allOk = true
for (const v of accepted) {
  resetLog()
  const r = run(CLI, ["--version"], { OC_REA_NODE_VERSION: v })
  if (r.status !== 0 || log().trim() !== "-y rea-agents@6.8.0 --version") {
    allOk = false
    check(`Node ${v}: accepted`, false, `code ${r.status} | ${log().trim()} | ${r.stderr.trim()}`)
  }
}
check(`Node gate: accepts ${accepted.join(", ")}`, allOk)

const rejected = ["26.12.0", "26.7.0", "25.9.0", "24.22.0", "22.23.3", "20.19.0", "18.0.0"]
allOk = true
for (const v of rejected) {
  resetLog()
  const r = run(CLI, ["--version"], { OC_REA_NODE_VERSION: v })
  if (r.status !== 1 || log().trim() !== "" || !/requires Node \^22\.23\.4 \|\| \^24\.22\.1 \|\| >=26\.12\.1/.test(r.stderr) || !r.stderr.includes(v)) {
    allOk = false
    check(`Node ${v}: rejected`, false, `code ${r.status} | ${log().trim()} | ${r.stderr.trim()}`)
  }
}
check(`Node gate: rejects ${rejected.join(", ")}`, allOk)

// ---------- 3. CLI passthrough ----------
resetLog()
let r = run(CLI, ["--check"], { OC_REA_NODE_VERSION: "26.13.0" })
check("oc-rea --check: exit 0 without npx", r.status === 0 && log().trim() === "", `code ${r.status} | ${log().trim()}`)

resetLog()
r = run(CLI, ["analyze-javascript-application", "/tmp/app", "--json"], { OC_REA_NODE_VERSION: "26.13.0" })
check("oc-rea: arguments passed through unchanged",
  r.status === 0 && log().trim() === "-y rea-agents@6.8.0 analyze-javascript-application /tmp/app --json",
  `code ${r.status} | ${log().trim()}`)

resetLog()
r = run(CLI, ["--version"], { OC_REA_NODE_VERSION: "26.13.0", OC_REA_VERSION: "9.9.9-test" })
check("oc-rea: OC_REA_VERSION overrides the pin", r.status === 0 && log().trim() === "-y rea-agents@9.9.9-test --version", log().trim())

resetLog()
r = run(CLI, ["--version"], { OC_REA_NODE_VERSION: "26.13.0" })
check("oc-rea: --version output is the CLI's (not a local echo)",
  r.status === 0 && /^FAKE_NPX -y rea-agents@6\.8\.0 --version$/m.test(r.stdout), r.stdout)

// ---------- 4. MCP launcher ----------
resetLog()
r = run(MCP, [], { OC_REA_NODE_VERSION: "26.13.0" })
check("oc-rea-mcp: starts the pinned MCP command",
  r.status === 0 && log().trim() === "-y rea-agents@6.8.0 mcp", `code ${r.status} | ${log().trim()}`)

resetLog()
r = run(MCP, ["--log-level", "debug"], { OC_REA_NODE_VERSION: "26.13.0" })
check("oc-rea-mcp: arguments passed after mcp",
  r.status === 0 && log().trim() === "-y rea-agents@6.8.0 mcp --log-level debug", log().trim())

resetLog()
r = run(MCP, ["--check"], { OC_REA_NODE_VERSION: "26.13.0" })
check("oc-rea-mcp --check: exit 0 without npx", r.status === 0 && log().trim() === "", `code ${r.status} | ${log().trim()}`)

resetLog()
r = run(MCP, [], { OC_REA_NODE_VERSION: "18.0.0" })
check("oc-rea-mcp: rejects Node 18 before npx", r.status === 1 && log().trim() === "", `code ${r.status} | ${log().trim()}`)

// ---------- 5. agent, skill, config, docs ----------
const agent = read(AGENT)
check("agent: reverse-engineer present", agent.startsWith("---") && /mode: subagent/.test(agent))
check("agent: read-only and rea_* allowed", /edit: deny/.test(agent) && /"rea_\*": allow/.test(agent))
check("agent: legal scope and refusal", /Legal scope/.test(agent) && /refuse/i.test(agent))
check("agent: documents oc-rea CLI fallback", /oc-rea\b/.test(agent))

const skillFiles = ["SKILL.md", "LICENSE", "UPSTREAM.md", "references/android-applications.md",
  "references/connection-and-recovery.md", "references/environments.md", "references/evidence-workflows.md",
  "references/javascript-applications.md", "references/native-and-artifacts.md", "references/runtime-observation.md"]
const missingSkill = skillFiles.filter((f) => !fs.existsSync(path.join(SKILL, f)))
check("skill: all vendored files present", missingSkill.length === 0, `missing: ${missingSkill.join(", ")}`)
const skillMd = read(path.join(SKILL, "SKILL.md"))
check("skill: name and tool count", /^name: reverse-engineer-anything$/m.test(skillMd) && /tool_count: 229/.test(skillMd))
check("skill: MIT license", /^MIT License$/m.test(read(path.join(SKILL, "LICENSE"))))
check("skill: UPSTREAM records 6.8.0", /rea-agents@6\.8\.0/.test(read(path.join(SKILL, "UPSTREAM.md"))))

const cfg = read(path.join(ROOT, "config", "opencode.jsonc"))
check("config: rea MCP declared", /"rea": \{/.test(cfg) && /oc-rea-mcp/.test(cfg))
check("config: rea_* denied globally", /"rea_\*": "deny"/.test(cfg))

const docs = read(DOCS)
for (const [name, re] of [
  ["docs/rea.md: MIT and upstream", /MIT[\s\S]*github\.com\/morluto\/rea/],
  ["docs/rea.md: legal scope", /Legal scope/],
  ["docs/rea.md: install with reverse", /--with reverse/],
  ["docs/rea.md: Node requirement", /\^22\.23\.4 \|\| \^24\.22\.1 \|\| >=26\.12\.1/],
  ["docs/rea.md: oc-rea CLI", /`oc-rea`/],
  ["docs/rea.md: MCP and skill", /oc-rea-mcp/],
  ["docs/rea.md: optional engines", /Ghidra[\s\S]*IDA[\s\S]*Hopper/],
  ["docs/rea.md: no rea setup", /Do not run `rea setup`/],
]) check(name, re.test(docs))
check("README links docs/rea.md", /\(docs\/rea\.md\)/.test(read(path.join(ROOT, "README.md"))))
check("ROADMAP links docs/rea.md", /\(docs\/rea\.md\)/.test(read(path.join(ROOT, "ROADMAP.md"))))
check("install.sh: launcher message includes oc-rea", /oc-terraform-mcp, oc-rea, oc-rea-mcp/.test(read(path.join(ROOT, "install.sh"))))
check("uninstall.sh: removes oc-rea", /"\$BIN\/oc-rea"/.test(read(path.join(ROOT, "uninstall.sh"))))

// ---------- 6. doctor: REA section with the reverse pack selected ----------
const dHome = path.join(TMP, "doctor-home")
const dCfg = path.join(dHome, "config", "opencode")
const dBin = path.join(dHome, "bin")
const reaLog = path.join(TMP, "rea.log")
write(path.join(dBin, "oc-rea"), `#!/bin/sh
printf '%s\\n' "$*" >> "\${REA_LOG:-/dev/null}"
[ "$1" = "--version" ] && echo "6.8.0"
exit 0
`)
write(path.join(dBin, "oc-rea-mcp"), "#!/bin/sh\nexit 0\n")
fs.mkdirSync(dCfg, { recursive: true })
fs.writeFileSync(path.join(dCfg, "opencode.jsonc"), JSON.stringify({
  mcp: { servers: { rea: { type: "local", command: [path.join(dBin, "oc-rea-mcp")] } } },
}, null, 2))
fs.writeFileSync(path.join(dCfg, ".opencode-prerequisites.profile"), "profile=full\npacks=core,reverse\n")
const preload = path.join(TMP, "no-network.mjs")
fs.writeFileSync(preload, 'globalThis.fetch = () => { throw new Error("network forbidden by the test") }\n')
const doctorEnv = {
  ...baseEnv,
  HOME: dHome,
  OPENCODE_CONFIG_DIR: dCfg,
  OBSCURA_BIN_DIR: dBin,
  PATH: [dBin, nodeDir, sysDir].join(path.delimiter),
  REA_LOG: reaLog,
}
const runDoctor = (offline) => {
  fs.writeFileSync(reaLog, "")
  const env = offline
    ? { ...doctorEnv, OC_DOCTOR_OFFLINE: "1" }
    : { ...doctorEnv, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }
  return spawnSync(process.execPath, [DOCTOR], { encoding: "utf8", env, timeout: 30000 })
}

let d = runDoctor(true)
let out = d.stdout + d.stderr
check("doctor: REA section shown when the reverse pack is selected", /REA \(reverse pack\):/.test(out), out.slice(-800))
check("doctor offline: oc-rea ready", /oc-rea ready \(Node is suitable\)/.test(out))
check("doctor offline: version check skipped explicitly", /oc-rea --version not run: offline mode/.test(out))
check("doctor offline: MCP Node gate checked", /rea: Node .* suitable \(REA MCP ready\)/.test(out))
check("doctor offline: no --version call", !read(reaLog).includes("--version"), read(reaLog))

d = runDoctor(false)
out = d.stdout + d.stderr
check("doctor online: oc-rea --version result shown", /oc-rea --version: 6\.8\.0/.test(out), out.slice(-800))
check("doctor online: --version actually called", read(reaLog).includes("--version"), read(reaLog))
check("doctor online: engine absence is a warning, not an error",
  /no Ghidra\/IDA\/Hopper found/.test(out) || /native engines:/.test(out))

// Without the reverse pack, the section must stay out of the report.
fs.writeFileSync(path.join(dCfg, ".opencode-prerequisites.profile"), "profile=core\npacks=core\n")
d = runDoctor(true)
out = d.stdout + d.stderr
check("doctor: no REA section without the reverse pack", !/REA \(reverse pack\):/.test(out), out.slice(-400))

fs.rmSync(TMP, { recursive: true, force: true })
console.log(failed ? `\n❌ ${failed} check(s) failed` : `\n✅ REA integration OK (${checks} checks)`)
process.exit(failed ? 1 : 0)
