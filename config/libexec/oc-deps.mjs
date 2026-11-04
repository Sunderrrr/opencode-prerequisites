#!/usr/bin/env node
// oc-deps: detects drift between the versions pinned by the kit and the latest published ones.
//
//   oc-deps check
//   oc-deps check --only trivy --json
//   oc-deps check --ecosysteme npm --offline
//   oc-deps check --dry-run
//
// oc-deps NEVER modifies a file: "oc-deps fix" does not exist. --dry-run only shows
// the proposed replacement; the update is done by hand after review.
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
  return `oc-deps — drift of the versions pinned by the kit (no automatic updates)

Usage:
  oc-deps check [options]

Options:
  --only <package>      limit to one package (name or id; repeatable, commas accepted)
  --ecosysteme <eco>    npm, pypi, github or maven
  --json                machine-readable JSON output
  --refresh             force oc-versions to ignore its cache (forwarded option)
  --offline             only read the oc-versions cache (unknown when absent)
  --dry-run             show the proposed replacement, never write
  --help                this help

No automatic update: oc-deps never modifies a file and "oc-deps fix" does not
exist. After review, update the pin by hand in install.sh,
config/opencode.jsonc, config/bin/oc-* or addons/android/bin/oc-mobile-mcp, then
rerun the tests. --dry-run only prints the proposed diff.

Exit codes: 0 everything up to date · 1 drift or unknown · 2 usage or pin not found.

Known limits:
  - The Android Containerfile only declares ARGs (API, build-tools, Gradle are
    resolved at build time) and an Ubuntu base image: no ecosystem covered by
    oc-versions, so nothing is compared for that file.
  - The Terraform image is tracked through the GitHub releases of the
    hashicorp/terraform-mcp-server repository (proxy for the image tag).
  - Outside the repository (installed config), install.sh is not copied: only the
    pins from configuration files are checked.`
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
  const opts = { command: null, json: false, refresh: false, offline: false, dryRun: false, only: [], ecosystem: null }
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]
    if (arg === "--help" || arg === "-h") return { help: true }
    if (arg === "--json") { opts.json = true; continue }
    if (arg === "--refresh") { opts.refresh = true; continue }
    if (arg === "--offline") { opts.offline = true; continue }
    if (arg === "--dry-run") { opts.dryRun = true; continue }
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

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(usage())
    return
  }
  if (opts.command === null) die(`missing command\n\n${usage()}`)
  if (opts.command === "fix") {
    die(`"oc-deps fix" does not exist: no automatic updates. Run "oc-deps check --dry-run", review the diff, then edit the pin by hand and rerun the tests.`)
  }
  if (opts.command !== "check") die(`unknown command: ${opts.command}\n\n${usage()}`)
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
        offline: opts.offline,
        refresh: opts.refresh,
        ecosystem: opts.ecosystem,
        only,
        results: [],
        skipped: [],
        summary: { total: 0, up_to_date: 0, drift: 0, unknown: 0 },
      }, null, 2))
    } else {
      console.log(`No pinned ${opts.ecosystem ? `${opts.ecosystem} ` : ""}package in the kit for this filter.`)
    }
    return
  }

  const skipped = []
  const checked = []
  for (const pin of selected) {
    const file = locate(pin)
    if (!file) {
      skipped.push({ package: pin.package, id: pin.id, reason: "source file missing" })
      continue
    }
    checked.push({ ...pin, file })
  }
  if (!checked.length) {
    die(`no source file found for ${selected.map((p) => p.package).join(", ")}`)
  }

  const groups = groupByEcosystem(checked)
  const latest = opts.offline ? fetchOffline(groups) : fetchOnline(groups, opts.refresh)

  const results = checked.map((pin) => {
    const source = readPin(pin, pin.file)
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
      file: displayPath(pin.file),
      line: source.lineNo,
      line_text: source.line,
    }
    if (got?.cached) result.cached = true
    if (got?.source) result.source = got.source
    if (detail) result.detail = detail
    if (status === "drift" && value) {
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
  }

  if (opts.json) {
    console.log(JSON.stringify({
      generated_at: new Date().toISOString(),
      offline: opts.offline,
      refresh: opts.refresh,
      ecosystem: opts.ecosystem,
      only,
      results,
      skipped,
      summary,
    }, null, 2))
  } else {
    for (const s of skipped) console.error(`⚠️  skipped (file missing): ${s.package}`)
    printTable(results)
    console.log(`\n${summary.total} packages · ${summary.up_to_date} up to date · ${summary.drift} drift · ${summary.unknown} unknown`)
    for (const r of results.filter((r) => r.status === "unknown")) {
      console.error(`⚠️  ${r.package}: ${r.detail ?? "unknown version"}`)
    }
    if (opts.dryRun) {
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
  }

  process.exitCode = summary.drift || summary.unknown ? 1 : 0
}

try {
  main()
} catch (e) {
  die(e.message)
}
