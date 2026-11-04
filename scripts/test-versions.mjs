#!/usr/bin/env node
// Tests hermétiques de oc-versions : fixtures locales, aucun accès réseau.
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

// Même transformation que l'outil : / et : deviennent __.
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

// --- fixtures : des versions volontairement fausses (si le réseau était appelé, le test échouerait) ---
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

// --- un écosystème à la fois ---
let r = run(["npm", "@playwright/mcp"])
check("npm : version affichée avec cache et source",
  r.status === 0 && /^@playwright\/mcp\s+0\.0\.99-test\s+\(cache: frais, fixture\)$/m.test(r.stdout), r.stderr)
check("npm : cache écrit (npm.json)", fs.existsSync(path.join(CACHE, "npm.json")))

r = run(["pypi", "semgrep-mcp"])
check("pypi : info.version lue", r.status === 0 && r.stdout.includes("9.9.9-test"), r.stderr)

r = run(["crates", "serde"])
check("crates : max_stable_version prioritaire sur max_version",
  r.status === 0 && r.stdout.includes("9.9.9-test") && !r.stdout.includes("10.0.0-test"), r.stderr)

r = run(["github", "Sunderrrr/opencode-prerequisites"])
check("github : tag de la dernière release", r.status === 0 && r.stdout.includes("v9.9.9-test"), r.stderr)

r = run(["maven", "com.google.guava:guava"])
check("maven : latestVersion de search.maven.org", r.status === 0 && r.stdout.includes("9.9.9-test"), r.stderr)

r = run(["android"])
check("android : 4 artefacts résolus",
  r.status === 0 && /^AGP\s+9\.5\.0\s/m.test(r.stdout) && /^Kotlin\s+2\.2\.20\s/m.test(r.stdout)
  && /^Compose BOM\s+2026\.09\.00\s/m.test(r.stdout) && /^activity-compose\s+1\.13\.0\s/m.test(r.stdout),
  r.stdout + r.stderr)
check("android : alpha/beta/RC ignorés",
  !/9\.6\.0-alpha02|2\.3\.0-RC2|1\.14\.0-alpha03/.test(r.stdout))

// --- paquet inconnu : code 1, sans bloquer les autres ---
r = run(["npm", "@playwright/mcp", "paquet-inexistant-oc-versions"])
check("paquet inconnu : code 1 mais les autres paquets sont rendus",
  r.status === 1 && r.stdout.includes("0.0.99-test") && /fixture introuvable/.test(r.stderr), r.stdout + r.stderr)

// --- cache frais : plus aucune source disponible, la 2e lecture doit venir du cache ---
put("npm", "@playwright/mcp", { name: "@playwright/mcp", "dist-tags": { latest: "0.0.100-test" } })
fs.rmSync(FIX, { recursive: true, force: true })
r = run(["npm", "@playwright/mcp"])
check("cache frais : 2e appel sans source (fixtures supprimées), version du cache servie",
  r.status === 0 && r.stdout.includes("0.0.99-test") && r.stdout.includes("(cache: frais"), r.stderr)

// --- cache expiré : TTL 0 force la réinterrogation, qui voit la nouvelle fixture ---
put("npm", "@playwright/mcp", { name: "@playwright/mcp", "dist-tags": { latest: "0.0.100-test" } })
r = run(["--json", "npm", "@playwright/mcp"], { ttl: 0 })
let payload = jsonOf(r.stdout)
check("cache expiré (TTL 0) : source réinterrogée et cache marqué non servi",
  r.status === 0 && payload?.results?.[0]?.version === "0.0.100-test"
  && payload.results[0].cached === false && payload.results[0].expired === false, r.stdout + r.stderr)

// --- --refresh : ignore un cache pourtant frais ---
put("npm", "@playwright/mcp", { name: "@playwright/mcp", "dist-tags": { latest: "0.0.101-test" } })
r = run(["npm", "@playwright/mcp"])
check("sans --refresh : le cache frais reste servi",
  r.status === 0 && r.stdout.includes("0.0.100-test") && !r.stdout.includes("0.0.101-test"), r.stderr)
r = run(["--refresh", "npm", "@playwright/mcp"])
check("--refresh : force la source et met le cache à jour",
  r.status === 0 && r.stdout.includes("0.0.101-test") && r.stdout.includes("(cache: frais, fixture)"), r.stderr)

// --- source injoignable + cache expiré : version conservée, état « expiré » visible ---
fs.rmSync(FIX, { recursive: true, force: true })
r = run(["--json", "npm", "@playwright/mcp"], { ttl: 0 })
payload = jsonOf(r.stdout)
check("cache expiré sans source : dernière version conservée et marquée expirée",
  r.status === 0 && payload?.results?.[0]?.version === "0.0.101-test"
  && payload.results[0].expired === true && /cache expiré/.test(r.stderr), r.stdout + r.stderr)

// --- sortie --json exploitable par une machine ---
put("pypi", "semgrep-mcp", { info: { version: "9.9.9-test" } })
r = run(["--json", "pypi", "semgrep-mcp"])
payload = jsonOf(r.stdout)
check("--json : écosystème, résultat, source et erreurs vides",
  r.status === 0 && payload?.ecosystem === "pypi" && payload.results?.[0]?.package === "semgrep-mcp"
  && payload.results[0].version === "9.9.9-test" && payload.results[0].source === "fixture"
  && Array.isArray(payload.errors) && payload.errors.length === 0, r.stdout + r.stderr)

r = run(["--json", "pypi", "paquet-absent"])
payload = jsonOf(r.stdout)
check("--json : paquet inconnu = erreur structurée + code 1",
  r.status === 1 && payload?.results?.length === 0 && payload?.errors?.[0]?.package === "paquet-absent", r.stdout + r.stderr)

// --- usage, lanceur, entrées invalides ---
r = spawnSync(process.execPath, [TOOL, "--help"], { encoding: "utf8", env: baseEnv })
check("--help : code 0 et variables documentées",
  r.status === 0 && r.stdout.includes("Usage :") && r.stdout.includes("OC_VERSIONS_FIXTURES"), r.stderr)

r = spawnSync(LAUNCHER, ["--help"], { encoding: "utf8", env: baseEnv })
check("lanceur config/bin/oc-versions : câblé sur le Node ESM",
  r.status === 0 && r.stdout.includes("Usage :"), r.stderr)

r = run(["rubygems", "rails"])
check("écosystème inconnu : code 2", r.status === 2 && /écosystème inconnu/.test(r.stderr), r.stderr)

r = run(["npm", "x"], { ttl: "abc" })
check("OC_VERSIONS_TTL invalide : code 2", r.status === 2 && /OC_VERSIONS_TTL invalide/.test(r.stderr), r.stderr)

r = run(["maven", "pas-de-deux-points"])
check("maven : coordonnée invalide signalée, code 1",
  r.status === 1 && /groupId:artifactId/.test(r.stderr), r.stderr)

fs.rmSync(TMP, { recursive: true, force: true })
console.log(failed ? `\n❌ ${failed} contrôle(s) en échec sur ${checks}` : `\n✅ oc-versions OK — ${checks} contrôles`)
process.exitCode = failed ? 1 : 0
