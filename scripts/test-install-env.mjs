#!/usr/bin/env node
// Machine-side installer tests: environment block (bash/zsh, non-interactive shells), trace-free uninstall,
// transactional install (make-lite failure → exact rollback, .installed marker), --memory-only, preserved
// customizations (.new, --force-config), permissions (umask 077), MemPalace (orphan file, "mempalace" symlink,
// no more "init"), detection of an OpenCode started before the installation, and semgrep MCP (real --check vs
// --check-quick).
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { parseJsonc, frontmatter } from "./lib/jsonc.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-envtest-"))
let failed = 0
const check = (name, cond, detail = "") => { if (!cond) failed++; console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`) }
const sh = (cmd, args, env, cwd = ROOT) => spawnSync(cmd, args, { encoding: "utf8", cwd, env: { ...process.env, ...env } })
const write = (f, t, mode) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t, mode ? { mode } : undefined) }
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex")
// Recursive fingerprint of the CONTENT (names, types, links and bytes), not of the permissions:
// used to prove that a rollback restores exactly the previous tree (permission hardening
// is verified separately).
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
// Every launcher the kit can install: config/bin/* plus oc-new-rust and the Android addon.
const kitLaunchers = [
  ...fs.readdirSync(path.join(ROOT, "config", "bin")),
  "oc-new-rust",
  ...fs.readdirSync(path.join(ROOT, "addons", "android", "bin")),
]

// Shared hermetic PATH: every real binary except uv/uvx/pipx. No test may trigger a
// download or a compilation; Node is a launcher to the real binary.
const noUv = path.join(tmp, "noub")
fs.mkdirSync(noUv)
for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
  let names = []; try { names = fs.readdirSync(dir) } catch { continue }
  for (const n of names) if (!["node", "uv", "uvx", "pipx"].includes(n) && !fs.existsSync(path.join(noUv, n))) { try { fs.symlinkSync(path.join(dir, n), path.join(noUv, n)) } catch { /* ignored */ } }
}
write(path.join(noUv, "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, 0o755)

// ---------- 1. shell environment block ----------
const home = path.join(tmp, "home"), bin = path.join(home, ".local", "bin"), cfg = path.join(home, "cfg")
write(path.join(home, ".mempalace/venv/bin/python"), "#!/bin/sh\n", 0o755)
const bashrc0 = "# ~/.bashrc\n[[ $- != *i* ]] && return\nalias ll='ls -l'\n"
write(path.join(home, ".bashrc"), bashrc0)
write(path.join(home, ".zshrc"), '# zshrc\n[[ -o interactive ]] || return\nexport EDITOR=nvim\n\n# opencode-prerequisites\nexport PATH="/old:$PATH"\nexport MEMPALACE_ADAPTER_PYTHON="/old/python"\n')
const env = { HOME: home, OPENCODE_CONFIG_DIR: cfg, OBSCURA_BIN_DIR: bin, XDG_DATA_HOME: path.join(home, ".local/share"), PATH: noUv }
sh("./install.sh", ["--no-tools", "--shell-env"], env)
const afterOne = fs.readFileSync(path.join(home, ".bashrc"), "utf8")
for (let i = 0; i < 2; i++) sh("./install.sh", ["--no-tools", "--shell-env"], env)
const bashrc = fs.readFileSync(path.join(home, ".bashrc"), "utf8")
check("bash: a single block, written BEFORE the non-interactive shells' \"return\"", (bashrc.match(/>>> opencode-prerequisites/g) ?? []).length === 1 && bashrc.indexOf(">>> opencode-prerequisites") < bashrc.indexOf("return"))
const viaBashEnv = sh("bash", ["-c", 'echo "PY=$MEMPALACE_ADAPTER_PYTHON"; echo "FIN=${PATH##*:}"'], { env: undefined, HOME: home, PATH: "/usr/bin:/bin", BASH_ENV: path.join(home, ".bashrc") })
check("NON-interactive bash (service case): the variable is visible", viaBashEnv.stdout.includes(`PY=${home}/.mempalace/venv/bin/python`), viaBashEnv.stdout + viaBashEnv.stderr)
check("PATH: ~/.local/bin appended AT THE END, never first", viaBashEnv.stdout.includes(`FIN=${bin}`) && !new RegExp(`^PATH=${bin}`).test(bashrc))
const zshenv = fs.readFileSync(path.join(home, ".zshenv"), "utf8"), zshrc = fs.readFileSync(path.join(home, ".zshrc"), "utf8")
check("zsh: block in ~/.zshenv (read outside an interactive terminal)", zshenv.includes(">>> opencode-prerequisites") && zshenv.includes("MEMPALACE_ADAPTER_PYTHON"))
check("zsh: old block removed from ~/.zshrc, rest of the file intact", !zshrc.includes("opencode-prerequisites") && !zshrc.includes("/old") && zshrc.includes("export EDITOR=nvim"))
check("idempotent: 3 runs produce exactly the same file as a single one", bashrc === afterOne, `lines ${afterOne.split("\n").length} → ${bashrc.split("\n").length}`)
const newLaunchers = ["oc-backup", "oc-restore", "oc-usage", "oc-new-web"]
check("install: the new launchers oc-backup/oc-restore/oc-usage/oc-new-web are installed",
  newLaunchers.every((n) => fs.existsSync(path.join(bin, n))), newLaunchers.filter((n) => !fs.existsSync(path.join(bin, n))).join(", "))
sh("./uninstall.sh", [], env)
check("uninstall: ~/.bashrc strictly identical to the original", fs.readFileSync(path.join(home, ".bashrc"), "utf8") === bashrc0)
check("uninstall: no trace left in .zshenv or .zshrc", !/opencode-prerequisites/.test(fs.readFileSync(path.join(home, ".zshenv"), "utf8") + fs.readFileSync(path.join(home, ".zshrc"), "utf8")))
const leftLaunchers = fs.existsSync(bin) ? fs.readdirSync(bin).filter((n) => kitLaunchers.includes(n)) : []
check("uninstall: no kit launcher left in $BIN", leftLaunchers.length === 0, leftLaunchers.join(", "))

// ---------- 1b. template, backups, personal files, MCP state ----------
const h4 = path.join(tmp, "home4"), cfg4 = path.join(h4, "cfg"), bin4 = path.join(h4, ".local/bin")
const fakeDateDir = path.join(tmp, "fakedate")
fs.mkdirSync(fakeDateDir, { recursive: true })
write(path.join(fakeDateDir, "date"), "#!/bin/sh\necho 20260101-120000\n", 0o755) // two installs "within the same second"
write(path.join(h4, ".mempalace/venv/bin/python"), "#!/bin/sh\nexit 0\n", 0o755)
write(path.join(cfg4, "plugins/guard.js"), "// my personal plugin\n")
write(path.join(cfg4, ".opencode-prerequisites.pentest"), "") // remembered choice: must NOT be replayed by --no-tools
// Fake uvx: only for the semgrep scenarios. Answers the launcher's MCP initialize
// (which requires "serverInfo" on stdout); any other call exits 0 silently.
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
check("install --no-tools: template copied flat (templates/rust-project, not templates/templates)",
  fs.existsSync(path.join(cfg4, "templates/rust-project/Cargo.toml")) && !fs.existsSync(path.join(cfg4, "templates/templates")), r4.stdout + r4.stderr)
check("install --no-tools: personal file plugins/guard.js kept on the first install", fs.existsSync(path.join(cfg4, "plugins/guard.js")))
check("install --no-tools: no tool downloaded (pentest/obscura/trivy/semgrep)",
  !["nuclei", "gitleaks", "semgrep", "obscura", "trivy", "mempalace"].some((n) => fs.existsSync(path.join(bin4, n))))
check("install --no-tools: remembered pentest choice not replayed, but kept",
  !fs.existsSync(path.join(bin4, "nuclei")) && fs.existsSync(path.join(cfg4, ".opencode-prerequisites.pentest")))
check("install --no-tools: MemPalace plugin not installed even with a venv present", !fs.existsSync(path.join(cfg4, "plugins/mempalace")))
check("install: single backup, no nested copy", backups4().length === 1 && !fs.existsSync(path.join(backups4()[0], "cfg")), backups4().join(", "))

fs.writeFileSync(path.join(cfg4, "templates/rust-project/Cargo.toml"), "# outdated\n")
// "Kit" file that disappeared: it is recorded in the manifest (as an older version would have done); it must be removed.
write(path.join(cfg4, "plugins/obsolete-kit.js"), "// old kit file\n")
fs.appendFileSync(path.join(cfg4, ".opencode-prerequisites.manifest"), "plugins/obsolete-kit.js\n")
r4 = run4()
check("install: 2 installs in the same second → 2 distinct backups, none nested",
  backups4().length === 2 && backups4().every((b) => !fs.existsSync(path.join(b, "cfg"))), backups4().join(", "))
check("install: a kit file that disappeared (manifest) is removed on the 2nd install",
  !fs.existsSync(path.join(cfg4, "plugins/obsolete-kit.js")))
check("install: the rust-project template is updated on the 2nd install",
  fs.readFileSync(path.join(cfg4, "templates/rust-project/Cargo.toml"), "utf8") === fs.readFileSync(path.join(ROOT, "templates/rust-project/Cargo.toml"), "utf8"))
check("install: no templates/templates after 2 installs", !fs.existsSync(path.join(cfg4, "templates/templates")))
check("install: opencode.jsonc remains valid JSONC", parses(cfg4text()))
check("install: kubernetes disabled only once, without duplicates",
  mcp4("kubernetes").disabled === true && disabledCount("kubernetes") === 1, `count=${disabledCount("kubernetes")}`)

// Re-enabling: a kubectl context appears
write(path.join(h4, ".kube/config"), "apiVersion: v1\ncurrent-context: kind-test\n")
r4 = run4()
check("install: kubernetes re-enabled when a current-context exists",
  mcp4("kubernetes").disabled === undefined && disabledCount("kubernetes") === 0, r4.stdout + r4.stderr)

// REA: the --check launcher depends on the Node version; simulate it with the dedicated variable.
r4 = run4(["--no-tools"], { OC_REA_NODE_VERSION: "26.12.1" })
check("install: rea re-enabled when the --check server succeeds", mcp4("rea").disabled === undefined && disabledCount("rea") === 0, r4.stdout + r4.stderr)
r4 = run4(["--no-tools"], { OC_REA_NODE_VERSION: "22.0.0" })
check("install: rea disabled only once when Node is too old", mcp4("rea").disabled === true && disabledCount("rea") === 1)

// Semgrep: PATH without uv/uvx/pipx → disabled, then re-enabled with the fake uvx (hermetic).
const noUvPath = `${fakeDateDir}:${noUv}`
r4 = run4(["--no-tools"], { PATH: noUvPath })
check("install: semgrep disabled only once without uvx/pipx", mcp4("semgrep").disabled === true && disabledCount("semgrep") === 1, r4.stdout + r4.stderr)
r4 = run4(["--no-tools"], { PATH: noUvPath })
check("install: semgrep stays disabled, without duplicates, after a 2nd install without uvx/pipx",
  mcp4("semgrep").disabled === true && disabledCount("semgrep") === 1)
const fakeUvxPath = `${fakeDateDir}:${fakeUvxDir}:${noUv}`
const uvxResolved = sh("sh", ["-c", "command -v uvx"], { PATH: fakeUvxPath }).stdout.trim()
check("semgrep test: the fake uvx is the one resolved (never the real one)", uvxResolved === path.join(fakeUvxDir, "uvx"), uvxResolved)
const uvMasked = sh("sh", ["-c", 'for c in uv uvx pipx; do command -v "$c" && exit 1; done; exit 0'], { PATH: noUvPath })
check("semgrep test: uv/uvx/pipx masked when the fake uvx is absent", uvMasked.status === 0, uvMasked.stdout + uvMasked.stderr)
r4 = run4(["--no-tools"], { PATH: fakeUvxPath })
check("install: semgrep re-enabled when uvx comes back", mcp4("semgrep").disabled === undefined && disabledCount("semgrep") === 0, r4.stdout + r4.stderr)
r4 = run4(["--no-tools"], { PATH: fakeUvxPath })
check("install: 2 installs with uvx do not recreate a \"disabled\" for semgrep",
  mcp4("semgrep").disabled === undefined && disabledCount("semgrep") === 0)

// oc-semgrep-mcp launcher: --check performs the real handshake; --check-quick starts NO process.
// Logging fake uvx: it records its arguments, then answers the MCP initialize like the real server.
const launcher = path.join(ROOT, "config/bin/oc-semgrep-mcp")
const fakeUvxLogDir = path.join(tmp, "fakeuvx-log"), uvxArgsLog = path.join(tmp, "uvx-args.log")
write(path.join(fakeUvxLogDir, "uvx"), `#!/bin/sh
printf '%s\\n' "$*" >> "${uvxArgsLog}"
cat >/dev/null 2>&1 || true
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"semgrep-mcp","version":"fake"}}}'
exit 0
`, 0o755)
const fakePipxDir = path.join(tmp, "fakepipx")
write(path.join(fakePipxDir, "pipx"), "#!/bin/sh\nexit 99\n", 0o755) // present, but --check-quick must not run it
const readLog = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : "")

const quickUvx = sh("bash", [launcher, "--check-quick"], { PATH: `${fakeUvxLogDir}:${noUv}` })
check("--check-quick: code 0 with uvx present, without running uvx",
  quickUvx.status === 0 && /uvx detected/.test(quickUvx.stdout) && readLog(uvxArgsLog) === "",
  `code ${quickUvx.status} | ${quickUvx.stdout}${quickUvx.stderr} | log "${readLog(uvxArgsLog)}"`)
const quickPipx = sh("bash", [launcher, "--check-quick"], { PATH: `${fakePipxDir}:${noUv}` })
check("--check-quick: code 0 with pipx alone (no uvx), without running pipx",
  quickPipx.status === 0 && /pipx detected/.test(quickPipx.stdout), `code ${quickPipx.status} | ${quickPipx.stdout}${quickPipx.stderr}`)
const quickNone = sh("bash", [launcher, "--check-quick"], { PATH: noUv })
check("--check-quick: code 1 without uvx or pipx, clear message",
  quickNone.status === 1 && /neither uvx nor pipx/.test(quickNone.stderr), `code ${quickNone.status} | ${quickNone.stderr}`)

const realCheck = sh("bash", [launcher, "--check"], { PATH: `${fakeUvxLogDir}:${noUv}` })
const uvxArgs = readLog(uvxArgsLog)
check("--check: real MCP handshake through uvx (code 0, serverInfo)",
  realCheck.status === 0 && /MCP initialize handshake OK/.test(realCheck.stdout) && /serverInfo semgrep-mcp fake/.test(realCheck.stdout),
  `code ${realCheck.status} | ${realCheck.stdout}${realCheck.stderr}`)
check("--check: uvx receives --python '>=3.10,<3.14' and the pinned version (Python/pydantic lock)",
  /--python\s+>=3\.10,<3\.14(\s|$)/.test(uvxArgs) && /--from semgrep-mcp==0\.9\.0/.test(uvxArgs) && /--with pydantic==2\.11\.10/.test(uvxArgs), uvxArgs)

// --no-tools: the launcher must stay on --check-quick; this trap fake uvx (log + failure) must
// never run, otherwise semgrep would be disabled and the log would contain a call.
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
try { semTrap = parseJsonc(fs.readFileSync(path.join(cfgTrap, "opencode.jsonc"), "utf8")).mcp?.servers?.semgrep ?? {} } catch { /* reported by the next test */ }
check("install --no-tools: NEVER runs uvx (trap: empty log + code 0)",
  rTrap.status === 0 && readLog(trapLog) === "", `code ${rTrap.status} | uvx calls: "${readLog(trapLog)}" | ${rTrap.stderr}`)
check("install --no-tools: semgrep enabled on uvx presence alone, without handshake",
  semTrap.disabled === undefined && Object.keys(semTrap).length > 0, JSON.stringify(semTrap))
check("install --no-tools: semgrep message announces the deferred check",
  /startup verified on the next full install/.test(rTrap.stdout), rTrap.stdout)

// CI scenario: --no-tools --android copies the module (files), without downloading anything.
const cfgAndroid = path.join(tmp, "cfg-android"), binAndroid = path.join(tmp, "bin-android")
r4 = sh("./install.sh", ["--no-tools", "--android"], { ...env4, OPENCODE_CONFIG_DIR: cfgAndroid, OBSCURA_BIN_DIR: binAndroid })
check("install --no-tools --android: Android module installed (agents, oc-android loop)",
  r4.status === 0 && fs.existsSync(path.join(cfgAndroid, "agents/android.md")) && fs.existsSync(path.join(cfgAndroid, ".opencode-prerequisites.android")) && fs.existsSync(path.join(binAndroid, "oc-android")), r4.stdout + r4.stderr)
check("install --no-tools --android: no binary downloaded",
  !["nuclei", "gitleaks", "semgrep", "obscura", "trivy"].some((n) => fs.existsSync(path.join(binAndroid, n))))

// Backup then restore: the 2nd backup from the same second must be chosen.
const h5 = path.join(tmp, "home5"), cfg5 = path.join(h5, "cfg"), bin5 = path.join(h5, ".local/bin")
write(path.join(cfg5, "personal.txt"), "personal\n")
const env5 = { ...env4, HOME: h5, OPENCODE_CONFIG_DIR: cfg5, OBSCURA_BIN_DIR: bin5 }
sh("./install.sh", ["--no-tools"], env5)
write(path.join(cfg5, "after-first-install.txt"), "x\n")
sh("./install.sh", ["--no-tools"], env5)
r4 = sh("./uninstall.sh", [], env5)
const removed5 = fs.readdirSync(h5).filter((n) => n.startsWith("cfg.removed-"))
check("uninstall: restores the most recent backup (same-second suffix)",
  fs.existsSync(path.join(cfg5, "after-first-install.txt")) && fs.existsSync(path.join(cfg5, "personal.txt")), r4.stdout + r4.stderr)
check("uninstall: current config moved without nesting",
  removed5.length === 1 && !fs.existsSync(path.join(h5, removed5[0], "cfg")), removed5.join(", "))

// The restored backup may itself contain markers left by an older install: uninstall must
// forget the remembered choices (.android/.pentest/.profile) so a later install cannot replay them.
const hMark = path.join(tmp, "home-mark"), cfgMark = path.join(hMark, "cfg"), binMark = path.join(hMark, ".local/bin")
write(path.join(cfgMark, "personal.txt"), "keep me\n")
for (const m of [".opencode-prerequisites.android", ".opencode-prerequisites.pentest", ".opencode-prerequisites.profile"]) write(path.join(cfgMark, m), "stale\n")
const envMark = { HOME: hMark, OPENCODE_CONFIG_DIR: cfgMark, OBSCURA_BIN_DIR: binMark, XDG_DATA_HOME: path.join(hMark, ".local/share"), PATH: noUv }
const rMark = sh("./install.sh", ["--no-tools", "--no-android"], envMark)
const rMarkUn = sh("./uninstall.sh", [], envMark)
const markersLeft = fs.readdirSync(cfgMark).filter((n) => n.startsWith(".opencode-prerequisites."))
check("uninstall: restored config keeps personal files but no remembered marker (.android/.pentest/.profile)",
  rMark.status === 0 && rMarkUn.status === 0 && fs.existsSync(path.join(cfgMark, "personal.txt")) && markersLeft.length === 0,
  `install ${rMark.status} | uninstall ${rMarkUn.status} | markers: ${markersLeft.join(", ")}`)

// ---------- 1c. make-lite failure: the config phase is cancelled and EVERYTHING is restored identically ----------
const h6 = path.join(tmp, "home6"), cfg6 = path.join(h6, "cfg"), bin6 = path.join(h6, ".local/bin")
write(path.join(cfg6, "witness.txt"), "witness from before installation\n")
const fakeLiteDir = path.join(tmp, "fakenode-lite")
write(path.join(fakeLiteDir, "node"), `#!/bin/sh
case "$*" in
  *make-lite.mjs*) printf 'make-lite: simulated failure\\n' >&2; exit 42 ;;
esac
exec "${process.execPath}" "$@"
`, 0o755)
const digest6 = treeDigest(cfg6)
const r6 = sh("./install.sh", ["--lite"], {
  HOME: h6, OPENCODE_CONFIG_DIR: cfg6, OBSCURA_BIN_DIR: bin6,
  XDG_DATA_HOME: path.join(h6, ".local/share"), PATH: `${fakeLiteDir}:${noUv}`,
})
check("make-lite failure: non-zero code and installation announced as cancelled",
  r6.status !== 0 && /Installation cancelled/.test(r6.stdout + r6.stderr), `code ${r6.status} | ${r6.stdout}${r6.stderr}`)
check("make-lite failure: $DEST strictly identical (recursive hash before/after)",
  treeDigest(cfg6) === digest6, `before ${digest6.slice(0, 12)} after ${treeDigest(cfg6).slice(0, 12)}`)
check("make-lite failure: .opencode-prerequisites.installed marker absent",
  !fs.existsSync(path.join(cfg6, ".opencode-prerequisites.installed")))
check("make-lite failure: no leftover launcher in $BIN",
  !fs.existsSync(bin6) || fs.readdirSync(bin6).length === 0, fs.existsSync(bin6) ? fs.readdirSync(bin6).join(", ") : "BIN absent")

// ---------- 1d. --memory-only: never touches the .installed marker ----------
const hMem = path.join(tmp, "home-mem"), memCfg = path.join(hMem, "cfg"), memBin = path.join(hMem, ".local/bin")
const memVenv = path.join(hMem, ".mempalace/venv/bin"), memFake = path.join(tmp, "fake-npm-mem")
write(path.join(memVenv, "python"), "#!/bin/sh\nexit 0\n", 0o755)
write(path.join(memVenv, "mempalace"), "#!/bin/sh\nexit 0\n", 0o755)
write(path.join(memFake, "npm"), `#!/bin/sh
mkdir -p node_modules/@rvboris/opencode-mempalace/dist/plugin
printf 'export default {}\\n' > node_modules/@rvboris/opencode-mempalace/dist/plugin/index.js
`, 0o755)
const envMem = { HOME: hMem, OPENCODE_CONFIG_DIR: memCfg, OBSCURA_BIN_DIR: memBin, XDG_DATA_HOME: path.join(hMem, ".local/share"), PATH: `${memFake}:${noUv}` }
write(path.join(memCfg, "personal-config.txt"), "keep\n")
const memMarker = path.join(memCfg, ".opencode-prerequisites.installed")
let rMem = sh("./install.sh", ["--memory-only"], envMem)
check("memory-only without marker: run OK, marker still absent, personal config intact",
  rMem.status === 0 && !fs.existsSync(memMarker) && fs.readFileSync(path.join(memCfg, "personal-config.txt"), "utf8") === "keep\n"
  && fs.existsSync(path.join(memCfg, "plugins/mempalace/index.ts")), `code ${rMem.status} | ${rMem.stdout}${rMem.stderr}`)
fs.writeFileSync(memMarker, "existing marker\n")
const markerDate = new Date("2021-02-03T04:05:06Z")
fs.utimesSync(memMarker, markerDate, markerDate)
const markerMtime = fs.statSync(memMarker).mtimeMs
rMem = sh("./install.sh", ["--memory-only"], envMem)
check("memory-only with marker: content and mtime of the marker unchanged",
  rMem.status === 0 && fs.readFileSync(memMarker, "utf8") === "existing marker\n" && fs.statSync(memMarker).mtimeMs === markerMtime,
  `code ${rMem.status} | mtime ${markerMtime} → ${fs.statSync(memMarker).mtimeMs}`)

// ---------- 1e. customization preserved (.new) then --force-config ----------
const h7 = path.join(tmp, "home7"), cfg7 = path.join(h7, "cfg"), bin7 = path.join(h7, ".local/bin")
const env7 = { HOME: h7, OPENCODE_CONFIG_DIR: cfg7, OBSCURA_BIN_DIR: bin7, XDG_DATA_HOME: path.join(h7, ".local/share"), PATH: noUv }
sh("./install.sh", ["--no-tools"], env7)
const userFile = path.join(cfg7, "opencode.jsonc"), newFile = `${userFile}.new`
const kitJson = fs.readFileSync(userFile, "utf8"), kitHash = sha256(kitJson)
const persoJson = kitJson.replace("{", '{\n  "x_perso_test": true,')
fs.writeFileSync(userFile, persoJson)
const persoHash = sha256(persoJson)
let r7 = sh("./install.sh", ["--no-tools"], env7)
check("customization: user file kept byte-for-byte on reinstall",
  r7.status === 0 && sha256(fs.readFileSync(userFile, "utf8")) === persoHash, `code ${r7.status} | ${r7.stdout}${r7.stderr}`)
check("customization: opencode.jsonc.new contains the kit version (without the user key)",
  fs.existsSync(newFile) && sha256(fs.readFileSync(newFile, "utf8")) === kitHash && !fs.readFileSync(newFile, "utf8").includes("x_perso_test"))
check("customization: explicit warning in the output",
  /Modified file preserved, new version in opencode\.jsonc\.new/.test(r7.stdout + r7.stderr), r7.stdout + r7.stderr)
check("customization: no \"cannot detect\" warning with a manifest that has fingerprints",
  !/cannot detect/.test(r7.stdout + r7.stderr), r7.stdout + r7.stderr)
r7 = sh("./install.sh", ["--no-tools", "--force-config"], env7)
// Observed and intended behavior: --force-config overwrites the user file. The .new from the
// previous pass is not removed by install.sh, but it is identical to the kit file:
// it can therefore no longer contain the customization (no misleading restore).
check("--force-config: opencode.jsonc overwritten by the kit version (user key lost)",
  r7.status === 0 && sha256(fs.readFileSync(userFile, "utf8")) === kitHash, `code ${r7.status} | ${r7.stdout}${r7.stderr}`)
check("--force-config: obsolete .new absent or identical to the kit, never the user version",
  !fs.existsSync(newFile) || (sha256(fs.readFileSync(newFile, "utf8")) === kitHash && !fs.readFileSync(newFile, "utf8").includes("x_perso_test")),
  fs.existsSync(newFile) ? "still in place (identical to the kit)" : "absent")

// ---------- 1e-bis. pre-existing config without a manifest / old manifest without fingerprints ----------
// Without fingerprints, a customization cannot be detected: the installer must say so
// explicitly before overwriting, and the full backup must remain usable.
const h9 = path.join(tmp, "home9"), cfg9 = path.join(h9, "cfg"), bin9 = path.join(h9, ".local/bin")
const env9 = { HOME: h9, OPENCODE_CONFIG_DIR: cfg9, OBSCURA_BIN_DIR: bin9, XDG_DATA_HOME: path.join(h9, ".local/share"), PATH: noUv }
const kitJson9 = fs.readFileSync(path.join(ROOT, "config/opencode.jsonc"), "utf8")
const perso9 = kitJson9.replace("{", '{\n  "x_perso_premier_install": true,')
write(path.join(cfg9, "opencode.jsonc"), perso9)
const back9 = () => fs.readdirSync(h9).filter((n) => n.startsWith("cfg.bak-")).map((n) => path.join(h9, n))
const r9 = sh("./install.sh", ["--no-tools"], env9)
const out9 = r9.stdout + r9.stderr, bak9 = back9()
check("without manifest: \"cannot detect\" warning and backup announced",
  r9.status === 0 && /Existing OpenCode configuration without a manifest: cannot detect your modifications; full backup in \S+/.test(out9),
  `code ${r9.status} | ${out9}`)
check("without manifest: customized opencode.jsonc overwritten by the kit version",
  !fs.readFileSync(path.join(cfg9, "opencode.jsonc"), "utf8").includes("x_perso_premier_install"))
check("without manifest: the backup contains the customization byte-for-byte",
  bak9.length === 1 && fs.readFileSync(path.join(bak9[0], "opencode.jsonc"), "utf8") === perso9,
  bak9.join(", "))

// Old manifest: bare path list, as before fingerprints were added.
const manifest9 = path.join(cfg9, ".opencode-prerequisites.manifest")
fs.writeFileSync(manifest9, fs.readFileSync(manifest9, "utf8").split("\n").filter(Boolean).map((l) => l.slice(l.indexOf("\t") + 1)).join("\n") + "\n")
check("legacy: manifest rewritten without any fingerprint", !/[0-9a-f]{64}\t/.test(fs.readFileSync(manifest9, "utf8")))
const persoLegacy9 = fs.readFileSync(path.join(cfg9, "opencode.jsonc"), "utf8").replace("{", '{\n  "x_perso_legacy": true,')
const agentsPerso9 = "# Customized AGENTS.md (legacy)\n"
fs.writeFileSync(path.join(cfg9, "opencode.jsonc"), persoLegacy9)
fs.writeFileSync(path.join(cfg9, "AGENTS.md"), agentsPerso9)
const r9b = sh("./install.sh", ["--no-tools"], env9)
const out9b = r9b.stdout + r9b.stderr
const bak9b = back9().filter((b) => fs.existsSync(path.join(b, "opencode.jsonc")) && fs.readFileSync(path.join(b, "opencode.jsonc"), "utf8") === persoLegacy9)
check("legacy: explicit \"Legacy manifest without fingerprints\" warning",
  r9b.status === 0 && /Legacy manifest without fingerprints: cannot detect your modifications/.test(out9b), `code ${r9b.status} | ${out9b}`)
check("legacy: full backup with customized opencode.jsonc AND AGENTS.md",
  bak9b.length === 1 && fs.readFileSync(path.join(bak9b[0], "AGENTS.md"), "utf8") === agentsPerso9, bak9b.join(", "))
check("legacy: kit files applied (customizations overwritten)",
  !fs.readFileSync(path.join(cfg9, "opencode.jsonc"), "utf8").includes("x_perso_legacy")
  && fs.readFileSync(path.join(cfg9, "AGENTS.md"), "utf8") === fs.readFileSync(path.join(ROOT, "config/AGENTS.md"), "utf8"))
check("legacy: the new installation restores the fingerprints",
  /^[0-9a-f]{64}\t/m.test(fs.readFileSync(manifest9, "utf8")))

// ---------- 1f. permissions: umask 077 and tree hardening ----------
const h8 = path.join(tmp, "home8"), cfg8 = path.join(h8, "cfg"), bin8 = path.join(h8, ".local/bin")
write(path.join(cfg8, "my-file.txt"), "user content\n", 0o644)
const env8 = { HOME: h8, OPENCODE_CONFIG_DIR: cfg8, OBSCURA_BIN_DIR: bin8, XDG_DATA_HOME: path.join(h8, ".local/share"), PATH: noUv }
const r8 = sh("./install.sh", ["--no-tools"], env8)
const bak8 = fs.readdirSync(h8).filter((n) => n.startsWith("cfg.bak-")).map((n) => path.join(h8, n))
const perso8 = path.join(cfg8, "my-file.txt")
check("permissions: $DEST in 700 and backup $DEST.bak-* in 700",
  r8.status === 0 && mode(cfg8) === 0o700 && bak8.length === 1 && mode(bak8[0]) === 0o700,
  `DEST ${mode(cfg8).toString(8)} | bak ${bak8.map((b) => mode(b).toString(8)).join(",")}`)
check("permissions: opencode.jsonc in 600, .installed marker in 600",
  mode(path.join(cfg8, "opencode.jsonc")) === 0o600 && mode(path.join(cfg8, ".opencode-prerequisites.installed")) === 0o600,
  `${mode(path.join(cfg8, "opencode.jsonc")).toString(8)} / ${mode(path.join(cfg8, ".opencode-prerequisites.installed")).toString(8)}`)
check("permissions: $BIN/oc-models launcher in 755",
  mode(path.join(bin8, "oc-models")) === 0o755, mode(path.join(bin8, "oc-models")).toString(8))
check("permissions: personal file preserved, readable by its owner, closed to others",
  fs.readFileSync(perso8, "utf8") === "user content\n" && (mode(perso8) & 0o400) !== 0 && (mode(perso8) & 0o077) === 0,
  `mode ${mode(perso8).toString(8)}`)

// ---------- 1g. profiles/packs: flags, resolution, marker, MCP gating ----------
const packEnv = (name) => {
  const h = path.join(tmp, `home-${name}`)
  const cfgDir = path.join(h, "cfg")
  const binDir = path.join(h, ".local", "bin")
  return {
    h, cfg: cfgDir, bin: binDir,
    env: { HOME: h, OPENCODE_CONFIG_DIR: cfgDir, OBSCURA_BIN_DIR: binDir, XDG_DATA_HOME: path.join(h, ".local/share"), PATH: `${fakeUvxDir}:${noUv}` },
  }
}
const runP = (p, args = [], extra = {}) => sh("./install.sh", [...args, "--no-tools"], { ...p.env, ...extra })
const agentsP = (cfgDir) => (fs.existsSync(path.join(cfgDir, "agents")) ? fs.readdirSync(path.join(cfgDir, "agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort() : [])
const skillsP = (cfgDir) => (fs.existsSync(path.join(cfgDir, "skills")) ? fs.readdirSync(path.join(cfgDir, "skills")).filter((d) => fs.existsSync(path.join(cfgDir, "skills", d, "SKILL.md"))) : [])
const commandsP = (cfgDir) => (fs.existsSync(path.join(cfgDir, "commands")) ? fs.readdirSync(path.join(cfgDir, "commands")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)) : [])
const profileP = (cfgDir) => fs.readFileSync(path.join(cfgDir, ".opencode-prerequisites.profile"), "utf8")
const cfgTextP = (cfgDir) => fs.readFileSync(path.join(cfgDir, "opencode.jsonc"), "utf8")
const mcpP = (cfgDir, name) => (parseJsonc(cfgTextP(cfgDir)).mcp?.servers?.[name] ?? {})

const helpP = sh("./install.sh", ["--help"], { PATH: noUv })
check("--help: exit 0 and lists profile/pack flags",
  helpP.status === 0 && ["--profile", "--with", "--without", "--no-pack", "--lite", "--android", "--pentest"].every((f) => helpP.stdout.includes(f)),
  `code ${helpP.status} | ${helpP.stdout.slice(0, 300)}`)

const pBad = packEnv("pack-bad")
const rBadPack = runP(pBad, ["--with", "nope"])
check("unknown pack: exit 1, names it and lists valid packs",
  rBadPack.status === 1 && /Unknown pack "nope"/.test(rBadPack.stderr) && /valid packs: core design/.test(rBadPack.stderr),
  `code ${rBadPack.status} | ${rBadPack.stderr}`)
check("unknown pack: nothing installed", !fs.existsSync(path.join(pBad.cfg, ".opencode-prerequisites.installed")))

const pAndroidWith = packEnv("pack-android-with")
const rAndroidWith = runP(pAndroidWith, ["--with", "android"])
check("--with android: exit 1 and tells to use --android",
  rAndroidWith.status === 1 && /use --android/.test(rAndroidWith.stderr), `code ${rAndroidWith.status} | ${rAndroidWith.stderr}`)

// core: 12 agents, 8 skills, 7 commands, optional MCPs disabled for their pack.
const pCore = packEnv("pack-core")
const rCore = runP(pCore, ["--profile", "core"])
const coreAgents = agentsP(pCore.cfg)
check("profile core: 12 agents, 8 skills, 7 commands",
  rCore.status === 0 && coreAgents.length === 12 && skillsP(pCore.cfg).length === 8 && commandsP(pCore.cfg).length === 7,
  `code ${rCore.status} | ${coreAgents.length} agents, ${skillsP(pCore.cfg).length} skills, ${commandsP(pCore.cfg).length} commands | ${rCore.stderr}`)
check("profile core: designer and pentest absent",
  !coreAgents.includes("designer") && !coreAgents.includes("pentest"))
check("profile core: marker profile=core packs=core, mode 600",
  profileP(pCore.cfg) === "profile=core\npacks=core\n" && mode(path.join(pCore.cfg, ".opencode-prerequisites.profile")) === 0o600,
  JSON.stringify(profileP(pCore.cfg)))
const coreText = cfgTextP(pCore.cfg)
check("profile core: terraform/kubernetes disabled with the devops pack reason",
  mcpP(pCore.cfg, "terraform").disabled === true && mcpP(pCore.cfg, "kubernetes").disabled === true
  && (coreText.match(/install\.sh: devops pack not installed \(--with devops\)/g) ?? []).length === 2, coreText)
check("profile core: rea disabled with the reverse pack reason",
  mcpP(pCore.cfg, "rea").disabled === true && /install\.sh: reverse pack not installed \(--with reverse\)/.test(coreText))
check("profile core: mandatory MCPs stay enabled",
  ["context7", "grep_app", "playwright", "obscura", "chrome-devtools", "semgrep", "trivy"].every((n) => Object.keys(mcpP(pCore.cfg, n)).length > 0 && mcpP(pCore.cfg, n).disabled === undefined),
  ["context7", "grep_app", "playwright", "obscura", "chrome-devtools", "semgrep", "trivy"].map((n) => `${n}:${JSON.stringify(mcpP(pCore.cfg, n).disabled)}`).join(" "))

// Remembered choice: a plain run replays profile+packs.
const rRemember = runP(pCore)
check("remembered choice: plain --no-tools stays on core (12 agents) and says so",
  rRemember.status === 0 && agentsP(pCore.cfg).length === 12 && /Profile remembered: core/.test(rRemember.stdout)
  && profileP(pCore.cfg) === "profile=core\npacks=core\n", rRemember.stdout + rRemember.stderr)

// Unknown and android entries in a saved marker are dropped with a warning.
fs.writeFileSync(path.join(pCore.cfg, ".opencode-prerequisites.profile"), "profile=core\npacks=core,ghost,android\n")
const rSaved = runP(pCore)
check("remembered packs: unknown and android entries dropped with a warning, marker rewritten",
  rSaved.status === 0 && /Unknown pack "ghost"/.test(rSaved.stderr) && /android pack is selected with --android/.test(rSaved.stderr)
  && profileP(pCore.cfg) === "profile=core\npacks=core\n" && agentsP(pCore.cfg).length === 12,
  rSaved.stderr + profileP(pCore.cfg))

// --with alone: core base (not full).
const pWith = packEnv("pack-with")
const rWith = runP(pWith, ["--with", "design"])
check("--with alone: core base + design = 13 agents, marker profile=core packs=core,design",
  rWith.status === 0 && agentsP(pWith.cfg).length === 13 && agentsP(pWith.cfg).includes("designer")
  && profileP(pWith.cfg) === "profile=core\npacks=core,design\n",
  `code ${rWith.status} | ${agentsP(pWith.cfg).length} agents | ${profileP(pWith.cfg)} | ${rWith.stderr}`)

// core + design + devops: packs add agents/skills/commands; MCPs follow the packs.
const pCDD = packEnv("pack-cdd")
const rCDD = runP(pCDD, ["--profile", "core", "--with", "design,devops"])
const cddAgents = agentsP(pCDD.cfg)
check("core --with design,devops: 18 agents (designer, devops team), 10 skills, 8 commands",
  rCDD.status === 0 && cddAgents.length === 18 && ["designer", "devops", "docker", "ansible", "terraform", "kubernetes"].every((a) => cddAgents.includes(a))
  && skillsP(pCDD.cfg).length === 10 && skillsP(pCDD.cfg).includes("ui-ux-pro-max") && skillsP(pCDD.cfg).includes("impeccable")
  && commandsP(pCDD.cfg).length === 8 && commandsP(pCDD.cfg).includes("impeccable"),
  `code ${rCDD.status} | ${cddAgents.length} agents, ${skillsP(pCDD.cfg).length} skills, ${commandsP(pCDD.cfg).length} commands | ${rCDD.stderr}`)
check("core --with design,devops: marker packs=core,design,devops",
  profileP(pCDD.cfg) === "profile=core\npacks=core,design,devops\n", JSON.stringify(profileP(pCDD.cfg)))
check("core --with design,devops: terraform enabled",
  mcpP(pCDD.cfg, "terraform").disabled === undefined && Object.keys(mcpP(pCDD.cfg, "terraform")).length > 0)
check("core --with design,devops: kubernetes disabled for the missing kubeconfig (not for the pack)",
  mcpP(pCDD.cfg, "kubernetes").disabled === true && /no kubectl context/.test(cfgTextP(pCDD.cfg))
  && !/devops pack not installed/.test(cfgTextP(pCDD.cfg)))
check("core --with design,devops: rea still disabled for the missing reverse pack",
  mcpP(pCDD.cfg, "rea").disabled === true && /reverse pack not installed/.test(cfgTextP(pCDD.cfg)))

// Same remembered selection + a kubeconfig: kubernetes is enabled.
write(path.join(pCDD.h, ".kube/config"), "apiVersion: v1\ncurrent-context: kind-test\n")
const rCDDKube = runP(pCDD)
check("remembered core+design+devops: kubernetes enabled when a kubeconfig exists",
  rCDDKube.status === 0 && mcpP(pCDD.cfg, "kubernetes").disabled === undefined
  && /Profile remembered: core/.test(rCDDKube.stdout), rCDDKube.stdout + rCDDKube.stderr)

// Idempotence of a reduced profile: same tree on a second run.
const cddDigest = treeDigest(pCDD.cfg)
const rCDDAgain = runP(pCDD)
check("idempotence: a second core+design+devops run is byte-identical (treeDigest)",
  rCDDAgain.status === 0 && treeDigest(pCDD.cfg) === cddDigest,
  `before ${cddDigest.slice(0, 12)} after ${treeDigest(pCDD.cfg).slice(0, 12)}`)

// full --without design: 27 agents, no designer, pentest kept.
const pFull = packEnv("pack-full")
const rFullMinus = runP(pFull, ["--profile", "full", "--without", "design"])
const fullMinusAgents = agentsP(pFull.cfg)
check("full --without design: 27 agents, no designer, pentest kept",
  rFullMinus.status === 0 && fullMinusAgents.length === 27 && !fullMinusAgents.includes("designer") && fullMinusAgents.includes("pentest"),
  `code ${rFullMinus.status} | ${fullMinusAgents.length} agents | ${rFullMinus.stderr}`)
check("full --without design: 9 skills, 9 commands, marker excludes design",
  skillsP(pFull.cfg).length === 9 && commandsP(pFull.cfg).length === 9
  && profileP(pFull.cfg) === "profile=full\npacks=core,devops,languages,data,docs,control,reverse,research,pentest\n",
  `${skillsP(pFull.cfg).length} skills, ${commandsP(pFull.cfg).length} commands | ${profileP(pFull.cfg)}`)

// Remembered full-minus-design, then --no-pack resets to full.
const rFullRemember = runP(pFull)
check("remembered choice: full --without design is replayed (27 agents)",
  rFullRemember.status === 0 && agentsP(pFull.cfg).length === 27 && /Profile remembered: full/.test(rFullRemember.stdout))
const rNoPack = runP(pFull, ["--no-pack"])
check("--no-pack: resets to the full profile (28 agents, designer back)",
  rNoPack.status === 0 && agentsP(pFull.cfg).length === 28 && agentsP(pFull.cfg).includes("designer")
  && profileP(pFull.cfg).startsWith("profile=full\npacks=core,design,"), rNoPack.stdout + rNoPack.stderr)

// --lite: 12 agents, context7 + grep_app only, no tools.
const pLite = packEnv("pack-lite")
const rLite = runP(pLite, ["--lite"])
const liteMcps = Object.keys(parseJsonc(cfgTextP(pLite.cfg)).mcp?.servers ?? {}).sort()
check("--lite: 12 agents and only context7 + grep_app MCPs",
  rLite.status === 0 && agentsP(pLite.cfg).length === 12 && liteMcps.join(",") === "context7,grep_app",
  `code ${rLite.status} | ${agentsP(pLite.cfg).length} agents | MCP ${liteMcps.join(",")} | ${rLite.stderr}`)
check("--lite: marker profile=lite packs=core, mode 600",
  profileP(pLite.cfg) === "profile=lite\npacks=core\n" && mode(path.join(pLite.cfg, ".opencode-prerequisites.profile")) === 0o600,
  JSON.stringify(profileP(pLite.cfg)))

// full + --pentest: config byte-identical to a plain full install (the pentest marker is extra).
const fakePentest = path.join(tmp, "fake-pentest")
for (const n of ["gitleaks", "semgrep", "nuclei", "httpx", "ffuf", "osv-scanner", "testssl.sh", "nikto"]) {
  write(path.join(fakePentest, n), "#!/bin/sh\nexit 0\n", 0o755)
}
const pPentFull = packEnv("pack-pentest-full"), pPent = packEnv("pack-pentest")
const rPentFull = runP(pPentFull)
const rPent = runP(pPent, ["--pentest"], { PATH: `${fakePentest}:${fakeUvxDir}:${noUv}` })
fs.rmSync(path.join(pPent.cfg, ".opencode-prerequisites.pentest"), { force: true })
check("full + --pentest: config tree byte-identical to full",
  rPentFull.status === 0 && rPent.status === 0 && treeDigest(pPentFull.cfg) === treeDigest(pPent.cfg),
  `codes ${rPentFull.status}/${rPent.status} | ${rPentFull.stderr}${rPent.stderr}`)
check("full + --pentest: pentest agent kept and marker packs includes pentest",
  agentsP(pPent.cfg).includes("pentest") && /packs=.*\bpentest\b/.test(profileP(pPent.cfg)),
  profileP(pPent.cfg))

// ---------- 2. MemPalace: no more "init", orphan file removed, "mempalace" symlink ----------
const h2 = path.join(tmp, "home2"), venv = path.join(h2, ".mempalace/venv/bin"), fake = path.join(tmp, "fake"), calls = path.join(tmp, "calls.log")
write(path.join(venv, "python"), `#!/bin/sh\necho "python $*" >> "${calls}"\nexit 0\n`, 0o755)
write(path.join(venv, "mempalace"), `#!/bin/sh\necho "mempalace $*" >> "${calls}"\nexit 0\n`, 0o755)
write(path.join(h2, ".mempalace/palace/mempalace.yaml"), "wing: x\n")                 // the orphan left by the old version
write(path.join(fake, "npm"), `#!/bin/sh\nmkdir -p node_modules/@rvboris/opencode-mempalace/dist/plugin && echo "export default {}" > node_modules/@rvboris/opencode-mempalace/dist/plugin/index.js\n`, 0o755)
const env2 = { HOME: h2, OPENCODE_CONFIG_DIR: path.join(h2, "cfg"), OBSCURA_BIN_DIR: path.join(h2, ".local/bin"), PATH: `${fake}:${process.env.PATH}` }
let r = sh("./install.sh", ["--memory-only"], env2)
check("memory-only: runs with an existing venv", r.status === 0, r.stderr + r.stdout)
const log = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : ""
check("MemPalace: no more \"mempalace init\" (the palace is created on first save)", !/mempalace init/.test(log) && /pip install/.test(log))
check("MemPalace: orphan file ~/.mempalace/palace removed", !fs.existsSync(path.join(h2, ".mempalace/palace")))
check("MemPalace: ~/.local/bin/mempalace → venv command (plugin fallback)", fs.lstatSync(path.join(h2, ".local/bin/mempalace")).isSymbolicLink() && fs.realpathSync(path.join(h2, ".local/bin/mempalace")) === fs.realpathSync(path.join(venv, "mempalace")))
check("MemPalace: local plugin that sets Python itself", /MEMPALACE_ADAPTER_PYTHON \|\|= /.test(fs.readFileSync(path.join(h2, "cfg/plugins/mempalace/index.ts"), "utf8")))
write(path.join(h2, ".mempalace/palace/chroma.sqlite3"), "x"); write(path.join(h2, ".mempalace/palace/mempalace.yaml"), "wing: x\n")
sh("./install.sh", ["--memory-only"], env2)
check("MemPalace: a palace that contains a real database is NEVER deleted", fs.existsSync(path.join(h2, ".mempalace/palace/chroma.sqlite3")))

// ---------- 3. diagnostic: OpenCode started before the installation ----------
const h3 = path.join(tmp, "home3"), cfg3 = path.join(h3, "cfg"), fbin = path.join(tmp, "fbin")
fs.mkdirSync(path.join(cfg3, "agents"), { recursive: true })
write(path.join(cfg3, "opencode.jsonc"), '{ "default_agent": "ceo", "mcp": { "servers": {} } }\n')
write(path.join(cfg3, "agents/ceo.md"), "---\ndescription: x\nmode: primary\n---\nx\n")
write(path.join(cfg3, ".opencode-prerequisites.installed"), "")
write(path.join(fbin, "opencode"), '#!/bin/sh\ncase "$*" in "--version") echo 2.2.5;; "debug config") echo \'{"default_agent":"ceo"}\';; "mcp list") echo "  ✓ x  connected";; "debug agents") echo ceo;; esac\n', 0o755)
write(path.join(fbin, "ps"), "#!/bin/sh\nprintf '  4242 Sun Nov  1 15:36:12 2020 /home/u/.local/share/mise/installs/opencode/latest/node_modules/.bin/opencode serve\\n  5151 Mon Nov  2 23:59:59 2099 opencode\\n   777 Sun Nov  1 15:00:00 2020 /usr/bin/vim notes-opencode.txt\\n'\n", 0o755)
// PATH WITHOUT the "which" command: minimal Arch, Fedora and Rocky images do not have it, and the diagnostic must not depend on it
const noWhich = path.join(tmp, "nowhich"); fs.mkdirSync(noWhich)
for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
  let names = []; try { names = fs.readdirSync(dir) } catch { continue }
  for (const n of names) if (n !== "which" && !fs.existsSync(path.join(noWhich, n))) { try { fs.symlinkSync(path.join(dir, n), path.join(noWhich, n)) } catch { /* ignored */ } }
}
r = sh(process.execPath, [path.join(ROOT, "scripts/doctor.mjs")], { HOME: h3, OPENCODE_CONFIG_DIR: cfg3, PATH: `${fbin}:${noWhich}` })
const out = r.stdout
check("doctor: reports the OpenCode started before the installation", /PID 4242/.test(out) && /service restart/.test(out), out.split("\n").filter((l) => /PID|running/.test(l)).join(" | "))
check("doctor: ignores an OpenCode newer than the installation and other processes", !/PID 5151/.test(out) && !/PID 777/.test(out))

// ---------- 4. frontmatter: a Windows checkout may deliver CRLF ----------
const crlfAgent = path.join(tmp, "crlf-agent.md")
write(crlfAgent, "---\r\ndescription: CRLF agent\r\nmode: primary\r\n---\r\n\r\nBody.\r\n")
const crlfFm = frontmatter(fs.readFileSync(crlfAgent, "utf8"))
check("frontmatter: a CRLF agent Markdown is parsed (description + mode)",
  crlfFm?.description === "CRLF agent" && crlfFm?.mode === "primary", JSON.stringify(crlfFm))
const crlfCommand = path.join(tmp, "crlf-command.md")
write(crlfCommand, "---\r\ndescription: CRLF command\r\nagent: ceo\r\n---\r\n\r\nRun it.\r\n")
const crlfCmdFm = frontmatter(fs.readFileSync(crlfCommand, "utf8"))
check("frontmatter: a CRLF command Markdown is parsed (description + agent)",
  crlfCmdFm?.description === "CRLF command" && crlfCmdFm?.agent === "ceo", JSON.stringify(crlfCmdFm))
const lfFm = frontmatter("---\ndescription: LF agent\n---\nbody\n")
check("frontmatter: LF Markdown still parsed", lfFm?.description === "LF agent", JSON.stringify(lfFm))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n❌ ${failed} test(s) failed` : "\n✅ Machine-side installer OK (environment, template, backups, MCP state, uninstall, MemPalace, diagnostic, frontmatter)")
process.exit(failed ? 1 : 0)
