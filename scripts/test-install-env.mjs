#!/usr/bin/env node
// Tests de l'installateur côté machine : bloc d'environnement (bash/zsh, shells non interactifs), désinstallation sans trace,
// installation transactionnelle (échec make-lite → rollback exact, repère .installed), --memory-only, personnalisations
// préservées (.new, --force-config), permissions (umask 077), MemPalace (fichier orphelin, lien « mempalace », plus de
// « init »), détection d'un OpenCode lancé avant l'installation, et MCP semgrep (--check réel vs --check-quick).
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { parseJsonc } from "./lib/jsonc.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-envtest-"))
let failed = 0
const check = (name, cond, detail = "") => { if (!cond) failed++; console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`) }
const sh = (cmd, args, env, cwd = ROOT) => spawnSync(cmd, args, { encoding: "utf8", cwd, env: { ...process.env, ...env } })
const write = (f, t, mode) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t, mode ? { mode } : undefined) }
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex")
// Empreinte récursive du CONTENU (noms, types, liens et octets), pas des permissions :
// sert à prouver qu'un rollback rend exactement l'arborescence d'avant (le durcissement
// des droits, lui, est vérifié séparément).
const treeDigest = (dir) => {
  const h = crypto.createHash("sha256")
  const walk = (d, rel = "") => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name), r = rel ? `${rel}/${name}` : name, st = fs.lstatSync(full)
      if (st.isDirectory()) { h.update(`D\0${r}\0`); walk(full, r) }
      else if (st.isSymbolicLink()) h.update(`L\0${r}\0${fs.readlinkSync(full)}\0`)
      else h.update(`F\0${r}\0${sha256(fs.readFileSync(full))}\0`)
    }
  }
  walk(dir)
  return h.digest("hex")
}
const mode = (f) => fs.statSync(f).mode & 0o777

// PATH hermétique partagé : tous les binaires réels sauf uv/uvx/pipx. Aucun test ne doit
// déclencher de téléchargement ni de compilation ; Node est un lanceur vers le vrai binaire.
const noUv = path.join(tmp, "noub")
fs.mkdirSync(noUv)
for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
  let names = []; try { names = fs.readdirSync(dir) } catch { continue }
  for (const n of names) if (!["node", "uv", "uvx", "pipx"].includes(n) && !fs.existsSync(path.join(noUv, n))) { try { fs.symlinkSync(path.join(dir, n), path.join(noUv, n)) } catch { /* ignoré */ } }
}
write(path.join(noUv, "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, 0o755)

// ---------- 1. bloc d'environnement ----------
const home = path.join(tmp, "home"), bin = path.join(home, ".local", "bin"), cfg = path.join(home, "cfg")
write(path.join(home, ".mempalace/venv/bin/python"), "#!/bin/sh\n", 0o755)
const bashrc0 = "# ~/.bashrc\n[[ $- != *i* ]] && return\nalias ll='ls -l'\n"
write(path.join(home, ".bashrc"), bashrc0)
write(path.join(home, ".zshrc"), '# zshrc\n[[ -o interactive ]] || return\nexport EDITOR=nvim\n\n# opencode-prerequisites\nexport PATH="/vieux:$PATH"\nexport MEMPALACE_ADAPTER_PYTHON="/vieux/python"\n')
const env = { HOME: home, OPENCODE_CONFIG_DIR: cfg, OBSCURA_BIN_DIR: bin, XDG_DATA_HOME: path.join(home, ".local/share"), PATH: noUv }
sh("./install.sh", ["--no-tools", "--shell-env"], env)
const afterOne = fs.readFileSync(path.join(home, ".bashrc"), "utf8")
for (let i = 0; i < 2; i++) sh("./install.sh", ["--no-tools", "--shell-env"], env)
const bashrc = fs.readFileSync(path.join(home, ".bashrc"), "utf8")
check("bash : un seul bloc, écrit AVANT le « return » des shells non interactifs", (bashrc.match(/>>> opencode-prerequisites/g) ?? []).length === 1 && bashrc.indexOf(">>> opencode-prerequisites") < bashrc.indexOf("return"))
const viaBashEnv = sh("bash", ["-c", 'echo "PY=$MEMPALACE_ADAPTER_PYTHON"; echo "FIN=${PATH##*:}"'], { env: undefined, HOME: home, PATH: "/usr/bin:/bin", BASH_ENV: path.join(home, ".bashrc") })
check("bash NON interactif (cas d'un service) : la variable est visible", viaBashEnv.stdout.includes(`PY=${home}/.mempalace/venv/bin/python`), viaBashEnv.stdout + viaBashEnv.stderr)
check("PATH : ~/.local/bin ajouté EN FIN, jamais en tête", viaBashEnv.stdout.includes(`FIN=${bin}`) && !new RegExp(`^PATH=${bin}`).test(bashrc))
const zshenv = fs.readFileSync(path.join(home, ".zshenv"), "utf8"), zshrc = fs.readFileSync(path.join(home, ".zshrc"), "utf8")
check("zsh : bloc dans ~/.zshenv (lu hors terminal interactif)", zshenv.includes(">>> opencode-prerequisites") && zshenv.includes("MEMPALACE_ADAPTER_PYTHON"))
check("zsh : ancien bloc retiré de ~/.zshrc, reste du fichier intact", !zshrc.includes("opencode-prerequisites") && !zshrc.includes("/vieux") && zshrc.includes("export EDITOR=nvim"))
check("idempotent : 3 exécutions donnent exactement le même fichier qu'une seule", bashrc === afterOne, `lignes ${afterOne.split("\n").length} → ${bashrc.split("\n").length}`)
sh("./uninstall.sh", [], env)
check("désinstallation : ~/.bashrc strictement identique à l'original", fs.readFileSync(path.join(home, ".bashrc"), "utf8") === bashrc0)
check("désinstallation : plus aucune trace dans .zshenv ni .zshrc", !/opencode-prerequisites/.test(fs.readFileSync(path.join(home, ".zshenv"), "utf8") + fs.readFileSync(path.join(home, ".zshrc"), "utf8")))

// ---------- 1b. gabarit, sauvegardes, fichiers personnels, état des MCP ----------
const h4 = path.join(tmp, "home4"), cfg4 = path.join(h4, "cfg"), bin4 = path.join(h4, ".local/bin")
const fakeDateDir = path.join(tmp, "fakedate")
fs.mkdirSync(fakeDateDir, { recursive: true })
write(path.join(fakeDateDir, "date"), "#!/bin/sh\necho 20260101-120000\n", 0o755) // deux installs « dans la même seconde »
write(path.join(h4, ".mempalace/venv/bin/python"), "#!/bin/sh\nexit 0\n", 0o755)
write(path.join(cfg4, "plugins/guard.js"), "// mon plugin perso\n")
write(path.join(cfg4, ".opencode-prerequisites.pentest"), "") // choix mémorisé : ne doit PAS être rejoué par --no-tools
// Faux uvx : uniquement pour les scénarios semgrep. Répond à l'initialize MCP du lanceur
// (qui exige "serverInfo" sur stdout) ; tout autre appel sort 0 sans bruit.
const fakeUvxDir = path.join(tmp, "fakeuvx")
write(path.join(fakeUvxDir, "uvx"), `#!/bin/sh
case "$*" in
  *semgrep-mcp*)
    cat >/dev/null 2>&1 || true
    printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"semgrep-mcp","version":"fake"}}}'
    exit 0 ;;
esac
exit 0
`, 0o755)
const env4 = { HOME: h4, OPENCODE_CONFIG_DIR: cfg4, OBSCURA_BIN_DIR: bin4, XDG_DATA_HOME: path.join(h4, ".local/share"), PATH: `${fakeDateDir}:${noUv}` }
const run4 = (args = ["--no-tools"], extra = {}) => sh("./install.sh", args, { ...env4, ...extra })
const cfg4text = () => fs.readFileSync(path.join(cfg4, "opencode.jsonc"), "utf8")
const cfg4json = () => parseJsonc(cfg4text())
const mcp4 = (name) => cfg4json().mcp.servers[name] ?? {}
const parses = (text) => { try { parseJsonc(text); return true } catch { return false } }
const disabledCount = (name) => (cfg4text().match(new RegExp(`"${name}"\\s*:\\s*\\{[^}]*?"disabled"\\s*:\\s*true`, "g")) ?? []).length
const backups4 = () => fs.readdirSync(h4).filter((n) => n.startsWith("cfg.bak-")).sort().map((n) => path.join(h4, n))

let r4 = run4()
check("install --no-tools : gabarit copié à plat (templates/rust-project, pas templates/templates)",
  fs.existsSync(path.join(cfg4, "templates/rust-project/Cargo.toml")) && !fs.existsSync(path.join(cfg4, "templates/templates")), r4.stdout + r4.stderr)
check("install --no-tools : fichier personnel plugins/guard.js conservé au premier install", fs.existsSync(path.join(cfg4, "plugins/guard.js")))
check("install --no-tools : aucun outil téléchargé (pentest/obscura/trivy/semgrep)",
  !["nuclei", "gitleaks", "semgrep", "obscura", "trivy", "mempalace"].some((n) => fs.existsSync(path.join(bin4, n))))
check("install --no-tools : choix pentest mémorisé non rejoué, mais conservé",
  !fs.existsSync(path.join(bin4, "nuclei")) && fs.existsSync(path.join(cfg4, ".opencode-prerequisites.pentest")))
check("install --no-tools : plugin MemPalace non installé même avec un venv présent", !fs.existsSync(path.join(cfg4, "plugins/mempalace")))
check("install : sauvegarde unique, pas de copie imbriquée", backups4().length === 1 && !fs.existsSync(path.join(backups4()[0], "cfg")), backups4().join(", "))

fs.writeFileSync(path.join(cfg4, "templates/rust-project/Cargo.toml"), "# périmé\n")
// Fichier « du kit » disparu : on l'inscrit au manifeste (comme l'aurait fait une ancienne version), il doit être retiré.
write(path.join(cfg4, "plugins/obsolete-kit.js"), "// ancien fichier du kit\n")
fs.appendFileSync(path.join(cfg4, ".opencode-prerequisites.manifest"), "plugins/obsolete-kit.js\n")
r4 = run4()
check("install : 2 installs dans la même seconde → 2 sauvegardes distinctes, aucune imbriquée",
  backups4().length === 2 && backups4().every((b) => !fs.existsSync(path.join(b, "cfg"))), backups4().join(", "))
check("install : un fichier du kit disparu (manifeste) est retiré à la 2e installation",
  !fs.existsSync(path.join(cfg4, "plugins/obsolete-kit.js")))
check("install : le gabarit rust-project est remis à jour au 2e install",
  fs.readFileSync(path.join(cfg4, "templates/rust-project/Cargo.toml"), "utf8") === fs.readFileSync(path.join(ROOT, "templates/rust-project/Cargo.toml"), "utf8"))
check("install : pas de templates/templates après 2 installs", !fs.existsSync(path.join(cfg4, "templates/templates")))
check("install : opencode.jsonc reste du JSONC valide", parses(cfg4text()))
check("install : kubernetes désactivé une seule fois, sans doublon",
  mcp4("kubernetes").disabled === true && disabledCount("kubernetes") === 1, `count=${disabledCount("kubernetes")}`)

// Réactivation : un contexte kubectl apparaît
write(path.join(h4, ".kube/config"), "apiVersion: v1\ncurrent-context: kind-test\n")
r4 = run4()
check("install : kubernetes réactivé quand un current-context existe",
  mcp4("kubernetes").disabled === undefined && disabledCount("kubernetes") === 0, r4.stdout + r4.stderr)

// REA : le lanceur --check dépend de la version de Node ; on la simule par la variable prévue.
r4 = run4(["--no-tools"], { OC_REA_NODE_VERSION: "26.12.1" })
check("install : rea réactivé quand le serveur --check réussit", mcp4("rea").disabled === undefined && disabledCount("rea") === 0, r4.stdout + r4.stderr)
r4 = run4(["--no-tools"], { OC_REA_NODE_VERSION: "22.0.0" })
check("install : rea désactivé une seule fois quand Node est trop ancien", mcp4("rea").disabled === true && disabledCount("rea") === 1)

// Semgrep : PATH sans uv/uvx/pipx → désactivé, puis réactivé avec le faux uvx (hermétique).
const noUvPath = `${fakeDateDir}:${noUv}`
r4 = run4(["--no-tools"], { PATH: noUvPath })
check("install : semgrep désactivé une seule fois sans uvx/pipx", mcp4("semgrep").disabled === true && disabledCount("semgrep") === 1, r4.stdout + r4.stderr)
r4 = run4(["--no-tools"], { PATH: noUvPath })
check("install : semgrep reste désactivé, sans doublon, après un 2e install sans uvx/pipx",
  mcp4("semgrep").disabled === true && disabledCount("semgrep") === 1)
const fakeUvxPath = `${fakeDateDir}:${fakeUvxDir}:${noUv}`
const uvxResolu = sh("sh", ["-c", "command -v uvx"], { PATH: fakeUvxPath }).stdout.trim()
check("test semgrep : le faux uvx est bien celui résolu (jamais le vrai)", uvxResolu === path.join(fakeUvxDir, "uvx"), uvxResolu)
const uvMasques = sh("sh", ["-c", 'for c in uv uvx pipx; do command -v "$c" && exit 1; done; exit 0'], { PATH: noUvPath })
check("test semgrep : uv/uvx/pipx masqués quand le faux uvx est absent", uvMasques.status === 0, uvMasques.stdout + uvMasques.stderr)
r4 = run4(["--no-tools"], { PATH: fakeUvxPath })
check("install : semgrep réactivé quand uvx revient", mcp4("semgrep").disabled === undefined && disabledCount("semgrep") === 0, r4.stdout + r4.stderr)
r4 = run4(["--no-tools"], { PATH: fakeUvxPath })
check("install : 2 installs avec uvx ne recréent pas de \"disabled\" pour semgrep",
  mcp4("semgrep").disabled === undefined && disabledCount("semgrep") === 0)

// Lanceur oc-semgrep-mcp : --check fait la vraie poignée de main ; --check-quick ne lance AUCUN processus.
// Faux uvx journalisé : il note ses arguments, puis répond à l'initialize MCP comme le vrai serveur.
const launcher = path.join(ROOT, "config/bin/oc-semgrep-mcp")
const fakeUvxLogDir = path.join(tmp, "fakeuvx-log"), uvxArgsLog = path.join(tmp, "uvx-args.log")
write(path.join(fakeUvxLogDir, "uvx"), `#!/bin/sh
printf '%s\\n' "$*" >> "${uvxArgsLog}"
cat >/dev/null 2>&1 || true
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"semgrep-mcp","version":"fake"}}}'
exit 0
`, 0o755)
const fakePipxDir = path.join(tmp, "fakepipx")
write(path.join(fakePipxDir, "pipx"), "#!/bin/sh\nexit 99\n", 0o755) // présent, mais --check-quick ne doit pas l'exécuter
const readLog = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : "")

const quickUvx = sh("bash", [launcher, "--check-quick"], { PATH: `${fakeUvxLogDir}:${noUv}` })
check("--check-quick : code 0 avec uvx présent, sans exécuter uvx",
  quickUvx.status === 0 && /uvx détecté/.test(quickUvx.stdout) && readLog(uvxArgsLog) === "",
  `code ${quickUvx.status} | ${quickUvx.stdout}${quickUvx.stderr} | journal « ${readLog(uvxArgsLog)} »`)
const quickPipx = sh("bash", [launcher, "--check-quick"], { PATH: `${fakePipxDir}:${noUv}` })
check("--check-quick : code 0 avec pipx seul (uvx absent), sans exécuter pipx",
  quickPipx.status === 0 && /pipx détecté/.test(quickPipx.stdout), `code ${quickPipx.status} | ${quickPipx.stdout}${quickPipx.stderr}`)
const quickNone = sh("bash", [launcher, "--check-quick"], { PATH: noUv })
check("--check-quick : code 1 sans uvx ni pipx, message clair",
  quickNone.status === 1 && /ni uvx ni pipx/.test(quickNone.stderr), `code ${quickNone.status} | ${quickNone.stderr}`)

const realCheck = sh("bash", [launcher, "--check"], { PATH: `${fakeUvxLogDir}:${noUv}` })
const uvxArgs = readLog(uvxArgsLog)
check("--check : poignée de main MCP réelle via uvx (code 0, serverInfo)",
  realCheck.status === 0 && /poignée de main MCP initialize OK/.test(realCheck.stdout) && /serverInfo semgrep-mcp fake/.test(realCheck.stdout),
  `code ${realCheck.status} | ${realCheck.stdout}${realCheck.stderr}`)
check("--check : uvx reçoit --python '>=3.10,<3.14' et la version épinglée (verrou Python/pydantic)",
  /--python\s+>=3\.10,<3\.14(\s|$)/.test(uvxArgs) && /--from semgrep-mcp==0\.9\.0/.test(uvxArgs) && /--with pydantic==2\.11\.10/.test(uvxArgs), uvxArgs)

// --no-tools : le lanceur doit rester en --check-quick ; ce faux uvx piège (journal + échec) ne doit
// jamais être exécuté, sinon semgrep serait désactivé et le journal contiendrait un appel.
const hTrap = path.join(tmp, "home-trap"), cfgTrap = path.join(hTrap, "cfg"), binTrap = path.join(hTrap, ".local/bin")
const trapDir = path.join(tmp, "uvx-trap"), trapLog = path.join(tmp, "uvx-trap.log")
write(path.join(trapDir, "uvx"), `#!/bin/sh
printf '%s\\n' "$*" >> "${trapLog}"
exit 97
`, 0o755)
const rTrap = sh("./install.sh", ["--no-tools"], {
  HOME: hTrap, OPENCODE_CONFIG_DIR: cfgTrap, OBSCURA_BIN_DIR: binTrap,
  XDG_DATA_HOME: path.join(hTrap, ".local/share"), PATH: `${trapDir}:${noUv}`,
})
let semTrap = {}
try { semTrap = parseJsonc(fs.readFileSync(path.join(cfgTrap, "opencode.jsonc"), "utf8")).mcp?.servers?.semgrep ?? {} } catch { /* signalé par le test suivant */ }
check("install --no-tools : n'exécute JAMAIS uvx (piège : journal vide + code 0)",
  rTrap.status === 0 && readLog(trapLog) === "", `code ${rTrap.status} | appels uvx : « ${readLog(trapLog)} » | ${rTrap.stderr}`)
check("install --no-tools : semgrep activé sur simple présence de uvx, sans poignée de main",
  semTrap.disabled === undefined && Object.keys(semTrap).length > 0, JSON.stringify(semTrap))
check("install --no-tools : message semgrep annonce la vérification différée",
  /démarrage vérifié à la prochaine installation complète/.test(rTrap.stdout), rTrap.stdout)

// Scénario CI : --no-tools --android copie le module (fichiers), sans rien télécharger.
const cfgAndroid = path.join(tmp, "cfg-android"), binAndroid = path.join(tmp, "bin-android")
r4 = sh("./install.sh", ["--no-tools", "--android"], { ...env4, OPENCODE_CONFIG_DIR: cfgAndroid, OBSCURA_BIN_DIR: binAndroid })
check("install --no-tools --android : module Android installé (agents, boucle oc-android)",
  r4.status === 0 && fs.existsSync(path.join(cfgAndroid, "agents/android.md")) && fs.existsSync(path.join(cfgAndroid, ".opencode-prerequisites.android")) && fs.existsSync(path.join(binAndroid, "oc-android")), r4.stdout + r4.stderr)
check("install --no-tools --android : aucun binaire téléchargé",
  !["nuclei", "gitleaks", "semgrep", "obscura", "trivy"].some((n) => fs.existsSync(path.join(binAndroid, n))))

// Sauvegarde puis restauration : la 2e sauvegarde de la même seconde doit être choisie.
const h5 = path.join(tmp, "home5"), cfg5 = path.join(h5, "cfg"), bin5 = path.join(h5, ".local/bin")
write(path.join(cfg5, "personnel.txt"), "perso\n")
const env5 = { ...env4, HOME: h5, OPENCODE_CONFIG_DIR: cfg5, OBSCURA_BIN_DIR: bin5 }
sh("./install.sh", ["--no-tools"], env5)
write(path.join(cfg5, "apres-premier-install.txt"), "x\n")
sh("./install.sh", ["--no-tools"], env5)
r4 = sh("./uninstall.sh", [], env5)
const removed5 = fs.readdirSync(h5).filter((n) => n.startsWith("cfg.removed-"))
check("uninstall : restaure la sauvegarde la plus récente (suffixe de même seconde)",
  fs.existsSync(path.join(cfg5, "apres-premier-install.txt")) && fs.existsSync(path.join(cfg5, "personnel.txt")), r4.stdout + r4.stderr)
check("uninstall : config actuelle déplacée sans imbrication",
  removed5.length === 1 && !fs.existsSync(path.join(h5, removed5[0], "cfg")), removed5.join(", "))

// ---------- 1c. échec de make-lite : la phase config est annulée et TOUT est rendu à l'identique ----------
const h6 = path.join(tmp, "home6"), cfg6 = path.join(h6, "cfg"), bin6 = path.join(h6, ".local/bin")
write(path.join(cfg6, "temoin.txt"), "témoin d'avant installation\n")
const fakeLiteDir = path.join(tmp, "fakenode-lite")
write(path.join(fakeLiteDir, "node"), `#!/bin/sh
case "$*" in
  *make-lite.mjs*) printf 'make-lite : échec simulé\\n' >&2; exit 42 ;;
esac
exec "${process.execPath}" "$@"
`, 0o755)
const digest6 = treeDigest(cfg6)
const r6 = sh("./install.sh", ["--lite"], {
  HOME: h6, OPENCODE_CONFIG_DIR: cfg6, OBSCURA_BIN_DIR: bin6,
  XDG_DATA_HOME: path.join(h6, ".local/share"), PATH: `${fakeLiteDir}:${noUv}`,
})
check("échec make-lite : code non nul et installation annoncée comme annulée",
  r6.status !== 0 && /Installation annulée/.test(r6.stdout + r6.stderr), `code ${r6.status} | ${r6.stdout}${r6.stderr}`)
check("échec make-lite : $DEST strictement identique (hash récursif avant/après)",
  treeDigest(cfg6) === digest6, `avant ${digest6.slice(0, 12)} après ${treeDigest(cfg6).slice(0, 12)}`)
check("échec make-lite : repère .opencode-prerequisites.installed absent",
  !fs.existsSync(path.join(cfg6, ".opencode-prerequisites.installed")))
check("échec make-lite : aucun lanceur résiduel dans $BIN",
  !fs.existsSync(bin6) || fs.readdirSync(bin6).length === 0, fs.existsSync(bin6) ? fs.readdirSync(bin6).join(", ") : "BIN absent")

// ---------- 1d. --memory-only : ne touche jamais au repère .installed ----------
const hMem = path.join(tmp, "home-mem"), memCfg = path.join(hMem, "cfg"), memBin = path.join(hMem, ".local/bin")
const memVenv = path.join(hMem, ".mempalace/venv/bin"), memFake = path.join(tmp, "fake-npm-mem")
write(path.join(memVenv, "python"), "#!/bin/sh\nexit 0\n", 0o755)
write(path.join(memVenv, "mempalace"), "#!/bin/sh\nexit 0\n", 0o755)
write(path.join(memFake, "npm"), `#!/bin/sh
mkdir -p node_modules/@rvboris/opencode-mempalace/dist/plugin
printf 'export default {}\\n' > node_modules/@rvboris/opencode-mempalace/dist/plugin/index.js
`, 0o755)
const envMem = { HOME: hMem, OPENCODE_CONFIG_DIR: memCfg, OBSCURA_BIN_DIR: memBin, XDG_DATA_HOME: path.join(hMem, ".local/share"), PATH: `${memFake}:${noUv}` }
write(path.join(memCfg, "config-perso.txt"), "garde\n")
const memMarker = path.join(memCfg, ".opencode-prerequisites.installed")
let rMem = sh("./install.sh", ["--memory-only"], envMem)
check("memory-only sans repère : exécution OK, repère toujours absent, config personnelle intacte",
  rMem.status === 0 && !fs.existsSync(memMarker) && fs.readFileSync(path.join(memCfg, "config-perso.txt"), "utf8") === "garde\n"
  && fs.existsSync(path.join(memCfg, "plugins/mempalace/index.ts")), `code ${rMem.status} | ${rMem.stdout}${rMem.stderr}`)
fs.writeFileSync(memMarker, "repère existant\n")
const markerDate = new Date("2021-02-03T04:05:06Z")
fs.utimesSync(memMarker, markerDate, markerDate)
const markerMtime = fs.statSync(memMarker).mtimeMs
rMem = sh("./install.sh", ["--memory-only"], envMem)
check("memory-only avec repère : contenu et mtime du repère inchangés",
  rMem.status === 0 && fs.readFileSync(memMarker, "utf8") === "repère existant\n" && fs.statSync(memMarker).mtimeMs === markerMtime,
  `code ${rMem.status} | mtime ${markerMtime} → ${fs.statSync(memMarker).mtimeMs}`)

// ---------- 1e. personnalisation conservée (.new) puis --force-config ----------
const h7 = path.join(tmp, "home7"), cfg7 = path.join(h7, "cfg"), bin7 = path.join(h7, ".local/bin")
const env7 = { HOME: h7, OPENCODE_CONFIG_DIR: cfg7, OBSCURA_BIN_DIR: bin7, XDG_DATA_HOME: path.join(h7, ".local/share"), PATH: noUv }
sh("./install.sh", ["--no-tools"], env7)
const userFile = path.join(cfg7, "opencode.jsonc"), newFile = `${userFile}.new`
const kitJson = fs.readFileSync(userFile, "utf8"), kitHash = sha256(kitJson)
const persoJson = kitJson.replace("{", '{\n  "x_perso_test": true,')
fs.writeFileSync(userFile, persoJson)
const persoHash = sha256(persoJson)
let r7 = sh("./install.sh", ["--no-tools"], env7)
check("personnalisation : fichier utilisateur conservé à l'octet près à la réinstallation",
  r7.status === 0 && sha256(fs.readFileSync(userFile, "utf8")) === persoHash, `code ${r7.status} | ${r7.stdout}${r7.stderr}`)
check("personnalisation : opencode.jsonc.new contient la version du kit (sans la clé utilisateur)",
  fs.existsSync(newFile) && sha256(fs.readFileSync(newFile, "utf8")) === kitHash && !fs.readFileSync(newFile, "utf8").includes("x_perso_test"))
check("personnalisation : avertissement explicite dans la sortie",
  /Fichier modifié conservé, nouvelle version dans opencode\.jsonc\.new/.test(r7.stdout + r7.stderr), r7.stdout + r7.stderr)
check("personnalisation : aucun avertissement « impossible de détecter » avec un manifeste à empreintes",
  !/impossible de détecter/.test(r7.stdout + r7.stderr), r7.stdout + r7.stderr)
r7 = sh("./install.sh", ["--no-tools", "--force-config"], env7)
// Comportement constaté et voulu : --force-config écrase le fichier utilisateur. Le .new de la
// passe précédente n'est pas supprimé par install.sh, mais il est identique au fichier du kit :
// il ne peut donc plus contenir la personnalisation (aucune restauration trompeuse).
check("--force-config : opencode.jsonc écrasé par la version du kit (clé utilisateur perdue)",
  r7.status === 0 && sha256(fs.readFileSync(userFile, "utf8")) === kitHash, `code ${r7.status} | ${r7.stdout}${r7.stderr}`)
check("--force-config : .new obsolète absent ou identique au kit, jamais la version utilisateur",
  !fs.existsSync(newFile) || (sha256(fs.readFileSync(newFile, "utf8")) === kitHash && !fs.readFileSync(newFile, "utf8").includes("x_perso_test")),
  fs.existsSync(newFile) ? "reste en place (identique au kit)" : "absent")

// ---------- 1e-bis. config préexistante sans manifeste / ancien manifeste sans empreintes ----------
// Sans empreintes, une personnalisation ne peut pas être détectée : l'installateur doit le dire
// explicitement avant d'écraser, et la sauvegarde complète doit rester exploitable.
const h9 = path.join(tmp, "home9"), cfg9 = path.join(h9, "cfg"), bin9 = path.join(h9, ".local/bin")
const env9 = { HOME: h9, OPENCODE_CONFIG_DIR: cfg9, OBSCURA_BIN_DIR: bin9, XDG_DATA_HOME: path.join(h9, ".local/share"), PATH: noUv }
const kitJson9 = fs.readFileSync(path.join(ROOT, "config/opencode.jsonc"), "utf8")
const perso9 = kitJson9.replace("{", '{\n  "x_perso_premier_install": true,')
write(path.join(cfg9, "opencode.jsonc"), perso9)
const back9 = () => fs.readdirSync(h9).filter((n) => n.startsWith("cfg.bak-")).map((n) => path.join(h9, n))
const r9 = sh("./install.sh", ["--no-tools"], env9)
const out9 = r9.stdout + r9.stderr, bak9 = back9()
check("sans manifeste : avertissement « impossible de détecter » et sauvegarde annoncée",
  r9.status === 0 && /Configuration OpenCode préexistante sans manifeste : impossible de détecter tes modifications ; sauvegarde complète dans \S+/.test(out9),
  `code ${r9.status} | ${out9}`)
check("sans manifeste : opencode.jsonc personnalisé écrasé par la version du kit",
  !fs.readFileSync(path.join(cfg9, "opencode.jsonc"), "utf8").includes("x_perso_premier_install"))
check("sans manifeste : la sauvegarde contient la personnalisation à l'octet près",
  bak9.length === 1 && fs.readFileSync(path.join(bak9[0], "opencode.jsonc"), "utf8") === perso9,
  bak9.join(", "))

// Ancien manifeste : liste de chemins nus, comme avant l'ajout des empreintes.
const manifest9 = path.join(cfg9, ".opencode-prerequisites.manifest")
fs.writeFileSync(manifest9, fs.readFileSync(manifest9, "utf8").split("\n").filter(Boolean).map((l) => l.slice(l.indexOf("\t") + 1)).join("\n") + "\n")
check("legacy : manifeste réécrit sans aucune empreinte", !/[0-9a-f]{64}\t/.test(fs.readFileSync(manifest9, "utf8")))
const persoLegacy9 = fs.readFileSync(path.join(cfg9, "opencode.jsonc"), "utf8").replace("{", '{\n  "x_perso_legacy": true,')
const agentsPerso9 = "# AGENTS.md personnalisé (legacy)\n"
fs.writeFileSync(path.join(cfg9, "opencode.jsonc"), persoLegacy9)
fs.writeFileSync(path.join(cfg9, "AGENTS.md"), agentsPerso9)
const r9b = sh("./install.sh", ["--no-tools"], env9)
const out9b = r9b.stdout + r9b.stderr
const bak9b = back9().filter((b) => fs.existsSync(path.join(b, "opencode.jsonc")) && fs.readFileSync(path.join(b, "opencode.jsonc"), "utf8") === persoLegacy9)
check("legacy : avertissement explicite « Ancien manifeste sans empreintes »",
  r9b.status === 0 && /Ancien manifeste sans empreintes : impossible de détecter tes modifications/.test(out9b), `code ${r9b.status} | ${out9b}`)
check("legacy : sauvegarde complète avec opencode.jsonc ET AGENTS.md personnalisés",
  bak9b.length === 1 && fs.readFileSync(path.join(bak9b[0], "AGENTS.md"), "utf8") === agentsPerso9, bak9b.join(", "))
check("legacy : fichiers du kit appliqués (personnalisations écrasées)",
  !fs.readFileSync(path.join(cfg9, "opencode.jsonc"), "utf8").includes("x_perso_legacy")
  && fs.readFileSync(path.join(cfg9, "AGENTS.md"), "utf8") === fs.readFileSync(path.join(ROOT, "config/AGENTS.md"), "utf8"))
check("legacy : la nouvelle installation rétablit les empreintes",
  /^[0-9a-f]{64}\t/m.test(fs.readFileSync(manifest9, "utf8")))

// ---------- 1f. permissions : umask 077 et durcissement de l'arborescence ----------
const h8 = path.join(tmp, "home8"), cfg8 = path.join(h8, "cfg"), bin8 = path.join(h8, ".local/bin")
write(path.join(cfg8, "mon-fichier.txt"), "contenu utilisateur\n", 0o644)
const env8 = { HOME: h8, OPENCODE_CONFIG_DIR: cfg8, OBSCURA_BIN_DIR: bin8, XDG_DATA_HOME: path.join(h8, ".local/share"), PATH: noUv }
const r8 = sh("./install.sh", ["--no-tools"], env8)
const bak8 = fs.readdirSync(h8).filter((n) => n.startsWith("cfg.bak-")).map((n) => path.join(h8, n))
const perso8 = path.join(cfg8, "mon-fichier.txt")
check("permissions : $DEST en 700 et sauvegarde $DEST.bak-* en 700",
  r8.status === 0 && mode(cfg8) === 0o700 && bak8.length === 1 && mode(bak8[0]) === 0o700,
  `DEST ${mode(cfg8).toString(8)} | bak ${bak8.map((b) => mode(b).toString(8)).join(",")}`)
check("permissions : opencode.jsonc en 600, repère .installed en 600",
  mode(path.join(cfg8, "opencode.jsonc")) === 0o600 && mode(path.join(cfg8, ".opencode-prerequisites.installed")) === 0o600,
  `${mode(path.join(cfg8, "opencode.jsonc")).toString(8)} / ${mode(path.join(cfg8, ".opencode-prerequisites.installed")).toString(8)}`)
check("permissions : lanceur $BIN/oc-models en 755",
  mode(path.join(bin8, "oc-models")) === 0o755, mode(path.join(bin8, "oc-models")).toString(8))
check("permissions : fichier personnel préservé, lisible par son propriétaire, fermé aux autres",
  fs.readFileSync(perso8, "utf8") === "contenu utilisateur\n" && (mode(perso8) & 0o400) !== 0 && (mode(perso8) & 0o077) === 0,
  `mode ${mode(perso8).toString(8)}`)

// ---------- 2. MemPalace : plus de « init », fichier orphelin retiré, lien « mempalace » ----------
const h2 = path.join(tmp, "home2"), venv = path.join(h2, ".mempalace/venv/bin"), fake = path.join(tmp, "fake"), calls = path.join(tmp, "calls.log")
write(path.join(venv, "python"), `#!/bin/sh\necho "python $*" >> "${calls}"\nexit 0\n`, 0o755)
write(path.join(venv, "mempalace"), `#!/bin/sh\necho "mempalace $*" >> "${calls}"\nexit 0\n`, 0o755)
write(path.join(h2, ".mempalace/palace/mempalace.yaml"), "wing: x\n")                 // l'orphelin laissé par l'ancienne version
write(path.join(fake, "npm"), `#!/bin/sh\nmkdir -p node_modules/@rvboris/opencode-mempalace/dist/plugin && echo "export default {}" > node_modules/@rvboris/opencode-mempalace/dist/plugin/index.js\n`, 0o755)
const env2 = { HOME: h2, OPENCODE_CONFIG_DIR: path.join(h2, "cfg"), OBSCURA_BIN_DIR: path.join(h2, ".local/bin"), PATH: `${fake}:${process.env.PATH}` }
let r = sh("./install.sh", ["--memory-only"], env2)
check("memory-only : s'exécute avec un venv existant", r.status === 0, r.stderr + r.stdout)
const log = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : ""
check("MemPalace : plus aucun « mempalace init » (le palais se crée à la première sauvegarde)", !/mempalace init/.test(log) && /pip install/.test(log))
check("MemPalace : fichier orphelin ~/.mempalace/palace retiré", !fs.existsSync(path.join(h2, ".mempalace/palace")))
check("MemPalace : lien ~/.local/bin/mempalace → commande du venv (repli du plugin)", fs.lstatSync(path.join(h2, ".local/bin/mempalace")).isSymbolicLink() && fs.realpathSync(path.join(h2, ".local/bin/mempalace")) === fs.realpathSync(path.join(venv, "mempalace")))
check("MemPalace : plugin local qui fixe lui-même le Python", /MEMPALACE_ADAPTER_PYTHON \|\|= /.test(fs.readFileSync(path.join(h2, "cfg/plugins/mempalace/index.ts"), "utf8")))
write(path.join(h2, ".mempalace/palace/chroma.sqlite3"), "x"); write(path.join(h2, ".mempalace/palace/mempalace.yaml"), "wing: x\n")
sh("./install.sh", ["--memory-only"], env2)
check("MemPalace : un palais qui contient une vraie base n'est JAMAIS supprimé", fs.existsSync(path.join(h2, ".mempalace/palace/chroma.sqlite3")))

// ---------- 3. diagnostic : OpenCode lancé avant l'installation ----------
const h3 = path.join(tmp, "home3"), cfg3 = path.join(h3, "cfg"), fbin = path.join(tmp, "fbin")
fs.mkdirSync(path.join(cfg3, "agents"), { recursive: true })
write(path.join(cfg3, "opencode.jsonc"), '{ "default_agent": "ceo", "mcp": { "servers": {} } }\n')
write(path.join(cfg3, "agents/ceo.md"), "---\ndescription: x\nmode: primary\n---\nx\n")
write(path.join(cfg3, ".opencode-prerequisites.installed"), "")
write(path.join(fbin, "opencode"), '#!/bin/sh\ncase "$*" in "--version") echo 2.2.5;; "debug config") echo \'{"default_agent":"ceo"}\';; "mcp list") echo "  ✓ x  connected";; "debug agents") echo ceo;; esac\n', 0o755)
write(path.join(fbin, "ps"), "#!/bin/sh\nprintf '  4242 Sun Nov  1 15:36:12 2020 /home/u/.local/share/mise/installs/opencode/latest/node_modules/.bin/opencode serve\\n  5151 Mon Nov  2 23:59:59 2099 opencode\\n   777 Sun Nov  1 15:00:00 2020 /usr/bin/vim notes-opencode.txt\\n'\n", 0o755)
// PATH SANS la commande « which » : les images minimales Arch, Fedora et Rocky n'en ont pas, et le diagnostic ne doit pas en dépendre
const noWhich = path.join(tmp, "nowhich"); fs.mkdirSync(noWhich)
for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
  let names = []; try { names = fs.readdirSync(dir) } catch { continue }
  for (const n of names) if (n !== "which" && !fs.existsSync(path.join(noWhich, n))) { try { fs.symlinkSync(path.join(dir, n), path.join(noWhich, n)) } catch { /* ignoré */ } }
}
r = sh(process.execPath, [path.join(ROOT, "scripts/doctor.mjs")], { HOME: h3, OPENCODE_CONFIG_DIR: cfg3, PATH: `${fbin}:${noWhich}` })
const out = r.stdout
check("doctor : signale l'OpenCode lancé avant l'installation", /PID 4242/.test(out) && /service restart/.test(out), out.split("\n").filter((l) => /PID|tourne/.test(l)).join(" | "))
check("doctor : ignore un OpenCode plus récent que l'installation et les autres processus", !/PID 5151/.test(out) && !/PID 777/.test(out))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n❌ ${failed} test(s) en échec` : "\n✅ Installateur côté machine OK (environnement, gabarit, sauvegardes, état MCP, désinstallation, MemPalace, diagnostic)")
process.exit(failed ? 1 : 0)
