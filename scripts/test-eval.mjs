#!/usr/bin/env node
// Hermetic tests for scripts/eval.mjs: temp fixtures, a fake opencode binary,
// no network and no model call.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EVAL = path.join(ROOT, "scripts", "eval.mjs")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oc-eval-test-"))
const RESULTS = path.join(TMP, "results")
const TASKS = path.join(TMP, "tasks")
const FIXTURES = path.join(TMP, "fixtures")
const FAKE = path.join(TMP, "fake-opencode.mjs")

let checks = 0
let failed = 0
const check = (name, condition, detail = "") => {
  checks++
  if (!condition) failed++
  console.log(`${condition ? "✅" : "❌"} ${name}${condition || !detail ? "" : ` — ${detail}`}`)
}
const json = (text) => { try { return JSON.parse(text) } catch { return null } }
const exists = (file) => fs.existsSync(file)
const read = (file) => fs.readFileSync(file, "utf8")
const rm = (target) => fs.rmSync(target, { recursive: true, force: true })

const baseEnv = { ...process.env }
for (const key of ["EVAL_OPENCODE", "EVAL_TASKS_DIR", "EVAL_FIXTURES_DIR", "EVAL_RESULTS_DIR", "FAKE_MODE", "FAKE_LOG"]) delete baseEnv[key]
const run = (args, env = {}) => {
  const merged = { ...baseEnv, EVAL_OPENCODE: FAKE, EVAL_RESULTS_DIR: RESULTS, ...env }
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key]
  return spawnSync(process.execPath, [EVAL, ...args], { encoding: "utf8", timeout: 120_000, env: merged })
}

// Fake CLI: behaves like a successful/failing/timing-out agent and writes the
// files the real fixtures need. It never touches the network or a model.
const fakeSource = String.raw`#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const args = process.argv.slice(2)
const mode = process.env.FAKE_MODE || "pass"
if (process.env.FAKE_LOG) {
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ args, cwd: process.cwd() }, null, 2))
}
if (args.includes("--version")) {
  console.log("fake-opencode 0.0.0")
  process.exit(0)
}
if (mode === "timeout") {
  setTimeout(() => {}, 60000)
} else {
  const cwd = process.cwd()
  if (mode === "pass" || mode === "json" || mode === "crash") {
    if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
      fs.mkdirSync(path.join(cwd, "src"), { recursive: true })
      fs.mkdirSync(path.join(cwd, "tests"), { recursive: true })
      fs.writeFileSync(path.join(cwd, "src", "lib.rs"), "pub fn greeting(name: &str) -> String {\n    format!(\"Hello, {name}!\")\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn greets() {\n        assert_eq!(greeting(\"Ada\"), \"Hello, Ada!\");\n    }\n}\n")
      fs.writeFileSync(path.join(cwd, "src", "main.rs"), "fn main() {\n    let name = std::env::args().nth(1).unwrap_or_else(|| \"world\".to_string());\n    println!(\"{}\", greet_cli::greeting(&name));\n}\n")
      fs.writeFileSync(path.join(cwd, "tests", "smoke.rs"), "use greet_cli::greeting;\n\n#[test]\nfn greets() {\n    assert_eq!(greeting(\"Ada\"), \"Hello, Ada!\");\n}\n")
    } else if (fs.existsSync(path.join(cwd, "package.json"))) {
      fs.writeFileSync(path.join(cwd, "src", "sum.js"), "export function sum(values) {\n  return values.reduce((total, value) => total + value, 0)\n}\n")
    } else {
      fs.writeFileSync(path.join(cwd, "index.html"), "<!doctype html>\n<html lang=\"en\">\n<head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Demo</title></head>\n<body><h1>Hello</h1><button aria-label=\"Say hello\">Say hello</button></body>\n</html>\n")
    }
  }
  if (mode === "json" || mode === "pass") {
    console.log(JSON.stringify({ type: "step_finish", part: { cost: 0.00123, tokens: { input: 120, output: 45 } } }))
    console.log(JSON.stringify({ type: "text", part: { text: "fake agent done" } }))
  }
  if (mode === "crash") process.exit(3)
}
`

function writeTask(name, task) {
  fs.mkdirSync(TASKS, { recursive: true })
  fs.writeFileSync(path.join(TASKS, `${name}.json`), `${JSON.stringify(task, null, 2)}\n`)
}

const baseTask = (name, fixture = "timeout") => ({
  name,
  prompt: "Test fixture: do nothing.",
  fixture,
  timeout: 10,
  checks: [{ name: "noop", command: process.execPath, args: ["-e", "process.exit(0)"] }],
})

try {
  fs.mkdirSync(FIXTURES, { recursive: true })
  fs.mkdirSync(path.join(FIXTURES, "timeout"), { recursive: true })
  fs.writeFileSync(path.join(FIXTURES, "timeout", "keep.txt"), "fixture\n")
  fs.writeFileSync(FAKE, fakeSource)
  fs.chmodSync(FAKE, 0o755)
  check("fake opencode binary is executable", exists(FAKE))

  // --- real tasks: schema and dry-run ---
  for (const name of ["rust-cli", "web-ui", "bugfix"]) {
    const r = run(["--task", name, "--dry-run", "--json"])
    const plan = json(r.stdout)
    check(`dry-run ${name}: exit 0`, r.status === 0, r.stderr)
    check(`dry-run ${name}: valid plan`, plan?.dryRun === true && plan.task === name && plan.checks.length > 0, r.stdout)
  }

  const dryLog = path.join(TMP, "dry.log")
  const dry = run(["--task", "bugfix", "--dry-run", "--json"], { FAKE_LOG: dryLog })
  check("dry-run: does not call opencode", !exists(dryLog))
  check("dry-run: does not write results", !exists(RESULTS) || fs.readdirSync(RESULTS).length === 0)
  const dryPlan = json(dry.stdout)
  check("dry-run: default agent is ceo", dryPlan?.agent === "ceo")
  check("dry-run: model is unset by default", dryPlan?.model === null)
  check("dry-run: checks are listed", dryPlan?.checks?.[0]?.command === "node")

  // --- CLI errors ---
  let r = run(["--task", "nope", "--dry-run"])
  check("unknown task: exit 2", r.status === 2, `status=${r.status}`)
  check("unknown task: message", /unknown task/.test(r.stderr), r.stderr)
  r = run(["--dry-run"])
  check("missing --task: exit 2", r.status === 2, `status=${r.status}`)
  r = run(["--task", "bugfix", "--dry-run", "--bogus"])
  check("unknown flag: exit 2", r.status === 2 && /unknown argument/.test(r.stderr), r.stderr)
  r = run(["--task", "../bugfix", "--dry-run"])
  check("invalid task name: exit 2", r.status === 2 && /invalid task name/.test(r.stderr), r.stderr)

  // --- schema validation ---
  const invalid = [
    ["bad-missing-prompt", (t) => { delete t.prompt }, "prompt"],
    ["bad-fixture", (t) => { t.fixture = "does-not-exist" }, "fixture directory not found"],
    ["bad-checks", (t) => { t.checks = [] }, "checks must be a non-empty array"],
    ["bad-timeout", (t) => { t.timeout = 0 }, "timeout must be"],
    ["bad-name", (t) => { t.name = "other-name" }, "must match the file name"],
    ["bad-args", (t) => { t.checks[0].args = "nope" }, "args must be an array of strings"],
    ["bad-check-timeout", (t) => { t.checks[0].timeout = 0 }, "checks[0].timeout must be"],
  ]
  for (const [name, mutate, expected] of invalid) {
    const task = baseTask(name)
    mutate(task)
    writeTask(name, task)
    const bad = run(["--task", name, "--dry-run"], { EVAL_TASKS_DIR: TASKS, EVAL_FIXTURES_DIR: FIXTURES })
    check(`schema ${name}: rejected`, bad.status === 2 && bad.stderr.includes(expected), bad.stderr.slice(0, 300))
  }
  writeTask("timeout", baseTask("timeout"))
  writeTask("check-timeout", {
    ...baseTask("check-timeout"),
    timeout: 30,
    checks: [{ name: "hang", command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"], timeout: 1 }],
  })

  // --- PASS: fake agent fixes the bugfix fixture ---
  rm(RESULTS)
  const passLog = path.join(TMP, "pass.log")
  r = run(["--task", "bugfix", "--agent", "debugger", "--model", "test/model", "--json"], { FAKE_MODE: "pass", FAKE_LOG: passLog })
  let result = json(r.stdout)
  check("pass: exit 0", r.status === 0, r.stderr)
  check("pass: overall PASS", result?.pass === true)
  check("pass: check passed", result?.checks?.length === 1 && result.checks[0].pass === true)
  check("pass: check output captured", /pass 3/.test(result?.checks?.[0]?.stdout ?? ""))
  check("pass: usage cost parsed", result?.agentRun?.usage?.cost === 0.00123, JSON.stringify(result?.agentRun?.usage))
  check("pass: usage tokens parsed", result?.agentRun?.usage?.tokens?.input === 120 && result?.agentRun?.usage?.tokens?.output === 45)
  check("pass: result JSON written", exists(result?.resultFiles?.json))
  check("pass: result Markdown written", exists(result?.resultFiles?.markdown))
  check("pass: Markdown says PASS", /PASS/.test(read(result?.resultFiles?.markdown ?? "")))
  const passArgs = json(read(passLog))?.args ?? []
  check("pass: --agent forwarded", passArgs.includes("--agent") && passArgs.includes("debugger"))
  check("pass: --model forwarded", passArgs.includes("--model") && passArgs.includes("test/model"))
  check("pass: prompt forwarded", passArgs.includes("The Node test suite in this project fails. Fix the bug in `src/sum.js` so that `node --test` passes. Do not modify the test files. Run `node --test` to verify.\n\nWork only in the current directory. Do not commit and do not ask questions."))
  const passCwd = json(read(passLog))?.cwd
  check("pass: runs in a temp copy", passCwd && passCwd !== path.join(ROOT, "evals", "fixtures", "bugfix") && passCwd.includes("oc-eval-bugfix"))
  const resultFiles = fs.readdirSync(RESULTS).filter((f) => f.endsWith(".json"))
  check("pass: timestamped result file", resultFiles.every((f) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?\.json$/.test(f)), resultFiles.join(", "))

  // --- FAIL: the agent leaves the fixture broken ---
  rm(RESULTS)
  r = run(["--task", "bugfix", "--json"], { FAKE_MODE: "fail" })
  result = json(r.stdout)
  check("fail: exit 1", r.status === 1, `status=${r.status}`)
  check("fail: overall FAIL", result?.pass === false)
  check("fail: check failed", result?.checks?.[0]?.pass === false)
  check("fail: result still written", exists(result?.resultFiles?.json))
  check("fail: Markdown says FAIL", /FAIL/.test(read(result?.resultFiles?.markdown ?? "")))

  // --- web-ui PASS and FAIL ---
  rm(RESULTS)
  r = run(["--task", "web-ui", "--json"], { FAKE_MODE: "pass" })
  result = json(r.stdout)
  check("web-ui pass: exit 0", r.status === 0, r.stderr)
  check("web-ui pass: 3 checks", result?.pass === true && result.checks.length === 3 && result.checks.every((c) => c.pass))
  r = run(["--task", "web-ui", "--json"], { FAKE_MODE: "fail" })
  result = json(r.stdout)
  check("web-ui fail: exit 1", r.status === 1)
  check("web-ui fail: missing file detected", result?.pass === false && result.checks[0].pass === false)

  // --- agent timeout ---
  const timeoutStart = Date.now()
  r = run(["--task", "timeout", "--json"], { EVAL_TASKS_DIR: TASKS, EVAL_FIXTURES_DIR: FIXTURES, FAKE_MODE: "timeout" })
  const timeoutElapsed = Date.now() - timeoutStart
  result = json(r.stdout)
  check("timeout: exit 1", r.status === 1, `status=${r.status} stdout=${r.stdout.slice(0, 200)} stderr=${r.stderr.slice(0, 200)}`)
  check("timeout: agent marked timed out", result?.agentRun?.timedOut === true, JSON.stringify(result?.agentRun ?? null))
  check("timeout: overall FAIL", result?.pass === false)
  check("timeout: checks still run", result?.checks?.[0]?.pass === true)
  check("timeout: returns promptly", timeoutElapsed < 15_000, `${timeoutElapsed}ms`)

  // --- check timeout ---
  const checkTimeoutStart = Date.now()
  r = run(["--task", "check-timeout", "--json"], { EVAL_TASKS_DIR: TASKS, EVAL_FIXTURES_DIR: FIXTURES, FAKE_MODE: "pass" })
  const checkTimeoutElapsed = Date.now() - checkTimeoutStart
  result = json(r.stdout)
  check("check timeout: exit 1", r.status === 1)
  check("check timeout: check marked timed out", result?.checks?.[0]?.timedOut === true)
  check("check timeout: overall FAIL", result?.pass === false)
  check("check timeout: returns promptly", checkTimeoutElapsed < 15_000, `${checkTimeoutElapsed}ms`)

  // --- agent crash fails the task even when checks pass ---
  r = run(["--task", "bugfix", "--json"], { FAKE_MODE: "crash" })
  result = json(r.stdout)
  check("crash: exit 1", r.status === 1)
  check("crash: agent exit code captured", result?.agentRun?.exitCode === 3)
  check("crash: checks pass but task FAIL", result?.checks?.[0]?.pass === true && result?.pass === false)

  // --- --keep ---
  r = run(["--task", "bugfix", "--keep"], { FAKE_MODE: "pass" })
  const keptMatch = r.stdout.match(/workdir \(kept\): (.+)/)
  check("keep: exit 0", r.status === 0, r.stderr)
  check("keep: workdir printed", Boolean(keptMatch), r.stdout.slice(-300))
  if (keptMatch) {
    const kept = keptMatch[1].trim()
    check("keep: workdir exists", exists(kept))
    check("keep: contains the fake fix", exists(path.join(kept, "src", "sum.js")))
    rm(kept)
  }
} finally {
  rm(TMP)
}

console.log(`\n${checks - failed}/${checks} checks passed`)
if (failed) {
  console.error(`❌ ${failed} eval harness test(s) failed`)
  process.exit(1)
}
console.log("✅ evals OK")
