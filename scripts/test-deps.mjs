#!/usr/bin/env node
// Hermetic oc-deps tests: local fixtures and isolated cache, no network access.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TOOL = path.join(ROOT, "config", "libexec", "oc-deps.mjs")
const LAUNCHER = path.join(ROOT, "config", "bin", "oc-deps")
const INSTALL_SH = path.join(ROOT, "install.sh")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oc-deps-test-"))
const FIX = path.join(TMP, "fixtures")

let checks = 0
let failed = 0
const check = (name, cond, detail = "") => {
  checks++
  if (!cond) failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`)
}
const jsonOf = (text) => { try { return JSON.parse(text) } catch { return null } }

const baseEnv = { ...process.env }
for (const key of ["OC_VERSIONS_TTL", "OC_VERSIONS_CACHE", "OC_VERSIONS_FIXTURES", "OPENCODE_CONFIG_DIR", "OBSCURA_BIN_DIR"]) {
  delete baseEnv[key]
}

const run = (args, { cache, fixtures = FIX, ttl } = {}) => {
  const env = { ...baseEnv }
  if (cache) env.OC_VERSIONS_CACHE = cache
  if (fixtures) env.OC_VERSIONS_FIXTURES = fixtures
  if (ttl !== undefined) env.OC_VERSIONS_TTL = String(ttl)
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", env, timeout: 30_000 })
}

const freshCache = (name) => {
  const dir = path.join(TMP, `cache-${name}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// Versions published "by default": equal to the current pins (except the v prefix of GitHub tags).
const LATEST = {
  npm: {
    "playwright": "1.64.1",
    "skills": "1.7.6",
    "kubernetes-mcp-server": "0.1.1",
    "@playwright/mcp": "0.0.84",
    "chrome-devtools-mcp": "1.12.0",
    "rea-agents": "6.8.0",
    "@mobilenext/mobile-mcp": "1.0.15",
  },
  pypi: {
    "mempalace": "3.11.0",
    "semgrep": "1.183.0",
    "semgrep-mcp": "0.9.0",
    "pydantic": "2.11.10",
    "setuptools": "80.10.2",
  },
  github: {
    "aquasecurity/trivy": "v0.76.1",
    "aquasecurity/trivy-plugin-mcp": "v0.0.20",
    "h4ckf0r0day/obscura": "v0.2.6",
    "astral-sh/uv": "0.13.7",
    "hashicorp/terraform-mcp-server": "v1.4.1",
  },
}

// Same transformation as oc-versions: / and : become __.
const fixKey = (key) => key.replace(/[\\/:]/g, "__").replace(/[^A-Za-z0-9._@-]/g, "_").replace(/\.{2,}/g, "_")
const fixtureFile = (eco, pkg) => path.join(FIX, eco, `${fixKey(pkg)}.json`)

const put = (eco, pkg, version) => {
  const file = fixtureFile(eco, pkg)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const data = eco === "npm"
    ? { name: pkg, "dist-tags": { latest: version } }
    : eco === "pypi"
      ? { info: { version } }
      : { tag_name: version }
  fs.writeFileSync(file, JSON.stringify(data))
}

const resetFixtures = (overrides = {}) => {
  fs.rmSync(FIX, { recursive: true, force: true })
  for (const [eco, packages] of Object.entries(LATEST)) {
    for (const [pkg, version] of Object.entries(packages)) put(eco, pkg, version)
  }
  for (const [key, version] of Object.entries(overrides)) {
    const [eco, pkg] = key.split("\u0000")
    put(eco, pkg, version)
  }
}

const seedCache = (cache, eco, entries) => {
  fs.mkdirSync(cache, { recursive: true })
  const payload = {
    version: 1,
    entries: Object.fromEntries(Object.entries(entries).map(([pkg, version]) => [pkg, {
      version,
      source: "fixture",
      fetchedAt: Date.now(),
    }])),
  }
  fs.writeFileSync(path.join(cache, `${eco}.json`), JSON.stringify(payload, null, 2) + "\n")
}

// --- 1. all pins are read and everything is up to date --------------------
resetFixtures()
let r = run(["check"], { cache: freshCache("up") })
check("all up to date: exit 0", r.status === 0, r.stdout + r.stderr)
check("table: header package | pinned | latest | status",
  /^package\s+\|\s+pinned\s+\|\s+latest\s+\|\s+status\s*$/m.test(r.stdout), r.stdout)
check("17 packages rendered (every pin in the kit)",
  r.stdout.split("\n").filter((l) => / \| /.test(l)).length === 18, r.stdout)
check("GitHub: tag v0.76.1 compared with pin 0.76.1",
  /aquasecurity\/trivy\s+\|\s+0\.76\.1\s+\|\s+v0\.76\.1\s+\|\s+up to date/.test(r.stdout), r.stdout)
check("pin with a v prefix kept (Trivy plugin)",
  /aquasecurity\/trivy-plugin-mcp\s+\|\s+v0\.0\.20\s+\|\s+v0\.0\.20\s+\|\s+up to date/.test(r.stdout), r.stdout)
check("summary: 17 up to date, no drift",
  /17 packages · 17 up to date · 0 drift · 0 unknown/.test(r.stdout), r.stdout)

// --- 2. drift detected ----------------------------------------------------
resetFixtures({ "npm\u0000kubernetes-mcp-server": "0.1.2" })
r = run(["check", "--only", "kubernetes-mcp-server"], { cache: freshCache("drift") })
check("drift: exit 1", r.status === 1, r.stdout + r.stderr)
check("drift: pinned, latest and status on the same line",
  /kubernetes-mcp-server\s+\|\s+0\.1\.1\s+\|\s+0\.1\.2\s+\|\s+drift/.test(r.stdout), r.stdout)
check("drift: summary shows 1 drift",
  /1 packages · 0 up to date · 1 drift · 0 unknown/.test(r.stdout), r.stdout)

// --- 3. unknown package ---------------------------------------------------
resetFixtures()
fs.rmSync(fixtureFile("npm", "@playwright/mcp"), { force: true })
r = run(["check", "--only", "@playwright/mcp"], { cache: freshCache("unknown") })
check("unknown: exit 1 and unknown status",
  r.status === 1 && /@playwright\/mcp\s+\|\s+0\.0\.84\s+\|\s+—\s+\|\s+unknown/.test(r.stdout), r.stdout + r.stderr)
check("unknown: cause shown on stderr", /fixture not found/.test(r.stderr), r.stderr)

// --- 4. --json usable by a machine ----------------------------------------
resetFixtures()
r = run(["check", "--json"], { cache: freshCache("json-up") })
let payload = jsonOf(r.stdout)
check("--json: 17 results and a consistent summary",
  r.status === 0 && payload?.results?.length === 17 && payload.summary.up_to_date === 17
  && payload.summary.drift === 0 && payload.summary.unknown === 0, r.stdout + r.stderr)
const mcp = payload?.results?.find((x) => x.package === "@playwright/mcp")
check("--json: package/pinned/latest/status/file/line fields",
  mcp?.pinned === "0.0.84" && mcp.latest === "0.0.84" && mcp.status === "up to date"
  && mcp.ecosystem === "npm" && mcp.file === "config/bin/oc-playwright-mcp" && mcp.line === 16,
  JSON.stringify(mcp))
const chromeMcp = payload?.results?.find((x) => x.package === "chrome-devtools-mcp")
const chromeExecLine = fs.readFileSync(path.join(ROOT, "config", "bin", "oc-chrome-devtools-mcp"), "utf8")
  .split("\n").findIndex((l) => l.startsWith("exec npx -y chrome-devtools-mcp@")) + 1
check("--json: chrome-devtools-mcp pin read from its launcher",
  chromeMcp?.pinned === "1.12.0" && chromeMcp.latest === "1.12.0" && chromeMcp.status === "up to date"
  && chromeMcp.ecosystem === "npm" && chromeMcp.file === "config/bin/oc-chrome-devtools-mcp"
  && chromeMcp.line === chromeExecLine, JSON.stringify(chromeMcp))

resetFixtures({ "github\u0000aquasecurity/trivy": "v0.77.0" })
r = run(["check", "--only", "trivy", "--json"], { cache: freshCache("json-drift") })
payload = jsonOf(r.stdout)
check("--json: drift with a proposed replacement",
  r.status === 1 && payload?.results?.[0]?.status === "drift"
  && payload.results[0].proposed === "0.77.0"
  && payload.results[0].proposed_line === 'OC_TRIVY_VERSION="${OC_TRIVY_VERSION:-0.77.0}"',
  r.stdout + r.stderr)

resetFixtures()
fs.rmSync(fixtureFile("github", "astral-sh/uv"), { force: true })
r = run(["check", "--only", "uv", "--json"], { cache: freshCache("json-unknown") })
payload = jsonOf(r.stdout)
check("--json: structured unknown with detail",
  r.status === 1 && payload?.results?.[0]?.status === "unknown"
  && payload.summary.unknown === 1 && /fixture not found/.test(payload.results[0].detail ?? ""),
  r.stdout + r.stderr)

// --- 5. --offline: cache only, no fixture ---------------------------------
let cache = freshCache("offline")
seedCache(cache, "github", { "aquasecurity/trivy": "v0.76.1" })
resetFixtures({ "github\u0000aquasecurity/trivy": "v9.9.9" })
r = run(["check", "--only", "trivy", "--offline"], { cache, fixtures: FIX })
check("--offline: cache served and fixtures ignored",
  r.status === 0 && /aquasecurity\/trivy\s+\|\s+0\.76\.1\s+\|\s+v0\.76\.1\s+\|\s+up to date/.test(r.stdout)
  && !/9\.9\.9/.test(r.stdout), r.stdout + r.stderr)
r = run(["check", "--only", "uv", "--offline", "--json"], { cache, fixtures: "" })
payload = jsonOf(r.stdout)
check("--offline: absent from cache = unknown, exit 1",
  r.status === 1 && payload?.results?.[0]?.status === "unknown"
  && /absent from the offline cache/.test(payload.results[0].detail ?? ""), r.stdout + r.stderr)

// Old cache accepted offline (no freshness requirement without network).
cache = freshCache("offline-old")
seedCache(cache, "github", { "aquasecurity/trivy": "v0.76.1" })
const old = JSON.parse(fs.readFileSync(path.join(cache, "github.json"), "utf8"))
old.entries["aquasecurity/trivy"].fetchedAt = 0
fs.writeFileSync(path.join(cache, "github.json"), JSON.stringify(old))
r = run(["check", "--only", "trivy", "--offline"], { cache, fixtures: "" })
check("--offline: old entry accepted", r.status === 0, r.stdout + r.stderr)

// --- 6. --only and --ecosysteme -------------------------------------------
resetFixtures()
r = run(["check", "--only", "@playwright/mcp", "--json"], { cache: freshCache("only") })
payload = jsonOf(r.stdout)
check("--only: a single package", payload?.results?.length === 1 && payload.results[0].package === "@playwright/mcp", r.stdout)
r = run(["check", "--only", "trivy,@playwright/mcp", "--json"], { cache: freshCache("only-list") })
payload = jsonOf(r.stdout)
check("--only: comma-separated list", payload?.results?.length === 2, r.stdout)
r = run(["check", "--only", "package-does-not-exist"], { cache: freshCache("only-bad") })
check("--only unknown: exit 2", r.status === 2 && /--only: unknown package/.test(r.stderr), r.stderr)

r = run(["check", "--ecosysteme", "npm", "--json"], { cache: freshCache("eco") })
payload = jsonOf(r.stdout)
check("--ecosysteme npm: 7 npm packages only",
  r.status === 0 && payload?.results?.length === 7 && payload.results.every((x) => x.ecosystem === "npm"), r.stdout)
r = run(["check", "--ecosysteme", "maven", "--json"], { cache: freshCache("eco-maven") })
payload = jsonOf(r.stdout)
check("--ecosysteme maven: valid, zero packages", r.status === 0 && payload?.results?.length === 0, r.stdout + r.stderr)
r = run(["check", "--ecosysteme", "rubygems"], { cache: freshCache("eco-bad") })
check("--ecosysteme invalid: exit 2", r.status === 2 && /unknown ecosystem/.test(r.stderr), r.stderr)

// --- 7. --refresh forwarded to oc-versions --------------------------------
cache = freshCache("refresh")
seedCache(cache, "github", { "aquasecurity/trivy": "v0.76.1" })
resetFixtures({ "github\u0000aquasecurity/trivy": "v0.77.0" })
r = run(["check", "--only", "trivy", "--json"], { cache })
payload = jsonOf(r.stdout)
check("without --refresh: fresh cache served", r.status === 0 && payload?.results?.[0]?.latest === "v0.76.1", r.stdout + r.stderr)
r = run(["check", "--only", "trivy", "--json", "--refresh"], { cache })
payload = jsonOf(r.stdout)
check("--refresh: source queried again and drift seen",
  r.status === 1 && payload?.results?.[0]?.latest === "v0.77.0"
  && payload.results[0].status === "drift", r.stdout + r.stderr)

// --- 8. --dry-run: proposed diff, no file modified -----------------------
resetFixtures({ "github\u0000aquasecurity/trivy": "v0.77.0" })
const before = fs.readFileSync(INSTALL_SH, "utf8")
r = run(["check", "--only", "trivy", "--dry-run"], { cache: freshCache("dry") })
check("--dry-run: proposed diff",
  r.status === 1 && /Proposed diff \(no file is modified\)/.test(r.stdout)
  && r.stdout.includes('-OC_TRIVY_VERSION="${OC_TRIVY_VERSION:-0.76.1}"')
  && r.stdout.includes('+OC_TRIVY_VERSION="${OC_TRIVY_VERSION:-0.77.0}"'), r.stdout + r.stderr)
check("--dry-run: install.sh unchanged", fs.readFileSync(INSTALL_SH, "utf8") === before)

// --- 9. CLI, help and guardrails ------------------------------------------
r = run([], { cache: freshCache("noargs") })
check("no argument: exit 2 and usage", r.status === 2 && /missing command/.test(r.stderr), r.stderr)
r = run(["fix"], { cache: freshCache("fix") })
check("fix does not exist: exit 2", r.status === 2 && /does not exist/.test(r.stderr), r.stderr)
r = run(["check", "--offline", "--refresh"], { cache: freshCache("conflict") })
check("--offline + --refresh: exit 2", r.status === 2 && /incompatible/.test(r.stderr), r.stderr)
r = run(["--help"], { cache: freshCache("help") })
check("--help: exit 0, manual update documented",
  r.status === 0 && /no automatic update/i.test(r.stdout) && /by hand/.test(r.stdout), r.stdout + r.stderr)
r = spawnSync(LAUNCHER, ["--help"], { encoding: "utf8", env: baseEnv, timeout: 20_000 })
check("launcher config/bin/oc-deps: wired to the Node ESM",
  r.status === 0 && /oc-deps — drift/.test(r.stdout), r.stdout + r.stderr)

fs.rmSync(TMP, { recursive: true, force: true })
console.log(failed ? `\n❌ ${failed} check(s) failed out of ${checks}` : `\n✅ oc-deps OK — ${checks} checks`)
process.exitCode = failed ? 1 : 0
