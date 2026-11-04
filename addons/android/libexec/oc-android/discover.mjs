#!/usr/bin/env node
// Discovers, from the OFFICIAL sources, what it takes to build the Android image:
//   node discover.mjs <api>   →  KEY=value lines (safe for `eval`): API, CLT_URL, CLT_SHA1, BUILD_TOOLS,
//                                GRADLE_VERSION, GRADLE_URL, GRADLE_SHA256
// Sources: dl.google.com (SDK catalog + system images) and services.gradle.org.
// OC_ANDROID_FIXTURES=<dir> reads repository2-3.xml, sys-img2-3.xml and gradle-current.json instead of the network (tests).
import fs from "node:fs"
import path from "node:path"

const api = process.argv[2] || "36"
const BASE = "https://dl.google.com/android/repository"
const fixtures = process.env.OC_ANDROID_FIXTURES

async function get(name, url) {
  if (fixtures) return fs.readFileSync(path.join(fixtures, name), "utf8")
  const res = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { "user-agent": "opencode-prerequisites" } })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.text()
}
const fail = (m) => { console.error(`❌ ${m}`); process.exit(1) }
const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`

try {
  const [repo, sysimg, gradleJson] = await Promise.all([
    get("repository2-3.xml", `${BASE}/repository2-3.xml`),
    get("sys-img2-3.xml", `${BASE}/sys-img/google_apis/sys-img2-3.xml`),
    get("gradle-current.json", "https://services.gradle.org/versions/current"),
  ])

  // 1. Command-line tools (Linux archive + SHA-1 published by Google)
  const pkg = repo.match(/<remotePackage path="cmdline-tools;latest"[^>]*>[\s\S]*?<\/remotePackage>/)?.[0]
  if (!pkg) fail("cmdline-tools;latest package not found in the Google catalog")
  const archive = [...pkg.matchAll(/<archive>[\s\S]*?<\/archive>/g)].map((m) => m[0]).find((a) => /<host-os>linux<\/host-os>/.test(a))
  const cltFile = archive?.match(/<url>([^<]+)<\/url>/)?.[1]
  const cltSha1 = archive?.match(/<checksum type="sha1">([0-9a-f]{40})<\/checksum>/)?.[1]
  if (!cltFile || !cltSha1) fail("Linux archive for the command-line tools not found")

  // 2. Latest stable build-tools
  const tools = [...repo.matchAll(/<remotePackage path="build-tools;(\d+)\.(\d+)\.(\d+)"/g)].map((m) => m.slice(1, 4).map(Number))
  if (!tools.length) fail("no stable build-tools in the catalog")
  tools.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
  const buildTools = tools.at(-1).join(".")

  // 3. Emulator system image for that API
  const apis = [...sysimg.matchAll(/<remotePackage path="system-images;android-([\d.]+);google_apis;x86_64"/g)].map((m) => m[1])
  if (!apis.includes(api)) fail(`no system image (google_apis x86_64) for API ${api}. Available: ${apis.join(", ")}`)
  if (!new RegExp(`<remotePackage path="platforms;android-${api.replace(/\./g, "\\.")}"`).test(repo)) fail(`android-${api} platform missing from the catalog`)

  // 4. Current Gradle
  const g = JSON.parse(gradleJson)
  if (!g.version || !g.downloadUrl || !/^[0-9a-f]{64}$/.test(g.checksum ?? "")) fail("unexpected Gradle response")

  const out = { API: api, CLT_URL: `${BASE}/${cltFile}`, CLT_SHA1: cltSha1, BUILD_TOOLS: buildTools, GRADLE_VERSION: g.version, GRADLE_URL: g.downloadUrl, GRADLE_SHA256: g.checksum }
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${q(v)}`)
} catch (e) {
  fail(`discovery failed: ${e.message}`)
}
