#!/usr/bin/env node
// Hermetic tests for the vendored security-audit skill, the /audit command and the
// core code-mode skill: pack rows, frontmatter, provenance, no network primitive in
// the vendored text, and the upstream `node --test` validator suites on nominal and
// invalid fixtures. No network, no installer, no write outside a /tmp fixture.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { frontmatter } from "./lib/jsonc.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SKILLS = path.join(ROOT, "config/skills")
const AUDIT = path.join(SKILLS, "security-audit")
const CODE_MODE = path.join(SKILLS, "code-mode")
const COMMAND = path.join(ROOT, "config/commands/audit.md")
const TABLE = path.join(ROOT, "profiles/packs.tsv")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-audittest-"))
const env = { ...process.env, NO_COLOR: "1" }
const read = (f) => fs.readFileSync(f, "utf8")
const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : [])
const walk = (d) => ls(d).flatMap((x) => {
  const p = path.join(d, x)
  return fs.lstatSync(p).isDirectory() ? walk(p) : [p]
})
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 180000, env, ...opts })
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
  const hasRow = (pack, kind, item) => rows.some(([p, k, i]) => p === pack && k === kind && i === item)
  const rowsOf = (pack) => rows.filter(([p]) => p === pack)

  check("packs: audit → skill security-audit", hasRow("audit", "skill", "security-audit"))
  check("packs: audit → command audit", hasRow("audit", "command", "audit"))
  check("packs: core → skill code-mode", hasRow("core", "skill", "code-mode"))
  check("packs: audit adds no agent and no MCP",
    rowsOf("audit").every(([, kind]) => kind === "skill" || kind === "command"), rowsOf("audit").map((r) => r.join(":")).join(" "))
  check("packs: core and audit are disjoint (opt-in pack)",
    !rowsOf("core").some(([, , item]) => item === "security-audit" || item === "audit"))
  check("packs: every listed audit/core item exists in the kit",
    hasRow("audit", "skill", "security-audit") && fs.existsSync(path.join(AUDIT, "SKILL.md"))
    && hasRow("audit", "command", "audit") && fs.existsSync(COMMAND)
    && hasRow("core", "skill", "code-mode") && fs.existsSync(path.join(CODE_MODE, "SKILL.md")))

  // ---------- 2. frontmatter ----------
  for (const [name, dir] of [["security-audit", AUDIT], ["code-mode", CODE_MODE]]) {
    const md = read(path.join(dir, "SKILL.md"))
    const fm = frontmatter(md)
    check(`${name}: frontmatter present`, !!fm)
    check(`${name}: name matches the directory`, fm?.name === name, fm ? `name=${fm.name}` : "none")
    check(`${name}: description present and <= 1024 chars`,
      !!fm?.description && fm.description.length <= 1024, fm ? `${fm.description.length} chars` : "none")
    check(`${name}: non-empty body`, !!md.split(/^---$/m)[2]?.trim())
    check(`${name}: LICENSE and UPSTREAM.md present`,
      fs.existsSync(path.join(dir, "LICENSE")) && fs.existsSync(path.join(dir, "UPSTREAM.md")))
  }

  // ---------- 3. provenance ----------
  const license = read(path.join(AUDIT, "LICENSE"))
  check("security-audit: LICENSE is MIT", /^MIT License/m.test(license))
  check("security-audit: LICENSE keeps Cloudflare's copyright",
    /Cloudflare, Inc\./.test(license), license.slice(0, 160))
  const upstream = read(path.join(AUDIT, "UPSTREAM.md"))
  check("security-audit: UPSTREAM records commit c1c8a8c",
    upstream.includes("c1c8a8c") && /c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/.test(upstream))
  check("security-audit: UPSTREAM records the repository and MIT license",
    upstream.includes("cloudflare/security-audit-skill") && /MIT/.test(upstream))
  check("security-audit: upstream validators and schema kept",
    ["validate-findings.cjs", "validate-coverage-ledger.cjs", "report-schema.json"]
      .every((f) => fs.existsSync(path.join(AUDIT, f))))
  check("security-audit: the three KIT-*.md adaptations present",
    ["KIT-ENVIRONMENT.md", "KIT-TOOLING.md", "KIT-REPORTING.md"]
      .every((f) => fs.existsSync(path.join(AUDIT, f))))

  // ---------- 4. no network primitive in the vendored text ----------
  // UPSTREAM.md (source URLs) and KIT-*.md (kit instructions, quoting tools) are the
  // normalisation layer, not vendored upstream text: the upstream files must be inert.
  const NETWORK = /curl|wget|http:\/\/|fetch\(/
  const networkFiles = walk(AUDIT)
    .filter((f) => /\.(?:md|json|cjs)$/.test(f))
    .filter((f) => !/(?:^|\/)(?:UPSTREAM|KIT-[^/]+)\.md$/.test(f))
  const hits = networkFiles.filter((f) => NETWORK.test(read(f))).map((f) => path.relative(AUDIT, f))
  check("security-audit: no curl/wget/http/fetch( in the vendored files",
    hits.length === 0, hits.join(", "))
  const codeMode = read(path.join(CODE_MODE, "SKILL.md"))
  check("code-mode: documents the sandbox and secret limits",
    /sandbox/i.test(codeMode) && /oc-secrets/.test(codeMode))

  // ---------- 5. validators: upstream node --test suites ----------
  const suites = ["validate-findings.test.cjs", "validate-coverage-ledger.test.cjs"]
    .map((f) => path.join(AUDIT, f))
  check("validators: both upstream test suites present", suites.every(fs.existsSync))
  const suiteRun = run(process.execPath, ["--test", ...suites], { cwd: ROOT })
  const suiteOut = suiteRun.stdout + suiteRun.stderr
  const suiteNum = (what) => Number(new RegExp(`^(?:#|ℹ)\\s*${what}\\s+(\\d+)`, "m").exec(suiteOut)?.[1] ?? -1)
  check("validators: node --test exits 0", suiteRun.status === 0,
    suiteOut.split("\n").filter((l) => /not ok|✖|fail/.test(l)).slice(0, 5).join(" | "))
  check("validators: at least 65 upstream tests pass",
    suiteNum("tests") >= 65 && suiteNum("pass") >= 65 && suiteNum("fail") === 0,
    `tests=${suiteNum("tests")} pass=${suiteNum("pass")} fail=${suiteNum("fail")} skipped=${suiteNum("skipped")}`)

  // ---------- 6. validators: CLI on nominal and invalid fixtures ----------
  const writeFixture = (name, value) => {
    const f = path.join(tmp, name)
    fs.writeFileSync(f, typeof value === "string" ? value : JSON.stringify(value))
    return f
  }
  const cli = (script, fixture) => run(process.execPath, [path.join(AUDIT, script), fixture], { cwd: tmp })

  const emptyFindings = writeFixture("findings-empty.json", [])
  const emptyLedger = writeFixture("ledger-empty.json", [])
  const badFindings = writeFixture("findings-bad.json", [{ verdict: "bogus" }])
  const badLedger = writeFixture("ledger-bad.json", {})
  const nominalFindings = cli("validate-findings.cjs", emptyFindings)
  const nominalLedger = cli("validate-coverage-ledger.cjs", emptyLedger)
  check("validate-findings: nominal [] exits 0 with PASS",
    nominalFindings.status === 0 && /PASS: 0 findings valid/.test(nominalFindings.stdout),
    nominalFindings.stdout + nominalFindings.stderr)
  check("validate-coverage-ledger: nominal [] exits 0 with PASS",
    nominalLedger.status === 0 && /PASS: 0 coverage units valid/.test(nominalLedger.stdout),
    nominalLedger.stdout + nominalLedger.stderr)
  const rejectedFindings = cli("validate-findings.cjs", badFindings)
  const rejectedLedger = cli("validate-coverage-ledger.cjs", badLedger)
  check("validate-findings: invalid verdict exits non-zero without a stack trace",
    rejectedFindings.status !== 0 && /FAIL/.test(rejectedFindings.stdout + rejectedFindings.stderr)
    && !/at Object\.|TypeError|ReferenceError/.test(rejectedFindings.stdout + rejectedFindings.stderr),
    rejectedFindings.stdout + rejectedFindings.stderr)
  check("validate-coverage-ledger: non-array exits non-zero without a stack trace",
    rejectedLedger.status !== 0 && /FAIL/.test(rejectedLedger.stdout + rejectedLedger.stderr)
    && !/at Object\.|TypeError|ReferenceError/.test(rejectedLedger.stdout + rejectedLedger.stderr),
    rejectedLedger.stdout + rejectedLedger.stderr)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n❌ ${failed} check(s) failed` : `\n✅ security-audit skill OK (${passed} checks)`)

process.exit(failed ? 1 : 0)
