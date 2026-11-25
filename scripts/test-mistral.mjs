#!/usr/bin/env node
// Tests for config/bin/oc-mistral: help/usage errors, argument construction, approval policy,
// output format, model and max-turns forwarding, exit-code propagation and the absence of the
// Studio CLI (`mistral`). Hermetic: no network, no real Vibe, no model call.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const MISTRAL = path.join(ROOT, "config/bin/oc-mistral")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-mistraltest-"))
let passed = 0, failed = 0
const check = (name, cond, detail = "") => {
  cond ? passed++ : failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`)
}
const write = (f, t, mode = 0o644) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t, { mode }) }
const real = (p) => fs.realpathSync(p)

const bin = path.join(tmp, "bin")
const cap = path.join(tmp, "cap")
const studioCap = path.join(tmp, "studio-called")
const vibe = `#!/bin/sh
printf '%s\\0' "$@" > "$CAP"
printf 'vibe-ok\\n'
exit "\${FAKE_RC:-0}"
`
write(path.join(bin, "vibe"), vibe, 0o755)
// If the launcher ever calls the Studio CLI, this marker appears.
write(path.join(bin, "mistral"), `#!/bin/sh
printf 'called\\n' > "$STUDIO_CAP"
`, 0o755)

const proj = path.join(tmp, "proj")
fs.mkdirSync(proj, { recursive: true })
const baseEnv = {
  HOME: path.join(tmp, "home"),
  PATH: `${bin}:/usr/bin:/bin`,
  CAP: cap,
  STUDIO_CAP: studioCap,
  PWD: real(proj),
}
const run = (args, extra = {}) => spawnSync("/bin/bash", [MISTRAL, ...args], {
  encoding: "utf8", cwd: proj, env: { ...baseEnv, ...extra },
})
const args = () => (fs.existsSync(cap) ? fs.readFileSync(cap, "utf8").split("\0").filter((s) => s !== "") : [])
const reset = () => { fs.rmSync(cap, { force: true }); fs.rmSync(studioCap, { force: true }) }

// ---------- 1. file and help ----------
const raw = fs.readFileSync(MISTRAL, "utf8")
check("oc-mistral: executable and Bash strict mode", (fs.statSync(MISTRAL).mode & 0o111) !== 0 &&
  raw.startsWith("#!/usr/bin/env bash") && /^set -Eeuo pipefail$/m.test(raw))
let r = run(["--help"])
check("--help: exit 0, usage and every option", r.status === 0 &&
  /Usage: oc-mistral/.test(r.stdout) && /--max-turns/.test(r.stdout) && /--yes/.test(r.stdout) &&
  /--json/.test(r.stdout) && /uv tool install mistral-vibe/.test(r.stdout), r.stderr)
r = run([])
check("no prompt: exit 2 and a hint on stderr", r.status === 2 && /missing prompt \(try --help\)/.test(r.stderr), `${r.status} ${r.stderr}`)
r = run(["--bogus", "task"])
check("unknown option: exit 2", r.status === 2 && /unknown option: --bogus/.test(r.stderr), r.stderr)
r = run(["-C"])
check("-C without value: exit 2", r.status === 2 && /requires a directory/.test(r.stderr), r.stderr)
r = run(["-C", path.join(tmp, "missing"), "task"])
check("missing working directory: exit 2", r.status === 2 && /directory not found/.test(r.stderr), r.stderr)
for (const bad of ["0", "-1", "abc", ""]) {
  r = run(["--max-turns", bad, "task"])
  check(`invalid --max-turns '${bad}': exit 2`, r.status === 2 && /invalid --max-turns/.test(r.stderr), r.stderr)
}

// ---------- 2. defaults: ask policy, text output, 40 turns ----------
reset()
r = run(["explain", "the", "build"])
let a = args()
const p1 = real(proj)
check("defaults: -p PROMPT, --workdir, --trust, text, ask, 40 turns",
  r.status === 0 && a[0] === "-p" && a[1] === "explain the build" &&
  a[2] === "--workdir" && a[3] === p1 && a[4] === "--trust" &&
  a[5] === "--output" && a[6] === "text" &&
  a[7] === "--approval-policy" && a[8] === "ask" &&
  a[9] === "--max-turns" && a[10] === "40" && a.length === 11, JSON.stringify(a))
check("stdout is returned unchanged", r.stdout === "vibe-ok\n", JSON.stringify(r.stdout))
check("the Studio CLI `mistral` is never called", !fs.existsSync(studioCap))

// ---------- 3. --yes, --json, -m and --max-turns ----------
reset()
r = run(["--yes", "--json", "-m", "devstral-medium", "--max-turns", "7", "review", "src/auth"])
a = args()
check("--yes: approval auto-approve", r.status === 0 && a[7] === "--approval-policy" && a[8] === "auto-approve", JSON.stringify(a))
check("--json: --output json", a[5] === "--output" && a[6] === "json", JSON.stringify(a))
check("-m and --max-turns are forwarded", a[9] === "--max-turns" && a[10] === "7" &&
  a[11] === "--model" && a[12] === "devstral-medium" && a.length === 13, JSON.stringify(a))
check("multi-word prompt stays one argument", a[1] === "review src/auth", JSON.stringify(a))
check("still no Studio CLI call", !fs.existsSync(studioCap))

// ---------- 4. -- separator, long options, exit code ----------
reset()
r = run(["--cd", proj, "--max-turns=12", "--", "-leading-dash task"])
a = args()
check("-- separator keeps a leading-dash prompt", r.status === 0 && a[1] === "-leading-dash task", JSON.stringify(a))
check("--max-turns=12 is parsed", a[9] === "--max-turns" && a[10] === "12", JSON.stringify(a))

reset()
r = run(["task"], { FAKE_RC: "3" })
check("vibe non-zero exit is propagated", r.status === 3 && /vibe exited with status 3/.test(r.stderr), `${r.status} ${r.stderr}`)

// ---------- 5. missing Vibe ----------
r = run(["task"], { PATH: "/usr/bin:/bin" })
check("missing vibe: exit 127 and install hint", r.status === 127 &&
  /vibe not found on PATH/.test(r.stderr) && /uv tool install mistral-vibe/.test(r.stderr), `${r.status} ${r.stderr}`)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
