#!/usr/bin/env node
// Tests for the lightweight profile (scripts/make-lite.mjs) on a complete fake configuration:
// 12 exact agents, MCPs reduced to context7 + grep_app, skills and commands tied to removed
// agents dropped, guard/notify plugins kept, mempalace removed, CEO/AGENTS.md annotated,
// plus the case where plugins/mempalace is already missing (must not fail). Fixtures under /tmp.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { parseJsonc, mcpServers } from "./lib/jsonc.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const MAKE_LITE = path.join(ROOT, "scripts/make-lite.mjs")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-litest-"))
let passed = 0, failed = 0
const check = (name, cond, detail = "") => {
  cond ? passed++ : failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`)
}
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t) }
const read = (f) => fs.readFileSync(f, "utf8")
const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : [])
const runLite = (dir) => spawnSync(process.execPath, [MAKE_LITE, dir], { encoding: "utf8" })

const KEEP = read(path.join(ROOT, "profiles/lite-agents.txt"))
  .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
// 27 kit agents + the 2 from the Android module: the lightweight profile must keep only 12.
const ALL_AGENTS = ["ansible", "architect", "backend", "ceo", "code-simplifier", "database", "debugger", "devops",
  "docker", "docs", "frontend", "go", "integrator", "kubernetes", "pentest", "python", "qa", "researcher",
  "reverse-engineer", "review", "rust", "security", "shell", "terraform", "typescript", "verify-app",
  "web-researcher", "android", "mobile-tester"]
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
  for (const s of ["git-commit", "grill-me", "handoff", "project-onboarding", "reverse-engineer-anything",
    "safe-refactor", "tdd", "web-research", "android-dev"]) {
    write(path.join(dir, "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: ${s}\n---\n`)
  }
  write(path.join(dir, "commands/check.md"), "Run lint, tests and build.\n")
  write(path.join(dir, "commands/pr.md"), "Use @integrator in PR mode for: $ARGUMENTS\n")
  write(path.join(dir, "commands/verify.md"), "Use @verify-app to check the work.\n")
  write(path.join(dir, "commands/ship.md"), "1. Use @code-simplifier.\n2. Use @verify-app.\n")
  write(path.join(dir, "commands/simplify.md"), "Use @code-simplifier on the current diff.\n")
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

// ---------- 1. complete configuration: expected reduction ----------
const full = path.join(tmp, "full")
buildConfig(full)
const r = runLite(full)
const out = r.stdout + r.stderr
check("make-lite: exit code 0 on a complete config", r.status === 0, out)
check("make-lite: announces 12 agents and the 2 MCPs", /Light profile: 12 agents, MCP context7, grep_app/.test(out), out)

const agents = ls(path.join(full, "agents"))
check("agents: exactly 12 .md files", agents.length === 12, `${agents.length}: ${agents.join(", ")}`)
check("agents: the list is exactly profiles/lite-agents.txt", KEEP.length === 12 && agents.map((f) => f.slice(0, -3)).join(",") === [...KEEP].sort().join(","),
  `expected ${[...KEEP].sort().join(",")} | got ${agents.join(",")}`)
check("agents: the removed ones (python, devops, code-simplifier) are gone",
  !agents.includes("python.md") && !agents.includes("devops.md") && !agents.includes("code-simplifier.md"))
check("agents: the Android module is dropped from the lightweight profile",
  !agents.includes("android.md") && !agents.includes("mobile-tester.md"))

const cfg = parseJsonc(read(path.join(full, "opencode.jsonc")))
const servers = mcpServers(cfg)
check("MCPs: reduced to exactly context7 + grep_app", Object.keys(servers).sort().join(",") === "context7,grep_app",
  Object.keys(servers).join(","))
check("MCPs: global timeout kept, no heavy server left",
  cfg.mcp.timeout?.startup === 120000 && !("kubernetes" in servers) && !("obscura" in servers) && !("mempalace" in servers))
check("config: no more plugin/plugins entry (npm MemPalace removed)", !("plugin" in cfg) && !("plugins" in cfg))
check("config: main model kept", cfg.model === "opencode-go/deepseek-v4.1-flash")

check("plugins: plugins/mempalace removed", !fs.existsSync(path.join(full, "plugins/mempalace")))
check("plugins: guard and notify kept with their entry",
  fs.existsSync(path.join(full, "plugins/guard/index.ts")) && fs.existsSync(path.join(full, "plugins/notify/index.ts")))
check("skills: reverse-engineer-anything and android-dev removed",
  !fs.existsSync(path.join(full, "skills/reverse-engineer-anything")) && !fs.existsSync(path.join(full, "skills/android-dev")))
check("skills: the others stay (tdd, git-commit)", fs.existsSync(path.join(full, "skills/tdd/SKILL.md")) && fs.existsSync(path.join(full, "skills/git-commit/SKILL.md")))

check("commands: those citing a removed agent are dropped (ship, simplify)",
  !fs.existsSync(path.join(full, "commands/ship.md")) && !fs.existsSync(path.join(full, "commands/simplify.md")))
check("commands: those without a removed agent are kept (check, pr, verify)",
  ["check.md", "pr.md", "verify.md"].every((f) => fs.existsSync(path.join(full, "commands", f))))
check("commands: content of kept commands unchanged",
  read(path.join(full, "commands/pr.md")) === "Use @integrator in PR mode for: $ARGUMENTS\n")

const ceo = read(path.join(full, "agents/ceo.md"))
check("CEO: the table row targeting only removed agents is dropped",
  !ceo.includes("| `@python` / `@typescript` / `@go` |") && !ceo.includes("| `@docker` |"))
check("CEO: a mixed table row (kept + removed agents) is kept",
  ceo.includes("| `@review` / `@code-simplifier` / `@verify-app` | final review |"))
check("CEO: a mention outside a table is not filtered (prose stays intact)",
  ceo.includes("Outside Rust, the prose still mentions @python: make-lite does not rewrite sentences outside tables."))
check("CEO: \"## Light profile\" section added with the 12 agents and the fallback rule",
  ceo.includes("## Light profile") && ceo.includes(`Only these agents exist: ${KEEP.map((a) => "@" + a).join(", ")}.`)
  && ceo.includes("Never call any other name") && ceo.includes("There is no @code-simplifier"))

const agentsMd = read(path.join(full, "AGENTS.md"))
check("AGENTS.md: original content kept and \"Light profile\" section added",
  agentsMd.startsWith("# Rules\n\nInitial kit content.\n")
  && agentsMd.includes(`## Light profile\nAvailable agents: ${KEEP.join(", ")}. Ignore any other agent names mentioned above.`))
check("files tied to the full profile: mempalace.jsonc and k8s-mcp.toml removed",
  !fs.existsSync(path.join(full, "mempalace.jsonc")) && !fs.existsSync(path.join(full, "k8s-mcp.toml")))

// ---------- 2. plugins/mempalace already missing: must not fail ----------
const noMem = path.join(tmp, "no-mem")
buildConfig(noMem, { mempalace: false })
const r2 = runLite(noMem)
check("without plugins/mempalace: exit code 0", r2.status === 0, r2.stdout + r2.stderr)
check("without plugins/mempalace: guard kept, 12 agents",
  fs.existsSync(path.join(noMem, "plugins/guard/index.ts")) && ls(path.join(noMem, "agents")).length === 12)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n❌ ${failed} check(s) failed` : `\n✅ make-lite OK (${passed} checks)`)
process.exit(failed ? 1 : 0)
