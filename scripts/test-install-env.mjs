#!/usr/bin/env node
// Tests de l'installateur côté machine : bloc d'environnement (bash/zsh, shells non interactifs), désinstallation sans trace,
// MemPalace (fichier orphelin, lien « mempalace », plus de « init »), détection d'un OpenCode lancé avant l'installation,
// et MCP semgrep (--check réel vs --check-quick sans processus ni téléchargement).
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
