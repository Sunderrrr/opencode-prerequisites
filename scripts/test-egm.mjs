#!/usr/bin/env node
// Tests for config/bin/oc-egm: help/usage errors, prompt construction, artifact resolution,
// bridge selection (Codex default, Antigravity --yes), option placement, and `check` against
// fake Codex/Antigravity CLIs. Hermetic: no network, no real CLI, no model call.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EGM = path.join(ROOT, "config/bin/oc-egm")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-egmtest-"))
let passed = 0, failed = 0
const check = (name, cond, detail = "") => {
  cond ? passed++ : failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`)
}
const write = (f, t, mode = 0o644) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t, { mode }) }
const real = (p) => fs.realpathSync(p)

// Fake bridge: records argv NUL-separated in $CAP, then prints a marker.
const bridge = (name) => write(path.join(tmp, "bin", name), `#!/bin/sh
printf '%s\\0' "$@" > "$CAP"
printf '${name}-ok\\n'
`, 0o755)
bridge("oc-codex")
bridge("oc-antigravity")

const codexOk = `#!/bin/sh
printf 'PLUGIN   STATUS              VERSION\\negm@egm  installed, enabled  0.1.1\\n'
`
const agyOk = `#!/bin/sh
printf 'Installed plugins:\\n- egm (enabled, 0.1.1)\\n'
`
write(path.join(tmp, "bin", "codex"), codexOk, 0o755)
write(path.join(tmp, "bin", "agy"), agyOk, 0o755)

const proj = path.join(tmp, "proj")
fs.mkdirSync(proj, { recursive: true })
const cap = path.join(tmp, "cap")
const baseEnv = {
  HOME: path.join(tmp, "home"),
  PATH: `${path.join(tmp, "bin")}:/usr/bin:/bin`,
  CAP: cap,
  PWD: real(proj),
}
const run = (args, extra = {}) => spawnSync("/bin/bash", [EGM, ...args], {
  encoding: "utf8", cwd: proj, env: { ...baseEnv, ...extra },
})
const args = () => fs.readFileSync(cap, "utf8").split("\0").filter((s) => s !== "")
const resetCap = () => fs.rmSync(cap, { force: true })

// ---------- 1. file and help ----------
const raw = fs.readFileSync(EGM, "utf8")
check("oc-egm: executable and Bash strict mode", (fs.statSync(EGM).mode & 0o111) !== 0 &&
  raw.startsWith("#!/usr/bin/env bash") && /^set -Eeuo pipefail$/m.test(raw))
let r = run(["--help"])
check("--help: exit 0 and lists commands/options", r.status === 0 &&
  /Usage: oc-egm/.test(r.stdout) && /review/.test(r.stdout) && /--artifact/.test(r.stdout) && /check/.test(r.stdout), r.stderr)
r = run([])
check("no command: exit 2 and usage on stderr", r.status === 2 && /Usage: oc-egm/.test(r.stderr), `${r.status} ${r.stderr}`)
r = run(["nonsense"])
check("unknown command: exit 2", r.status === 2 && /unknown command: nonsense/.test(r.stderr), r.stderr)
r = run(["--bogus", "review"])
check("unknown option: exit 2", r.status === 2 && /unknown option: --bogus/.test(r.stderr), r.stderr)
r = run(["-C"])
check("-C without value: exit 2", r.status === 2 && /requires a directory/.test(r.stderr), r.stderr)
r = run(["-C", path.join(tmp, "missing"), "review"])
check("missing working directory: exit 2", r.status === 2 && /directory not found/.test(r.stderr), r.stderr)
r = run(["--via", "other", "review"])
check("invalid --via: exit 2", r.status === 2 && /invalid --via/.test(r.stderr), r.stderr)

// ---------- 2. Codex (default): exact bridge arguments and prompt ----------
resetCap()
r = run(["review", "docs/x.md"])
let a = args()
const p1 = real(proj)
const prompt = (skill, artifact, rest = "") =>
  `Use the \`${skill}\` skill. EGM artifact directory: ${artifact}.${rest ? ` ${rest}.` : ""} Return the reports' paths and a short summary.`
check("codex: oc-codex called with -C DIR and the prompt", r.status === 0 && a[0] === "-C" && a[1] === p1 &&
  a[2] === prompt("egm-review", `${p1}/.dev/docs`, "docs/x.md"), JSON.stringify(a))
check("codex: the bridge output is returned unchanged", r.stdout.includes("oc-codex-ok"), r.stdout)

// ---------- 3. Antigravity: --yes, options after the command, artifact with .. ----------
resetCap()
r = run(["brainstorm", "Add webhook delivery", "--via", "antigravity", "--artifact", "../out/designs"])
a = args()
const artifact = path.join(real(tmp), "out/designs")
check("antigravity: --yes -C DIR and the prompt", r.status === 0 && a[0] === "--yes" && a[1] === "-C" && a[2] === p1 &&
  a[3] === prompt("egm-brainstorm", artifact, "Add webhook delivery"), JSON.stringify(a))
check("antigravity: multi-word ARGS stay one sentence", r.stdout.includes("oc-antigravity-ok"), r.stdout)

// ---------- 4. absolute artifact, -- separator, every command mapping ----------
resetCap()
r = run(["draft", "--artifact", "/tmp/egm-abs", "--", "notes one.md"])
a = args()
check("absolute --artifact kept as-is", r.status === 0 && a[2] === prompt("egm-draft", "/tmp/egm-abs", "notes one.md"), JSON.stringify(a))
for (const cmd of ["resolve", "bootstrap", "lite", "drift-report"]) {
  resetCap()
  r = run([cmd])
  a = args()
  check(`${cmd}: maps to egm-${cmd}`, r.status === 0 && a[2] === prompt(`egm-${cmd}`, `${p1}/.dev/docs`), JSON.stringify(a))
}
resetCap()
r = run(["review", "--", "-odd-name.md"])
a = args()
check("-- separator: a leading-dash ARG is forwarded", r.status === 0 && a[2] === prompt("egm-review", `${p1}/.dev/docs`, "-odd-name.md"), JSON.stringify(a))

// ---------- 5. check ----------
r = run(["check"])
check("check: both plugins found, exit 0", r.status === 0 && /✅ codex: egm@egm OK/.test(r.stdout) && /✅ antigravity: egm OK/.test(r.stdout), r.stdout + r.stderr)
write(path.join(tmp, "bin", "codex"), "#!/bin/sh\nprintf 'no plugins here\\n'\n", 0o755)
r = run(["check"])
check("check: missing Codex plugin, exit 1", r.status === 1 && /❌ codex: egm@egm missing/.test(r.stdout), r.stdout + r.stderr)
write(path.join(tmp, "bin", "codex"), codexOk, 0o755)
write(path.join(tmp, "bin", "agy"), "#!/bin/sh\nprintf 'Installed plugins:\\n- other (enabled)\\n'\n", 0o755)
r = run(["check"])
check("check: missing Antigravity plugin, exit 1", r.status === 1 && /❌ antigravity: egm missing/.test(r.stdout), r.stdout + r.stderr)
write(path.join(tmp, "bin", "agy"), agyOk, 0o755)
r = run(["check"], { PATH: "/usr/bin:/bin" })
check("check: missing CLIs reported, exit 1", r.status === 1 &&
  /❌ codex: CLI not found/.test(r.stdout) && /❌ antigravity: CLI not found/.test(r.stdout), r.stdout + r.stderr)
r = run(["--via", "antigravity", "check"])
check("check: ignores --via and still checks both", r.status === 0 && /✅ codex/.test(r.stdout) && /✅ antigravity/.test(r.stdout), r.stdout)

// ---------- 6. missing bridge ----------
const standalone = path.join(tmp, "standalone")
write(path.join(standalone, "oc-egm"), raw, 0o755)
r = spawnSync("/bin/bash", [path.join(standalone, "oc-egm"), "review"], {
  encoding: "utf8", cwd: proj, env: { ...baseEnv, PATH: "/usr/bin:/bin" },
})
check("missing oc-codex (PATH and sibling): exit 127", r.status === 127 && /oc-codex not found/.test(r.stderr), `${r.status} ${r.stderr}`)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
