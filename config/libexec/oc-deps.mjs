#!/usr/bin/env node
// oc-deps: detects drift between the versions pinned by the kit and the latest published ones.
//
//   oc-deps check
//   oc-deps check --only trivy --json
//   oc-deps check --ecosysteme npm --offline
//   oc-deps check --dry-run
//   oc-deps update --write --yes
//   oc-deps snapshot > versions.json
//
// "check" is read-only. "update" without --write only prints the proposed diff.
// "update --write --yes" backs up each modified file to <file>.bak-<timestamp>,
// applies the pin replacements, then reruns "oc-deps check".
// "snapshot" prints every pin as JSON: install.sh stores it in <config>/versions.json,
// the only pin source available outside the repository (install.sh is not copied).
//
// Latest versions come from oc-versions (subprocess, same 24 h cache):
// no network access of its own. Inherited variables: OC_VERSIONS_TTL, OC_VERSIONS_CACHE,
// OC_VERSIONS_FIXTURES (hermetic tests).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const LIBEXEC = path.dirname(fileURLToPath(import.meta.url))
const CONFIG = path.dirname(LIBEXEC)
// Repository: config/libexec/../.. contains install.sh. Installed: config/libexec/.. is the config.
const REPO = fs.existsSync(path.join(CONFIG, "..", "install.sh")) ? path.dirname(CONFIG) : null
const BIN = process.env.OBSCURA_BIN_DIR?.trim() || path.join(os.homedir(), ".local", "bin")
const VERSIONS_MODULE = path.join(LIBEXEC, "oc-versions.mjs")
const CACHE_DIR = process.env.OC_VERSIONS_CACHE?.trim()
  || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "opencode-versions")

const ECOSYSTEMS = ["npm", "pypi", "github", "maven"]
const TIMEOUT_MS = 180_000

function die(message, code = 2) {
  console.error(`❌ ${message}`)
  process.exit(code)
}

function usage() {
  return `oc-deps — drift of the versions pinned by the kit

Usage:
  oc-deps check [options]          read-only report
  oc-deps update [options]         propose changes; --write --yes applies them
  oc-deps snapshot                 print every pin as JSON (install.sh writes versions.json)

Options:
  --only <package>      limit to one package (name or id; repeatable, commas accepted)
  --ecosysteme <eco>    npm, pypi, github or maven
  --json                machine-readable JSON output
  --refresh             force oc-versions to ignore its cache (forwarded option)
  --offline             only read the oc-versions cache (unknown when absent)
  --dry-run             show the proposed replacement, never write (update default)
  --write               update: apply the proposed pin replacements
  --yes                 confirm --write (required with --write)
  --help                this help

check never writes. update without --write only prints the proposed diff;
"update --write --yes" applies the pin replacements, backs up every modified file
to <file>.bak-<timestamp>, then reruns "oc-deps check" and reports its exit code.
"oc-deps fix" does not exist: use "oc-deps update".

Pins listed as intentional (for example pydantic and setuptools, constrained by
semgrep-mcp) are reported as "intentional", never as drift, and are never rewritten.

Exit codes: 0 everything up to date · 1 drift or unknown · 2 usage or pin not
found · the update --write --yes exit code is the one of the final check.

Known limits:
  - The Android Containerfile only declares ARGs (API, build-tools, Gradle are
    resolved at build time) and an Ubuntu base image: no ecosystem covered by
    oc-versions, so nothing is compared for that file.
  - The Terraform image is tracked through the GitHub releases of the
    hashicorp/terraform-mcp-server repository (proxy for the image tag).
  - Outside the repository (installed config), install.sh is not copied: the pins
    it holds are read from <config>/versions.json, written by install.sh. Those
    pins are read-only: oc-deps never rewrites versions.json. Update the kit and
    rerun install.sh instead.`
}

// --- pin catalogue --------------------------------------------------------
// Each expression is anchored on the whole line and captures the "version" group.
// A format change makes oc-deps fail (exit 2) instead of reading an approximate pin.
const envPin = (name, envName = name) =>
  new RegExp(`^${name}="[$][{]${envName}:-(?<version>v?[0-9]+[.][0-9]+[.][0-9]+)[}]"$`, "dgm")

const PINS = [
  {
    id: "trivy",
    package: "aquasecurity/trivy",
    ecosystem: "github",
    repoPath: "install.sh",
    re: envPin("OC_TRIVY_VERSION"),
  },
  {
    id: "trivy-plugin-mcp",
    package: "aquasecurity/trivy-plugin-mcp",
    ecosystem: "github",
    repoPath: "install.sh",
    re: envPin("OC_TRIVY_MCP_VERSION"),
  },
  {
    id: "obscura",
    package: "h4ckf0r0day/obscura",
    ecosystem: "github",
    repoPath: "install.sh",
    re: envPin("OC_OBSCURA_VERSION"),
  },
  {
    id: "uv",
    package: "astral-sh/uv",
    ecosystem: "github",
    repoPath: "install.sh",
    re: envPin("OC_UV_VERSION"),
  },
  {
    id: "mempalace",
    package: "mempalace",
    ecosystem: "pypi",
    repoPath: "install.sh",
    re: envPin("OC_MEMPALACE_VERSION"),
  },
  {
    id: "semgrep",
    package: "semgrep",
    ecosystem: "pypi",
    repoPath: "install.sh",
    re: envPin("OC_SEMGREP_VERSION"),
  },
  {
    id: "playwright",
    package: "playwright",
    ecosystem: "npm",
    repoPath: "install.sh",
    re: envPin("OC_PLAYWRIGHT_VERSION"),
  },
  {
    id: "skills",
    package: "skills",
    ecosystem: "npm",
    repoPath: "install.sh",
    re: envPin("OC_SKILLS_VERSION"),
  },
  {
    id: "kubernetes-mcp-server",
    package: "kubernetes-mcp-server",
    ecosystem: "npm",
    repoPath: "config/opencode.jsonc",
    configPath: "opencode.jsonc",
    re: /^[ \t]*"command": \["npx", "-y", "kubernetes-mcp-server@(?<version>[0-9]+\.[0-9]+\.[0-9]+)", "--config", "\{env:HOME\}\/\.config\/opencode\/k8s-mcp\.toml"\][ \t]*$/dgm,
  },
  {
    id: "@playwright/mcp",
    package: "@playwright/mcp",
    ecosystem: "npm",
    repoPath: "config/bin/oc-playwright-mcp",
    binName: "oc-playwright-mcp",
    re: /^pkg="@playwright\/mcp@(?<version>[0-9]+\.[0-9]+\.[0-9]+)"$/dgm,
  },
  {
    id: "chrome-devtools-mcp",
    package: "chrome-devtools-mcp",
    ecosystem: "npm",
    repoPath: "config/bin/oc-chrome-devtools-mcp",
    binName: "oc-chrome-devtools-mcp",
    re: /^exec npx -y chrome-devtools-mcp@(?<version>[0-9]+\.[0-9]+\.[0-9]+) --headless --isolated --no-usage-statistics --no-performance-crux --executablePath "\$exe" "\$@"$/dgm,
  },
  {
    id: "rea-agents",
    package: "rea-agents",
    ecosystem: "npm",
    repoPath: "config/bin/oc-rea-mcp",
    binName: "oc-rea-mcp",
    re: envPin("REA_VERSION", "OC_REA_VERSION"),
  },
  {
    id: "semgrep-mcp",
    package: "semgrep-mcp",
    ecosystem: "pypi",
    repoPath: "config/bin/oc-semgrep-mcp",
    binName: "oc-semgrep-mcp",
    re: envPin("MCP_VERSION", "OC_SEMGREP_MCP_VERSION"),
  },
  {
    id: "pydantic",
    package: "pydantic",
    ecosystem: "pypi",
    repoPath: "config/bin/oc-semgrep-mcp",
    binName: "oc-semgrep-mcp",
    re: envPin("PYDANTIC_VERSION", "OC_SEMGREP_PYDANTIC_VERSION"),
  },
  {
    id: "setuptools",
    package: "setuptools",
    ecosystem: "pypi",
    repoPath: "config/bin/oc-semgrep-mcp",
    binName: "oc-semgrep-mcp",
    re: envPin("SETUPTOOLS_VERSION", "OC_SEMGREP_SETUPTOOLS_VERSION"),
  },
  {
    id: "@mobilenext/mobile-mcp",
    package: "@mobilenext/mobile-mcp",
    ecosystem: "npm",
    repoPath: "addons/android/bin/oc-mobile-mcp",
    binName: "oc-mobile-mcp",
    re: envPin("MOBILE_VERSION", "OC_MOBILE_VERSION"),
  },
  {
    id: "terraform-mcp-server",
    package: "hashicorp/terraform-mcp-server",
    ecosystem: "github",
    repoPath: "config/bin/oc-terraform-mcp",
    binName: "oc-terraform-mcp",
    re: /^exec "\$rt" run -i --rm docker\.io\/hashicorp\/terraform-mcp-server:(?<version>[0-9]+\.[0-9]+\.[0-9]+) stdio --toolsets=registry "\$@"$/dgm,
  },
]

// Pins held back on purpose: a newer release exists but upgrading breaks a dependency
// at runtime. "check" reports them as "intentional" (not drift, exit code 0) and
// "update" never rewrites them. Keep the reason next to the pin it protects.
const INTENTIONAL = {
  "pydantic": "semgrep-mcp 0.9.0 ships mcp 1.12.2, which imports pydantic._internal._typing_extra.eval_type_backport, removed in pydantic 2.12+",
  "setuptools": "semgrep 1.135.0 imports pkg_resources, removed from setuptools 82+ (81 only deprecates it)",
}

// Written by install.sh: the only pin record when the kit runs outside its repository.
const INSTALLED_PINS_FILE = path.join(CONFIG, "versions.json")

// --- reading pins ---------------------------------------------------------
function locate(pin) {
  const candidates = []
  if (REPO && pin.repoPath) candidates.push(path.join(REPO, pin.repoPath))
  if (pin.configPath) candidates.push(path.join(CONFIG, pin.configPath))
  if (pin.binName) candidates.push(path.join(BIN, pin.binName))
  return candidates.find((f) => fs.existsSync(f)) || null
}

function displayPath(file) {
  if (REPO && (file === REPO || file.startsWith(REPO + path.sep))) return path.relative(REPO, file)
  return file
}

function readPin(pin, file) {
  const text = fs.readFileSync(file, "utf8")
  const matches = [...text.matchAll(pin.re)]
  if (matches.length !== 1) {
    const what = matches.length === 0 ? "not found" : `ambiguous (${matches.length} occurrences)`
    throw new Error(`pin ${what} in ${displayPath(file)}: format changed, update oc-deps`)
  }
  const m = matches[0]
  const [start, end] = m.indices.groups.version
  const lineNo = text.slice(0, m.index).split("\n").length
  const line = text.split("\n")[lineNo - 1].replace(/\r$/, "")
  return { pinned: m.groups.version, line, lineNo, start, end, text }
}

// versions.json (written by install.sh) records every pin as { "<id>": "<version>" }.
// It is only a fallback: a pin whose source file is present is always read from that file.
function readInstalledPins() {
  let text
  try {
    text = fs.readFileSync(INSTALLED_PINS_FILE, "utf8")
  } catch (e) {
    if (e.code !== "ENOENT") console.error(`⚠️  ${displayPath(INSTALLED_PINS_FILE)} unreadable: ${e.message}`)
    return null
  }
  try {
    const data = JSON.parse(text)
    if (data?.pins && typeof data.pins === "object" && !Array.isArray(data.pins)) {
      return { pins: data.pins, text }
    }
    console.error(`⚠️  ${displayPath(INSTALLED_PINS_FILE)}: no "pins" object, installed pins ignored`)
  } catch (e) {
    console.error(`⚠️  ${displayPath(INSTALLED_PINS_FILE)}: invalid JSON (${e.message}), installed pins ignored`)
  }
  return null
}

function installedPinSource(pin, installed) {
  const value = installed.pins[pin.id]
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`pin ${pin.id} missing from ${displayPath(INSTALLED_PINS_FILE)}: rerun install.sh`)
  }
  const needle = `"${pin.id}"`
  const at = installed.text.indexOf(needle)
  const lineNo = at === -1 ? null : installed.text.slice(0, at).split("\n").length
  return {
    pinned: value.trim(),
    line: lineNo === null ? `pins.${pin.id} = ${value.trim()}` : installed.text.split("\n")[lineNo - 1].trim(),
    lineNo,
    start: null,
    end: null,
    text: installed.text,
  }
}

const normalize = (v) => v.trim().replace(/^v(?=[0-9])/i, "")

function conformVersion(pinned, latest) {
  let next = latest.trim()
  if (pinned.startsWith("v") && !next.startsWith("v")) next = `v${next}`
  if (!pinned.startsWith("v") && next.startsWith("v")) next = next.slice(1)
  return next
}

function proposedLine(source, latest) {
  const next = conformVersion(source.pinned, latest)
  const lineStart = source.text.lastIndexOf("\n", source.start - 1) + 1
  const lineEndRaw = source.text.indexOf("\n", source.end)
  const lineEnd = lineEndRaw === -1 ? source.text.length : lineEndRaw
  return source.text.slice(lineStart, source.start) + next + source.text.slice(source.end, lineEnd)
}

// --- resolving latest versions -------------------------------------------
const keyOf = (eco, pkg) => `${eco}\u0000${pkg}`

function groupByEcosystem(entries) {
  const groups = new Map()
  for (const e of entries) {
    if (!groups.has(e.ecosystem)) groups.set(e.ecosystem, [])
    groups.get(e.ecosystem).push(e)
  }
  return groups
}

function fetchOnline(groups, refresh) {
  const found = new Map()
  for (const [eco, entries] of groups) {
    const packages = [...new Set(entries.map((e) => e.package))]
    if (!fs.existsSync(VERSIONS_MODULE)) {
      die(`oc-versions not found: ${VERSIONS_MODULE}`)
    }
    const args = [VERSIONS_MODULE, "--json"]
    if (refresh) args.push("--refresh")
    args.push(eco, ...packages)
    const r = spawnSync(process.execPath, args, {
      encoding: "utf8",
      env: process.env,
      timeout: TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    })
    let payload = null
    try { payload = JSON.parse(r.stdout) } catch { /* treated as a global failure */ }
    if (!payload) {
      const why = r.error ? r.error.message : `unreadable output (code ${r.status})`
      for (const pkg of packages) found.set(keyOf(eco, pkg), { error: `oc-versions: ${why}` })
      continue
    }
    for (const res of payload.results ?? []) {
      if (!res?.package) continue
      found.set(keyOf(eco, res.package), {
        version: res.version,
        expired: Boolean(res.expired),
        cached: Boolean(res.cached),
        source: res.source,
      })
    }
    for (const err of payload.errors ?? []) {
      if (err?.package) found.set(keyOf(eco, err.package), { error: err.error ?? "not found" })
    }
  }
  return found
}

function readOfflineCache(eco) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${eco}.json`), "utf8"))
    return data?.entries && typeof data.entries === "object" ? data.entries : {}
  } catch {
    return {}
  }
}

function fetchOffline(groups) {
  const found = new Map()
  for (const [eco, entries] of groups) {
    const cache = readOfflineCache(eco)
    for (const e of entries) {
      const hit = cache[e.package]
      if (hit && typeof hit.version === "string") {
        found.set(keyOf(eco, e.package), { version: hit.version, cached: true, offline: true, source: hit.source })
      }
    }
  }
  return found
}

// --- arguments ------------------------------------------------------------
function splitOnly(values) {
  return values.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean)
}

function parseArgs(argv) {
  const opts = { command: null, json: false, refresh: false, offline: false, dryRun: false, write: false, yes: false, only: [], ecosystem: null }
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]
    if (arg === "--help" || arg === "-h") return { help: true }
    if (arg === "--json") { opts.json = true; continue }
    if (arg === "--refresh") { opts.refresh = true; continue }
    if (arg === "--offline") { opts.offline = true; continue }
    if (arg === "--dry-run") { opts.dryRun = true; continue }
    if (arg === "--write") { opts.write = true; continue }
    if (arg === "--yes") { opts.yes = true; continue }
    if (arg === "--only" || arg.startsWith("--only=")) {
      let value
      if (arg.includes("=")) value = arg.slice(arg.indexOf("=") + 1)
      else {
        value = argv[++i]
        if (value === undefined || value.startsWith("--")) die(`--only requires a package\n\n${usage()}`)
      }
      opts.only.push(value)
      continue
    }
    if (arg === "--ecosysteme" || arg.startsWith("--ecosysteme=")) {
      let value
      if (arg.includes("=")) value = arg.slice(arg.indexOf("=") + 1)
      else {
        value = argv[++i]
        if (value === undefined || value.startsWith("--")) die(`--ecosysteme requires a value\n\n${usage()}`)
      }
      opts.ecosystem = value
      continue
    }
    if (arg.startsWith("-")) die(`unknown option: ${arg}\n\n${usage()}`)
    if (opts.command !== null) die(`unexpected argument: ${arg}\n\n${usage()}`)
    opts.command = arg
  }
  return opts
}

// --- output ---------------------------------------------------------------
function printTable(results) {
  const headers = ["package", "pinned", "latest", "status"]
  const rows = results.map((r) => [r.package, r.pinned, r.latest ?? "—", r.status])
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)))
  const render = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join(" | ")
  console.log(render(headers))
  console.log(widths.map((w) => "-".repeat(w)).join("-+-"))
  for (const row of rows) console.log(render(row))
}

function reportPayload(results, skipped, summary, opts, extra = {}) {
  return {
    generated_at: new Date().toISOString(),
    command: opts.command,
    offline: opts.offline,
    refresh: opts.refresh,
    ecosystem: opts.ecosystem,
    only: opts.only,
    dry_run: opts.command === "update" ? !opts.write : opts.dryRun,
    results,
    skipped,
    summary,
    ...extra,
  }
}

function printReport(results, skipped, summary, opts, { showDiff = false, hint = null } = {}) {
  if (opts.json) {
    console.log(JSON.stringify(reportPayload(results, skipped, summary, opts), null, 2))
    return
  }
  for (const s of skipped) console.error(`⚠️  skipped (file missing): ${s.package}`)
  printTable(results)
  console.log(`\n${summary.total} packages · ${summary.up_to_date} up to date · ${summary.drift} drift · ${summary.unknown} unknown · ${summary.intentional} intentional`)
  for (const r of results.filter((r) => r.status === "unknown")) {
    console.error(`⚠️  ${r.package}: ${r.detail ?? "unknown version"}`)
  }
  for (const r of results.filter((r) => r.status === "intentional")) {
    console.log(`ℹ️  intentional: ${r.package} ${r.pinned} (latest ${r.latest}) — ${r.reason}`)
  }
  const readonly = results.filter((r) => r.status === "drift" && r.readonly)
  if (readonly.length) {
    console.log(`ℹ️  ${readonly.length} drift(s) recorded in versions.json (installed config): update the kit and rerun install.sh; oc-deps never rewrites versions.json.`)
  }
  if (showDiff) {
    const changes = results.filter((r) => r.status === "drift" && r.proposed_line)
    if (!changes.length) {
      console.log("\nNo proposed change.")
    } else {
      console.log("\nProposed diff (no file is modified):")
      for (const r of changes) {
        console.log(`--- ${r.file}`)
        console.log(`+++ ${r.file} (proposed)`)
        console.log(`-${r.line_text}`)
        console.log(`+${r.proposed_line}`)
      }
    }
  }
  if (hint) console.log(`\n${hint}`)
}

function timestamp() {
  return new Date().toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-")
}

function uniquePath(base) {
  let candidate = base
  let i = 1
  while (fs.existsSync(candidate)) candidate = `${base}-${i++}`
  return candidate
}

// Apply the proposed replacements file by file. Each modified file is backed up
// to <file>.bak-<timestamp>; the write is atomic (temporary file + rename).
// Symlinks and non-regular files are refused: a pin must be edited in place.
function applyUpdates(results) {
  const changes = results.filter((r) => r.status === "drift" && r.proposed && r.latest)
  if (!changes.length) return { files: [], pins: 0 }

  const byFile = new Map()
  for (const r of changes) {
    if (!r._absFile) throw new Error(`no source file for ${r.package}`)
    if (!byFile.has(r._absFile)) byFile.set(r._absFile, [])
    byFile.get(r._absFile).push(r)
  }

  const stamp = timestamp()
  const files = []
  let pins = 0
  for (const [file, fileChanges] of byFile) {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) throw new Error(`refusing to modify a symlink: ${displayPath(file)}`)
    if (!stat.isFile()) throw new Error(`refusing to modify a non-regular file: ${displayPath(file)}`)

    const text = fs.readFileSync(file, "utf8")
    const entries = fileChanges.map((r) => {
      const pin = PINS.find((p) => p.id === r.id)
      if (!pin) throw new Error(`internal error: unknown pin ${r.id}`)
      const source = readPin(pin, file)
      if (source.pinned !== r.pinned) {
        throw new Error(`${displayPath(file)} changed while oc-deps was running (pin ${r.id})`)
      }
      return { r, source }
    }).sort((a, b) => b.source.start - a.source.start)

    let next = text
    for (const { r, source } of entries) {
      if (next.slice(source.start, source.end) !== source.pinned) {
        throw new Error(`${displayPath(file)} changed while oc-deps was running (pin ${r.id})`)
      }
      next = next.slice(0, source.start) + conformVersion(source.pinned, r.latest) + next.slice(source.end)
    }

    const backup = uniquePath(`${file}.bak-${stamp}`)
    fs.copyFileSync(file, backup)
    fs.chmodSync(backup, stat.mode)
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    try {
      fs.writeFileSync(tmp, next, { mode: stat.mode })
      fs.chmodSync(tmp, stat.mode)
      fs.renameSync(tmp, file)
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* best effort */ }
      throw e
    }

    pins += entries.length
    files.push({
      file: displayPath(file),
      backup: displayPath(backup),
      pins: entries.map(({ r, source }) => ({
        package: r.package,
        from: source.pinned,
        to: conformVersion(source.pinned, r.latest),
      })),
    })
  }
  return { files, pins }
}

function recheck(opts) {
  const args = [fileURLToPath(import.meta.url), "check"]
  if (opts.json) args.push("--json")
  if (opts.offline) args.push("--offline")
  if (opts.refresh) args.push("--refresh")
  if (opts.ecosystem) args.push("--ecosysteme", opts.ecosystem)
  for (const o of opts.only) args.push("--only", o)
  return spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: process.env,
    timeout: TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  })
}

// Record every readable pin as JSON on stdout. Deterministic (no timestamp) so that a
// reinstall writes a byte-identical versions.json; install.sh applies mode 600.
function snapshot() {
  const pins = {}
  for (const pin of PINS) {
    const file = locate(pin)
    if (!file) {
      console.error(`⚠️  snapshot: skipped ${pin.id} (source file missing)`)
      continue
    }
    pins[pin.id] = readPin(pin, file).pinned
  }
  const payload = { schema: 1 }
  if (REPO) {
    try { payload.kit_version = fs.readFileSync(path.join(REPO, "VERSION"), "utf8").trim() } catch { /* optional */ }
  }
  payload.pins = pins
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n")
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(usage())
    return
  }
  if (opts.command === null) die(`missing command\n\n${usage()}`)
  if (opts.command === "fix") {
    die(`"oc-deps fix" does not exist: review "oc-deps update --dry-run", then run "oc-deps update --write --yes" or edit the pin by hand.`)
  }
  if (opts.command === "snapshot") {
    snapshot()
    return
  }
  if (opts.command !== "check" && opts.command !== "update") {
    die(`unknown command: ${opts.command}\n\n${usage()}`)
  }
  if (opts.write && opts.command !== "update") die(`--write only applies to update\n\n${usage()}`)
  if (opts.yes && !opts.write) die(`--yes requires --write\n\n${usage()}`)
  if (opts.write && opts.dryRun) die(`--write and --dry-run are incompatible\n\n${usage()}`)
  if (opts.write && !opts.yes) {
    die(`refusing to write without --yes: review "oc-deps update --dry-run", then run "oc-deps update --write --yes"\n\n${usage()}`)
  }
  if (opts.ecosystem && !ECOSYSTEMS.includes(opts.ecosystem)) {
    die(`unknown ecosystem: "${opts.ecosystem}". Valid: ${ECOSYSTEMS.join(", ")}`)
  }
  if (opts.offline && opts.refresh) die("--offline and --refresh are incompatible")

  const only = splitOnly(opts.only).map((v) => v.toLowerCase())
  for (const selector of only) {
    if (!PINS.some((p) => p.id.toLowerCase() === selector || p.package.toLowerCase() === selector)) {
      die(`--only: unknown package "${selector}"`)
    }
  }

  let selected = PINS.filter((p) => {
    if (opts.ecosystem && p.ecosystem !== opts.ecosystem) return false
    if (!only.length) return true
    return only.includes(p.id.toLowerCase()) || only.includes(p.package.toLowerCase())
  })
  if (!selected.length) {
    if (opts.json) {
      console.log(JSON.stringify({
        generated_at: new Date().toISOString(),
        command: opts.command,
        offline: opts.offline,
        refresh: opts.refresh,
        ecosystem: opts.ecosystem,
        only,
        results: [],
        skipped: [],
        summary: { total: 0, up_to_date: 0, drift: 0, unknown: 0, intentional: 0 },
      }, null, 2))
    } else {
      console.log(`No pinned ${opts.ecosystem ? `${opts.ecosystem} ` : ""}package in the kit for this filter.`)
    }
    return
  }

  const installed = readInstalledPins()
  const skipped = []
  const checked = []
  for (const pin of selected) {
    const file = locate(pin)
    if (file) {
      checked.push({ ...pin, file })
      continue
    }
    if (installed && Object.prototype.hasOwnProperty.call(installed.pins, pin.id)) {
      checked.push({ ...pin, file: null, installed })
      continue
    }
    skipped.push({ package: pin.package, id: pin.id, reason: "source file missing" })
  }
  if (!checked.length) {
    die(`no source file found for ${selected.map((p) => p.package).join(", ")}`)
  }

  const groups = groupByEcosystem(checked)
  const latest = opts.offline ? fetchOffline(groups) : fetchOnline(groups, opts.refresh)

  const results = checked.map((pin) => {
    const source = pin.file ? readPin(pin, pin.file) : installedPinSource(pin, pin.installed)
    const got = latest.get(keyOf(pin.ecosystem, pin.package))
    let status = "unknown"
    let detail = null
    let value = null
    if (got?.error) {
      detail = got.error
    } else if (got?.version) {
      value = got.version
      if (got.expired) {
        detail = "cache expired and source unreachable"
      } else if (normalize(value) === normalize(source.pinned)) {
        status = "up to date"
      } else if (INTENTIONAL[pin.id]) {
        status = "intentional"
      } else {
        status = "drift"
      }
    } else {
      detail = opts.offline ? "absent from the offline cache" : "no version returned by oc-versions"
    }
    const result = {
      id: pin.id,
      package: pin.package,
      ecosystem: pin.ecosystem,
      pinned: source.pinned,
      latest: value,
      status,
      file: pin.file ? displayPath(pin.file) : displayPath(INSTALLED_PINS_FILE),
      line: source.lineNo,
      line_text: source.line,
    }
    if (pin.file) Object.defineProperty(result, "_absFile", { value: pin.file, enumerable: false })
    else result.readonly = true
    if (got?.cached) result.cached = true
    if (got?.source) result.source = got.source
    if (detail) result.detail = detail
    if (status === "intentional") {
      result.intentional = true
      result.reason = INTENTIONAL[pin.id]
    }
    if (status === "drift" && value && pin.file) {
      result.proposed = conformVersion(source.pinned, value)
      result.proposed_line = proposedLine(source, value)
    }
    return result
  })

  const summary = {
    total: results.length,
    up_to_date: results.filter((r) => r.status === "up to date").length,
    drift: results.filter((r) => r.status === "drift").length,
    unknown: results.filter((r) => r.status === "unknown").length,
    intentional: results.filter((r) => r.status === "intentional").length,
  }

  if (opts.command === "update" && !opts.write) {
    printReport(results, skipped, summary, opts, {
      showDiff: true,
      hint: summary.drift
        ? `Run "oc-deps update --write --yes" to apply these changes (each modified file is backed up to <file>.bak-<timestamp>).`
        : null,
    })
    process.exitCode = summary.drift || summary.unknown ? 1 : 0
    return
  }

  if (opts.command === "update" && opts.write) {
    const applied = applyUpdates(results)
    if (!applied.pins) {
      if (opts.json) {
        console.log(JSON.stringify({
          generated_at: new Date().toISOString(),
          command: "update",
          applied: { files: [], pins: 0 },
          summary,
          message: "no proposed change",
        }, null, 2))
      } else {
        const readonly = results.filter((r) => r.status === "drift" && r.readonly)
        if (readonly.length) {
          console.log(`ℹ️  ${readonly.length} drift(s) recorded in versions.json (installed config): update the kit and rerun install.sh; oc-deps never rewrites versions.json.`)
        }
        console.log("No proposed change; nothing to write.")
      }
      process.exitCode = summary.unknown || summary.drift ? 1 : 0
      return
    }

    if (!opts.json) {
      console.log(`✅ Updated ${applied.pins} pin(s) in ${applied.files.length} file(s):`)
      for (const f of applied.files) {
        for (const p of f.pins) console.log(`  ${f.file}: ${p.package} ${p.from} → ${p.to}`)
        console.log(`  backup: ${f.backup}`)
      }
      console.log("\n🔄 Re-running oc-deps check…")
    }

    const check = recheck(opts)
    if (opts.json) {
      let payload = null
      try { payload = JSON.parse(check.stdout) } catch { /* reported below */ }
      console.log(JSON.stringify({
        generated_at: new Date().toISOString(),
        command: "update",
        applied,
        recheck: payload ?? {
          error: "unreadable oc-deps check output",
          stdout: check.stdout,
          stderr: check.stderr,
        },
      }, null, 2))
      process.exitCode = payload ? (check.status ?? 1) : 1
    } else {
      process.stdout.write(check.stdout)
      process.stderr.write(check.stderr)
      process.exitCode = check.status ?? 1
    }
    return
  }

  printReport(results, skipped, summary, opts, { showDiff: opts.dryRun })
  process.exitCode = summary.drift || summary.unknown ? 1 : 0
}

try {
  main()
} catch (e) {
  die(e.message)
}
