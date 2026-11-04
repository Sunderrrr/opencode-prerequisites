#!/usr/bin/env node
// oc-versions: latest real package versions, with a 24 h disk cache.
//
//   oc-versions npm @playwright/mcp
//   oc-versions pypi semgrep-mcp
//   oc-versions crates serde
//   oc-versions github owner/repo
//   oc-versions maven groupId:artifactId
//   oc-versions android
//
// Options: --json (machine), --refresh (ignore the cache), --help.
// Variables: OC_VERSIONS_TTL (hours, default 24), OC_VERSIONS_CACHE (directory),
//            OC_VERSIONS_FIXTURES (fixtures directory: no network).
//
// Fixtures (tests): <fixtures>/<ecosystem>/<key>.json; the / and : of the key
// become __ (e.g. npm/@scope__package.json, maven/group__artifact.json).
// The android preset reads XML: <fixtures>/android/<group>__<artifact>.xml.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const UA = "oc-versions/1.0 (+https://github.com/Sunderrrr/opencode-prerequisites)"
const TIMEOUT_MS = 10_000
const DEFAULT_TTL = 24
const ECOSYSTEMS = ["npm", "pypi", "crates", "github", "maven", "android"]

const CACHE_DIR = process.env.OC_VERSIONS_CACHE?.trim()
  || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "opencode-versions")
const FIXTURES = process.env.OC_VERSIONS_FIXTURES?.trim() || ""

function die(message, code = 2) {
  console.error(`❌ ${message}`)
  process.exit(code)
}

function usage() {
  return `oc-versions — latest real package versions (${DEFAULT_TTL} h cache)

Usage: oc-versions [--json] [--refresh] <ecosystem> <package...>
       oc-versions [--json] [--refresh] android

Ecosystems:
  npm       npm name, e.g. @playwright/mcp
  pypi      PyPI name, e.g. semgrep-mcp
  crates    crates.io name, e.g. serde
  github    owner/repo, latest GitHub release
  maven     groupId:artifactId (search.maven.org)
  android   preset: AGP, Kotlin, Compose BOM, activity-compose (latest stable)

Options:
  --json      machine-readable JSON output
  --refresh   ignore the cache and query the source
  --help      this help

Variables:
  OC_VERSIONS_TTL       cache lifetime in hours (default: ${DEFAULT_TTL}, 0 = always expired)
  OC_VERSIONS_CACHE     cache directory (default: ${CACHE_DIR})
  OC_VERSIONS_FIXTURES  fixtures directory for tests (no network)

Exit codes: 0 all found · 1 at least one package not found · 2 invalid usage.`
}

// --- disk cache ---
const cacheFile = (eco) => path.join(CACHE_DIR, `${eco}.json`)

function loadCache(eco) {
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile(eco), "utf8"))
    if (data && data.entries && typeof data.entries === "object") return data
  } catch { /* cache missing or unreadable: start empty */ }
  return { version: 1, entries: {} }
}

function saveCache(eco, cache) {
  const file = cacheFile(eco)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n")
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* nothing to clean up */ }
    console.error(`⚠️  cache not written (${file}): ${e.message}`)
  }
}

function ttlHours() {
  const raw = process.env.OC_VERSIONS_TTL
  if (raw === undefined || raw.trim() === "") return DEFAULT_TTL
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) die(`invalid OC_VERSIONS_TTL: "${raw}" (hours expected, e.g. 24 or 0)`)
  return value
}

// --- sources (network or fixtures) ---
function fixtureKey(key) {
  return key
    .replace(/[\\/:]/g, "__")
    .replace(/[^A-Za-z0-9._@-]/g, "_")
    .replace(/\.{2,}/g, "_")
}

function httpError(status, eco) {
  if (status === 404) return eco === "github" ? "not found or private (404)" : "not found (404)"
  if (status === 403) return "access denied (403) — rate limit or rejected User-Agent"
  if (status === 429) return "too many requests (429) — retry later"
  if (status >= 500) return `service unavailable (${status})`
  return `HTTP response ${status}`
}

async function readSource(eco, key, url, ext = "json") {
  if (FIXTURES) {
    const file = path.join(FIXTURES, eco, `${fixtureKey(key)}.${ext}`)
    try {
      return { body: fs.readFileSync(file, "utf8"), source: "fixture" }
    } catch (e) {
      if (e.code === "ENOENT") throw new Error(`fixture not found: ${file}`)
      throw new Error(`unreadable fixture (${file}): ${e.message}`)
    }
  }

  let res
  try {
    res = await fetch(url, {
      headers: {
        "user-agent": UA,
        accept: ext === "xml" ? "application/xml, text/xml, */*" : "application/json, */*",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    const timeout = e?.name === "TimeoutError" || e?.name === "AbortError"
    throw new Error(timeout ? `timed out (${TIMEOUT_MS / 1000} s)` : `network unavailable: ${e.message}`)
  }
  if (!res.ok) throw new Error(httpError(res.status, eco))
  try {
    return { body: await res.text(), source: new URL(url).host }
  } catch (e) {
    throw new Error(`cannot read response: ${e.message}`)
  }
}

function parseJson(body, what) {
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`unreadable ${what} response (invalid JSON)`)
  }
}

// --- per-ecosystem resolvers ---
async function npmVersion(name) {
  const encoded = name.startsWith("@") ? name.replace("/", "%2F") : encodeURIComponent(name)
  const { body, source } = await readSource("npm", name, `https://registry.npmjs.org/${encoded}`)
  const data = parseJson(body, "npm")
  const version = data?.["dist-tags"]?.latest
  if (!version) throw new Error("missing dist-tags.latest in npm response")
  return { version, source }
}

async function pypiVersion(name) {
  const { body, source } = await readSource("pypi", name, `https://pypi.org/pypi/${encodeURIComponent(name)}/json`)
  const data = parseJson(body, "PyPI")
  const version = data?.info?.version
  if (!version) throw new Error("missing info.version in PyPI response")
  return { version, source }
}

async function cratesVersion(name) {
  const { body, source } = await readSource("crates", name, `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`)
  const data = parseJson(body, "crates.io")
  const crate = data?.crate
  const version = crate?.max_stable_version || crate?.max_version || crate?.newest_version
  if (!version) throw new Error("missing version in crates.io response")
  return { version, source }
}

async function githubVersion(spec) {
  const m = spec.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  if (!m) throw new Error("expected format: owner/repo")
  const { body, source } = await readSource("github", spec, `https://api.github.com/repos/${m[1]}/${m[2]}/releases/latest`)
  const data = parseJson(body, "GitHub")
  const version = data?.tag_name
  if (!version) throw new Error("missing tag_name (repository without releases?)")
  return { version, source }
}

function parseMaven(spec) {
  const i = spec.indexOf(":")
  const g = i > 0 ? spec.slice(0, i) : ""
  const a = i > 0 ? spec.slice(i + 1) : ""
  if (!g || !a || spec.indexOf(":", i + 1) !== -1 || !/^[A-Za-z0-9_.-]+$/.test(g) || !/^[A-Za-z0-9_.-]+$/.test(a)) {
    throw new Error("expected format: groupId:artifactId")
  }
  return [g, a]
}

async function mavenVersion(spec) {
  const [g, a] = parseMaven(spec)
  const q = encodeURIComponent(`g:"${g}" AND a:"${a}"`)
  const { body, source } = await readSource("maven", spec, `https://search.maven.org/solrsearch/select?q=${q}&rows=1&wt=json`)
  const data = parseJson(body, "Maven")
  const doc = data?.response?.docs?.[0]
  const version = doc?.latestVersion ?? doc?.v
  if (!version) throw new Error(`no Maven result for ${g}:${a}`)
  return { version, source }
}

// Android preset: latest stable version (alpha/beta/RC are not offered).
const ANDROID = [
  { label: "AGP", group: "com.android.tools.build", artifact: "gradle", repo: "google" },
  { label: "Kotlin", group: "org.jetbrains.kotlin", artifact: "kotlin-gradle-plugin", repo: "central" },
  { label: "Compose BOM", group: "androidx.compose", artifact: "compose-bom", repo: "google" },
  { label: "activity-compose", group: "androidx.activity", artifact: "activity-compose", repo: "google" },
]

const PRERELEASE = /(?:^|[-.])(?:alpha|beta|rc|dev|snapshot|preview|eap|m)[0-9]*(?:[-.]|$)/i

function xmlTag(xml, tag) {
  return xml.match(new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`))?.[1]
}

function stableVersion(xml) {
  const versions = [...xml.matchAll(/<version>\s*([^<]+?)\s*<\/version>/g)].map((m) => m[1])
  const stable = versions.filter((v) => !PRERELEASE.test(v))
  return stable.at(-1) || xmlTag(xml, "release") || xmlTag(xml, "latest") || versions.at(-1)
}

function androidUrl({ group, artifact, repo }) {
  const base = repo === "google"
    ? "https://dl.google.com/dl/android/maven2"
    : "https://repo1.maven.org/maven2"
  return `${base}/${group.replace(/\./g, "/")}/${artifact}/maven-metadata.xml`
}

async function androidVersion(art) {
  const key = `${art.group}:${art.artifact}`
  const { body, source } = await readSource("android", key, androidUrl(art), "xml")
  const version = stableVersion(body)
  if (!version) throw new Error(`missing version in maven-metadata.xml (${key})`)
  return { version, source }
}

const LOOKUP = {
  npm: npmVersion,
  pypi: pypiVersion,
  crates: cratesVersion,
  github: githubVersion,
  maven: mavenVersion,
}

// --- main program ---
async function main() {
  const opts = { json: false, refresh: false }
  const operands = []
  for (const arg of process.argv.slice(2)) {
    if (arg === "--json") opts.json = true
    else if (arg === "--refresh") opts.refresh = true
    else if (arg === "--help" || arg === "-h") { console.log(usage()); return }
    else if (arg.startsWith("-")) die(`unknown option: ${arg}\n\n${usage()}`)
    else operands.push(arg)
  }

  const [eco, ...packages] = operands
  if (!eco) die(`missing ecosystem\n\n${usage()}`)
  if (!ECOSYSTEMS.includes(eco)) die(`unknown ecosystem: "${eco}". Valid: ${ECOSYSTEMS.join(", ")}`)
  if (eco === "android" && packages.length) die('the android preset takes no package: run "oc-versions android"')
  if (eco !== "android" && !packages.length) die(`no package: oc-versions ${eco} <package...>`)

  const ttlH = ttlHours()
  const ttlMs = ttlH * 3_600_000
  const cache = loadCache(eco)
  const now = Date.now()
  const results = []
  const errors = []
  let dirty = false

  async function handle(display, key, resolve) {
    const entry = cache.entries[key]
    const hit = entry && typeof entry.version === "string" && typeof entry.fetchedAt === "number" ? entry : null
    const fresh = hit && now - hit.fetchedAt < ttlMs
    const identity = key === display ? {} : { coordinate: key }

    if (!opts.refresh && fresh) {
      results.push({ package: display, ...identity, version: hit.version, cached: true, expired: false, source: hit.source })
      return
    }

    try {
      const got = await resolve()
      results.push({ package: display, ...identity, version: got.version, cached: false, expired: false, source: got.source })
      cache.entries[key] = { version: got.version, source: got.source, fetchedAt: Date.now() }
      dirty = true
    } catch (e) {
      if (hit) {
        // Expired / refresh requested, but the source does not answer: keep the last known version.
        results.push({ package: display, ...identity, version: hit.version, cached: true, expired: true, source: hit.source })
        console.error(`⚠️  ${display}: cache expired and refresh failed (${e.message}); keeping cached version`)
      } else {
        errors.push({ package: display, ...identity, error: e.message })
      }
    }
  }

  if (eco === "android") {
    for (const art of ANDROID) await handle(art.label, `${art.group}:${art.artifact}`, () => androidVersion(art))
  } else {
    for (const raw of packages) {
      const name = raw.trim()
      if (!name) { errors.push({ package: raw, error: "empty name" }); continue }
      await handle(name, name, () => LOOKUP[eco](name))
    }
  }

  if (dirty) saveCache(eco, cache)

  if (opts.json) {
    console.log(JSON.stringify({
      ecosystem: eco,
      ttl_hours: ttlH,
      generated_at: new Date(now).toISOString(),
      results,
      errors,
    }, null, 2))
  } else {
    const width = Math.max(0, ...results.map((r) => r.package.length))
    for (const r of results) {
      const state = r.expired ? "expired" : "fresh"
      console.log(`${r.package.padEnd(width)}  ${r.version}  (cache: ${state}, ${r.source})`)
    }
    for (const e of errors) console.error(`❌ ${e.package}: ${e.error}`)
  }

  process.exitCode = errors.length ? 1 : 0
}

main().catch((e) => {
  console.error(`❌ ${e.message}`)
  process.exitCode = 1
})
