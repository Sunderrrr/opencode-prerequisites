#!/usr/bin/env node
// Tests hermétiques de la chaîne d'approvisionnement de install.sh : versions épinglées, sommes
// publiées, refus d'un checksum invalide ou d'un asset absent. Aucun accès réseau : un faux curl
// sert des fixtures locales (URL → fichier), et un faux uname fixe la plateforme.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const INSTALL = path.join(ROOT, "install.sh")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oc-supplytest-"))
const FAKEBIN = path.join(TMP, "fakebin")
const RUNNER = path.join(TMP, "runner.sh")
let checks = 0
let failed = 0

const check = (name, cond, detail = "") => {
  checks++
  if (!cond) failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`)
}
const write = (file, text, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, mode ? { mode } : undefined)
}
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const tarball = (dir, name, members) => {
  const stage = path.join(dir, `stage-${name.replace(/[^\w.-]/g, "_")}`)
  for (const [rel, text] of Object.entries(members)) write(path.join(stage, rel), text, 0o755)
  const archive = path.join(dir, name)
  const r = spawnSync("tar", ["-czf", archive, "-C", stage, ...Object.keys(members)], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`tar ${name} : ${r.stderr}`)
  return archive
}

// ---------- faux binaires : tout le PATH réel sauf curl/uname/trivy/uv, puis nos doublures ----------
const SHADOW = new Set(["curl", "uname", "trivy", "uv", "uvx", "node"])
fs.mkdirSync(FAKEBIN, { recursive: true })
for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
  let names = []
  try { names = fs.readdirSync(dir) } catch { continue }
  for (const n of names) {
    if (SHADOW.has(n) || fs.existsSync(path.join(FAKEBIN, n))) continue
    try { if (fs.statSync(path.join(dir, n)).isFile()) fs.symlinkSync(path.join(dir, n), path.join(FAKEBIN, n)) } catch { /* ignoré */ }
  }
}
write(path.join(FAKEBIN, "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, 0o755)
write(path.join(FAKEBIN, "uname"), "#!/bin/sh\ncase \"${1:-}\" in\n  -m) echo x86_64 ;;\n  -s) echo Linux ;;\n  *) echo Linux ;;\nesac\n", 0o755)
write(path.join(FAKEBIN, "curl"), [
  "#!/bin/sh",
  "# Faux curl : sert le fichier associé à l'URL dans $FAKE_CURL_MAP (URL<TAB>chemin).",
  'url=""; dest=""',
  'while [ $# -gt 0 ]; do',
  '  case "$1" in',
  '    -o) dest="$2"; shift 2 ;;',
  '    --retry|--connect-timeout) shift 2 ;;',
  '    -*) shift ;;',
  '    *) url="$1"; shift ;;',
  '  esac',
  'done',
  '[ -n "$url" ] && [ -n "$dest" ] || exit 2',
  '[ -n "${FAKE_CURL_LOG:-}" ] && printf \'%s\\n\' "$url" >> "$FAKE_CURL_LOG"',
  "file=\"$(awk -F '\\t' -v u=\"$url\" '$1 == u { print $2; exit }' \"$FAKE_CURL_MAP\")\"",
  '[ -n "$file" ] && [ -f "$file" ] || { echo "curl: (22) faux 404 $url" >&2; exit 22; }',
  'cat "$file" > "$dest"',
  "",
].join("\n"), 0o755)
write(RUNNER, [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  'func="${OC_TEST_FUNC:?}"',
  "set --",
  `OC_INSTALL_LIB=1 . "${ROOT}/install.sh"`,
  'if [ "$func" = get_uv ]; then',
  '  uv_path="$(get_uv)"',
  "  printf 'UV_PATH=%s\\n' \"$uv_path\"",
  '  [ -x "$uv_path" ]',
  "else",
  '  "$func"',
  "fi",
  "",
].join("\n"), 0o755)

// ---------- environnement d'un scénario : HOME/PATH/map isolés, aucun réseau possible ----------
const baseEnv = { ...process.env }
for (const k of Object.keys(baseEnv)) {
  if (k.startsWith("OC_") || ["OPENCODE_CONFIG_DIR", "OBSCURA_BIN_DIR", "BASH_ENV", "ENV"].includes(k)) delete baseEnv[k]
}
const run = (func, { version = {}, map = [] } = {}) => {
  const dir = fs.mkdtempSync(path.join(TMP, "case-"))
  const bin = path.join(dir, "bin")
  const mapFile = path.join(dir, "curl-map.tsv")
  const log = path.join(dir, "curl.log")
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(path.join(dir, "tmp"), { recursive: true })
  write(mapFile, `${map.filter(Boolean).join("\n")}\n`)
  const r = spawnSync("bash", [RUNNER], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...baseEnv,
      HOME: path.join(dir, "home"),
      OPENCODE_CONFIG_DIR: path.join(dir, "cfg"),
      OBSCURA_BIN_DIR: bin,
      TMPDIR: path.join(dir, "tmp"),
      PATH: FAKEBIN,
      FAKE_CURL_MAP: mapFile,
      FAKE_CURL_LOG: log,
      OC_TEST_FUNC: func,
      ...version,
    },
  })
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", bin, calls }
}

// ---------- 1. versions par défaut et épinglage statique ----------
const install = fs.readFileSync(INSTALL, "utf8")
const DEFAULTS = {
  OC_TRIVY_VERSION: "0.76.1",
  OC_TRIVY_MCP_VERSION: "v0.0.20",
  OC_OBSCURA_VERSION: "0.2.6",
  OC_UV_VERSION: "0.13.7",
  OC_MEMPALACE_VERSION: "3.11.0",
  OC_SEMGREP_VERSION: "1.183.0",
  OC_PLAYWRIGHT_VERSION: "1.64.1",
  OC_SKILLS_VERSION: "1.7.6",
}
for (const [key, want] of Object.entries(DEFAULTS)) {
  const m = install.match(new RegExp(`^${key}="\\$\\{${key}:-([^}]*)\\}"$`, "m"))
  check(`${key} épinglé à ${want}`, m?.[1] === want, m ? `trouvé ${m[1]}` : "ligne absente")
}
check("aucune URL de release « latest » pour les binaires", !/releases\/latest\/download/.test(install))
check("Playwright épinglé (pas de @latest)", install.includes('playwright@$OC_PLAYWRIGHT_VERSION'))
check("skills épinglé (pas de @latest)", install.includes('skills@$OC_SKILLS_VERSION'))
check("MemPalace épinglé (pas de pip -U)", install.includes('"mempalace==$OC_MEMPALACE_VERSION"') && !/pip install[^\n]*-U\b/.test(install))
check("semgrep épinglé", install.includes('"semgrep==$OC_SEMGREP_VERSION"'))
check("plugin Trivy MCP épinglé", install.includes('trivy-plugin-mcp@$OC_TRIVY_MCP_VERSION'))
check("versions surchargeables validées (anti-injection d'URL)", install.includes("Version invalide"))

// ---------- 2. Trivy : checksum valide, invalide, asset absent ----------
const trivyCase = (kind) => {
  const dir = fs.mkdtempSync(path.join(TMP, "trivy-"))
  const v = "9.9.9-test"
  const asset = `trivy_${v}_Linux-64bit.tar.gz`
  const archive = tarball(dir, asset, { trivy: "#!/bin/sh\necho fake-trivy-ok\n" })
  const hash = kind === "bad" ? "0".repeat(64) : sha256(archive)
  const listed = kind === "absent" ? `trivy_${v}_Linux-ARM64.tar.gz` : asset
  const sums = path.join(dir, "checksums.txt")
  write(sums, `${hash}  ${listed}\n`)
  const base = `https://github.com/aquasecurity/trivy/releases/download/v${v}`
  return run("install_trivy", {
    version: { OC_TRIVY_VERSION: v },
    map: [`${base}/trivy_${v}_checksums.txt\t${sums}`, `${base}/${asset}\t${archive}`],
  })
}
let r = trivyCase("valid")
check("trivy : checksum valide → installation", r.status === 0 && /✅ trivy 9\.9\.9-test installé/.test(r.stdout), r.stderr + r.stdout)
check("trivy : binaire installé et exécutable", fs.existsSync(path.join(r.bin, "trivy")) && /fake-trivy-ok/.test(spawnSync(path.join(r.bin, "trivy"), [], { encoding: "utf8" }).stdout))
check("trivy : sommes puis archive téléchargées", /_checksums\.txt/.test(r.calls) && /trivy_9\.9\.9-test_Linux-64bit\.tar\.gz/.test(r.calls))
r = trivyCase("bad")
check("trivy : checksum invalide → refus explicite", r.status !== 0 && /somme de contrôle invalide/.test(r.stderr), r.stderr + r.stdout)
check("trivy : rien installé après un checksum invalide", !fs.existsSync(path.join(r.bin, "trivy")))
r = trivyCase("absent")
check("trivy : asset absent des sommes → refus explicite", r.status !== 0 && /absent des sommes/.test(r.stderr), r.stderr + r.stdout)
check("trivy : archive non téléchargée si l'asset manque", !/trivy_9\.9\.9-test_Linux-64bit\.tar\.gz/.test(r.calls))

// ---------- 3. Obscura : digest de l'API, fichier de sommes, asset absent, digest absent ----------
const obscuraCase = ({ digest = true, asset = true, sums = false } = {}) => {
  const dir = fs.mkdtempSync(path.join(TMP, "obscura-"))
  const v = "9.9.9-test"
  const name = "obscura-x86_64-linux.tar.gz"
  const archive = tarball(dir, name, {
    obscura: "#!/bin/sh\necho fake-obscura-ok\n",
    "obscura-worker": "#!/bin/sh\nexit 0\n",
  })
  const hash = sha256(archive)
  const url = `https://fixtures.test/${name}`
  const assets = asset ? [{ name, browser_download_url: url, ...(digest ? { digest: `sha256:${hash}` } : {}) }] : [{ name: "obscura-aarch64-macos.tar.gz", browser_download_url: "https://fixtures.test/autre.tar.gz", digest: `sha256:${hash}` }]
  const map = []
  if (sums) {
    const sumsFile = path.join(dir, "checksums.txt")
    write(sumsFile, `${hash}  ${name}\n`)
    assets.push({ name: "checksums.txt", browser_download_url: "https://fixtures.test/checksums.txt" })
    map.push(`https://fixtures.test/checksums.txt\t${sumsFile}`)
  }
  const api = path.join(dir, "release.json")
  write(api, JSON.stringify({ assets }))
  map.push(`https://api.github.com/repos/h4ckf0r0day/obscura/releases/tags/v${v}\t${api}`)
  if (asset) map.push(`${url}\t${archive}`)
  return run("install_obscura", { version: { OC_OBSCURA_VERSION: v }, map })
}
r = obscuraCase()
check("obscura : digest sha256 de l'API → installation", r.status === 0 && /✅ obscura 9\.9\.9-test installé/.test(r.stdout), r.stderr + r.stdout)
check("obscura : binaires obscura et obscura-worker installés", ["obscura", "obscura-worker"].every((f) => fs.existsSync(path.join(r.bin, f)) && /fake-obscura-ok/.test(spawnSync(path.join(r.bin, "obscura"), ["--help"], { encoding: "utf8" }).stdout)))
r = obscuraCase({ sums: true })
check("obscura : repli sur le fichier de sommes publié", r.status === 0 && fs.existsSync(path.join(r.bin, "obscura")), r.stderr + r.stdout)
r = obscuraCase({ asset: false })
check("obscura : asset absent de la release → refus explicite", r.status !== 0 && /absent de la release/.test(r.stderr), r.stderr + r.stdout)
check("obscura : archive non téléchargée si l'asset manque", !/obscura-x86_64-linux\.tar\.gz/.test(r.calls))
r = obscuraCase({ digest: false })
check("obscura : aucun sha256 publié → refus explicite", r.status !== 0 && /aucun sha256 publié/.test(r.stderr), r.stderr + r.stdout)

// ---------- 4. uv : .sha256 publié, checksum invalide, fichier de somme absent ----------
const uvCase = (kind) => {
  const dir = fs.mkdtempSync(path.join(TMP, "uv-"))
  const v = "9.9.9-test"
  const asset = "uv-x86_64-unknown-linux-musl.tar.gz"
  const archive = tarball(dir, asset, { "uv-x86_64-unknown-linux-musl/uv": "#!/bin/sh\necho fake-uv-ok\n" })
  const hash = kind === "bad" ? "f".repeat(64) : sha256(archive)
  const sums = path.join(dir, `${asset}.sha256`)
  write(sums, `${hash}  ${asset}\n`)
  const base = `https://github.com/astral-sh/uv/releases/download/${v}`
  const map = [`${base}/${asset}\t${archive}`]
  if (kind !== "missing") map.push(`${base}/${asset}.sha256\t${sums}`)
  return run("get_uv", { version: { OC_UV_VERSION: v }, map })
}
r = uvCase("valid")
check("uv : .sha256 publié → binaire extrait et exécutable", r.status === 0 && /UV_PATH=.*\/uvbin\/uv/.test(r.stdout) && !/somme|annulée/.test(r.stderr), r.stderr + r.stdout)
r = uvCase("bad")
check("uv : checksum invalide → refus", r.status !== 0 && /somme de contrôle invalide/.test(r.stderr), r.stderr + r.stdout)
r = uvCase("missing")
check("uv : fichier .sha256 absent → refus", r.status !== 0 && /\.sha256 introuvable/.test(r.stderr), r.stderr + r.stdout)

// ---------- 5. une version surchargeable ne peut pas injecter d'URL ----------
r = run("install_trivy", { version: { OC_TRIVY_VERSION: "1.0/../evil" } })
check("version avec « / » refusée avant tout téléchargement", r.status !== 0 && /Version invalide/.test(r.stderr) && r.calls === "", r.stderr + r.stdout)

fs.rmSync(TMP, { recursive: true, force: true })
console.log(failed ? `\n❌ ${failed}/${checks} test(s) en échec` : `\n✅ Chaîne d'approvisionnement OK (${checks} contrôles : versions, checksums, assets, refus)`)
process.exit(failed ? 1 : 0)
