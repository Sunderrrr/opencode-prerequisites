#!/usr/bin/env node
// Tests de l'installateur côté machine : bloc d'environnement (bash/zsh, shells non interactifs), désinstallation sans trace,
// MemPalace (fichier orphelin, lien « mempalace », plus de « init »), et détection d'un OpenCode lancé avant l'installation.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-envtest-"))
let failed = 0
const check = (name, cond, detail = "") => { if (!cond) failed++; console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`) }
const sh = (cmd, args, env, cwd = ROOT) => spawnSync(cmd, args, { encoding: "utf8", cwd, env: { ...process.env, ...env } })
const write = (f, t, mode) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t, mode ? { mode } : undefined) }

// ---------- 1. bloc d'environnement ----------
const home = path.join(tmp, "home"), bin = path.join(home, ".local", "bin"), cfg = path.join(home, "cfg")
write(path.join(home, ".mempalace/venv/bin/python"), "#!/bin/sh\n", 0o755)
const bashrc0 = "# ~/.bashrc\n[[ $- != *i* ]] && return\nalias ll='ls -l'\n"
write(path.join(home, ".bashrc"), bashrc0)
write(path.join(home, ".zshrc"), '# zshrc\n[[ -o interactive ]] || return\nexport EDITOR=nvim\n\n# opencode-prerequisites\nexport PATH="/vieux:$PATH"\nexport MEMPALACE_ADAPTER_PYTHON="/vieux/python"\n')
const env = { HOME: home, OPENCODE_CONFIG_DIR: cfg, OBSCURA_BIN_DIR: bin, XDG_DATA_HOME: path.join(home, ".local/share") }
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
r = sh(process.execPath, [path.join(ROOT, "scripts/doctor.mjs")], { HOME: h3, OPENCODE_CONFIG_DIR: cfg3, PATH: `${fbin}:${process.env.PATH}` })
const out = r.stdout
check("doctor : signale l'OpenCode lancé avant l'installation", /PID 4242/.test(out) && /service restart/.test(out), out.split("\n").filter((l) => /PID|tourne/.test(l)).join(" | "))
check("doctor : ignore un OpenCode plus récent que l'installation et les autres processus", !/PID 5151/.test(out) && !/PID 777/.test(out))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n❌ ${failed} test(s) en échec` : "\n✅ Installateur côté machine OK (environnement, désinstallation, MemPalace, diagnostic)")
process.exit(failed ? 1 : 0)
