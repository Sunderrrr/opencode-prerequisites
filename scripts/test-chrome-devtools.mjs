#!/usr/bin/env node
// Hermetic tests for config/bin/oc-chrome-devtools-mcp and its doctor check.
// No real Chrome, no npx, no network: fake npx and fake browser binaries only, in a
// temporary HOME/PATH. Verifies the resolution order (OC_CHROME_PATH, PATH, Playwright
// cache), the exact pinned package/flags, telemetry-off environment, argument passthrough,
// the clear failure without Chrome, --check, and the doctor warning.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const LAUNCHER = path.join(ROOT, "config", "bin", "oc-chrome-devtools-mcp")
const DOCTOR = path.join(ROOT, "scripts", "doctor.mjs")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oc-chrome-devtools-"))

let checks = 0
let failed = 0
const check = (name, cond, detail = "") => {
  checks++
  if (!cond) failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`)
}
const write = (f, body) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, body, { mode: 0o755 })
}

// Minimal PATH: a bash for the launcher's shebang, a fake npx, and the fake browsers of
// each scenario. /usr/bin is deliberately absent: a real Chrome on this machine can never
// be picked, which keeps the test hermetic.
const bash = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"].find(fs.existsSync)
if (!bash) throw new Error("bash not found: the launcher cannot be tested")
const sysDir = path.join(TMP, "sys")
fs.mkdirSync(sysDir, { recursive: true })
fs.symlinkSync(bash, path.join(sysDir, "bash"))

const NPX = `#!/bin/sh
printf 'NO_UPDATE=%s\\n' "\${CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS:-unset}"
printf '%s\\n' "$*"
`
const CHROME_STUB = "#!/bin/sh\nexit 0\n"

const mkbin = (name, browsers = []) => {
  const dir = path.join(TMP, `bin-${name}`)
  fs.mkdirSync(dir, { recursive: true })
  write(path.join(dir, "npx"), NPX)
  for (const browser of browsers) write(path.join(dir, browser), CHROME_STUB)
  return dir
}
const chrome = (name) => {
  const file = path.join(TMP, "chrome", name)
  write(file, CHROME_STUB)
  return file
}

const baseEnv = { ...process.env, HOME: path.join(TMP, "home-empty") }
for (const key of ["OC_CHROME_PATH", "CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS"]) delete baseEnv[key]

const run = (bin, args = [], env = {}) => spawnSync(LAUNCHER, args, {
  encoding: "utf8",
  env: { ...baseEnv, PATH: `${bin}${path.delimiter}${sysDir}`, ...env },
  timeout: 20000,
})
const parse = (stdout) => {
  const lines = stdout.trim().split("\n")
  return { noUpdate: (lines[0] ?? "").replace(/^NO_UPDATE=/, ""), args: lines[1] ?? "" }
}
// The fake npx sees every argv, including npx's own -y flag.
const expectedArgs = (exe) =>
  `-y chrome-devtools-mcp@1.12.0 --headless --isolated --no-usage-statistics --no-performance-crux --executablePath ${exe}`

// --- 1. OC_CHROME_PATH wins over PATH; exact pin/flags; telemetry off; passthrough ------
const custom = chrome("custom-chrome")
let bin = mkbin("override", ["google-chrome-stable", "chromium"])
let r = run(bin, [], { OC_CHROME_PATH: custom, CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "0" })
let got = parse(r.stdout)
check("OC_CHROME_PATH wins over PATH", r.status === 0 && got.args === expectedArgs(custom),
  `code ${r.status} | ${r.stdout}${r.stderr}`)
check("exact pinned package and exact flags", got.args === expectedArgs(custom), got.args)
check("CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS is forced to 1", got.noUpdate === "1", got.noUpdate)

r = run(bin, ["--browserUrl", "http://127.0.0.1:9222"], { OC_CHROME_PATH: custom })
got = parse(r.stdout)
check("extra arguments are passed through after the pinned flags",
  got.args === `${expectedArgs(custom)} --browserUrl http://127.0.0.1:9222`, got.args)

// --- 2. PATH fallback, in the documented order ----------------------------------------
bin = mkbin("path", ["google-chrome-stable", "chromium"])
r = run(bin)
got = parse(r.stdout)
check("PATH fallback: google-chrome-stable preferred over chromium",
  r.status === 0 && got.args === expectedArgs(path.join(bin, "google-chrome-stable")),
  `code ${r.status} | ${got.args}${r.stderr}`)

bin = mkbin("path-chromium", ["chromium", "chromium-browser"])
r = run(bin)
check("PATH fallback: chromium when no Google Chrome",
  parse(r.stdout).args === expectedArgs(path.join(bin, "chromium")), r.stdout + r.stderr)

// --- 3. Playwright cache fallback: newest revision, chrome-linux64 accepted ------------
const pwHome = path.join(TMP, "home-playwright")
const old = path.join(pwHome, ".cache", "ms-playwright", "chromium-1148", "chrome-linux", "chrome")
const newest = path.join(pwHome, ".cache", "ms-playwright", "chromium-1248", "chrome-linux64", "chrome")
write(old, CHROME_STUB)
write(newest, CHROME_STUB)
// A headless shell must never be selected (the server needs the full Chrome binary).
write(path.join(pwHome, ".cache", "ms-playwright", "chromium_headless_shell-1248", "chrome-linux", "headless_shell"), CHROME_STUB)
bin = mkbin("playwright")
r = run(bin, [], { HOME: pwHome })
got = parse(r.stdout)
check("Playwright fallback: newest chromium-* revision (chrome-linux64)",
  r.status === 0 && got.args === expectedArgs(newest), `code ${r.status} | ${got.args}${r.stderr}`)

r = run(bin, ["--check"], { HOME: pwHome })
check("--check: Playwright build reported as may-work/unsupported",
  r.status === 0 && /chrome-devtools-mcp 1\.12\.0: Chrome found at .*chromium-1248.*not officially supported/.test(r.stdout),
  r.stdout + r.stderr)

// --- 4. --check starts nothing ---------------------------------------------------------
r = run(bin, ["--check"], { OC_CHROME_PATH: custom })
check("--check: resolves the binary without starting npx",
  r.status === 0 && /^chrome-devtools-mcp 1\.12\.0: Chrome found at /.test(r.stdout) && !/NO_UPDATE=/.test(r.stdout),
  r.stdout + r.stderr)

// --- 5. clear failures ----------------------------------------------------------------
bin = mkbin("none")
r = run(bin)
check("no Chrome: exit 1 and no npx launch", r.status === 1 && r.stdout === ""
  && /no Chrome\/Chromium binary found/.test(r.stderr), `code ${r.status} | ${r.stdout}${r.stderr}`)
check("no Chrome: fixes listed (Chrome, Chromium, Playwright, OC_CHROME_PATH)",
  /google\.com\/chrome/.test(r.stderr) && /playwright install chromium/.test(r.stderr)
  && /OC_CHROME_PATH/.test(r.stderr), r.stderr)

r = run(mkbin("bad-override", ["google-chrome-stable"]), [], { OC_CHROME_PATH: path.join(TMP, "missing-chrome") })
check("invalid OC_CHROME_PATH: clear failure, no silent fallback",
  r.status === 1 && r.stdout === "" && /OC_CHROME_PATH is not an executable file/.test(r.stderr),
  `code ${r.status} | ${r.stdout}${r.stderr}`)

// --- 6. doctor: warning when Chrome is missing, success when it is resolved -----------
const docHome = path.join(TMP, "doctor-home")
const docCfg = path.join(docHome, "config", "opencode")
write(path.join(docCfg, "agents", "ceo.md"), "---\ndescription: Test\nmode: primary\n---\nPrompt.\n")
fs.writeFileSync(path.join(docCfg, "opencode.jsonc"), JSON.stringify({
  default_agent: "ceo",
  mcp: { servers: { "chrome-devtools": { type: "local", command: [LAUNCHER] } } },
}, null, 2))
const docBin = mkbin("doctor-none")
const docEnv = {
  ...baseEnv,
  HOME: docHome,
  OPENCODE_CONFIG_DIR: docCfg,
  OBSCURA_BIN_DIR: docBin,
  PATH: `${docBin}${path.delimiter}${sysDir}`,
  OC_DOCTOR_OFFLINE: "1",
}
const runDoctor = (env = {}) => spawnSync(process.execPath, [DOCTOR, "--offline"], {
  encoding: "utf8", cwd: ROOT, env: { ...docEnv, ...env }, timeout: 30000,
})

r = runDoctor()
check("doctor: warns when the chrome-devtools MCP has no Chrome",
  /chrome-devtools: chrome-devtools-mcp: no Chrome\/Chromium binary found/.test(r.stdout),
  r.stdout + r.stderr)
r = runDoctor({ OC_CHROME_PATH: custom })
check("doctor: reports the Chrome binary when OC_CHROME_PATH resolves",
  /chrome-devtools: chrome-devtools-mcp 1\.12\.0: Chrome found at /.test(r.stdout),
  r.stdout + r.stderr)

fs.rmSync(TMP, { recursive: true, force: true })
if (failed) {
  console.log(`\n❌ ${failed} check(s) failed out of ${checks}`)
  process.exitCode = 1
} else {
  console.log("\n✅ chrome-devtools MCP launcher OK")
  console.log(`${checks} checks passed`)
}
