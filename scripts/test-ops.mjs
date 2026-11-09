#!/usr/bin/env node
// Hermetic tests of the operational tools:
//   oc-backup   archive + .sha256, missing config refused, last 5 kept
//   oc-restore  round-trip, corrupt archive refused, current config backed up,
//               exact added/modified/unchanged counts, --list
//   oc-usage    fake opencode stats: --json payload and --warn exit code
//   oc-deps     update --dry-run / --write guardrails, --write --yes + .bak,
//               check stays read-only (isolated repo copy, offline cache)
// Temp directories only, no network, no call to the real opencode or oc-versions.
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const BIN = path.join(ROOT, "config", "bin")
const BACKUP = path.join(BIN, "oc-backup")
const RESTORE = path.join(BIN, "oc-restore")
const USAGE = path.join(BIN, "oc-usage")
const DEPS_LAUNCHER = path.join(BIN, "oc-deps")
const DEPS_MODULE = path.join(ROOT, "config", "libexec", "oc-deps.mjs")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ops-test-"))

let checks = 0
let failed = 0
const check = (name, cond, detail = "") => {
  checks++
  if (!cond) failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${tail(detail)}`}`)
}
const tail = (s, n = 1500) => {
  const t = String(s ?? "").trim()
  return t.length > n ? `…${t.slice(-n)}` : t
}
const jsonOf = (text) => { try { return JSON.parse(text) } catch { return null } }

// Hermetic environment: the user's installed config, backup dir and version
// cache are ignored; HOME points inside the test directory.
const baseEnv = { ...process.env }
for (const key of [
  "OPENCODE_CONFIG_DIR",
  "OBSCURA_BIN_DIR",
  "OC_MEMPALACE_PLUGIN_DIR",
  "OC_BACKUP_DIR",
  "OC_VERSIONS_TTL",
  "OC_VERSIONS_CACHE",
  "OC_VERSIONS_FIXTURES",
]) delete baseEnv[key]
const HOME = path.join(TMP, "home")
fs.mkdirSync(HOME, { recursive: true })
baseEnv.HOME = HOME

const run = (tool, args, env = {}, opts = {}) =>
  spawnSync(tool, args, { encoding: "utf8", env: { ...baseEnv, ...env }, timeout: 60_000, ...opts })
const read = (file) => fs.readFileSync(file, "utf8")
const exists = (file) => fs.existsSync(file)
const write = (file, content, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  if (mode !== undefined) fs.chmodSync(file, mode)
}
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const matching = (dir, prefix, suffix = "") =>
  fs.readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith(suffix)).sort()

// --- fixtures -------------------------------------------------------------
const makeSetup = (name) => {
  const root = path.join(TMP, name)
  const config = path.join(root, "config")
  const bin = path.join(root, "bin")
  const mp = path.join(root, "mp")
  const backups = path.join(root, "backups")
  write(path.join(config, "opencode.jsonc"), '{"v":1}\n')
  write(path.join(config, "agents", "ceo.md"), "ceo\n")
  write(path.join(config, "keep.txt"), "keep\n")
  write(path.join(bin, "oc-demo"), "#!/bin/sh\nprintf 'demo\\n'\n", 0o755)
  write(path.join(mp, "package.json"), '{"name":"mempalace-plugin"}\n')
  fs.mkdirSync(backups, { recursive: true })
  return {
    root,
    config,
    bin,
    mp,
    backups,
    env: {
      OPENCODE_CONFIG_DIR: config,
      OBSCURA_BIN_DIR: bin,
      OC_MEMPALACE_PLUGIN_DIR: mp,
      OC_BACKUP_DIR: backups,
    },
  }
}

const tarList = (archive) => {
  const r = spawnSync("tar", ["-tzf", archive], { encoding: "utf8", timeout: 30_000 })
  return { status: r.status, members: r.stdout.split("\n").filter(Boolean) }
}

// --- 1. oc-backup ---------------------------------------------------------
let r = run(BACKUP, ["--out", path.join(TMP, "missing-backups")], {
  OPENCODE_CONFIG_DIR: path.join(TMP, "does-not-exist"),
})
check(
  "backup: missing config refused (exit 1)",
  r.status === 1 && /config directory not found/.test(r.stderr),
  r.stdout + r.stderr,
)
check("backup: missing config writes nothing", !exists(path.join(TMP, "missing-backups")))

const b1 = makeSetup("backup")
r = run(BACKUP, ["--out", b1.backups], b1.env)
const b1Archives = matching(b1.backups, "opencode-", ".tar.gz")
check("backup: exit 0 and exactly one archive", r.status === 0 && b1Archives.length === 1, r.stdout + r.stderr)
const b1Archive = path.join(b1.backups, b1Archives[0])
const b1Sha = `${b1Archive}.sha256`
check("backup: .sha256 written next to the archive", exists(b1Sha), r.stdout)
check(
  "backup: checksum matches the archive bytes",
  read(b1Sha).trim().split(/\s+/)[0] === sha256(b1Archive) && read(b1Sha).includes(b1Archives[0]),
  read(b1Sha),
)
const b1List = tarList(b1Archive)
check(
  "backup: archive holds config, launcher, plugin settings and info",
  b1List.status === 0
  && ["backup-info.txt", "config/opencode.jsonc", "config/agents/ceo.md", "bin/oc-demo", "mempalace-plugin/package.json"]
    .every((m) => b1List.members.includes(m)),
  b1List.members.join("\n"),
)
const info = spawnSync("tar", ["-xOzf", b1Archive, "backup-info.txt"], { encoding: "utf8", timeout: 30_000 }).stdout
check(
  "backup: backup-info.txt reports the real counts",
  /^config_files=3$/m.test(info) && /^bin_files=1$/m.test(info) && /^mempalace_files=1$/m.test(info),
  info,
)

const b5 = makeSetup("retention")
let retentionOk = true
let firstArchive = ""
for (let i = 0; i < 7; i++) {
  const out = run(BACKUP, ["--out", b5.backups], b5.env)
  if (out.status !== 0) retentionOk = false
  if (i === 0) firstArchive = matching(b5.backups, "opencode-", ".tar.gz")[0] ?? ""
}
const kept = matching(b5.backups, "opencode-", ".tar.gz")
check("backup: 7 runs succeed", retentionOk)
check("backup: only the last 5 archives are kept", kept.length === 5, kept.join(", "))
check("backup: 5 matching .sha256 files are kept", matching(b5.backups, "opencode-", ".sha256").length === 5)
check(
  "backup: the oldest archive and its checksum are pruned",
  firstArchive !== "" && !exists(path.join(b5.backups, firstArchive)) && !exists(path.join(b5.backups, `${firstArchive}.sha256`)),
  firstArchive,
)

// --- 2. oc-restore round-trip --------------------------------------------
const rt = makeSetup("restore")
r = run(BACKUP, ["--out", rt.backups], rt.env)
const rtArchiveName = matching(rt.backups, "opencode-", ".tar.gz")[0]
const rtArchive = path.join(rt.backups, rtArchiveName)
check("restore: backup fixture created", r.status === 0 && exists(rtArchive), r.stdout + r.stderr)

// Drift the live setup before restoring: one file modified, one added, one
// unchanged, one removed; launcher and plugin settings removed too.
write(path.join(rt.config, "opencode.jsonc"), '{"v":2}\n')
fs.rmSync(path.join(rt.config, "agents", "ceo.md"))
write(path.join(rt.config, "extra.txt"), "extra\n")
fs.rmSync(path.join(rt.bin, "oc-demo"))
fs.rmSync(path.join(rt.mp, "package.json"))

r = run(RESTORE, [rtArchive], rt.env)
check("restore: exit 0", r.status === 0, r.stdout + r.stderr)
check(
  "restore: exact config counts (1 added, 1 modified, 1 unchanged)",
  /config 1 added, 1 modified, 1 unchanged/.test(r.stdout),
  r.stdout,
)
check(
  "restore: launcher and plugin counts",
  /launchers 1\/0\/0/.test(r.stdout) && /mempalace 1\/0\/0/.test(r.stdout),
  r.stdout,
)
check("restore: malformed count line is gone", !/added,  modified/.test(r.stdout), r.stdout)
const configBackups = matching(rt.root, "config.bak-")
check(
  "restore: current config backed up before touching it",
  /Current config backed up:/.test(r.stdout) && configBackups.length === 1,
  r.stdout + `\n${configBackups.join(", ")}`,
)
const preRestore = path.join(rt.root, configBackups[0])
check(
  "restore: backup holds the pre-restore state",
  read(path.join(preRestore, "opencode.jsonc")) === '{"v":2}\n'
  && read(path.join(preRestore, "extra.txt")) === "extra\n"
  && !exists(path.join(preRestore, "agents", "ceo.md")),
  preRestore,
)
check(
  "restore: config files restored",
  read(path.join(rt.config, "opencode.jsonc")) === '{"v":1}\n'
  && read(path.join(rt.config, "agents", "ceo.md")) === "ceo\n"
  && read(path.join(rt.config, "keep.txt")) === "keep\n",
)
check("restore: extra file not in the archive was kept", read(path.join(rt.config, "extra.txt")) === "extra\n")
check(
  "restore: launcher restored and executable",
  read(path.join(rt.bin, "oc-demo")).includes("demo") && (fs.statSync(path.join(rt.bin, "oc-demo")).mode & 0o111) !== 0,
)
check("restore: mempalace plugin settings restored", exists(path.join(rt.mp, "package.json")))

r = run(RESTORE, ["--list", "--dir", rt.backups], rt.env)
check(
  "restore --list: archive listed with a valid checksum",
  r.status === 0 && r.stdout.includes(rtArchiveName) && /sha256 ok/.test(r.stdout),
  r.stdout + r.stderr,
)

// --- 3. oc-restore refusals ----------------------------------------------
const corrupt = path.join(rt.root, "corrupt.tar.gz")
fs.copyFileSync(rtArchive, corrupt)
fs.appendFileSync(corrupt, "tampered")
fs.copyFileSync(`${rtArchive}.sha256`, `${corrupt}.sha256`)
let beforeBackups = matching(rt.root, "config.bak-").length
r = run(RESTORE, [corrupt], rt.env)
check(
  "restore: corrupt archive refused (exit 3, checksum mismatch)",
  r.status === 3 && /checksum mismatch/.test(r.stderr),
  r.stdout + r.stderr,
)
check(
  "restore: corrupt archive modified nothing",
  matching(rt.root, "config.bak-").length === beforeBackups && read(path.join(rt.config, "opencode.jsonc")) === '{"v":1}\n',
)

const noSha = path.join(rt.root, "nosha.tar.gz")
fs.copyFileSync(rtArchive, noSha)
beforeBackups = matching(rt.root, "config.bak-").length
r = run(RESTORE, [noSha], rt.env)
check(
  "restore: archive without checksum refused (exit 3)",
  r.status === 3 && /checksum file missing/.test(r.stderr),
  r.stdout + r.stderr,
)
check(
  "restore: unverifiable archive modified nothing",
  matching(rt.root, "config.bak-").length === beforeBackups && read(path.join(rt.config, "opencode.jsonc")) === '{"v":1}\n',
)

// --- 4. oc-usage with a fake opencode ------------------------------------
const fakeBin = path.join(TMP, "fake-bin")
const stats = {
  sessions: 3,
  subagents: 2,
  prompts: 10,
  steps: 42,
  cost: 1.25,
  tokens: { input: 600, output: 300, reasoning: 100, cache: { read: 50, write: 25 } },
  models: [
    {
      model: { providerID: "openai", id: "gpt-5" },
      steps: 20,
      tokens: { input: 400, output: 200, reasoning: 50, cache: { read: 30, write: 10 } },
      cost: 0.9,
    },
    {
      model: { providerID: "anthropic", id: "claude" },
      steps: 22,
      tokens: { input: 200, output: 100, reasoning: 50, cache: { read: 20, write: 15 } },
      cost: 0.35,
    },
  ],
}
write(
  path.join(fakeBin, "opencode"),
  `#!/bin/sh
if [ "$1" = stats ]; then
  if [ "\${FAKE_OPENCODE_FAIL:-}" = 1 ]; then
    echo "fake stats failure" >&2
    exit 1
  fi
  cat <<'JSON'
${JSON.stringify(stats, null, 2)}
JSON
  exit 0
fi
exit 1
`,
  0o755,
)
const usageEnv = { PATH: `${fakeBin}:${process.env.PATH}` }

r = run(USAGE, ["--json"], usageEnv)
let payload = jsonOf(r.stdout)
check("usage --json: exit 0 and valid JSON", r.status === 0 && payload !== null, r.stdout + r.stderr)
check(
  "usage --json: totals include input/output/reasoning/cache",
  payload?.tokens?.total === 1075 && payload.tokens.input === 600 && payload.tokens.cache_read === 50 && payload.tokens.cache_write === 25,
  JSON.stringify(payload?.tokens),
)
check(
  "usage --json: per-model table sorted by total tokens",
  payload?.models?.length === 2
  && payload.models[0].model === "openai/gpt-5" && payload.models[0].tokens.total === 690
  && payload.models[1].tokens.total === 385,
  JSON.stringify(payload?.models),
)
check(
  "usage --json: no invented quota, no default threshold",
  payload?.quota?.available === false && payload?.threshold === null,
  JSON.stringify({ quota: payload?.quota, threshold: payload?.threshold }),
)

r = run(USAGE, ["--json", "--warn", "1000"], usageEnv)
payload = jsonOf(r.stdout)
check(
  "usage --warn 1000: threshold crossed, exit 1",
  r.status === 1 && payload?.threshold?.exceeded === true && payload.threshold.tokens === 1000
  && /Token threshold exceeded/.test(r.stderr),
  r.stdout + r.stderr,
)
r = run(USAGE, ["--json", "--warn", "2k"], usageEnv)
payload = jsonOf(r.stdout)
check(
  "usage --warn 2k: below threshold, exit 0",
  r.status === 0 && payload?.threshold?.exceeded === false && payload.threshold.tokens === 2000,
  r.stdout + r.stderr,
)
r = run(USAGE, ["--warn", "1000"], usageEnv)
check("usage --warn 1000 (human output): exit 1", r.status === 1 && /Token threshold exceeded/.test(r.stderr), r.stdout + r.stderr)
r = run(USAGE, ["--warn", "nope"], usageEnv)
check(
  "usage --warn invalid: exit 2",
  r.status === 2 && /--warn expects a positive integer/.test(r.stderr),
  r.stdout + r.stderr,
)
r = run(USAGE, ["--json"], { ...usageEnv, FAKE_OPENCODE_FAIL: "1" })
check(
  "usage: opencode stats failure reported (exit 1)",
  r.status === 1 && /"opencode stats --days 7 --json" failed/.test(r.stderr) && /fake stats failure/.test(r.stderr),
  r.stdout + r.stderr,
)

// --- 5. oc-deps update in an isolated repository copy --------------------
const repo = path.join(TMP, "deps-repo")
write(path.join(repo, "config", "libexec", "oc-deps.mjs"), read(DEPS_MODULE))
write(path.join(repo, "config", "bin", "oc-deps"), read(DEPS_LAUNCHER), 0o755)
const install = path.join(repo, "install.sh")
const original = '#!/bin/sh\nOC_TRIVY_VERSION="${OC_TRIVY_VERSION:-0.76.1}"\n'
write(install, original)
const cache = path.join(TMP, "deps-cache")
write(
  path.join(cache, "github.json"),
  JSON.stringify({
    version: 1,
    entries: { "aquasecurity/trivy": { version: "v0.77.0", source: "fixture", fetchedAt: Date.now() } },
  }, null, 2),
)
const depsEnv = { OC_VERSIONS_CACHE: cache, OC_VERSIONS_FIXTURES: path.join(TMP, "no-fixtures") }
const deps = (args) => run(path.join(repo, "config", "bin", "oc-deps"), args, depsEnv)
const depsBackups = () => matching(repo, "install.sh.bak-")

r = deps(["check", "--only", "trivy", "--offline", "--json"])
payload = jsonOf(r.stdout)
check(
  "deps check: drift detected from the offline cache",
  r.status === 1 && payload?.results?.[0]?.status === "drift" && payload.results[0].latest === "v0.77.0",
  r.stdout + r.stderr,
)
check(
  "deps check: read-only (file unchanged, no .bak)",
  read(install) === original && depsBackups().length === 0,
)

r = deps(["update", "--only", "trivy", "--offline", "--dry-run"])
check(
  "deps update --dry-run: proposed diff, exit 1",
  r.status === 1 && /Proposed diff \(no file is modified\)/.test(r.stdout) && r.stdout.includes("0.77.0"),
  r.stdout + r.stderr,
)
check(
  "deps update --dry-run: no write",
  read(install) === original && depsBackups().length === 0,
)

r = deps(["update", "--only", "trivy", "--offline", "--write"])
check(
  "deps update --write without --yes: exit 2",
  r.status === 2 && /refusing to write without --yes/.test(r.stderr),
  r.stdout + r.stderr,
)
check(
  "deps update --write without --yes: no write",
  read(install) === original && depsBackups().length === 0,
)

r = deps(["update", "--only", "trivy", "--offline", "--write", "--yes"])
const backups = depsBackups()
check("deps update --write --yes: exit 0 after the final check", r.status === 0, r.stdout + r.stderr)
check(
  "deps update --write --yes: the pin is replaced",
  read(install).includes("0.77.0") && !read(install).includes("0.76.1"),
  read(install),
)
check(
  "deps update --write --yes: .bak-<timestamp> holds the original file",
  backups.length === 1 && read(path.join(repo, backups[0])) === original,
  backups.join(", "),
)
check("deps update --write --yes: recheck reports 0 drift", /0 drift/.test(r.stdout), r.stdout)

r = deps(["check", "--only", "trivy", "--offline"])
check("deps check: up to date after the update, still exit 0", r.status === 0 && /0 drift/.test(r.stdout), r.stdout + r.stderr)

fs.rmSync(TMP, { recursive: true, force: true })
console.log(failed ? `\n❌ ${failed} check(s) failed out of ${checks}` : `\n✅ ops tools OK — ${checks} checks`)
process.exitCode = failed ? 1 : 0
