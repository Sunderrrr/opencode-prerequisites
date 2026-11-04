#!/usr/bin/env node
// Android module test with a FAKE podman (no container, no network): checks the commands built,
// the mounts, the protections (licenses, KVM, image) and the fake adb. Does not prove the emulator really boots.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const A = path.join(ROOT, "addons", "android")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-android-test-"))
let failed = 0
const check = (name, cond, detail = "") => { if (!cond) failed++; console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`) }

// --- fake podman: logs every call, keeps the "emulator running" state in a file ---
const log = path.join(tmp, "podman.log"), state = path.join(tmp, "running"), fakeBin = path.join(tmp, "podman")
fs.writeFileSync(fakeBin, `#!/bin/bash
echo "$*" >> "${log}"
case "$1" in
  --version) echo "podman version 5.0.0" ;;
  info) exit 0 ;;
  image) [ "$2" = exists ] && [ "\${FAKE_IMAGE:-1}" = 1 ]; exit $? ;;
  network) exit 0 ;;
  container) cat "${state}" 2>/dev/null || echo false ;;
  run) case "$*" in *" -d "*) echo true > "${state}" ;; esac ;;
  rm) echo false > "${state}" ;;
  exec) case "$*" in *getprop*) echo 1 ;; *"adb devices"*) printf 'List of devices attached\\nemulator-5554\\tdevice\\n' ;; esac; exit "\${FAKE_EXEC_RC:-0}" ;;
esac
exit 0
`, { mode: 0o755 })

// --- simulated install configuration + fake catalogs for discover.mjs ---
const cfg = path.join(tmp, "cfg"), ctx = path.join(cfg, "android"), fixtures = path.join(tmp, "fixtures"), kvm = path.join(tmp, "kvm")
fs.mkdirSync(ctx, { recursive: true }); fs.mkdirSync(fixtures)
for (const f of fs.readdirSync(path.join(A, "libexec", "oc-android"))) fs.copyFileSync(path.join(A, "libexec", "oc-android", f), path.join(ctx, f))
fs.writeFileSync(kvm, "")
const sha = "a".repeat(40), g256 = "b".repeat(64)
fs.writeFileSync(path.join(fixtures, "repository2-3.xml"), `<repo>
<remotePackage path="cmdline-tools;latest"><archives><archive><complete><size>1</size><checksum type="sha1">${sha}</checksum><url>commandlinetools-linux-1_latest.zip</url></complete><host-os>linux</host-os></archive></archives></remotePackage>
<remotePackage path="build-tools;36.0.0"></remotePackage><remotePackage path="build-tools;37.0.0"></remotePackage><remotePackage path="build-tools;37.0.0-rc1"></remotePackage>
<remotePackage path="platforms;android-36"></remotePackage></repo>`)
fs.writeFileSync(path.join(fixtures, "sys-img2-3.xml"), `<repo><remotePackage path="system-images;android-36;google_apis;x86_64"></remotePackage></repo>`)
fs.writeFileSync(path.join(fixtures, "gradle-current.json"), JSON.stringify({ version: "9.9.9", downloadUrl: "https://services.gradle.org/distributions/gradle-9.9.9-bin.zip", checksum: g256 }))

const project = path.join(tmp, "project"); fs.mkdirSync(project)
fs.writeFileSync(path.join(project, "gradlew"), "#!/bin/sh\n", { mode: 0o755 })
const env = { ...process.env, OC_PODMAN: fakeBin, OPENCODE_CONFIG_DIR: cfg, XDG_DATA_HOME: path.join(tmp, "data"), XDG_CACHE_HOME: path.join(tmp, "cache"), OC_ANDROID_KVM: kvm, OC_ANDROID_FIXTURES: fixtures, FAKE_IMAGE: "1" }
const run = (script, args, extra = {}, cwd = project) => spawnSync(script, args, { encoding: "utf8", env: { ...env, ...extra }, cwd })
const oc = (args, extra, cwd) => run(path.join(A, "bin", "oc-android"), args, extra, cwd)
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "")
const reset = () => { fs.rmSync(log, { force: true }); fs.rmSync(state, { force: true }) }
const proj = fs.realpathSync(project)

// 1. gradle
reset(); let r = oc(["gradle", "assembleDebug"])
let c = calls().split("\n").find((l) => l.startsWith("run ")) ?? ""
check("gradle: runs ./gradlew in the container", r.status === 0 && c.includes("localhost/oc-android:latest ./gradlew assembleDebug"), r.stderr)
check("gradle: mounts the project and the Gradle cache", c.includes(`-v ${proj}:/workspace`) && c.includes("-w /workspace") && /-v \S+\/oc-android\/gradle:\/gradle/.test(c))
check("gradle: SELinux without relabeling, dedicated network, adb to the emulator", c.includes("--security-opt label=disable") && c.includes("--network oc-android") && c.includes("ADB_SERVER_SOCKET=tcp:oc-android-emu:5037"))
check("gradle: never --privileged nor with the Podman socket", !/--privileged|podman\.sock|docker\.sock/.test(calls()))

// 2. missing image
reset(); r = oc(["gradle", "assembleDebug"], { FAKE_IMAGE: "0" })
check("gradle without image: refuses and says what to do", r.status !== 0 && /build-image/.test(r.stderr) && !calls().includes("run "))

// 3. emulator
reset(); r = oc(["emulator", "start"], { OC_ANDROID_KVM: path.join(tmp, "absent") })
check("emulator start without KVM: refuses (no software emulation)", r.status !== 0 && /kvm/i.test(r.stderr) && !calls().includes("run -d"))
reset(); r = oc(["emulator", "start", "--wait"])
c = calls().split("\n").find((l) => l.startsWith("run -d")) ?? ""
check("emulator start: named, detached container on the dedicated network", r.status === 0 && c.includes("--name oc-android-emu") && c.includes("--network oc-android"), r.stderr + calls())
check("emulator start: /dev/kvm passed with groups preserved", c.includes(`--device ${kvm}`) && c.includes("--group-add keep-groups"))
check("emulator start: project mounted READ-ONLY, persistent AVD", c.includes(`-v ${proj}:${proj}:ro`) && /-v \S+\/oc-android\/avd:\/avd/.test(c))
check("emulator start: image entrypoint", c.includes("--entrypoint /usr/local/bin/oc-emulator-entrypoint"))
check("emulator start --wait: waits for sys.boot_completed", calls().includes("getprop sys.boot_completed") && /Android is ready/.test(r.stdout))
check("emulator start: writes the list of mounted directories (for the fake adb)", fs.readFileSync(path.join(tmp, "data", "oc-android", "mounts"), "utf8").trim().split("\n").includes(proj))
r = oc(["emulator", "status"]); check("emulator status: running + device listed", /running/.test(r.stdout) && /emulator-5554/.test(r.stdout))

// 3b. adb: current directory mounted (same path) and used as working dir, for relative APK paths
reset(); fs.writeFileSync(state, "true")
r = oc(["adb", "install", "-r", "app/build/outputs/apk/debug/app-debug.apk"])
c = calls().split("\n").find((l) => l.startsWith("run ") && l.includes(" adb ")) ?? ""
check("adb install: mounts the project and works in $PWD", r.status === 0 && c.includes(`-v ${proj}:${proj}`) && c.includes(`-w ${proj}`) && c.includes(`localhost/oc-android:latest adb install -r app/build/outputs/apk/debug/app-debug.apk`), r.stderr + calls())
check("adb: never --privileged nor with the Podman socket", !/--privileged|podman\.sock|docker\.sock/.test(calls()))
const outsideProject = path.join(tmp, "outside project"); fs.mkdirSync(outsideProject, { recursive: true })
const outsideProjectReal = fs.realpathSync(outsideProject)
reset(); fs.writeFileSync(state, "true")
r = oc(["adb", "logcat", "-d"], {}, outsideProject)
c = calls().split("\n").find((l) => l.startsWith("run ") && l.includes(" adb ")) ?? ""
check("adb outside a project: logcat works, current directory mounted", r.status === 0 && c.includes(`-v ${outsideProjectReal}:${outsideProjectReal}`) && c.includes(`-w ${outsideProjectReal}`) && c.includes("adb logcat -d"), r.stderr + calls())

// 3c. exec: the option separator "--" (a common habit) must not be sent to Podman
reset(); r = oc(["exec", "--", "java", "-version"])
c = calls().split("\n").find((l) => l.startsWith("run ")) ?? ""
check("exec --: -- stripped, the command reaches Podman as is", r.status === 0 && / java -version$/.test(c) && !/ -- java -version/.test(c), r.stderr + calls())
reset(); r = oc(["exec", "java", "-version"])
c = calls().split("\n").find((l) => l.startsWith("run ")) ?? ""
check("exec without --: command unchanged", r.status === 0 && / java -version$/.test(c) && !/ -- java -version/.test(c), r.stderr + calls())

r = oc(["emulator", "stop"]); check("emulator stop: removes the container", r.status === 0 && /rm -f oc-android-emu/.test(calls()))

// 4. image build
reset(); r = oc(["build-image"])
check("build-image without --accept-licenses: refuses", r.status !== 0 && /licenses/i.test(r.stderr) && !calls().includes("build "))
reset(); r = oc(["build-image", "--accept-licenses"])
c = calls().split("\n").find((l) => l.startsWith("build ")) ?? ""
check("build-image: licenses explicitly accepted, tag and Containerfile", r.status === 0 && c.includes("ACCEPT_ANDROID_LICENSES=yes") && c.includes("-t localhost/oc-android:latest") && c.includes(path.join(ctx, "Containerfile")), r.stderr + c)
check("build-image: SHA-1 checksum and Gradle version from the official sources", c.includes(`CLT_SHA1=${sha}`) && c.includes("GRADLE_SHA256=" + g256) && c.includes("GRADLE_VERSION=9.9.9") && c.includes("BUILD_TOOLS=37.0.0"))
check("build-image: skips prerelease build-tools (-rc)", !c.includes("rc1"))
reset(); r = oc(["build-image", "--accept-licenses", "--api", "99"])
check("build-image: API without a system image rejected before building", r.status !== 0 && /no system image/.test(r.stderr) && !calls().includes("build "))

// 5. fake adb
const shim = path.join(A, "libexec", "oc-android", "adb-shim")
reset(); fs.writeFileSync(state, "true")
r = run(shim, ["devices"]); check("fake adb: forwards to the emulator container", /exec -i oc-android-emu adb devices/.test(calls()) && /emulator-5554/.test(r.stdout), r.stderr)
check("fake adb: -w only if the directory is mounted", !/ -w /.test(calls()))
reset(); r = run(shim, ["install", "-r", "app.apk"]); fs.writeFileSync(path.join(tmp, "data", "oc-android", "mounts"), proj + "\n")
reset(); r = run(shim, ["install", "-r", "app.apk"]); check("fake adb: -w <current directory> when it is mounted", calls().includes(`-w ${proj} oc-android-emu adb install -r app.apk`) || calls().includes(`-w ${proj}`), calls())
reset(); r = run(shim, ["devices"], { FAKE_EXEC_RC: "125" }); check("fake adb: clear message if the container is stopped", r.status === 125 && /oc-android emulator start/.test(r.stderr))

// 6. mobile MCP
const mcp = path.join(A, "bin", "oc-mobile-mcp")
const data = path.join(tmp, "data"); const sdkRoot = path.join(data, "oc-android", "sdk", "platform-tools"); fs.mkdirSync(sdkRoot, { recursive: true }); fs.writeFileSync(path.join(sdkRoot, "adb"), "#!/bin/sh\n", { mode: 0o755 })
const clean = { PATH: "/usr/bin:/bin", HOME: path.join(tmp, "emptyhome"), ANDROID_HOME: "" }
fs.mkdirSync(clean.HOME, { recursive: true })
r = run(mcp, ["--check"], clean); check("oc-mobile-mcp --check: OK with the module's fake adb and Podman", r.status === 0, r.stderr)
r = run(mcp, ["--check"], { ...clean, OC_PODMAN: path.join(tmp, "absent") }); check("oc-mobile-mcp --check: KO if Podman is missing", r.status !== 0)
fs.rmSync(path.join(data, "oc-android", "sdk"), { recursive: true })
r = run(mcp, ["--check"], clean); check("oc-mobile-mcp --check: KO without module or adb", r.status !== 0 && /install\.sh --android/.test(r.stderr))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n❌ ${failed} test(s) failed` : "\n✅ Android module OK (commands, mounts, protections, fake adb)")
process.exit(failed ? 1 : 0)
