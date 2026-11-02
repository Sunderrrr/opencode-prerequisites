#!/usr/bin/env node
// Découvre, depuis les sources OFFICIELLES, ce qu'il faut pour construire l'image Android :
//   node discover.mjs <api>   →  lignes CLE=valeur (sûres pour `eval`) : API, CLT_URL, CLT_SHA1, BUILD_TOOLS,
//                                GRADLE_VERSION, GRADLE_URL, GRADLE_SHA256
// Sources : dl.google.com (catalogue du SDK + images système) et services.gradle.org.
// OC_ANDROID_FIXTURES=<dossier> lit repository2-3.xml, sys-img2-3.xml et gradle-current.json à la place du réseau (tests).
import fs from "node:fs"
import path from "node:path"

const api = process.argv[2] || "36"
const BASE = "https://dl.google.com/android/repository"
const fixtures = process.env.OC_ANDROID_FIXTURES

async function get(name, url) {
  if (fixtures) return fs.readFileSync(path.join(fixtures, name), "utf8")
  const res = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { "user-agent": "opencode-prerequisites" } })
  if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`)
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

  // 1. Outils en ligne de commande (archive Linux + SHA-1 annoncé par Google)
  const pkg = repo.match(/<remotePackage path="cmdline-tools;latest"[^>]*>[\s\S]*?<\/remotePackage>/)?.[0]
  if (!pkg) fail("paquet cmdline-tools;latest introuvable dans le catalogue Google")
  const archive = [...pkg.matchAll(/<archive>[\s\S]*?<\/archive>/g)].map((m) => m[0]).find((a) => /<host-os>linux<\/host-os>/.test(a))
  const cltFile = archive?.match(/<url>([^<]+)<\/url>/)?.[1]
  const cltSha1 = archive?.match(/<checksum type="sha1">([0-9a-f]{40})<\/checksum>/)?.[1]
  if (!cltFile || !cltSha1) fail("archive Linux des outils en ligne de commande introuvable")

  // 2. build-tools stable le plus récent
  const tools = [...repo.matchAll(/<remotePackage path="build-tools;(\d+)\.(\d+)\.(\d+)"/g)].map((m) => m.slice(1, 4).map(Number))
  if (!tools.length) fail("aucun build-tools stable dans le catalogue")
  tools.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
  const buildTools = tools.at(-1).join(".")

  // 3. Image système de l'émulateur pour cette API
  const apis = [...sysimg.matchAll(/<remotePackage path="system-images;android-([\d.]+);google_apis;x86_64"/g)].map((m) => m[1])
  if (!apis.includes(api)) fail(`pas d'image système google_apis x86_64 pour l'API ${api}. Disponibles : ${apis.join(", ")}`)
  if (!new RegExp(`<remotePackage path="platforms;android-${api.replace(/\./g, "\\.")}"`).test(repo)) fail(`plate-forme android-${api} absente du catalogue`)

  // 4. Gradle courant
  const g = JSON.parse(gradleJson)
  if (!g.version || !g.downloadUrl || !/^[0-9a-f]{64}$/.test(g.checksum ?? "")) fail("réponse Gradle inattendue")

  const out = { API: api, CLT_URL: `${BASE}/${cltFile}`, CLT_SHA1: cltSha1, BUILD_TOOLS: buildTools, GRADLE_VERSION: g.version, GRADLE_URL: g.downloadUrl, GRADLE_SHA256: g.checksum }
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${q(v)}`)
} catch (e) {
  fail(`découverte impossible : ${e.message}`)
}
