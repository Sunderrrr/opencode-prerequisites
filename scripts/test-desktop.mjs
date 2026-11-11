#!/usr/bin/env node
// Hermetic OpenCode Desktop support tests (Linux): no real desktop app, no network, temp HOME.
// Covers desktop-env.sh (PATH order, no duplicates, idempotence, OC_*_BIN), every launcher sourcing
// it, install.sh --desktop (environment.d + .desktop override, backup, idempotence, AppImage), and
// doctor.sh --desktop (pass, mode error, Wayland note).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oc-desktop-test-"))
let passed = 0
let failed = 0
const check = (name, cond, detail = "") => {
  cond ? passed++ : failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`)
}
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const read = (file) => fs.readFileSync(file, "utf8")
const mode = (file) => fs.statSync(file).mode & 0o777
const exists = (file) => fs.existsSync(file)
const baseEnv = (home, pathValue, extra = {}) => ({ HOME: home, PATH: pathValue, TMPDIR: os.tmpdir(), LANG: "C", ...extra })
// An absolute bash: the empty-PATH probe cannot resolve "bash" through PATH.
const BASH = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"].find(exists) || "bash"

// A fake HOME with a "GUI-visible" node (wrapper writes a marker, proving desktop-env.sh put
// ~/.local/bin first even when /usr/bin/node also exists), npx and opencode-desktop.
function makeHome(name, { desktop = true } = {}) {
  const home = path.join(TMP, name)
  const bin = path.join(home, ".local", "bin")
  fs.mkdirSync(bin, { recursive: true })
  const node = path.join(bin, "node")
  write(node, `#!/bin/sh\nprintf 'used\\n' > "$HOME/.oc-desktop-node-used"\nexec "${process.execPath}" "$@"\n`)
  write(path.join(bin, "npx"), "#!/bin/sh\nexit 0\n")
  const files = ["node", "npx"]
  if (desktop) {
    write(path.join(bin, "opencode-desktop"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"OpenCode Desktop 9.9.9-test\"; fi\nexit 0\n")
    files.push("opencode-desktop")
  }
  for (const f of files) fs.chmodSync(path.join(bin, f), 0o755)
  return { home, bin }
}

// --- 1. desktop-env.sh -----------------------------------------------------------------------
const HOME1 = makeHome("home-env").home
const DENV = path.join(ROOT, "config", "libexec", "desktop-env.sh")
const probe = (pathValue, extra = {}) => {
  const script = '. "$1"; printf "%s\\n" "$PATH"; . "$1"; printf "%s\\n" "$PATH"; printf "%s|%s|%s\\n" "$OC_NODE_BIN" "$OC_NPX_BIN" "$OC_BASH_BIN"'
  return spawnSync(BASH, ["-c", script, "bash", DENV], {
    encoding: "utf8",
    env: baseEnv(HOME1, pathValue, extra),
    timeout: 20_000,
  })
}
// A non-empty PATH keeps its exact order: user directories are prepended, and no system
// directory is appended (a deliberately minimal PATH must stay minimal).
const userDirs = [
  path.join(HOME1, ".local", "bin"),
  path.join(HOME1, ".local", "share", "mise", "shims"),
  path.join(HOME1, ".cargo", "bin"),
  path.join(HOME1, ".bun", "bin"),
  path.join(HOME1, ".npm-global", "bin"),
].join(":")
const fakeGitDir = path.join(TMP, "fake-git")

let r = probe("/usr/bin:/bin")
let lines = (r.stdout || "").trim().split("\n")
check("desktop-env: exits 0", r.status === 0, r.stderr)
check("desktop-env: user dirs first, then existing PATH order, no system dir appended",
  lines[0] === `${userDirs}:/usr/bin:/bin`, lines[0])
check("desktop-env: sourcing twice is idempotent", lines[1] === lines[0], lines[1])
check("desktop-env: no duplicate PATH entry", new Set(lines[0].split(":")).size === lines[0].split(":").length)
check("desktop-env: OC_NODE_BIN resolved from ~/.local/bin", lines[2].split("|")[0] === path.join(HOME1, ".local", "bin", "node"), lines[2])
check("desktop-env: OC_NPX_BIN resolved", lines[2].split("|")[1] === path.join(HOME1, ".local", "bin", "npx"), lines[2])
check("desktop-env: OC_BASH_BIN resolved", /\/bash$/.test(lines[2].split("|")[2]), lines[2])

// An empty PATH (GUI process without a session PATH) falls back to the minimal system PATH,
// once, and a second sourcing keeps it idempotent.
r = probe("")
lines = (r.stdout || "").trim().split("\n")
check("desktop-env: empty PATH gets /usr/local/bin:/usr/bin:/bin once",
  lines[0] === `${userDirs}:/usr/local/bin:/usr/bin:/bin` && lines[1] === lines[0], lines[0])

// Regression: a git shim directory placed first in PATH must stay before /usr/bin, otherwise
// the real /usr/bin/git shadows it (macOS CI: agent-wt list).
r = probe(`${fakeGitDir}:/usr/bin:/bin:${fakeGitDir}:/opt/custom:/usr/bin`)
lines = (r.stdout || "").trim().split("\n")
check("desktop-env: existing shim dir kept before /usr/bin",
  lines[0] === `${userDirs}:${fakeGitDir}:/usr/bin:/bin:/opt/custom`
  && lines[0].indexOf(fakeGitDir) < lines[0].indexOf("/usr/bin"), lines[0])
check("desktop-env: pre-existing duplicate removed", lines[0].split(":").filter((d) => d === fakeGitDir).length === 1, lines[0])

// --- 2. every launcher sources desktop-env.sh ------------------------------------------------
const launchers = [
  ...fs.readdirSync(path.join(ROOT, "config", "bin")).map((f) => path.join(ROOT, "config", "bin", f)),
  ...fs.readdirSync(path.join(ROOT, "addons", "android", "bin")).map((f) => path.join(ROOT, "addons", "android", "bin", f)),
].filter((f) => fs.statSync(f).isFile())
const missing = launchers.filter((f) => !/desktop-env\.sh/.test(read(f)) || !/^set -Eeuo pipefail$/m.test(read(f)))
check(`launchers: all ${launchers.length} source desktop-env.sh after set -Eeuo pipefail`, missing.length === 0,
  missing.map((f) => path.relative(ROOT, f)).join(", "))

// --- 3. install.sh --desktop ----------------------------------------------------------------
const A = makeHome("home-install")
const xdg = path.join(TMP, "xdg")
const systemDesktop = path.join(xdg, "applications", "ai.opencode.desktop.desktop")
write(systemDesktop, `[Desktop Entry]
Type=Application
Name=OpenCode Desktop
Comment=AI coding agent
Exec=${A.bin}/opencode-desktop %U
TryExec=${A.bin}/opencode-desktop
Icon=opencode-desktop
Categories=Development;
`)
// User file that must be backed up, and a Python venv that must reach environment.d.
const userOverride = path.join(A.home, ".local", "share", "applications", "ai.opencode.desktop.desktop")
write(userOverride, "[Desktop Entry]\nName=My personal override\n")
const venvPython = path.join(A.home, ".mempalace", "venv", "bin", "python")
write(venvPython, "#!/bin/sh\nexit 0\n")
fs.chmodSync(venvPython, 0o755)

const install = (home, args, extra = {}) => spawnSync("bash", [path.join(ROOT, "install.sh"), ...args], {
  encoding: "utf8",
  env: baseEnv(home, `${path.join(home, ".local", "bin")}:/usr/bin:/bin`, extra),
  timeout: 120_000,
})

let res = install(A.home, ["--no-tools", "--desktop"], { XDG_DATA_DIRS: xdg })
const installOut = `${res.stdout}${res.stderr}`
check("install --desktop: exits 0", res.status === 0, installOut.split("\n").slice(-8).join("\n"))
check("install --desktop: detects the desktop binary", /OpenCode Desktop detected: .*opencode-desktop/.test(res.stdout), res.stdout)
check("install --desktop: prints relaunch and Settings → Extensions", /relaunch/.test(res.stdout) && /Settings → Extensions/.test(res.stdout), res.stdout)

const envFile = path.join(A.home, ".config", "environment.d", "90-opencode-prerequisites.conf")
const expectedPath = `${A.home}/.local/bin:${A.home}/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin`
check("install --desktop: environment.d file written", exists(envFile))
const envText = exists(envFile) ? read(envFile) : ""
check("install --desktop: environment.d PATH", new RegExp(`^PATH=${expectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(envText), envText)
check("install --desktop: environment.d tagged block", envText.includes("# >>> opencode-prerequisites >>>") && envText.includes("# <<< opencode-prerequisites <<<"))
check("install --desktop: environment.d mode 600", exists(envFile) && mode(envFile) === 0o600, exists(envFile) ? `mode ${mode(envFile).toString(8)}` : "missing")
check("install --desktop: MEMPALACE_ADAPTER_PYTHON when the venv exists", envText.includes(`MEMPALACE_ADAPTER_PYTHON=${venvPython}`), envText)

check("install --desktop: user desktop file backed up", exists(`${userOverride}.bak-opencode-prerequisites`)
  && read(`${userOverride}.bak-opencode-prerequisites`).includes("My personal override"))
const desktopText = exists(userOverride) ? read(userOverride) : ""
check("install --desktop: Exec runs env PATH then the original command",
  desktopText.includes(`Exec=env PATH="${expectedPath}" ${A.bin}/opencode-desktop %U`), desktopText.split("\n").find((l) => l.startsWith("Exec=")))
check("install --desktop: exactly one %U", (desktopText.match(/%U/g) || []).length === 1)
check("install --desktop: TryExec kept", desktopText.includes(`TryExec=${A.bin}/opencode-desktop`))
check("install --desktop: StartupWMClass", desktopText.includes("StartupWMClass=ai.opencode.desktop"))
check("install --desktop: X-GNOME-UsesNotifications", desktopText.includes("X-GNOME-UsesNotifications=true"))
check("install --desktop: metadata preserved", desktopText.includes("Name=OpenCode Desktop") && desktopText.includes("Icon=opencode-desktop"))

const before = { env: read(envFile), desktop: read(userOverride), backup: read(`${userOverride}.bak-opencode-prerequisites`) }
res = install(A.home, ["--no-tools", "--desktop"], { XDG_DATA_DIRS: xdg })
check("install --desktop: second run exits 0", res.status === 0, res.stderr.split("\n").slice(-5).join("\n"))
check("install --desktop: environment.d idempotent", read(envFile) === before.env)
check("install --desktop: .desktop idempotent (no nested env)", read(userOverride) === before.desktop
  && !/Exec=env PATH="[^"]*" env PATH/.test(read(userOverride)))
check("install --desktop: first backup not overwritten by our own file", read(`${userOverride}.bak-opencode-prerequisites`) === before.backup)
check("install --desktop: --desktop does not force --no-tools",
  /--desktop\) DESKTOP=1 ;;/.test(read(path.join(ROOT, "install.sh"))) && !/--desktop\).*NOTOOLS=1/.test(read(path.join(ROOT, "install.sh"))))

// --- 4. AppImage: absolute path in Exec, no system desktop entry -----------------------------
const B = makeHome("home-appimage", { desktop: false })
const appImage = path.join(B.home, "Applications", "opencode-desktop-0.9.9-test.AppImage")
write(appImage, "#!/bin/sh\nexit 0\n")
fs.chmodSync(appImage, 0o755)
const emptyXdg = path.join(TMP, "xdg-empty")
fs.mkdirSync(emptyXdg, { recursive: true })
res = install(B.home, ["--no-tools", "--desktop"], { XDG_DATA_DIRS: emptyXdg })
check("AppImage: detected", /AppImage .*opencode-desktop-0\.9\.9-test\.AppImage/.test(res.stdout), res.stdout)
const appDesktop = path.join(B.home, ".local", "share", "applications", "ai.opencode.desktop.desktop")
const appText = exists(appDesktop) ? read(appDesktop) : ""
check("AppImage: absolute path and %U in Exec",
  appText.includes(`"${appImage}" %U`) && appText.includes(`Exec=env PATH="`), appText.split("\n").find((l) => l.startsWith("Exec=")))
check("AppImage: TryExec uses the absolute path", appText.includes(`TryExec=${appImage}`))
check("AppImage: no MEMPALACE line without a venv", !read(path.join(B.home, ".config", "environment.d", "90-opencode-prerequisites.conf")).includes("MEMPALACE_ADAPTER_PYTHON"))

// --- 5. installed launchers work with a GUI-like PATH (no node outside ~/.local/bin) ---------
const launched = (name, args, cwd = A.home) => spawnSync(path.join(A.home, ".local", "bin", name), args, {
  encoding: "utf8",
  env: baseEnv(A.home, "/usr/bin:/bin", { OC_REA_NODE_VERSION: "26.12.1" }),
  cwd,
  timeout: 30_000,
})
fs.rmSync(path.join(A.home, ".oc-desktop-node-used"), { force: true })
r = launched("oc-versions", ["--help"])
check("launcher oc-versions: works with PATH=/usr/bin:/bin", r.status === 0 && /latest real package versions/.test(r.stdout), r.stderr)
check("launcher oc-versions: used the ~/.local/bin/node prepared by desktop-env.sh", exists(path.join(A.home, ".oc-desktop-node-used")))
r = launched("oc-rea", ["--check"])
check("launcher oc-rea --check: works with PATH=/usr/bin:/bin", r.status === 0, r.stderr)
// Hermetic repository with one real worktree: the check must not depend on this checkout having
// a .worktrees/ directory (a fresh clone does not).
const wtRepo = path.join(TMP, "agentwt-repo")
fs.mkdirSync(wtRepo, { recursive: true })
const gitEnv = baseEnv(A.home, "/usr/bin:/bin", {
  GIT_AUTHOR_NAME: "oc-test", GIT_AUTHOR_EMAIL: "oc-test@example.invalid",
  GIT_COMMITTER_NAME: "oc-test", GIT_COMMITTER_EMAIL: "oc-test@example.invalid",
})
const git = (...args) => spawnSync("git", ["-C", wtRepo, ...args], { encoding: "utf8", env: gitEnv, timeout: 30_000 })
for (const args of [["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "init"], ["worktree", "add", "-q", ".worktrees/t1", "-b", "agent/t1"]]) {
  const g = git(...args)
  if (g.status !== 0) throw new Error(`git ${args.join(" ")}: ${g.stderr}`)
}
r = launched("agent-wt", ["list"], wtRepo)
check("launcher agent-wt: works with PATH=/usr/bin:/bin", r.status === 0 && /worktree/.test(r.stdout) && /t1/.test(r.stdout), r.stderr + r.stdout)

// --- 6. doctor.sh --desktop -----------------------------------------------------------------
const doctor = (home, extra = {}) => spawnSync("bash", [path.join(ROOT, "doctor.sh"), "--desktop"], {
  encoding: "utf8",
  env: baseEnv(home, "/usr/bin:/bin", extra),
  timeout: 30_000,
})
r = doctor(A.home, { XDG_SESSION_TYPE: "wayland" })
check("doctor --desktop: passes on the installed wiring", r.status === 0 && /OpenCode Desktop support OK/.test(r.stdout), r.stderr + r.stdout)
check("doctor --desktop: version probe", /opencode-desktop version: OpenCode Desktop 9\.9\.9-test/.test(r.stdout), r.stdout)
check("doctor --desktop: node/npx/bash resolved via desktop-env.sh", /node resolvable: .*\.local\/bin\/node/.test(r.stdout) && /npx resolvable:/.test(r.stdout) && /bash resolvable:/.test(r.stdout), r.stdout)
check("doctor --desktop: Wayland note", /Wayland session: .*OC_ALLOW_WAYLAND=1/.test(r.stdout), r.stdout)

fs.chmodSync(envFile, 0o644)
r = doctor(A.home)
check("doctor --desktop: fails on a non-600 environment.d file", r.status === 1 && /environment\.d file mode is 644/.test(r.stdout), r.stdout)
fs.chmodSync(envFile, 0o600)

const emptyHome = path.join(TMP, "home-empty")
fs.mkdirSync(emptyHome, { recursive: true })
r = doctor(emptyHome)
check("doctor --desktop: fails without installation", r.status === 1 && /Config directory missing/.test(r.stdout), r.stdout)

// --- 7. uninstall: desktop wiring removed, unrelated files untouched ------------------------
const uninstall = (home) => spawnSync("bash", [path.join(ROOT, "uninstall.sh")], {
  encoding: "utf8",
  env: baseEnv(home, "/usr/bin:/bin"),
  timeout: 60_000,
})

// The desktop entry written by the installer had replaced a user file: uninstall restores it.
r = uninstall(A.home)
check("uninstall --desktop: exits 0", r.status === 0, r.stderr)
check("uninstall --desktop: restores the pre-install user desktop entry",
  exists(userOverride) && read(userOverride).includes("My personal override"), exists(userOverride) ? read(userOverride) : "missing")
check("uninstall --desktop: removes an environment.d file that only held the kit block", !exists(envFile))

// A file with unrelated content is kept (kit block stripped); an unmarked desktop file is untouched.
const C = makeHome("home-uninstall")
const cxdg = path.join(TMP, "xdg-uninstall")
write(path.join(cxdg, "applications", "ai.opencode.desktop.desktop"), `[Desktop Entry]
Type=Application
Name=OpenCode Desktop
Exec=${C.bin}/opencode-desktop %U
TryExec=${C.bin}/opencode-desktop
`)
res = install(C.home, ["--no-tools", "--desktop"], { XDG_DATA_DIRS: cxdg })
const cEnv = path.join(C.home, ".config", "environment.d", "90-opencode-prerequisites.conf")
const cDesktop = path.join(C.home, ".local", "share", "applications", "ai.opencode.desktop.desktop")
const unrelated = path.join(C.home, ".local", "share", "applications", "unrelated.desktop")
write(unrelated, "[Desktop Entry]\nName=Unrelated\n")
const unrelatedBefore = read(unrelated)
fs.appendFileSync(cEnv, "OC_TEST_KEEP=1\n")
r = uninstall(C.home)
const cEnvAfter = exists(cEnv) ? read(cEnv) : ""
check("uninstall --desktop setup: install succeeds", res.status === 0, res.stderr)
check("uninstall --desktop: keeps unrelated environment.d lines, drops the kit block",
  cEnvAfter.includes("OC_TEST_KEEP=1") && !/opencode-prerequisites/.test(cEnvAfter) && !/^PATH=/m.test(cEnvAfter), cEnvAfter)
check("uninstall --desktop: removes the kit desktop override", !exists(cDesktop))
check("uninstall --desktop: leaves an unmarked desktop file untouched", read(unrelated) === unrelatedBefore)
r = uninstall(C.home)
check("uninstall --desktop: second run is a no-op", r.status === 0 && (exists(cEnv) ? read(cEnv) : "") === cEnvAfter, r.stderr)

// --- summary --------------------------------------------------------------------------------
fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed === 0) {
  console.log("✅ desktop support OK")
} else {
  console.log("❌ desktop support: failures above")
  process.exitCode = 1
}
