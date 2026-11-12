#!/usr/bin/env node
// Tests for profiles/packs.tsv and scripts/make-lite.mjs on a complete fake configuration:
// table well-formedness and coverage, lite/core/full/--packs/--android selection, exact agent
// list, MCP rewrite, skills/commands pruning (pack + `agent:`/`@mention`), CEO/AGENTS.md notes,
// idempotence, full no-op (byte-identical), unknown pack/profile. Fixtures under the OS tmp dir.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { parseJsonc, mcpServers } from "./lib/jsonc.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const MAKE_LITE = path.join(ROOT, "scripts/make-lite.mjs")
const TABLE = path.join(ROOT, "profiles/packs.tsv")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-litest-"))
let passed = 0, failed = 0
const check = (name, cond, detail = "") => {
  cond ? passed++ : failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`)
}
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t) }
const read = (f) => fs.readFileSync(f, "utf8")
const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : [])
const runLite = (dir, ...args) => spawnSync(process.execPath, [MAKE_LITE, dir, ...args], { encoding: "utf8" })

function treeHash(dir) {
  const files = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) files.push(p)
    }
  }
  walk(dir)
  files.sort()
  const h = crypto.createHash("sha256")
  for (const f of files) {
    h.update(path.relative(dir, f))
    h.update("\0")
    h.update(fs.readFileSync(f))
    h.update("\0")
  }
  return h.digest("hex")
}

// ---------- 0. pack table (single source of truth) ----------
const tableExists = fs.existsSync(TABLE)
check("table: profiles/packs.tsv exists", tableExists)
const tableText = tableExists ? read(TABLE) : ""
const rows = []
const tableErrors = []
for (const [index, raw] of tableText.split(/\r?\n/).entries()) {
  if (!raw.trim() || raw.trimStart().startsWith("#")) continue
  const line = index + 1
  const cols = raw.split("\t")
  if (cols.length !== 3) { tableErrors.push(`line ${line}: ${cols.length} field(s)`); continue }
  const [pack, kind, item] = cols.map((s) => s.trim())
  if (!pack || !kind || !item) { tableErrors.push(`line ${line}: empty field`); continue }
  if (!["agent", "skill", "command", "mcp"].includes(kind)) { tableErrors.push(`line ${line}: bad kind "${kind}"`); continue }
  rows.push({ pack, kind, item, line })
}
check("table: every row is pack<TAB>kind<TAB>item", tableExists && tableErrors.length === 0, tableErrors.join("; "))

const CORE_AGENTS = rows.filter((r) => r.pack === "core" && r.kind === "agent").map((r) => r.item)
const configAgents = ls(path.join(ROOT, "config/agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))
const configSkills = ls(path.join(ROOT, "config/skills"))
const listedAgents = rows.filter((r) => r.kind === "agent").map((r) => r.item)
const listedSkills = rows.filter((r) => r.kind === "skill").map((r) => r.item)
const agentCount = (name) => listedAgents.filter((a) => a === name).length
const skillCount = (name) => listedSkills.filter((s) => s === name).length
const badAgents = configAgents.filter((a) => agentCount(a) !== 1)
const badSkills = configSkills.filter((s) => skillCount(s) !== 1)
check("table: every config/agents/*.md appears exactly once", badAgents.length === 0,
  badAgents.map((a) => `${a}: ${agentCount(a)}`).join(", "))
check("table: every config/skills/* appears exactly once", badSkills.length === 0,
  badSkills.map((s) => `${s}: ${skillCount(s)}`).join(", "))
check("table: core has exactly 12 agents", CORE_AGENTS.length === 12, `${CORE_AGENTS.length}: ${CORE_AGENTS.join(", ")}`)
check("table: core/control command rows are empty (derived from `agent:`/`@mention`)",
  rows.every((r) => r.kind !== "command" || !["core", "control"].includes(r.pack)))
const rowKeys = rows.map((r) => `${r.kind}:${r.item}`)
check("table: no agent/skill/command/mcp is listed twice", new Set(rowKeys).size === rowKeys.length,
  rowKeys.filter((k, i) => rowKeys.indexOf(k) !== i).join(", "))

const kitMcp = new Set(Object.keys(mcpServers(parseJsonc(read(path.join(ROOT, "config/opencode.jsonc"))))))
const missingRows = rows.filter((r) => {
  if (r.kind === "agent") {
    return !fs.existsSync(path.join(ROOT, "config/agents", `${r.item}.md`))
      && !fs.existsSync(path.join(ROOT, "addons/android/agents", `${r.item}.md`))
  }
  if (r.kind === "skill") {
    return !fs.existsSync(path.join(ROOT, "config/skills", r.item, "SKILL.md"))
      && !fs.existsSync(path.join(ROOT, "addons/android/skills", r.item, "SKILL.md"))
  }
  if (r.kind === "command") return !fs.existsSync(path.join(ROOT, "config/commands", `${r.item}.md`))
  return !kitMcp.has(r.item)
})
check("table: every listed agent/skill/command/mcp exists in the kit", missingRows.length === 0,
  missingRows.map((r) => `line ${r.line}: ${r.kind} ${r.item}`).join("; "))

// ---------- 1. complete fake configuration ----------
const ALL_AGENTS = [...configAgents, "android", "mobile-tester"] // 28 kit agents + the 2 Android ones
const FIXTURE_SKILLS = [...new Set(rows.filter((r) => r.kind === "skill").map((r) => r.item))]
const fixtureSkills = FIXTURE_SKILLS.length ? FIXTURE_SKILLS : configSkills
const CEO = `---
description: Director (CE0): splits work and delegates.
mode: primary
---
You lead the team.

## Your team
| Specialist | When to call |
|---|---|
| \`@architect\` | design |
| \`@python\` / \`@typescript\` / \`@go\` | languages |
| \`@docker\` | containers |
| \`@review\` / \`@code-simplifier\` / \`@verify-app\` | final review |
| \`@integrator\` | merge |

Outside Rust, the prose still mentions @python: make-lite does not rewrite sentences outside tables.
`
function buildConfig(dir, { mempalace = true } = {}) {
  for (const a of ALL_AGENTS) {
    const body = a === "ceo" ? CEO : `---\ndescription: ${a}\nmode: subagent\n---\nPrompt for ${a}.\n`
    write(path.join(dir, "agents", `${a}.md`), body)
  }
  for (const s of fixtureSkills) {
    write(path.join(dir, "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: ${s}\n---\n`)
  }
  write(path.join(dir, "commands/check.md"), "Run lint, tests and build.\n")
  write(path.join(dir, "commands/learn.md"), "Add the lesson to AGENTS.md.\n")
  write(path.join(dir, "commands/plan-first.md"),
    "---\ndescription: Propose a plan.\nagent: plan\n---\nTask: $ARGUMENTS\n")
  write(path.join(dir, "commands/pr.md"), "Use @integrator in PR mode for: $ARGUMENTS\n")
  write(path.join(dir, "commands/remember.md"), "Save this in MemPalace.\n")
  write(path.join(dir, "commands/usage.md"), "---\ndescription: Usage.\nsubtask: true\n---\nStats.\n")
  write(path.join(dir, "commands/verify.md"), "Use @verify-app to check the work.\n")
  write(path.join(dir, "commands/ship.md"), "1. Use @code-simplifier.\n2. Use @verify-app.\n")
  write(path.join(dir, "commands/simplify.md"), "Use @code-simplifier on the current diff.\n")
  write(path.join(dir, "commands/impeccable.md"),
    "---\ndescription: Improve a frontend interface.\nagent: designer\n---\nUse the `impeccable` skill.\n")
  write(path.join(dir, "commands/design-review.md"),
    "---\ndescription: Review the UI implementation.\nagent: frontend\n---\nReview the UI.\n")
  write(path.join(dir, "plugins/guard/index.ts"), "export default { id: 'guard' }\n")
  write(path.join(dir, "plugins/notify/index.ts"), "export default { id: 'notify' }\n")
  if (mempalace) write(path.join(dir, "plugins/mempalace/index.ts"), "export default { id: 'mempalace' }\n")
  write(path.join(dir, "opencode.jsonc"), `{
  // Complete fake configuration: make-lite must reduce it.
  "model": "opencode-go/deepseek-v4.1-flash",
  "small_model": "opencode-go/deepseek-v4.1-flash",
  "mcp": {
    "timeout": { "startup": 120000 },
    "servers": {
      "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp" },
      "grep_app": { "type": "remote", "url": "https://mcp.grep.app" },
      "kubernetes": { "type": "local", "command": ["kubernetes-mcp-server"] },
      "obscura": { "type": "local", "command": ["obscura", "mcp"] },
      "mempalace": { "type": "local", "command": ["mempalace-mcp"] }
    }
  },
  "plugin": ["@rvboris/opencode-mempalace"],
  "plugins": ["legacy-form"]
}
`)
  write(path.join(dir, "mempalace.jsonc"), '{ "autosaveEnabled": true }\n')
  write(path.join(dir, "k8s-mcp.toml"), "[kubernetes]\n")
  write(path.join(dir, "AGENTS.md"), "# Rules\n\nInitial kit content.\n")
}

const agentNames = (dir) => ls(path.join(dir, "agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))
const skillDirs = (dir) => ls(path.join(dir, "skills")).filter((d) => fs.existsSync(path.join(dir, "skills", d, "SKILL.md")))
const commandNames = (dir) => ls(path.join(dir, "commands")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))

// ---------- 2. default (one argument) = lite: expected reduction ----------
const lite = path.join(tmp, "lite")
buildConfig(lite)
const r = runLite(lite)
const out = r.stdout + r.stderr
check("make-lite: exit code 0 on a complete config", r.status === 0, out)
check("make-lite: one argument defaults to the lite profile", /Light profile: 12 agents, MCP context7, grep_app/.test(out), out)

const agents = agentNames(lite)
check("agents: exactly 12 .md files", agents.length === 12, `${agents.length}: ${agents.join(", ")}`)
check("agents: the list is exactly the core agents of profiles/packs.tsv",
  agents.join(",") === [...CORE_AGENTS].sort().join(","), `expected ${[...CORE_AGENTS].sort().join(",")} | got ${agents.join(",")}`)
check("agents: the removed ones (python, devops, code-simplifier) are gone",
  !agents.includes("python") && !agents.includes("devops") && !agents.includes("code-simplifier"))
check("agents: the UI/UX agent is dropped from the lightweight profile", !agents.includes("designer"))
check("agents: the Android module is dropped from the lightweight profile",
  !agents.includes("android") && !agents.includes("mobile-tester"))

const cfg = parseJsonc(read(path.join(lite, "opencode.jsonc")))
const servers = mcpServers(cfg)
check("MCPs: reduced to exactly context7 + grep_app", Object.keys(servers).sort().join(",") === "context7,grep_app",
  Object.keys(servers).join(","))
check("MCPs: global timeout kept, no heavy server left",
  cfg.mcp.timeout?.startup === 120000 && !("kubernetes" in servers) && !("obscura" in servers) && !("mempalace" in servers))
check("config: no more plugin/plugins entry (npm MemPalace removed)", !("plugin" in cfg) && !("plugins" in cfg))
check("config: main model kept", cfg.model === "opencode-go/deepseek-v4.1-flash")

check("plugins: plugins/mempalace removed", !fs.existsSync(path.join(lite, "plugins/mempalace")))
check("plugins: guard and notify kept with their entry",
  fs.existsSync(path.join(lite, "plugins/guard/index.ts")) && fs.existsSync(path.join(lite, "plugins/notify/index.ts")))
check("skills: reverse-engineer-anything and android-dev removed",
  !fs.existsSync(path.join(lite, "skills/reverse-engineer-anything")) && !fs.existsSync(path.join(lite, "skills/android-dev")))
check("skills: the UI/UX skills (ui-ux-pro-max, impeccable) removed",
  !fs.existsSync(path.join(lite, "skills/ui-ux-pro-max")) && !fs.existsSync(path.join(lite, "skills/impeccable")))
check("skills: the opt-in floci skill is dropped from lite", !fs.existsSync(path.join(lite, "skills/floci")))
check("skills: exactly the 8 core skills stay",
  skillDirs(lite).length === 8 && skillDirs(lite).includes("tdd") && skillDirs(lite).includes("git-commit")
  && skillDirs(lite).includes("anti-ia-detection"), skillDirs(lite).join(", "))

check("commands: those citing a removed agent are dropped (ship, simplify)",
  !fs.existsSync(path.join(lite, "commands/ship.md")) && !fs.existsSync(path.join(lite, "commands/simplify.md")))
check("commands: those without a removed agent are kept (check, learn, plan-first, pr, remember, usage, verify)",
  ["check.md", "learn.md", "plan-first.md", "pr.md", "remember.md", "usage.md", "verify.md"]
    .every((f) => fs.existsSync(path.join(lite, "commands", f))))
check("commands: frontmatter `agent: designer` is dropped (impeccable)",
  !fs.existsSync(path.join(lite, "commands/impeccable.md")))
check("commands: frontmatter `agent:` naming a kept agent is kept (design-review)",
  fs.existsSync(path.join(lite, "commands/design-review.md")))
check("commands: content of kept commands unchanged",
  read(path.join(lite, "commands/pr.md")) === "Use @integrator in PR mode for: $ARGUMENTS\n")

const ceo = read(path.join(lite, "agents/ceo.md"))
check("CEO: the table row targeting only removed agents is dropped",
  !ceo.includes("| `@python` / `@typescript` / `@go` |") && !ceo.includes("| `@docker` |"))
check("CEO: a mixed table row (kept + removed agents) is kept",
  ceo.includes("| `@review` / `@code-simplifier` / `@verify-app` | final review |"))
check("CEO: a mention outside a table is not filtered (prose stays intact)",
  ceo.includes("Outside Rust, the prose still mentions @python: make-lite does not rewrite sentences outside tables."))
check("CEO: \"## Light profile\" section added with the 12 agents and the fallback rule",
  ceo.includes("## Light profile") && ceo.includes(`Only these agents exist: ${CORE_AGENTS.map((a) => "@" + a).join(", ")}.`)
  && ceo.includes("Never call any other name") && ceo.includes("There is no @code-simplifier"))

const agentsMd = read(path.join(lite, "AGENTS.md"))
check("AGENTS.md: original content kept and \"Light profile\" section added",
  agentsMd.startsWith("# Rules\n\nInitial kit content.\n")
  && agentsMd.includes(`## Light profile\nAvailable agents: ${CORE_AGENTS.join(", ")}. Ignore any other agent names mentioned above.`))
check("files tied to the full profile: mempalace.jsonc and k8s-mcp.toml removed",
  !fs.existsSync(path.join(lite, "mempalace.jsonc")) && !fs.existsSync(path.join(lite, "k8s-mcp.toml")))

// ---------- 3. plugins/mempalace already missing: must not fail ----------
const noMem = path.join(tmp, "no-mem")
buildConfig(noMem, { mempalace: false })
const r2 = runLite(noMem)
check("without plugins/mempalace: exit code 0", r2.status === 0, r2.stdout + r2.stderr)
check("without plugins/mempalace: guard kept, 12 agents",
  fs.existsSync(path.join(noMem, "plugins/guard/index.ts")) && agentNames(noMem).length === 12)

// ---------- 4. --profile core: same packs as lite, but no lite MCP/plugin rewrite ----------
const core = path.join(tmp, "core")
buildConfig(core)
const r3 = runLite(core, "--profile", "core")
check("core: exit code 0", r3.status === 0, r3.stdout + r3.stderr)
check("core: announces 12 agents and unchanged MCPs", /Core profile: 12 agents, MCP unchanged/.test(r3.stdout), r3.stdout)
check("core: 12 agents, 8 skills, 8 commands",
  agentNames(core).length === 12 && skillDirs(core).length === 8 && commandNames(core).length === 8,
  `${agentNames(core).length} agents, ${skillDirs(core).length} skills, ${commandNames(core).length} commands`)
const coreCfg = parseJsonc(read(path.join(core, "opencode.jsonc")))
check("core: MCPs and npm plugin untouched",
  "kubernetes" in mcpServers(coreCfg) && "mempalace" in mcpServers(coreCfg)
  && Array.isArray(coreCfg.plugin) && Array.isArray(coreCfg.plugins))
check("core: plugins/mempalace, mempalace.jsonc and k8s-mcp.toml kept",
  fs.existsSync(path.join(core, "plugins/mempalace/index.ts"))
  && fs.existsSync(path.join(core, "mempalace.jsonc")) && fs.existsSync(path.join(core, "k8s-mcp.toml")))
check("core: \"## Profile: core\" note added to CEO and AGENTS.md",
  read(path.join(core, "agents/ceo.md")).includes(`## Profile: core\nOnly these agents exist: ${CORE_AGENTS.map((a) => "@" + a).join(", ")}.`)
  && read(path.join(core, "AGENTS.md")).includes(`## Profile: core\nAvailable agents: ${CORE_AGENTS.join(", ")}.`))

// ---------- 5. core --with design (--packs adds to core) ----------
const design = path.join(tmp, "design")
buildConfig(design)
const r4 = runLite(design, "--profile", "core", "--packs", "design")
check("core+design: exit code 0", r4.status === 0, r4.stdout + r4.stderr)
check("core+design: 13 agents (designer added), 10 skills, 9 commands",
  agentNames(design).length === 13 && agentNames(design).includes("designer")
  && skillDirs(design).length === 10 && skillDirs(design).includes("ui-ux-pro-max") && skillDirs(design).includes("impeccable")
  && commandNames(design).length === 9 && fs.existsSync(path.join(design, "commands/impeccable.md")),
  `${agentNames(design).length} agents, ${skillDirs(design).length} skills, ${commandNames(design).length} commands`)
check("core+design: CEO note lists the designer too",
  read(path.join(design, "agents/ceo.md")).includes("@integrator, @designer."))
check("core+design: MCPs still untouched", "kubernetes" in mcpServers(parseJsonc(read(path.join(design, "opencode.jsonc")))))

// ---------- 5b. core --packs floci (opt-in skill pack; install.sh exposes it as --with) ----------
const flociPack = path.join(tmp, "floci-pack")
buildConfig(flociPack)
const r4c = runLite(flociPack, "--profile", "core", "--packs", "floci")
check("core --packs floci: exit 0, 12 agents, 9 skills, floci kept",
  r4c.status === 0 && agentNames(flociPack).length === 12 && skillDirs(flociPack).length === 9
  && fs.existsSync(path.join(flociPack, "skills/floci/SKILL.md")),
  `${r4c.stdout}${r4c.stderr} | ${agentNames(flociPack).length} agents, ${skillDirs(flociPack).length} skills`)

// Commands are derived from the table: no control pack = no @code-simplifier = ship/simplify dropped.
const control = path.join(tmp, "control")
buildConfig(control)
const r4b = runLite(control, "--profile", "core", "--packs", "control")
check("core+control: code-simplifier back, ship/simplify kept by the @mention rule",
  r4b.status === 0 && agentNames(control).includes("code-simplifier") && agentNames(control).length === 13
  && fs.existsSync(path.join(control, "commands/ship.md")) && fs.existsSync(path.join(control, "commands/simplify.md")),
  r4b.stdout + r4b.stderr)

// ---------- 6. --profile full: byte-identical no-op ----------
const full = path.join(tmp, "full")
buildConfig(full)
const fullBefore = treeHash(full)
const r5 = runLite(full, "--profile", "full")
check("full: exit code 0", r5.status === 0, r5.stdout + r5.stderr)
check("full: announces no change", /Full profile: no change/.test(r5.stdout), r5.stdout)
check("full: tree is byte-identical", treeHash(full) === fullBefore)

// full + explicit packs is NOT a no-op (install.sh --without path)
const fullCore = path.join(tmp, "full-core")
buildConfig(fullCore)
const r5b = runLite(fullCore, "--profile", "full", "--packs", "core")
check("full --packs core: prunes to 12 agents, MCPs untouched",
  r5b.status === 0 && agentNames(fullCore).length === 12
  && "kubernetes" in mcpServers(parseJsonc(read(path.join(fullCore, "opencode.jsonc")))), r5b.stdout + r5b.stderr)

// ---------- 7. idempotence ----------
const idem = path.join(tmp, "idem")
buildConfig(idem)
const r6 = runLite(idem)
const idemHash1 = treeHash(idem)
const r7 = runLite(idem)
const idemHash2 = treeHash(idem)
const ceoNotes = read(path.join(idem, "agents/ceo.md")).split("<!-- >>> opencode-prerequisites profile >>> -->").length - 1
const mdNotes = read(path.join(idem, "AGENTS.md")).split("<!-- >>> opencode-prerequisites profile >>> -->").length - 1
check("idempotence: second lite run exits 0", r6.status === 0 && r7.status === 0, r6.stderr + r7.stderr)
check("idempotence: second lite run is byte-identical", idemHash1 === idemHash2)
check("idempotence: the CEO/AGENTS.md note is not duplicated", ceoNotes === 1 && mdNotes === 1, `${ceoNotes}/${mdNotes}`)

// ---------- 8. errors: unknown pack/profile, android via --packs ----------
const bad = path.join(tmp, "bad")
buildConfig(bad)
const badBefore = treeHash(bad)
const r8 = runLite(bad, "--packs", "nope")
check("unknown pack: non-zero exit", r8.status !== 0, `status ${r8.status}`)
check("unknown pack: names the pack", /unknown pack "nope"/.test(r8.stderr), r8.stderr)
check("unknown pack: fails before touching the config", treeHash(bad) === badBefore)

const r9 = runLite(bad, "--profile", "nope")
check("unknown profile: non-zero exit and clear error", r9.status !== 0 && /unknown profile "nope"/.test(r9.stderr), r9.stderr)

const r10 = runLite(bad, "--packs", "android")
check("--packs android: rejected, --android is required", r10.status !== 0 && /--android, not --packs/.test(r10.stderr), r10.stderr)
check("--packs android: fails before touching the config", treeHash(bad) === badBefore)

// ---------- 8b. make-lite runtime validation on a copied kit (table errors are fatal) ----------
const kit = path.join(tmp, "kit")
fs.mkdirSync(path.join(kit, "scripts/lib"), { recursive: true })
fs.copyFileSync(MAKE_LITE, path.join(kit, "scripts/make-lite.mjs"))
fs.copyFileSync(path.join(ROOT, "scripts/lib/jsonc.mjs"), path.join(kit, "scripts/lib/jsonc.mjs"))
fs.cpSync(path.join(ROOT, "profiles"), path.join(kit, "profiles"), { recursive: true })
fs.cpSync(path.join(ROOT, "config"), path.join(kit, "config"), { recursive: true })
fs.cpSync(path.join(ROOT, "addons/android"), path.join(kit, "addons/android"), { recursive: true })
const kitDest = path.join(kit, "dest")
fs.cpSync(path.join(ROOT, "config"), kitDest, { recursive: true })
const goodTable = read(path.join(kit, "profiles/packs.tsv"))
const runKit = () => spawnSync(process.execPath, [path.join(kit, "scripts/make-lite.mjs"), kitDest], { encoding: "utf8" })

write(path.join(kit, "profiles/packs.tsv"), goodTable + "core\tagent\n")
const rBadTable = runKit()
check("table validation: a row without 3 tab fields is rejected",
  rBadTable.status !== 0 && /expected pack<TAB>kind<TAB>item/.test(rBadTable.stderr), rBadTable.stderr)

write(path.join(kit, "profiles/packs.tsv"), goodTable + "core\tagent\tghost\n")
const rGhost = runKit()
check("table validation: a listed file missing from the kit is rejected",
  rGhost.status !== 0 && /agent "ghost" does not exist in the kit/.test(rGhost.stderr), rGhost.stderr)

write(path.join(kit, "profiles/packs.tsv"), goodTable)
const rGood = runKit()
check("table validation: the restored table runs again", rGood.status === 0, rGood.stdout + rGood.stderr)

// ---------- 9. --android: android pack selected ----------
const android = path.join(tmp, "android")
buildConfig(android)
const r11 = runLite(android, "--android")
check("lite --android: exit code 0 and 14 agents", r11.status === 0 && agentNames(android).length === 14, r11.stdout + r11.stderr)
check("lite --android: android and mobile-tester kept, android-dev skill kept",
  agentNames(android).includes("android") && agentNames(android).includes("mobile-tester")
  && fs.existsSync(path.join(android, "skills/android-dev/SKILL.md")))
check("lite --android: designer and ui-ux skills still dropped",
  !agentNames(android).includes("designer") && !fs.existsSync(path.join(android, "skills/ui-ux-pro-max")))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n❌ ${failed} check(s) failed` : `\n✅ make-lite OK (${passed} checks)`)
process.exit(failed ? 1 : 0)
