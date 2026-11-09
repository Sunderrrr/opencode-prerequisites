#!/usr/bin/env node
// Hermetic oc-secrets tests: temp config, no user secrets touched.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TOOL = path.join(ROOT, "config", "bin", "oc-secrets")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oc-secrets-test-"))
const CONFIG = path.join(TMP, "config")
const SECRETS = path.join(CONFIG, "secrets")

const baseEnv = { ...process.env }
delete baseEnv.OPENCODE_CONFIG_DIR
const env = { ...baseEnv, OPENCODE_CONFIG_DIR: CONFIG }

const run = (args, input) => spawnSync(process.env.BASH || "bash", [TOOL, ...args], {
  encoding: "utf8",
  env,
  input,
  timeout: 20_000,
})

let checks = 0
let failed = 0
const check = (name, cond, detail = "") => {
  checks++
  if (!cond) failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`)
}
const modeOf = (file) => (fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : -1)
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null)
const secretFile = (name) => path.join(SECRETS, name)

try {
  // --- help and usage ---
  let r = run(["--help"])
  check("--help: exit 0 and lists the commands",
    r.status === 0 && /Usage: oc-secrets/.test(r.stdout) && /set <NAME>/.test(r.stdout)
    && /export/.test(r.stdout) && /not encrypted at rest/i.test(r.stdout), r.stderr)

  r = run([])
  check("missing command: exit 2 and usage", r.status === 2 && /missing command/.test(r.stderr), r.stderr)

  r = run(["nope"])
  check("unknown command: exit 2", r.status === 2 && /unknown command/.test(r.stderr), r.stderr)

  // --- set from stdin, permissions ---
  r = run(["set", "CONTEXT7_API_KEY"], "ctx-secret-123\n")
  check("set: stores the value read from stdin",
    r.status === 0 && read(secretFile("CONTEXT7_API_KEY")) === "ctx-secret-123", r.stderr)
  check("set: secrets directory is mode 700", modeOf(SECRETS) === 0o700, String(modeOf(SECRETS)))
  check("set: secret file is mode 600", modeOf(secretFile("CONTEXT7_API_KEY")) === 0o600,
    String(modeOf(secretFile("CONTEXT7_API_KEY"))))
  check("set: warns that the file backend is not encrypted at rest",
    /not encrypted at rest/.test(r.stderr))

  r = run(["set", "ARGV_TEST", "value"])
  check("set: refuses a value on argv (stdin only)",
    r.status === 2 && !fs.existsSync(secretFile("ARGV_TEST")), r.stderr)

  // --- get / list / check ---
  r = run(["get", "CONTEXT7_API_KEY"])
  check("get: prints the value only",
    r.status === 0 && r.stdout === "ctx-secret-123\n" && r.stderr === "", r.stdout + r.stderr)

  r = run(["list"])
  check("list: prints the name only",
    r.status === 0 && r.stdout === "CONTEXT7_API_KEY\n", r.stdout + r.stderr)
  check("list: never prints the value",
    !r.stdout.includes("ctx-secret-123") && !r.stderr.includes("ctx-secret-123"), r.stdout + r.stderr)

  r = run(["check"])
  check("check: prints the name, never the value",
    r.status === 0 && r.stdout === "CONTEXT7_API_KEY\n"
    && !r.stdout.includes("ctx-secret-123") && !r.stderr.includes("ctx-secret-123"),
    r.stdout + r.stderr)

  // --- export, including shell quoting and eval round-trip ---
  r = run(["export"])
  check("export: emits a single-quoted export line",
    r.status === 0 && r.stdout === "export CONTEXT7_API_KEY='ctx-secret-123'\n", r.stdout + r.stderr)

  r = spawnSync(process.env.BASH || "bash",
    ["-c", 'eval "$("$1" export)"; printf "%s" "$CONTEXT7_API_KEY"', "bash", TOOL],
    { encoding: "utf8", env })
  check("export: eval sets the environment variable",
    r.status === 0 && r.stdout === "ctx-secret-123", r.stdout + r.stderr)

  r = run(["set", "QUOTED"], "a'b c\n")
  check("set: accepts spaces and single quotes", r.status === 0, r.stderr)
  r = run(["export"])
  check("export: escapes single quotes",
    r.status === 0 && r.stdout.includes("export QUOTED='a'\\''b c'\n"), r.stdout + r.stderr)
  r = spawnSync(process.env.BASH || "bash",
    ["-c", 'eval "$("$1" export)"; printf "%s" "$QUOTED"', "bash", TOOL],
    { encoding: "utf8", env })
  check("export: eval round-trips spaces and single quotes",
    r.status === 0 && r.stdout === "a'b c", r.stdout + r.stderr)

  // --- invalid names, missing secrets, empty value ---
  r = run(["set", "bad-name"], "x\n")
  check("set: refuses a name outside [A-Z0-9_]+",
    r.status === 2 && /invalid secret name/.test(r.stderr)
    && !fs.existsSync(secretFile("bad-name")), r.stderr)

  r = run(["set", "lowercase"], "x\n")
  check("set: refuses lowercase names",
    r.status === 2 && /invalid secret name/.test(r.stderr), r.stderr)

  r = run(["get", "MISSING"])
  check("get: missing secret exits 1",
    r.status === 1 && /no such secret/.test(r.stderr) && r.stdout === "", r.stderr)

  r = run(["rm", "MISSING"])
  check("rm: missing secret exits 1",
    r.status === 1 && /no such secret/.test(r.stderr), r.stderr)

  r = run(["set", "EMPTY"], "")
  check("set: refuses an empty value",
    r.status === 1 && /empty value/.test(r.stderr) && !fs.existsSync(secretFile("EMPTY")), r.stderr)

  // --- idempotent overwrite ---
  r = run(["set", "CONTEXT7_API_KEY"], "new-value\n")
  check("set: overwrites the same file atomically",
    r.status === 0 && read(secretFile("CONTEXT7_API_KEY")) === "new-value"
    && modeOf(secretFile("CONTEXT7_API_KEY")) === 0o600, r.stderr)
  r = run(["list"])
  check("list: still one entry per name after overwrite",
    r.status === 0 && r.stdout === "CONTEXT7_API_KEY\nQUOTED\n", r.stdout + r.stderr)

  // --- permission check ---
  fs.chmodSync(secretFile("CONTEXT7_API_KEY"), 0o644)
  r = run(["check"])
  check("check: warns on a 644 file, exits 1 and never prints the value",
    r.status === 1 && /mode 644/.test(r.stderr) && r.stdout.includes("CONTEXT7_API_KEY")
    && !r.stdout.includes("new-value") && !r.stderr.includes("new-value"), r.stdout + r.stderr)
  fs.chmodSync(secretFile("CONTEXT7_API_KEY"), 0o600)

  fs.chmodSync(SECRETS, 0o755)
  r = run(["check"])
  check("check: warns on a 755 directory and exits 1",
    r.status === 1 && /mode 755/.test(r.stderr), r.stdout + r.stderr)
  fs.chmodSync(SECRETS, 0o700)

  // --- rm ---
  r = run(["rm", "CONTEXT7_API_KEY"])
  check("rm: removes the file",
    r.status === 0 && !fs.existsSync(secretFile("CONTEXT7_API_KEY")) && /Removed/.test(r.stdout),
    r.stdout + r.stderr)
  r = run(["get", "CONTEXT7_API_KEY"])
  check("rm: get fails afterwards", r.status === 1 && /no such secret/.test(r.stderr), r.stderr)

  r = run(["rm", "QUOTED"])
  check("rm: removes the second secret", r.status === 0, r.stderr)
  r = run(["list"])
  check("list: empty after removing every secret", r.status === 0 && r.stdout === "", r.stdout + r.stderr)
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(failed ? `\n❌ ${failed} check(s) failed out of ${checks}` : `\n✅ secrets OK — ${checks} checks`)
process.exitCode = failed ? 1 : 0
