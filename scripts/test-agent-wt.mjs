#!/usr/bin/env node
// Functional tests of agent-wt: real git repository created under /tmp, no network access.
// Covers new (task file, branch, exclude), list/list --porcelain (paths with spaces),
// registry (table + orphan task ignored), remove (dirty refused then --force), merge in
// conflict, worktree deleted by hand and invalid names.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TOOL = path.join(ROOT, "config", "bin", "agent-wt")
// macOS $TMPDIR (/var/folders/...) is a symlink to /private/var/folders/... while
// git reports resolved paths: compare canonical paths on both sides.
const real = (p) => {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p)
  } catch {
    return p
  }
}
const TMP = real(fs.mkdtempSync(path.join(os.tmpdir(), "agent-wt-test-")))
const REPO = path.join(TMP, "repo with space")
const WT = path.join(REPO, ".worktrees")
const EXCLUDE = path.join(REPO, ".git", "info", "exclude")
const GITCONFIG = path.join(TMP, "gitconfig")

fs.writeFileSync(GITCONFIG, "")
const ENV = {
  ...process.env,
  HOME: TMP,
  GIT_CONFIG_GLOBAL: GITCONFIG,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "agent-wt test",
  GIT_AUTHOR_EMAIL: "agent-wt@example.invalid",
  GIT_COMMITTER_NAME: "agent-wt test",
  GIT_COMMITTER_EMAIL: "agent-wt@example.invalid",
  LC_ALL: "C",
  TZ: "UTC",
}

let checks = 0
let failed = 0
const check = (name, cond, detail = "") => {
  checks++
  if (!cond) failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`)
}
const run = (args, cwd = REPO) =>
  spawnSync("bash", [TOOL, ...args], { cwd, encoding: "utf8", env: ENV, timeout: 30_000 })
const git = (args, cwd = REPO) =>
  spawnSync("git", args, { cwd, encoding: "utf8", env: ENV, timeout: 30_000 })
const gitOk = (args, cwd = REPO) => {
  const r = git(args, cwd)
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`)
  return r.stdout
}
const read = (file) => fs.readFileSync(file, "utf8")
const countLine = (text, line) => text.split("\n").filter((l) => l === line).length
const porcelain = () => {
  const r = run(["list", "--porcelain"])
  const lines = r.stdout.split("\n").filter(Boolean)
  const rows = lines.map((line) => line.split("\t"))
  return { r, lines, rows, byTask: new Map(rows.map((row) => [row[0], row])) }
}
const mdRows = (stdout) =>
  stdout
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| Task ") && !l.startsWith("| --- "))
    .map((l) => l.slice(1, -1).split("|").map((c) => c.trim()))

try {
  // --- test repository: path deliberately contains a space ---------------------------
  fs.mkdirSync(REPO, { recursive: true })
  gitOk(["init", "-q", "-b", "main"])
  gitOk(["config", "user.name", "agent-wt test"])
  gitOk(["config", "user.email", "agent-wt@example.invalid"])
  fs.writeFileSync(path.join(REPO, "README.md"), "initial line\n")
  gitOk(["add", "README.md"])
  gitOk(["commit", "-q", "-m", "init"])

  // --- new --------------------------------------------------------------------------
  let r = run(["new", "alpha", "--agent", "rust", "--session", "ses_alpha"])
  const ALPHA = path.join(WT, "alpha")
  check(
    "new: exit 0, path on stdout, canonical (no symlink component)",
    r.status === 0 && real(r.stdout.trim()) === real(ALPHA) && r.stdout.trim() === real(r.stdout.trim()),
    r.stderr,
  )
  check(
    "new: branch agent/alpha created",
    git(["show-ref", "--verify", "--quiet", "refs/heads/agent/alpha"]).status === 0,
  )
  check(
    "new: worktree registered (path with a space)",
    gitOk(["worktree", "list", "--porcelain"]).includes(`worktree ${ALPHA}`),
  )
  const alphaTask = read(path.join(ALPHA, "task"))
  check("new: task= in the task file", /^task=alpha$/m.test(alphaTask), alphaTask)
  check("new: branch= in the task file", /^branch=agent\/alpha$/m.test(alphaTask), alphaTask)
  check("new: agent= from --agent", /^agent=rust$/m.test(alphaTask), alphaTask)
  check("new: sessionID= from --session", /^sessionID=ses_alpha$/m.test(alphaTask), alphaTask)
  check(
    "new: created= UTC ISO 8601",
    /^created=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m.test(alphaTask),
    alphaTask,
  )
  check(
    "new: the task file does not make the worktree dirty",
    git(["status", "--porcelain"], ALPHA).stdout === "",
    git(["status", "--porcelain"], ALPHA).stdout,
  )
  const exclude = read(EXCLUDE)
  check("new: .worktrees/ added once to .git/info/exclude", countLine(exclude, ".worktrees/") === 1)
  check("new: /task added once to .git/info/exclude", countLine(exclude, "/task") === 1)
  check("new: .gitignore not created/modified", !fs.existsSync(path.join(REPO, ".gitignore")))
  check("new: main repository clean", git(["status", "--porcelain"]).stdout === "")

  r = run(["new", "beta"])
  const BETA = path.join(WT, "beta")
  const betaTask = read(path.join(BETA, "task"))
  check("new without options: exit 0", r.status === 0 && real(r.stdout.trim()) === real(BETA), r.stderr)
  check("new without options: no agent= line", !/^agent=/m.test(betaTask), betaTask)
  check("new without options: no sessionID= line", !/^sessionID=/m.test(betaTask), betaTask)
  check("new without options: exclude still unique", countLine(read(EXCLUDE), ".worktrees/") === 1)

  r = run(["new", "base-test", "main", "--agent", "qa"])
  const BASETEST = path.join(WT, "base-test")
  check("new [base]: positional argument still accepted", r.status === 0 && real(r.stdout.trim()) === real(BASETEST), r.stderr)
  check("new [base]: agent= written after the base argument", /^agent=qa$/m.test(read(path.join(BASETEST, "task"))))
  check(
    "new [base]: branch created at main's HEAD",
    gitOk(["rev-parse", "HEAD"], BASETEST).trim() === gitOk(["rev-parse", "main"]).trim(),
  )
  r = run(["remove", "base-test"])
  check(
    "remove: clean worktree removed with its branch",
    r.status === 0 &&
      !fs.existsSync(BASETEST) &&
      git(["show-ref", "--verify", "--quiet", "refs/heads/agent/base-test"]).status !== 0,
    r.stderr,
  )

  // --- invalid names / duplicates ----------------------------------------------------
  for (const bad of ["bad/name", "../evade", "foo bar", ".", "..", "-evil", "a|b", "x.lock", "x.", ""]) {
    const rr = run(["new", bad])
    check(`invalid name refused: ${JSON.stringify(bad)}`, rr.status !== 0 && /Invalid task name/i.test(rr.stderr), rr.stderr)
  }
  check("invalid name: no escape outside .worktrees", !fs.existsSync(path.join(TMP, "evade")))
  r = run(["new", "alpha"])
  check("new: existing branch refused", r.status !== 0 && /already exists/.test(r.stderr), r.stderr)
  r = run(["--help"])
  check("--help: usage on stdout and exit 0", r.status === 0 && /usage: agent-wt/.test(r.stdout))
  r = run([])
  check("no command: usage on stderr and exit 1", r.status === 1 && /usage: agent-wt/.test(r.stderr))

  // --- list (default output unchanged) -----------------------------------------------
  r = run(["list"])
  check(
    "list: identical to git worktree list",
    r.status === 0 && r.stdout.trimEnd() === gitOk(["worktree", "list"]).trimEnd(),
    r.stdout,
  )
  check("list: extra argument refused", run(["list", "--porcelain", "x"]).status !== 0)

  // --- list --porcelain --------------------------------------------------------------
  let p = porcelain()
  check("porcelain: exit 0 and no header", p.r.status === 0 && !/^task\t/.test(p.r.stdout))
  check("porcelain: one line per worktree (3)", p.lines.length === 3, p.r.stdout)
  check("porcelain: 7 fields per line", p.rows.every((row) => row.length === 7), p.r.stdout)
  const mainRow = p.byTask.get("-")
  const alphaRow = p.byTask.get("alpha")
  check("porcelain: main repository with task '-'", Boolean(mainRow), p.r.stdout)
  check(
    "porcelain: main branch",
    mainRow && mainRow[1] === "main" && mainRow[2] === "0" && mainRow[3] === "0" && mainRow[4] === "0",
    mainRow && mainRow.join("|"),
  )
  check("porcelain: main short commit", Boolean(mainRow && /^[0-9a-f]{7,}$/.test(mainRow[5])))
  check("porcelain: exact main path", mainRow && real(mainRow[6]) === real(REPO), mainRow && mainRow[6])
  check(
    "porcelain: alpha (task, branch, dirty 0, 0/0)",
    alphaRow &&
      alphaRow[1] === "agent/alpha" &&
      alphaRow[2] === "0" &&
      alphaRow[3] === "0" &&
      alphaRow[4] === "0",
    alphaRow && alphaRow.join("|"),
  )
  check("porcelain: exact alpha path with a space", alphaRow && real(alphaRow[6]) === real(ALPHA), alphaRow && alphaRow[6])
  check(
    "porcelain: alpha short commit",
    Boolean(alphaRow && alphaRow[5] === gitOk(["rev-parse", "--short", "HEAD"], ALPHA).trim()),
  )
  r = run(["list", "--porcelain"], ALPHA)
  check(
    "porcelain: run from a worktree, same main repository",
    r.status === 0 && r.stdout === p.r.stdout,
    r.stderr,
  )

  // dirty / ahead / behind
  fs.writeFileSync(path.join(ALPHA, "dirty.txt"), "uncommitted\n")
  p = porcelain()
  check("porcelain: dirty=1 with an uncommitted file", p.byTask.get("alpha")[2] === "1")
  fs.rmSync(path.join(ALPHA, "dirty.txt"))
  fs.writeFileSync(path.join(ALPHA, "alpha.txt"), "alpha commit\n")
  gitOk(["add", "alpha.txt"], ALPHA)
  gitOk(["commit", "-q", "-m", "alpha commit"], ALPHA)
  p = porcelain()
  check(
    "porcelain: ahead=1 after a commit in the worktree",
    p.byTask.get("alpha")[3] === "1" && p.byTask.get("alpha")[4] === "0",
    p.byTask.get("alpha").join("|"),
  )
  fs.writeFileSync(path.join(REPO, "main.txt"), "main commit\n")
  gitOk(["add", "main.txt"])
  gitOk(["commit", "-q", "-m", "main commit"])
  p = porcelain()
  check(
    "porcelain: behind=1 after a commit on main",
    p.byTask.get("alpha")[3] === "1" && p.byTask.get("alpha")[4] === "1",
    p.byTask.get("alpha").join("|"),
  )

  // detached HEAD: no branch
  r = run(["new", "detach"])
  const DET = path.join(WT, "detach")
  check("new detach: exit 0", r.status === 0 && real(r.stdout.trim()) === real(DET), r.stderr)
  gitOk(["checkout", "--detach", "HEAD"], DET)
  p = porcelain()
  check("porcelain: branch '-' when HEAD is detached", p.byTask.get("detach")[1] === "-", p.byTask.get("detach").join("|"))

  // --- registry ----------------------------------------------------------------------
  fs.mkdirSync(path.join(WT, "orphan"), { recursive: true })
  fs.writeFileSync(
    path.join(WT, "orphan", "task"),
    "task=orphan\nbranch=agent/orphan\ncreated=2026-01-01T00:00:00Z\n",
  )
  r = run(["registry"])
  check("registry: exit 0", r.status === 0, r.stderr)
  check("registry: title", r.stdout.includes("# Task registry"))
  check(
    "registry: exact header",
    r.stdout.includes("| Task | Branch | Dirty | Ahead/Behind | Commit | Path |"),
  )
  const rows = mdRows(r.stdout)
  const alphaMd = rows.find((row) => row[0] === "alpha")
  check("registry: alpha row present", Boolean(alphaMd), r.stdout)
  check(
    "registry: alpha values (branch, dirty, ahead/behind, commit)",
    alphaMd &&
      alphaMd[1] === "agent/alpha" &&
      alphaMd[2] === "0" &&
      alphaMd[3] === "1/1" &&
      alphaMd[4] === gitOk(["rev-parse", "--short", "HEAD"], ALPHA).trim(),
    alphaMd && alphaMd.join("|"),
  )
  check("registry: alpha path with a space", alphaMd && real(alphaMd[5]) === real(ALPHA), alphaMd && alphaMd[5])
  check("registry: main repository excluded", !rows.some((row) => row[0] === "-"), r.stdout)
  check("registry: orphan task file ignored", !r.stdout.includes("orphan"), r.stdout)
  check("list: orphan worktree absent", !porcelain().byTask.has("orphan"))

  // registry --out: keeps the History section
  const REG = path.join(WT, "REGISTRY.md")
  fs.writeFileSync(REG, "# old registry\n\n## History\n\n- kept trace\n")
  r = run(["registry", "--out", REG])
  let reg = read(REG)
  check("registry --out: exit 0 and empty stdout", r.status === 0 && r.stdout === "", r.stderr)
  check("registry --out: table regenerated", reg.includes("| alpha | agent/alpha |"), reg)
  check("registry --out: history kept", reg.includes("## History") && reg.includes("- kept trace"))
  check("registry --out: old content replaced", !reg.includes("# old registry"))
  run(["registry", "--out", REG])
  reg = read(REG)
  check("registry --out: history not duplicated", (reg.match(/- kept trace/g) || []).length === 1)
  check("registry: bad argument refused", run(["registry", "--bad"]).status !== 0)
  // Legacy French heading "Historique" (no accent) kept for backward compatibility.
  const LEGACY = path.join(WT, "LEGACY.md")
  fs.writeFileSync(LEGACY, "# old registry\n\n## Historique\n\n- legacy trace\n")
  run(["registry", "--out", LEGACY])
  check(
    "registry --out: legacy 'Historique' section still kept",
    read(LEGACY).includes("## Historique") && read(LEGACY).includes("- legacy trace"),
  )

  // --- remove -----------------------------------------------------------------------
  r = run(["new", "dirty"])
  const DIRTY = path.join(WT, "dirty")
  check("new dirty: exit 0", r.status === 0 && real(r.stdout.trim()) === real(DIRTY), r.stderr)
  fs.writeFileSync(path.join(DIRTY, "uncommitted.txt"), "to lose\n")
  r = run(["remove", "dirty"])
  check("remove: refused with uncommitted changes", r.status !== 0 && /uncommitted changes/.test(r.stderr), r.stderr)
  check("remove: worktree kept after refusal", fs.existsSync(DIRTY))
  check(
    "remove: branch kept after refusal",
    git(["show-ref", "--verify", "--quiet", "refs/heads/agent/dirty"]).status === 0,
  )
  r = run(["remove", "dirty", "--force"])
  check("remove --force: exit 0", r.status === 0, r.stderr)
  check("remove --force: worktree removed", !fs.existsSync(DIRTY))
  check(
    "remove --force: branch removed",
    git(["show-ref", "--verify", "--quiet", "refs/heads/agent/dirty"]).status !== 0,
  )
  r = run(["remove", "ghost"])
  check("remove: unknown task refused clearly", r.status !== 0 && /not found/.test(r.stderr), r.stderr)

  // --- merge ------------------------------------------------------------------------
  r = run(["new", "conflict"])
  const CONF = path.join(WT, "conflict")
  check("new conflict: exit 0", r.status === 0 && real(r.stdout.trim()) === real(CONF), r.stderr)
  fs.writeFileSync(path.join(CONF, "README.md"), "worktree version\n")
  gitOk(["add", "README.md"], CONF)
  gitOk(["commit", "-q", "-m", "worktree conflict"], CONF)
  fs.writeFileSync(path.join(REPO, "README.md"), "main version\n")
  gitOk(["add", "README.md"])
  gitOk(["commit", "-q", "-m", "main conflict"])
  fs.writeFileSync(path.join(CONF, "uncommitted.txt"), "x\n")
  r = run(["merge", "conflict"])
  check("merge: refused if the worktree is dirty", r.status !== 0 && /uncommitted changes/.test(r.stderr), r.stderr)
  fs.rmSync(path.join(CONF, "uncommitted.txt"))
  r = run(["merge", "conflict"])
  check("merge conflict: exit 2", r.status === 2, `status=${r.status} stderr=${r.stderr}`)
  check("merge conflict: CONFLICTS message", /CONFLICTS/.test(r.stderr), r.stderr)
  check("merge conflict: conflicting file listed", /README\.md/.test(r.stderr), r.stderr)
  check("merge conflict: real conflict in the repository", /^UU README\.md$/m.test(git(["status", "--porcelain"]).stdout))
  git(["merge", "--abort"])
  check("merge conflict: abort restores a clean repository", git(["status", "--porcelain"]).stdout === "")
  r = run(["merge", "ghost"])
  check("merge: missing branch refused clearly", r.status !== 0 && /not found/.test(r.stderr), r.stderr)

  // --- worktree deleted by hand ------------------------------------------------------
  fs.rmSync(DET, { recursive: true, force: true })
  p = porcelain()
  check("porcelain: worktree deleted by hand does not crash", p.r.status === 0 && p.byTask.has("detach"), p.r.stderr)
  check(
    "porcelain: vanished worktree marked dirty=1 and commit '-'",
    p.byTask.get("detach")[2] === "1" && p.byTask.get("detach")[5] === "-",
    p.byTask.get("detach").join("|"),
  )
  check("registry: vanished worktree ignored", !run(["registry"]).stdout.includes("| detach |"))
  r = run(["remove", "detach"])
  check("remove: vanished worktree and branch cleaned up", r.status === 0, r.stderr)
  check(
    "remove: detached branch removed",
    git(["show-ref", "--verify", "--quiet", "refs/heads/agent/detach"]).status !== 0,
  )
  check("remove: no more detach worktree", !gitOk(["worktree", "list", "--porcelain"]).includes(DET))
  check("registry: orphan still ignored after prune", !run(["registry"]).stdout.includes("orphan"))
} catch (error) {
  check("exception during the tests", false, String(error && error.stack ? error.stack : error))
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`❌ agent-wt: ${failed} failure(s) out of ${checks} check(s)`)
  process.exit(1)
}
console.log(`✅ agent-wt OK (${checks} checks)`)
