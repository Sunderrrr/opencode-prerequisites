#!/usr/bin/env node
// Hermetic tests for the vendored Matt Pocock architecture quartet, its
// `architecture` pack and the `/architecture` command: pack rows, frontmatter,
// LICENSE/UPSTREAM provenance, no executable or network primitive in the vendored
// text, `$ARGUMENTS` in the command, and make-lite keeping the pack. No network, no
// installer, no write outside a /tmp fixture.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { frontmatter } from "./lib/jsonc.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SKILLS = path.join(ROOT, "config/skills")
const COMMAND = path.join(ROOT, "config/commands/architecture.md")
const TABLE = path.join(ROOT, "profiles/packs.tsv")
// Upstream commit per skill. The files are vendored individually, so each skill records
// the commit its files were taken from: only domain-modeling moved past abeeaf9 (upstream
// changed its GLOSSARY-FORMAT.md); the other three are unchanged there.
const UPSTREAM_SHA = {
  "improve-codebase-architecture": "abeeaf95660ba9e8b7c753eb38f441ca707a8823",
  "codebase-design": "abeeaf95660ba9e8b7c753eb38f441ca707a8823",
  "grilling": "abeeaf95660ba9e8b7c753eb38f441ca707a8823",
  "domain-modeling": "bbadaa631c37af594e5a05c9cefacd9956136b18",
}
// The quartet: upstream skill name => directory under config/skills.
const QUARTET = [
  "improve-codebase-architecture",
  "codebase-design",
  "grilling",
  "domain-modeling",
]
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archtest-"))
const read = (f) => fs.readFileSync(f, "utf8")
const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : [])
const walk = (d) => ls(d).flatMap((x) => {
  const p = path.join(d, x)
  return fs.lstatSync(p).isDirectory() ? walk(p) : [p]
})
let passed = 0, failed = 0
const check = (name, cond, detail = "") => {
  cond ? passed++ : failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`)
}

try {
  // ---------- 1. pack table ----------
  const rows = read(TABLE).split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("\t"))
    .filter((fields) => fields.length === 3)
  const rowsOf = (pack) => rows.filter(([p]) => p === pack)
  const hasRow = (pack, kind, item) => rows.some(([p, k, i]) => p === pack && k === kind && i === item)

  check("packs: architecture has exactly 4 skills + 1 command",
    rowsOf("architecture").length === 5, rowsOf("architecture").map((r) => r.join(":")).join(" "))
  for (const skill of QUARTET) {
    check(`packs: architecture → skill ${skill}`, hasRow("architecture", "skill", skill))
  }
  check("packs: architecture → command architecture", hasRow("architecture", "command", "architecture"))
  check("packs: architecture adds no agent and no MCP",
    rowsOf("architecture").every(([, kind]) => kind === "skill" || kind === "command"),
    rowsOf("architecture").map((r) => r.join(":")).join(" "))
  check("packs: architecture is disjoint from core (opt-in pack)",
    !rowsOf("core").some(([, , item]) => item === "architecture" || QUARTET.includes(item)))
  check("packs: every listed architecture item exists in the kit",
    QUARTET.every((s) => fs.existsSync(path.join(SKILLS, s, "SKILL.md"))) && fs.existsSync(COMMAND))

  // ---------- 2. skills: frontmatter, LICENSE, provenance ----------
  for (const skill of QUARTET) {
    const dir = path.join(SKILLS, skill)
    const md = read(path.join(dir, "SKILL.md"))
    const fm = frontmatter(md)
    check(`${skill}: SKILL.md present`, fs.existsSync(path.join(dir, "SKILL.md")))
    check(`${skill}: name matches the directory`, fm?.name === skill, fm ? `name=${fm.name}` : "no frontmatter")
    check(`${skill}: description present and <= 1024 chars`,
      !!fm?.description && fm.description.length <= 1024, fm ? `${fm.description.length} chars` : "none")
    check(`${skill}: LICENSE present and MIT`,
      fs.existsSync(path.join(dir, "LICENSE")) && /^MIT License/m.test(read(path.join(dir, "LICENSE"))))
    const upstream = fs.existsSync(path.join(dir, "UPSTREAM.md")) ? read(path.join(dir, "UPSTREAM.md")) : ""
    const sha = UPSTREAM_SHA[skill] ?? ""
    check(`${skill}: UPSTREAM records commit ${sha.slice(0, 7)}`,
      !!sha && upstream.includes(sha) && upstream.includes("mattpocock/skills") && /MIT/.test(upstream))
  }

  // ---------- 3. model invocation and inert vendored text ----------
  const improve = read(path.join(SKILLS, "improve-codebase-architecture/SKILL.md"))
  check("improve-codebase-architecture: no disable-model-invocation (model-invocable)",
    !/disable-model-invocation/.test(improve), "frontmatter still hides the skill from automatic selection")
  const files = QUARTET.flatMap((s) => walk(path.join(SKILLS, s)))
  const executables = files.filter((f) => (fs.statSync(f).mode & 0o111) !== 0)
  check("quartet: no executable file", executables.length === 0,
    executables.map((f) => path.relative(ROOT, f)).join(", "))
  const network = files.filter((f) => /\b(?:curl|wget)\b/.test(read(f)))
  check("quartet: no curl/wget in the vendored text", network.length === 0,
    network.map((f) => path.relative(ROOT, f)).join(", "))

  // ---------- 4. /architecture command ----------
  const command = fs.existsSync(COMMAND) ? read(COMMAND) : ""
  check("command /architecture contains $ARGUMENTS", command.includes("$ARGUMENTS"))

  // ---------- 5. make-lite keeps core+architecture and drops design ----------
  const dest = path.join(tmp, "cfg")
  fs.cpSync(path.join(ROOT, "config"), dest, { recursive: true })
  const run = spawnSync(process.execPath, [path.join(ROOT, "scripts/make-lite.mjs"), dest,
    "--profile", "core", "--packs", "core,architecture"], { encoding: "utf8", timeout: 180000 })
  const out = run.stdout + run.stderr
  const keptSkills = QUARTET.every((s) => fs.existsSync(path.join(dest, "skills", s, "SKILL.md")))
  const designDropped = !fs.existsSync(path.join(dest, "skills", "ui-ux-pro-max"))
    && !fs.existsSync(path.join(dest, "skills", "impeccable"))
  check("make-lite core+architecture: keeps the quartet and /architecture, drops design",
    run.status === 0 && keptSkills && fs.existsSync(path.join(dest, "commands/architecture.md")) && designDropped, out)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n❌ ${failed} check(s) failed` : `\n✅ architecture skill OK (${passed} checks)`)

process.exit(failed ? 1 : 0)
