#!/usr/bin/env node
// Tests fonctionnels de agent-wt : dépôt git réel créé sous /tmp, aucun accès réseau.
// Couvre new (fichier task, branche, exclude), list/list --porcelain (chemins avec
// espaces), registry (tableau + tâche orpheline ignorée), remove (sale refusé puis
// --force), merge en conflit, worktree supprimé à la main et noms invalides.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TOOL = path.join(ROOT, "config", "bin", "agent-wt")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agent-wt-test-"))
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
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} : ${r.stderr || r.stdout}`)
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
    .filter((l) => l.startsWith("| ") && !l.startsWith("| Tâche ") && !l.startsWith("| --- "))
    .map((l) => l.slice(1, -1).split("|").map((c) => c.trim()))

try {
  // --- dépôt de test : chemin volontairement avec un espace -------------------------
  fs.mkdirSync(REPO, { recursive: true })
  gitOk(["init", "-q", "-b", "main"])
  gitOk(["config", "user.name", "agent-wt test"])
  gitOk(["config", "user.email", "agent-wt@example.invalid"])
  fs.writeFileSync(path.join(REPO, "README.md"), "ligne initiale\n")
  gitOk(["add", "README.md"])
  gitOk(["commit", "-q", "-m", "init"])

  // --- new --------------------------------------------------------------------------
  let r = run(["new", "alpha", "--agent", "rust", "--session", "ses_alpha"])
  const ALPHA = path.join(WT, "alpha")
  check("new : code 0 et chemin sur stdout", r.status === 0 && r.stdout.trim() === ALPHA, r.stderr)
  check(
    "new : branche agent/alpha créée",
    git(["show-ref", "--verify", "--quiet", "refs/heads/agent/alpha"]).status === 0,
  )
  check(
    "new : worktree enregistré (chemin avec espace)",
    gitOk(["worktree", "list", "--porcelain"]).includes(`worktree ${ALPHA}`),
  )
  const alphaTask = read(path.join(ALPHA, "task"))
  check("new : task= dans le fichier task", /^task=alpha$/m.test(alphaTask), alphaTask)
  check("new : branch= dans le fichier task", /^branch=agent\/alpha$/m.test(alphaTask), alphaTask)
  check("new : agent= depuis --agent", /^agent=rust$/m.test(alphaTask), alphaTask)
  check("new : sessionID= depuis --session", /^sessionID=ses_alpha$/m.test(alphaTask), alphaTask)
  check(
    "new : created= UTC ISO 8601",
    /^created=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m.test(alphaTask),
    alphaTask,
  )
  check(
    "new : le fichier task ne rend pas le worktree sale",
    git(["status", "--porcelain"], ALPHA).stdout === "",
    git(["status", "--porcelain"], ALPHA).stdout,
  )
  const exclude = read(EXCLUDE)
  check("new : .worktrees/ ajouté une fois à .git/info/exclude", countLine(exclude, ".worktrees/") === 1)
  check("new : /task ajouté une fois à .git/info/exclude", countLine(exclude, "/task") === 1)
  check("new : .gitignore non créé/modifié", !fs.existsSync(path.join(REPO, ".gitignore")))
  check("new : dépôt principal propre", git(["status", "--porcelain"]).stdout === "")

  r = run(["new", "beta"])
  const BETA = path.join(WT, "beta")
  const betaTask = read(path.join(BETA, "task"))
  check("new sans options : code 0", r.status === 0 && r.stdout.trim() === BETA, r.stderr)
  check("new sans options : pas de ligne agent=", !/^agent=/m.test(betaTask), betaTask)
  check("new sans options : pas de ligne sessionID=", !/^sessionID=/m.test(betaTask), betaTask)
  check("new sans options : exclude toujours unique", countLine(read(EXCLUDE), ".worktrees/") === 1)

  r = run(["new", "base-test", "main", "--agent", "qa"])
  const BASETEST = path.join(WT, "base-test")
  check("new [base] : argument positionnel toujours accepté", r.status === 0 && r.stdout.trim() === BASETEST, r.stderr)
  check("new [base] : agent= écrit après l'argument base", /^agent=qa$/m.test(read(path.join(BASETEST, "task"))))
  check(
    "new [base] : branche créée au HEAD de main",
    gitOk(["rev-parse", "HEAD"], BASETEST).trim() === gitOk(["rev-parse", "main"]).trim(),
  )
  r = run(["remove", "base-test"])
  check(
    "remove : worktree propre supprimé avec sa branche",
    r.status === 0 &&
      !fs.existsSync(BASETEST) &&
      git(["show-ref", "--verify", "--quiet", "refs/heads/agent/base-test"]).status !== 0,
    r.stderr,
  )

  // --- noms invalides / doublons -----------------------------------------------------
  for (const bad of ["bad/name", "../evade", "foo bar", ".", "..", "-evil", "a|b", "x.lock", "x.", ""]) {
    const rr = run(["new", bad])
    check(`nom invalide refusé : ${JSON.stringify(bad)}`, rr.status !== 0 && /invalide/i.test(rr.stderr), rr.stderr)
  }
  check("nom invalide : aucune évasion hors .worktrees", !fs.existsSync(path.join(TMP, "evade")))
  r = run(["new", "alpha"])
  check("new : branche existante refusée", r.status !== 0 && /déjà existante/.test(r.stderr), r.stderr)
  r = run(["--help"])
  check("--help : usage sur stdout et code 0", r.status === 0 && /usage : agent-wt/.test(r.stdout))
  r = run([])
  check("sans commande : usage sur stderr et code 1", r.status === 1 && /usage : agent-wt/.test(r.stderr))

  // --- list (sortie par défaut inchangée) --------------------------------------------
  r = run(["list"])
  check(
    "list : identique à git worktree list",
    r.status === 0 && r.stdout.trimEnd() === gitOk(["worktree", "list"]).trimEnd(),
    r.stdout,
  )
  check("list : argument en trop refusé", run(["list", "--porcelain", "x"]).status !== 0)

  // --- list --porcelain --------------------------------------------------------------
  let p = porcelain()
  check("porcelain : code 0 et pas d'en-tête", p.r.status === 0 && !/^tâche\t/.test(p.r.stdout))
  check("porcelain : une ligne par worktree (3)", p.lines.length === 3, p.r.stdout)
  check("porcelain : 7 champs par ligne", p.rows.every((row) => row.length === 7), p.r.stdout)
  const mainRow = p.byTask.get("-")
  const alphaRow = p.byTask.get("alpha")
  check("porcelain : dépôt principal avec tâche '-'", Boolean(mainRow), p.r.stdout)
  check(
    "porcelain : branche du principal",
    mainRow && mainRow[1] === "main" && mainRow[2] === "0" && mainRow[3] === "0" && mainRow[4] === "0",
    mainRow && mainRow.join("|"),
  )
  check("porcelain : commit court du principal", Boolean(mainRow && /^[0-9a-f]{7,}$/.test(mainRow[5])))
  check("porcelain : chemin exact du principal", mainRow && mainRow[6] === REPO, mainRow && mainRow[6])
  check(
    "porcelain : alpha (tâche, branche, dirty 0, 0/0)",
    alphaRow &&
      alphaRow[1] === "agent/alpha" &&
      alphaRow[2] === "0" &&
      alphaRow[3] === "0" &&
      alphaRow[4] === "0",
    alphaRow && alphaRow.join("|"),
  )
  check("porcelain : chemin exact d'alpha avec espace", alphaRow && alphaRow[6] === ALPHA, alphaRow && alphaRow[6])
  check(
    "porcelain : commit court d'alpha",
    Boolean(alphaRow && alphaRow[5] === gitOk(["rev-parse", "--short", "HEAD"], ALPHA).trim()),
  )
  r = run(["list", "--porcelain"], ALPHA)
  check(
    "porcelain : lancé depuis un worktree, même dépôt principal",
    r.status === 0 && r.stdout === p.r.stdout,
    r.stderr,
  )

  // dirty / ahead / behind
  fs.writeFileSync(path.join(ALPHA, "sale.txt"), "non commité\n")
  p = porcelain()
  check("porcelain : dirty=1 avec un fichier non commité", p.byTask.get("alpha")[2] === "1")
  fs.rmSync(path.join(ALPHA, "sale.txt"))
  fs.writeFileSync(path.join(ALPHA, "alpha.txt"), "commit alpha\n")
  gitOk(["add", "alpha.txt"], ALPHA)
  gitOk(["commit", "-q", "-m", "commit alpha"], ALPHA)
  p = porcelain()
  check(
    "porcelain : ahead=1 après un commit dans le worktree",
    p.byTask.get("alpha")[3] === "1" && p.byTask.get("alpha")[4] === "0",
    p.byTask.get("alpha").join("|"),
  )
  fs.writeFileSync(path.join(REPO, "main.txt"), "commit main\n")
  gitOk(["add", "main.txt"])
  gitOk(["commit", "-q", "-m", "commit main"])
  p = porcelain()
  check(
    "porcelain : behind=1 après un commit sur main",
    p.byTask.get("alpha")[3] === "1" && p.byTask.get("alpha")[4] === "1",
    p.byTask.get("alpha").join("|"),
  )

  // HEAD détaché : branche absente
  r = run(["new", "detach"])
  const DET = path.join(WT, "detach")
  check("new detach : code 0", r.status === 0 && r.stdout.trim() === DET, r.stderr)
  gitOk(["checkout", "--detach", "HEAD"], DET)
  p = porcelain()
  check("porcelain : branche '-' quand HEAD est détaché", p.byTask.get("detach")[1] === "-", p.byTask.get("detach").join("|"))

  // --- registry ----------------------------------------------------------------------
  fs.mkdirSync(path.join(WT, "orpheline"), { recursive: true })
  fs.writeFileSync(
    path.join(WT, "orpheline", "task"),
    "task=orpheline\nbranch=agent/orpheline\ncreated=2026-01-01T00:00:00Z\n",
  )
  r = run(["registry"])
  check("registry : code 0", r.status === 0, r.stderr)
  check("registry : titre", r.stdout.includes("# Registre des tâches"))
  check(
    "registry : en-tête exact",
    r.stdout.includes("| Tâche | Branche | Dirty | Ahead/Behind | Commit | Chemin |"),
  )
  const rows = mdRows(r.stdout)
  const alphaMd = rows.find((row) => row[0] === "alpha")
  check("registry : ligne alpha présente", Boolean(alphaMd), r.stdout)
  check(
    "registry : valeurs alpha (branche, dirty, ahead/behind, commit)",
    alphaMd &&
      alphaMd[1] === "agent/alpha" &&
      alphaMd[2] === "0" &&
      alphaMd[3] === "1/1" &&
      alphaMd[4] === gitOk(["rev-parse", "--short", "HEAD"], ALPHA).trim(),
    alphaMd && alphaMd.join("|"),
  )
  check("registry : chemin alpha avec espace", alphaMd && alphaMd[5] === ALPHA, alphaMd && alphaMd[5])
  check("registry : dépôt principal exclu", !rows.some((row) => row[0] === "-"), r.stdout)
  check("registry : fichier task orphelin ignoré", !r.stdout.includes("orpheline"), r.stdout)
  check("list : worktree orphelin absent", !porcelain().byTask.has("orpheline"))

  // registry --out : conserve la section Historique
  const REG = path.join(WT, "REGISTRE.md")
  fs.writeFileSync(REG, "# ancien registre\n\n## Historique\n\n- trace conservée\n")
  r = run(["registry", "--out", REG])
  let reg = read(REG)
  check("registry --out : code 0 et stdout vide", r.status === 0 && r.stdout === "", r.stderr)
  check("registry --out : tableau régénéré", reg.includes("| alpha | agent/alpha |"), reg)
  check("registry --out : historique conservé", reg.includes("## Historique") && reg.includes("- trace conservée"))
  check("registry --out : ancien contenu remplacé", !reg.includes("# ancien registre"))
  run(["registry", "--out", REG])
  reg = read(REG)
  check("registry --out : historique non dupliqué", (reg.match(/- trace conservée/g) || []).length === 1)
  check("registry : mauvais argument refusé", run(["registry", "--bad"]).status !== 0)

  // --- remove -----------------------------------------------------------------------
  r = run(["new", "sale"])
  const SALE = path.join(WT, "sale")
  check("new sale : code 0", r.status === 0 && r.stdout.trim() === SALE, r.stderr)
  fs.writeFileSync(path.join(SALE, "non-commite.txt"), "à perdre\n")
  r = run(["remove", "sale"])
  check("remove : refusé si changements non commités", r.status !== 0 && /non commités/.test(r.stderr), r.stderr)
  check("remove : worktree conservé après refus", fs.existsSync(SALE))
  check(
    "remove : branche conservée après refus",
    git(["show-ref", "--verify", "--quiet", "refs/heads/agent/sale"]).status === 0,
  )
  r = run(["remove", "sale", "--force"])
  check("remove --force : code 0", r.status === 0, r.stderr)
  check("remove --force : worktree supprimé", !fs.existsSync(SALE))
  check(
    "remove --force : branche supprimée",
    git(["show-ref", "--verify", "--quiet", "refs/heads/agent/sale"]).status !== 0,
  )
  r = run(["remove", "fantome"])
  check("remove : tâche inconnue refusée clairement", r.status !== 0 && /introuvable/.test(r.stderr), r.stderr)

  // --- merge ------------------------------------------------------------------------
  r = run(["new", "conflit"])
  const CONF = path.join(WT, "conflit")
  check("new conflit : code 0", r.status === 0 && r.stdout.trim() === CONF, r.stderr)
  fs.writeFileSync(path.join(CONF, "README.md"), "version worktree\n")
  gitOk(["add", "README.md"], CONF)
  gitOk(["commit", "-q", "-m", "conflit worktree"], CONF)
  fs.writeFileSync(path.join(REPO, "README.md"), "version main\n")
  gitOk(["add", "README.md"])
  gitOk(["commit", "-q", "-m", "conflit main"])
  fs.writeFileSync(path.join(CONF, "non-commite.txt"), "x\n")
  r = run(["merge", "conflit"])
  check("merge : refusé si le worktree est sale", r.status !== 0 && /non commités/.test(r.stderr), r.stderr)
  fs.rmSync(path.join(CONF, "non-commite.txt"))
  r = run(["merge", "conflit"])
  check("merge conflit : code 2", r.status === 2, `status=${r.status} stderr=${r.stderr}`)
  check("merge conflit : message CONFLITS", /CONFLITS/.test(r.stderr), r.stderr)
  check("merge conflit : fichier en conflit listé", /README\.md/.test(r.stderr), r.stderr)
  check("merge conflit : conflit réel dans le dépôt", /^UU README\.md$/m.test(git(["status", "--porcelain"]).stdout))
  git(["merge", "--abort"])
  check("merge conflit : abort ramène un dépôt propre", git(["status", "--porcelain"]).stdout === "")
  r = run(["merge", "fantome"])
  check("merge : branche absente refusée clairement", r.status !== 0 && /introuvable/.test(r.stderr), r.stderr)

  // --- worktree supprimé à la main --------------------------------------------------
  fs.rmSync(DET, { recursive: true, force: true })
  p = porcelain()
  check("porcelain : worktree supprimé à la main ne plante pas", p.r.status === 0 && p.byTask.has("detach"), p.r.stderr)
  check(
    "porcelain : worktree disparu marqué dirty=1 et commit '-'",
    p.byTask.get("detach")[2] === "1" && p.byTask.get("detach")[5] === "-",
    p.byTask.get("detach").join("|"),
  )
  check("registry : worktree disparu ignoré", !run(["registry"]).stdout.includes("| detach |"))
  r = run(["remove", "detach"])
  check("remove : worktree disparu et branche nettoyés", r.status === 0, r.stderr)
  check(
    "remove : branche détachée supprimée",
    git(["show-ref", "--verify", "--quiet", "refs/heads/agent/detach"]).status !== 0,
  )
  check("remove : plus de worktree detach", !gitOk(["worktree", "list", "--porcelain"]).includes(DET))
  check("registry : orpheline toujours ignorée après prune", !run(["registry"]).stdout.includes("orpheline"))
} catch (error) {
  check("exception pendant les tests", false, String(error && error.stack ? error.stack : error))
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`❌ agent-wt : ${failed} échec(s) sur ${checks} contrôle(s)`)
  process.exit(1)
}
console.log(`✅ agent-wt OK (${checks} contrôles)`)
