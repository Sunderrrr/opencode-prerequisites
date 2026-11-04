#!/usr/bin/env node
// oc-versions : dernières versions réelles des paquets, avec un cache disque de 24 h.
//
//   oc-versions npm @playwright/mcp
//   oc-versions pypi semgrep-mcp
//   oc-versions crates serde
//   oc-versions github owner/repo
//   oc-versions maven groupId:artifactId
//   oc-versions android
//
// Options : --json (machine), --refresh (ignore le cache), --help.
// Variables : OC_VERSIONS_TTL (heures, défaut 24), OC_VERSIONS_CACHE (dossier),
//             OC_VERSIONS_FIXTURES (dossier de fixtures : aucun réseau).
//
// Fixtures (tests) : <fixtures>/<écosystème>/<clé>.json ; les / et : de la clé
// deviennent __ (ex. npm/@scope__paquet.json, maven/groupe__artefact.json).
// Le preset android lit des XML : <fixtures>/android/<groupe>__<artefact>.xml.
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
  return `oc-versions — dernières versions réelles des paquets (cache ${DEFAULT_TTL} h)

Usage : oc-versions [--json] [--refresh] <écosystème> <paquet...>
        oc-versions [--json] [--refresh] android

Écosystèmes :
  npm       nom npm, ex. @playwright/mcp
  pypi      nom PyPI, ex. semgrep-mcp
  crates    nom crates.io, ex. serde
  github    owner/repo, dernière release GitHub
  maven     groupId:artifactId (search.maven.org)
  android   preset : AGP, Kotlin, Compose BOM, activity-compose (dernières stables)

Options :
  --json      sortie JSON pour les machines
  --refresh   ignore le cache et interroge la source
  --help      cette aide

Variables :
  OC_VERSIONS_TTL       durée du cache en heures (défaut : ${DEFAULT_TTL}, 0 = toujours expiré)
  OC_VERSIONS_CACHE     dossier du cache (défaut : ${CACHE_DIR})
  OC_VERSIONS_FIXTURES  dossier de fixtures pour les tests (aucun réseau)

Codes : 0 tout trouvé · 1 au moins un paquet introuvable · 2 usage invalide.`
}

// --- cache disque ---
const cacheFile = (eco) => path.join(CACHE_DIR, `${eco}.json`)

function loadCache(eco) {
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile(eco), "utf8"))
    if (data && data.entries && typeof data.entries === "object") return data
  } catch { /* cache absent ou illisible : on repart vide */ }
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
    try { fs.rmSync(tmp, { force: true }) } catch { /* rien à nettoyer */ }
    console.error(`⚠️  cache non écrit (${file}) : ${e.message}`)
  }
}

function ttlHours() {
  const raw = process.env.OC_VERSIONS_TTL
  if (raw === undefined || raw.trim() === "") return DEFAULT_TTL
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) die(`OC_VERSIONS_TTL invalide : "${raw}" (heures attendues, ex. 24 ou 0)`)
  return value
}

// --- sources (réseau ou fixtures) ---
function fixtureKey(key) {
  return key
    .replace(/[\\/:]/g, "__")
    .replace(/[^A-Za-z0-9._@-]/g, "_")
    .replace(/\.{2,}/g, "_")
}

function httpError(status, eco) {
  if (status === 404) return eco === "github" ? "introuvable ou privé (404)" : "introuvable (404)"
  if (status === 403) return "accès refusé (403) — limite de débit ou User-Agent refusé"
  if (status === 429) return "trop de requêtes (429) — réessaie plus tard"
  if (status >= 500) return `service indisponible (${status})`
  return `réponse HTTP ${status}`
}

async function readSource(eco, key, url, ext = "json") {
  if (FIXTURES) {
    const file = path.join(FIXTURES, eco, `${fixtureKey(key)}.${ext}`)
    try {
      return { body: fs.readFileSync(file, "utf8"), source: "fixture" }
    } catch (e) {
      if (e.code === "ENOENT") throw new Error(`fixture introuvable : ${file}`)
      throw new Error(`fixture illisible (${file}) : ${e.message}`)
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
    throw new Error(timeout ? `délai dépassé (${TIMEOUT_MS / 1000} s)` : `réseau indisponible : ${e.message}`)
  }
  if (!res.ok) throw new Error(httpError(res.status, eco))
  try {
    return { body: await res.text(), source: new URL(url).host }
  } catch (e) {
    throw new Error(`lecture de la réponse impossible : ${e.message}`)
  }
}

function parseJson(body, what) {
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`réponse ${what} illisible (JSON invalide)`)
  }
}

// --- résolveurs par écosystème ---
async function npmVersion(name) {
  const encoded = name.startsWith("@") ? name.replace("/", "%2F") : encodeURIComponent(name)
  const { body, source } = await readSource("npm", name, `https://registry.npmjs.org/${encoded}`)
  const data = parseJson(body, "npm")
  const version = data?.["dist-tags"]?.latest
  if (!version) throw new Error("dist-tags.latest absent de la réponse npm")
  return { version, source }
}

async function pypiVersion(name) {
  const { body, source } = await readSource("pypi", name, `https://pypi.org/pypi/${encodeURIComponent(name)}/json`)
  const data = parseJson(body, "PyPI")
  const version = data?.info?.version
  if (!version) throw new Error("info.version absent de la réponse PyPI")
  return { version, source }
}

async function cratesVersion(name) {
  const { body, source } = await readSource("crates", name, `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`)
  const data = parseJson(body, "crates.io")
  const crate = data?.crate
  const version = crate?.max_stable_version || crate?.max_version || crate?.newest_version
  if (!version) throw new Error("version absente de la réponse crates.io")
  return { version, source }
}

async function githubVersion(spec) {
  const m = spec.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  if (!m) throw new Error("format attendu : owner/repo")
  const { body, source } = await readSource("github", spec, `https://api.github.com/repos/${m[1]}/${m[2]}/releases/latest`)
  const data = parseJson(body, "GitHub")
  const version = data?.tag_name
  if (!version) throw new Error("tag_name absent (dépôt sans release ?)")
  return { version, source }
}

function parseMaven(spec) {
  const i = spec.indexOf(":")
  const g = i > 0 ? spec.slice(0, i) : ""
  const a = i > 0 ? spec.slice(i + 1) : ""
  if (!g || !a || spec.indexOf(":", i + 1) !== -1 || !/^[A-Za-z0-9_.-]+$/.test(g) || !/^[A-Za-z0-9_.-]+$/.test(a)) {
    throw new Error("format attendu : groupId:artifactId")
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
  if (!version) throw new Error(`aucun résultat Maven pour ${g}:${a}`)
  return { version, source }
}

// Preset android : dernière version stable (les alpha/beta/RC ne sont pas proposées).
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
  if (!version) throw new Error(`version absente de maven-metadata.xml (${key})`)
  return { version, source }
}

const LOOKUP = {
  npm: npmVersion,
  pypi: pypiVersion,
  crates: cratesVersion,
  github: githubVersion,
  maven: mavenVersion,
}

// --- programme principal ---
async function main() {
  const opts = { json: false, refresh: false }
  const operands = []
  for (const arg of process.argv.slice(2)) {
    if (arg === "--json") opts.json = true
    else if (arg === "--refresh") opts.refresh = true
    else if (arg === "--help" || arg === "-h") { console.log(usage()); return }
    else if (arg.startsWith("-")) die(`option inconnue : ${arg}\n\n${usage()}`)
    else operands.push(arg)
  }

  const [eco, ...packages] = operands
  if (!eco) die(`écosystème manquant\n\n${usage()}`)
  if (!ECOSYSTEMS.includes(eco)) die(`écosystème inconnu : "${eco}". Valides : ${ECOSYSTEMS.join(", ")}`)
  if (eco === "android" && packages.length) die("le preset android ne prend pas de paquet : lance « oc-versions android »")
  if (eco !== "android" && !packages.length) die(`aucun paquet : oc-versions ${eco} <paquet...>`)

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
        // Expiré / refresh demandé, mais la source ne répond pas : on garde la dernière version connue.
        results.push({ package: display, ...identity, version: hit.version, cached: true, expired: true, source: hit.source })
        console.error(`⚠️  ${display} : cache expiré et récupération impossible (${e.message}) ; version du cache conservée`)
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
      if (!name) { errors.push({ package: raw, error: "nom vide" }); continue }
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
      const state = r.expired ? "expiré" : "frais"
      console.log(`${r.package.padEnd(width)}  ${r.version}  (cache: ${state}, ${r.source})`)
    }
    for (const e of errors) console.error(`❌ ${e.package} : ${e.error}`)
  }

  process.exitCode = errors.length ? 1 : 0
}

main().catch((e) => {
  console.error(`❌ ${e.message}`)
  process.exitCode = 1
})
