#!/usr/bin/env node
// Hermetic tests for config/bin/oc-playwright-mcp and its doctor check.
// No real npm, node, npx, browser or network: fake executables only, in a temporary
// HOME/XDG_DATA_HOME/PATH. Verifies the dedicated install layout, self-healing on startup,
// --check (pass/fail, no network), --repair (force reinstall), the local cli.js launch
// (never npx in the normal path), the dedicated-cache npx fallback, the preserved browser
// arguments and the doctor warning.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const LAUNCHER = path.join(ROOT, "config", "bin", "oc-playwright-mcp")
const DOCTOR = path.join(ROOT, "scripts", "doctor.mjs")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oc-playwright-"))

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
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "")
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const isRoot = typeof process.getuid === "function" && process.getuid() === 0

// Minimal system PATH: a bash for the shebangs and the coreutils the launcher/fake npm need.
// /usr/bin is deliberately absent: no real node, npm, npx or browser can leak into a test.
const bash = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"].find(fs.existsSync)
if (!bash) throw new Error("bash not found: the launcher cannot be tested")
const firstExisting = (list) => list.find(fs.existsSync)
const sysDir = path.join(TMP, "sys")
fs.mkdirSync(sysDir, { recursive: true })
for (const name of ["bash", "rm", "mkdir"]) {
  const target = name === "bash"
    ? bash
    : firstExisting([`/bin/${name}`, `/usr/bin/${name}`, `/usr/local/bin/${name}`])
  if (!target) throw new Error(`${name} not found: the launcher cannot be tested`)
  fs.symlinkSync(target, path.join(sysDir, name))
}

const NPM = `#!${bash}
printf '%s\\n' "$*" >> "$NPM_LOG"
prefix=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$prefix" ] || { printf 'fake npm: no --prefix\\n' >&2; exit 91; }
if [ -n "\${NPM_FAIL:-}" ] && [ -f "$NPM_FAIL" ]; then
  printf 'fake npm: simulated offline failure\\n' >&2
  exit 1
fi
rm -rf "$prefix/node_modules"
mkdir -p "$prefix/node_modules/@playwright/mcp" "$prefix/node_modules/playwright-core/lib"
printf '%s\\n' '{"name":"@playwright/mcp","version":"0.0.84","bin":{"playwright-mcp":"cli.js"}}' > "$prefix/node_modules/@playwright/mcp/package.json"
printf '%s\\n' '// fake cli' > "$prefix/node_modules/@playwright/mcp/cli.js"
printf '%s\\n' '// fake utilsBundle' > "$prefix/node_modules/playwright-core/lib/utilsBundle.js"
exit 0
`
const NODE = `#!${bash}
printf '%s\\n' "$*" >> "$NODE_LOG"
exit 0
`
const NPX = `#!${bash}
printf 'cache=%s\\nargs=%s\\n' "\${npm_config_cache:-unset}" "$*" >> "$NPX_LOG"
exit 0
`
const BROWSER = "#!/bin/sh\nexit 0\n"

const makeBin = (name, { npm = true, node = true, npx = true, browsers = [] } = {}) => {
  const dir = path.join(TMP, `bin-${name}`)
  fs.mkdirSync(dir, { recursive: true })
  if (npm) write(path.join(dir, "npm"), NPM)
  if (node) write(path.join(dir, "node"), NODE)
  if (npx) write(path.join(dir, "npx"), NPX)
  for (const b of browsers) write(path.join(dir, b), BROWSER)
  return dir
}

const home = (name) => path.join(TMP, name)
const mcpHome = (h) => path.join(h, ".local", "share", "opencode-prerequisites", "mcp", "playwright")
const mcpEntry = (h) => path.join(mcpHome(h), "node_modules", "@playwright", "mcp", "cli.js")
const mcpUtils = (h) => path.join(mcpHome(h), "node_modules", "playwright-core", "lib", "utilsBundle.js")
const npmLog = path.join(TMP, "npm.log")
const nodeLog = path.join(TMP, "node.log")
const npxLog = path.join(TMP, "npx.log")
const resetLogs = () => { for (const f of [npmLog, nodeLog, npxLog]) fs.rmSync(f, { force: true }) }
const lines = (f) => read(f).split("\n").filter(Boolean)

const envFor = (h, bin, extra = {}) => ({
  HOME: h,
  XDG_DATA_HOME: path.join(h, ".local", "share"),
  PATH: `${bin}${path.delimiter}${sysDir}`,
  TMPDIR: os.tmpdir(),
  LANG: "C",
  NPM_LOG: npmLog,
  NODE_LOG: nodeLog,
  NPX_LOG: npxLog,
  ...extra,
})
const run = (args, env) => spawnSync(LAUNCHER, args, { encoding: "utf8", env, timeout: 20000 })

// --- 1. first run: dedicated install, then the local cli.js (no npx) ----------------------
const home1 = home("home-1")
const chromium = "chromium"
const binFull = makeBin("full", { browsers: [chromium] })
resetLogs()
let r = run([], envFor(home1, binFull))
let nodeArgs = lines(nodeLog)[0] ?? ""
let expectedNodeArgs = `${mcpEntry(home1)} --executable-path ${path.join(binFull, chromium)} --headless${isRoot ? " --no-sandbox" : ""}`
check("first run: installs @playwright/mcp@0.0.84 into the dedicated XDG directory",
  r.status === 0 && lines(npmLog).length === 1
  && lines(npmLog)[0] === `install --prefix ${mcpHome(home1)} --no-audit --no-fund --silent @playwright/mcp@0.0.84`,
  `code ${r.status} | npm: ${lines(npmLog).join(" ; ")} | ${r.stderr}`)
check("first run: package.json, cli.js and playwright-core/lib/utilsBundle.js exist",
  fs.existsSync(path.join(mcpHome(home1), "node_modules", "@playwright", "mcp", "package.json"))
  && fs.existsSync(mcpEntry(home1)) && fs.existsSync(mcpUtils(home1)))
check("first run: launches node on the local cli.js with the browser args (never npx)",
  r.status === 0 && nodeArgs === expectedNodeArgs && lines(npxLog).length === 0,
  `node: ${nodeArgs} | npx: ${lines(npxLog).join(" ; ")} | ${r.stderr}`)
check("first run: no MODULE_NOT_FOUND / npx cache in the output", !/MODULE_NOT_FOUND|_npx/.test(r.stdout + r.stderr))

// --- 2. --check: local verification, no npm/node invocation, no network -------------------
const binCheck = makeBin("check", { npm: false, npx: false })
resetLogs()
r = run(["--check"], envFor(home1, binCheck))
check("--check: exit 0 and reports the install path",
  r.status === 0 && new RegExp(`playwright-mcp 0\\.0\\.84: installed in ${esc(mcpHome(home1))}`).test(r.stdout),
  `code ${r.status} | ${r.stdout}${r.stderr}`)
check("--check: runs neither npm nor the server", lines(npmLog).length === 0 && lines(nodeLog).length === 0)
check("--check: no shared npx cache path printed", !/_npx/.test(r.stdout + r.stderr))

const home2 = home("home-2")
r = run(["--check"], envFor(home2, binCheck))
check("--check: missing install → exit 1, clear message and repair hint",
  r.status === 1 && /dedicated install missing or incomplete/.test(r.stderr) && /--repair/.test(r.stderr),
  `code ${r.status} | ${r.stdout}${r.stderr}`)
check("--check: a missing install is never repaired silently (no network)",
  !fs.existsSync(mcpHome(home2)) && lines(npmLog).length === 0)

// --- 3. self-healing on startup and forced --repair ---------------------------------------
fs.rmSync(mcpUtils(home1))
resetLogs()
r = run([], envFor(home1, binFull))
check("self-heal: a corrupt install (utilsBundle.js missing) is reinstalled on startup",
  r.status === 0 && fs.existsSync(mcpUtils(home1)) && lines(npmLog).length === 1,
  `code ${r.status} | npm: ${lines(npmLog).join(" ; ")} | ${r.stderr}`)

fs.rmSync(mcpUtils(home1))
resetLogs()
r = run(["--repair"], envFor(home1, binFull))
check("--repair: reinstalls and exits 0 with the --check message",
  r.status === 0 && fs.existsSync(mcpUtils(home1)) && lines(npmLog).length === 1
  && /playwright-mcp 0\.0\.84: installed in/.test(r.stdout),
  `code ${r.status} | ${r.stdout}${r.stderr}`)
check("--repair: launches no server", lines(nodeLog).length === 0)
resetLogs()
r = run(["--repair"], envFor(home1, binFull))
check("--repair: forces a reinstall even when the install is healthy",
  r.status === 0 && lines(npmLog).length === 1, `code ${r.status} | npm: ${lines(npmLog).join(" ; ")}`)

// --- 4. npm failure → npx with the dedicated cache, browser args preserved ----------------
const home3 = home("home-3")
const npmFail = path.join(TMP, "npm-fail")
fs.writeFileSync(npmFail, "1")
resetLogs()
r = run([], envFor(home3, binFull, { NPM_FAIL: npmFail }))
const npxLines = lines(npxLog)
const expectedNpxArgs = `-y @playwright/mcp@0.0.84 --executable-path ${path.join(binFull, chromium)} --headless${isRoot ? " --no-sandbox" : ""}`
check("fallback: npm failure warns and keeps running (exit 0)",
  r.status === 0 && /dedicated npm install failed/.test(r.stderr) && /dedicated cache/.test(r.stderr),
  `code ${r.status} | ${r.stderr}`)
check("fallback: npx uses ~/.cache/oc-npm, never the shared ~/.npm/_npx",
  npxLines[0] === `cache=${path.join(home3, ".cache", "oc-npm")}` && !(npxLines[0] ?? "").includes("_npx"),
  npxLines[0] ?? "no npx call")
check("fallback: npx receives the pinned package and the browser args",
  npxLines[1] === `args=${expectedNpxArgs}`, npxLines[1] ?? "")

// --- 5. browser resolution and argument passthrough ---------------------------------------
const custom = path.join(TMP, "custom-browser")
write(custom, BROWSER)
resetLogs()
r = run(["--browser", "firefox"], envFor(home1, binFull, { OC_PLAYWRIGHT_BROWSER: custom, OC_PLAYWRIGHT_HEADED: "1" }))
nodeArgs = lines(nodeLog)[0] ?? ""
check("OC_PLAYWRIGHT_BROWSER wins; headed removes --headless; extra args pass through",
  r.status === 0 && nodeArgs === `${mcpEntry(home1)} --executable-path ${custom} --browser firefox${isRoot ? " --no-sandbox" : ""}`,
  nodeArgs)

const binNoBrowser = makeBin("no-browser", { browsers: [] })
resetLogs()
r = run(["--port", "9222"], envFor(home1, binNoBrowser))
nodeArgs = lines(nodeLog)[0] ?? ""
check("no system browser: no executable/headless flag, passthrough intact",
  r.status === 0 && nodeArgs === `${mcpEntry(home1)} --port 9222`, nodeArgs)

r = run(["--help"], envFor(home1, binNoBrowser))
check("--help: exit 0 and documents --check/--repair",
  r.status === 0 && /--check/.test(r.stdout) && /--repair/.test(r.stdout), r.stdout)

// --- 6. doctor: warn when the dedicated install is missing, then report the install -------
const docHome = home("doctor-home")
const docCfg = path.join(docHome, "config", "opencode")
write(path.join(docCfg, "agents", "ceo.md"), "---\ndescription: Test\nmode: primary\n---\nPrompt.\n")
fs.writeFileSync(path.join(docCfg, "opencode.jsonc"), JSON.stringify({
  default_agent: "ceo",
  mcp: { servers: { playwright: { type: "local", command: [LAUNCHER] } } },
}, null, 2))
const docBin = makeBin("doctor")
const docEnv = {
  ...envFor(docHome, docBin),
  OPENCODE_CONFIG_DIR: docCfg,
  OBSCURA_BIN_DIR: docBin,
  OC_DOCTOR_OFFLINE: "1",
}
const runDoctor = () => spawnSync(process.execPath, [DOCTOR, "--offline"], {
  encoding: "utf8", cwd: ROOT, env: docEnv, timeout: 30000,
})
r = runDoctor()
check("doctor: warns with --repair when the Playwright MCP install is missing",
  /playwright: .*dedicated install missing or incomplete/.test(r.stdout) && /--repair/.test(r.stdout),
  r.stdout + r.stderr)
const docBinFull = makeBin("doctor-full", { browsers: [chromium] })
r = run(["--repair"], { ...docEnv, PATH: `${docBinFull}${path.delimiter}${sysDir}` })
check("doctor setup: dedicated install ready", r.status === 0, r.stdout + r.stderr)
r = runDoctor()
check("doctor: reports the dedicated install when present",
  /playwright: playwright-mcp 0\.0\.84: installed in/.test(r.stdout), r.stdout + r.stderr)
check("doctor: keeps the browser check", /playwright: (system browser|no browser|Playwright Chromium)/.test(r.stdout),
  r.stdout)

fs.rmSync(TMP, { recursive: true, force: true })
if (failed) {
  console.log(`\n❌ ${failed} check(s) failed out of ${checks}`)
  process.exitCode = 1
} else {
  console.log("\n✅ playwright MCP OK")
  console.log(`${checks} checks passed`)
}
