#!/usr/bin/env node
// Hermetic oc-versions tests: local fixtures, no network access.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TOOL = path.join(ROOT, "config", "libexec", "oc-versions.mjs")
const LAUNCHER = path.join(ROOT, "config", "bin", "oc-versions")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oc-versions-test-"))
const FIX = path.join(TMP, "fixtures")
const CACHE = path.join(TMP, "cache")

let checks = 0
let failed = 0
const check = (name, cond, detail = "") => {
  checks++
  if (!cond) failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`)
}
const jsonOf = (text) => { try { return JSON.parse(text) } catch { return null } }

const baseEnv = { ...process.env }
for (const key of ["OC_VERSIONS_TTL", "OC_VERSIONS_CACHE", "OC_VERSIONS_FIXTURES", "OPENCODE_CONFIG_DIR"]) delete baseEnv[key]
const run = (args, { ttl, fixtures = FIX, cache = CACHE } = {}) => {
  const env = { ...baseEnv, OC_VERSIONS_CACHE: cache }
  if (fixtures) env.OC_VERSIONS_FIXTURES = fixtures
  if (ttl !== undefined) env.OC_VERSIONS_TTL = String(ttl)
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", env, timeout: 20_000 })
}

// Same transformation as the tool: / and : become __.
const fixKey = (key) => key.replace(/[\\/:]/g, "__").replace(/[^A-Za-z0-9._@-]/g, "_").replace(/\.{2,}/g, "_")
const put = (eco, key, data, ext = "json") => {
  const file = path.join(FIX, eco, `${fixKey(key)}.${ext}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data))
}
const metadata = (group, artifact, versions) => `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>${group}</groupId>
  <artifactId>${artifact}</artifactId>
  <versioning>
    <latest>${versions.at(-1)}</latest>
    <release>${versions.at(-1)}</release>
    <versions>
${versions.map((v) => `      <version>${v}</version>`).join("\n")}
    </versions>
  </versioning>
</metadata>
`

// --- fixtures: deliberately fake versions (the test would fail if the network were called) ---
put("npm", "@playwright/mcp", { name: "@playwright/mcp", "dist-tags": { latest: "0.0.99-test" } })
put("pypi", "semgrep-mcp", { info: { version: "9.9.9-test" } })
put("crates", "serde", { crate: { max_stable_version: "9.9.9-test", max_version: "10.0.0-test" } })
put("github", "Sunderrrr/opencode-prerequisites", { tag_name: "v9.9.9-test" })
put("maven", "com.google.guava:guava", { response: { docs: [{ latestVersion: "9.9.9-test" }] } })
put("android", "com.android.tools.build:gradle",
  metadata("com.android.tools.build", "gradle", ["9.4.0", "9.5.0-alpha01", "9.5.0-beta01", "9.5.0", "9.6.0-alpha02"]), "xml")
put("android", "org.jetbrains.kotlin:kotlin-gradle-plugin",
  metadata("org.jetbrains.kotlin", "kotlin-gradle-plugin", ["2.2.0", "2.2.20", "2.3.0-RC2"]), "xml")
put("android", "androidx.compose:compose-bom",
  metadata("androidx.compose", "compose-bom", ["2026.08.00", "2026.09.00-alpha01", "2026.09.00"]), "xml")
put("android", "androidx.activity:activity-compose",
  metadata("androidx.activity", "activity-compose", ["1.13.0", "1.14.0-alpha03"]), "xml")

// --- one ecosystem at a time ---
let r = run(["npm", "@playwright/mcp"])
check("npm: version shown with cache and source",
  r.status === 0 && /^@playwright\/mcp\s+0\.0\.99-test\s+\(cache: fresh, fixture\)$/m.test(r.stdout), r.stderr)
check("npm: cache written (npm.json)", fs.existsSync(path.join(CACHE, "npm.json")))

r = run(["pypi", "semgrep-mcp"])
check("pypi: info.version read", r.status === 0 && r.stdout.includes("9.9.9-test"), r.stderr)

r = run(["crates", "serde"])
check("crates: max_stable_version takes precedence over max_version",
  r.status === 0 && r.stdout.includes("9.9.9-test") && !r.stdout.includes("10.0.0-test"), r.stderr)

r = run(["github", "Sunderrrr/opencode-prerequisites"])
check("github: latest release tag", r.status === 0 && r.stdout.includes("v9.9.9-test"), r.stderr)

r = run(["maven", "com.google.guava:guava"])
check("maven: latestVersion from search.maven.org", r.status === 0 && r.stdout.includes("9.9.9-test"), r.stderr)

r = run(["android"])
check("android: 4 artifacts resolved",
  r.status === 0 && /^AGP\s+9\.5\.0\s/m.test(r.stdout) && /^Kotlin\s+2\.2\.20\s/m.test(r.stdout)
  && /^Compose BOM\s+2026\.09\.00\s/m.test(r.stdout) && /^activity-compose\s+1\.13\.0\s/m.test(r.stdout),
  r.stdout + r.stderr)
check("android: alpha/beta/RC ignored",
  !/9\.6\.0-alpha02|2\.3\.0-RC2|1\.14\.0-alpha03/.test(r.stdout))

// --- unknown package: exit 1, without blocking the others ---
r = run(["npm", "@playwright/mcp", "missing-package-oc-versions"])
check("unknown package: exit 1 but other packages are still rendered",
  r.status === 1 && r.stdout.includes("0.0.99-test") && /fixture not found/.test(r.stderr), r.stdout + r.stderr)

// --- fresh cache: no source left, the 2nd read must come from the cache ---
put("npm", "@playwright/mcp", { name: "@playwright/mcp", "dist-tags": { latest: "0.0.100-test" } })
fs.rmSync(FIX, { recursive: true, force: true })
r = run(["npm", "@playwright/mcp"])
check("fresh cache: 2nd call without source (fixtures removed), cached version served",
  r.status === 0 && r.stdout.includes("0.0.99-test") && r.stdout.includes("(cache: fresh"), r.stderr)

// --- expired cache: TTL 0 forces a new query, which sees the new fixture ---
put("npm", "@playwright/mcp", { name: "@playwright/mcp", "dist-tags": { latest: "0.0.100-test" } })
r = run(["--json", "npm", "@playwright/mcp"], { ttl: 0 })
let payload = jsonOf(r.stdout)
check("expired cache (TTL 0): source queried again and cache marked as not served",
  r.status === 0 && payload?.results?.[0]?.version === "0.0.100-test"
  && payload.results[0].cached === false && payload.results[0].expired === false, r.stdout + r.stderr)

// --- --refresh: ignores an otherwise fresh cache ---
put("npm", "@playwright/mcp", { name: "@playwright/mcp", "dist-tags": { latest: "0.0.101-test" } })
r = run(["npm", "@playwright/mcp"])
check("without --refresh: fresh cache is still served",
  r.status === 0 && r.stdout.includes("0.0.100-test") && !r.stdout.includes("0.0.101-test"), r.stderr)
r = run(["--refresh", "npm", "@playwright/mcp"])
check("--refresh: forces the source and updates the cache",
  r.status === 0 && r.stdout.includes("0.0.101-test") && r.stdout.includes("(cache: fresh, fixture)"), r.stderr)

// --- unreachable source + expired cache: version kept, "expired" state visible ---
fs.rmSync(FIX, { recursive: true, force: true })
r = run(["--json", "npm", "@playwright/mcp"], { ttl: 0 })
payload = jsonOf(r.stdout)
check("expired cache without source: last version kept and marked expired",
  r.status === 0 && payload?.results?.[0]?.version === "0.0.101-test"
  && payload.results[0].expired === true && /cache expired/.test(r.stderr), r.stdout + r.stderr)

// --- --json output usable by a machine ---
put("pypi", "semgrep-mcp", { info: { version: "9.9.9-test" } })
r = run(["--json", "pypi", "semgrep-mcp"])
payload = jsonOf(r.stdout)
check("--json: ecosystem, result, source and empty errors",
  r.status === 0 && payload?.ecosystem === "pypi" && payload.results?.[0]?.package === "semgrep-mcp"
  && payload.results[0].version === "9.9.9-test" && payload.results[0].source === "fixture"
  && Array.isArray(payload.errors) && payload.errors.length === 0, r.stdout + r.stderr)

r = run(["--json", "pypi", "missing-package"])
payload = jsonOf(r.stdout)
check("--json: unknown package = structured error + exit 1",
  r.status === 1 && payload?.results?.length === 0 && payload?.errors?.[0]?.package === "missing-package", r.stdout + r.stderr)

// --- usage, launcher, invalid input ---
r = spawnSync(process.execPath, [TOOL, "--help"], { encoding: "utf8", env: baseEnv })
check("--help: exit 0 and documented variables",
  r.status === 0 && r.stdout.includes("Usage:") && r.stdout.includes("OC_VERSIONS_FIXTURES"), r.stderr)

r = spawnSync(LAUNCHER, ["--help"], { encoding: "utf8", env: baseEnv })
check("launcher config/bin/oc-versions: wired to the Node ESM",
  r.status === 0 && r.stdout.includes("Usage:"), r.stderr)

r = run(["rubygems", "rails"])
check("unknown ecosystem: exit 2", r.status === 2 && /unknown ecosystem/.test(r.stderr), r.stderr)

r = run(["npm", "x"], { ttl: "abc" })
check("invalid OC_VERSIONS_TTL: exit 2", r.status === 2 && /invalid OC_VERSIONS_TTL/.test(r.stderr), r.stderr)

r = run(["maven", "no-colon-here"])
check("maven: invalid coordinate reported, exit 1",
  r.status === 1 && /groupId:artifactId/.test(r.stderr), r.stderr)

fs.rmSync(TMP, { recursive: true, force: true })
console.log(failed ? `\n❌ ${failed} check(s) failed out of ${checks}` : `\n✅ oc-versions OK — ${checks} checks`)
process.exitCode = failed ? 1 : 0
