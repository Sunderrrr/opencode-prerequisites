#!/usr/bin/env node
// Tests of the oc-new-android generator: hermetic generation under /tmp (no network),
// refusal of invalid input, package substitution, wrapper, git, help, simulated install.
//
// Optional real build (requires oc-android + Podman + image):
//   OC_NEW_ANDROID_BUILD=1 node scripts/test-new-android.mjs
//   OC_NEW_ANDROID_BUILD_TIMEOUT=900 (seconds, default 900)
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TOOL = path.join(ROOT, "config", "bin", "oc-new-android")
const TEMPLATE = path.join(ROOT, "templates", "android-project")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oc-new-android-test-"))

let checks = 0
let failed = 0
const check = (name, cond, detail = "") => {
  checks++
  if (!cond) failed++
  if (cond) console.log(`✅ ${name}`)
  else console.log(`❌ ${name}${detail ? ` — ${tail(detail)}` : ""}`)
}
const tail = (s, n = 1500) => {
  const t = String(s ?? "").trim()
  return t.length > n ? `…${t.slice(-n)}` : t
}

// Hermetic environment: the user's installed config is ignored.
const baseEnv = { ...process.env }
for (const key of ["OC_NEW_ANDROID_TEMPLATE", "OPENCODE_CONFIG_DIR"]) delete baseEnv[key]
const env = {
  ...baseEnv,
  OPENCODE_CONFIG_DIR: path.join(TMP, "no-installed-config"),
  GIT_AUTHOR_NAME: "Test oc-new-android",
  GIT_AUTHOR_EMAIL: "oc-new-android@example.invalid",
}
const run = (args, opts = {}) =>
  spawnSync(TOOL, args, { encoding: "utf8", env, timeout: 60_000, ...opts })
const read = (file) => fs.readFileSync(file, "utf8")
const exists = (file) => fs.existsSync(file)

// --- help and invalid arguments ---
let r = run(["--help"])
check("--help: exit 0 and usage", r.status === 0 && r.stdout.includes("Usage: oc-new-android"), r.stdout + r.stderr)
check("--help: documents the variables", r.stdout.includes("OPENCODE_CONFIG_DIR") && r.stdout.includes("OC_NEW_ANDROID_TEMPLATE"))

r = run([])
check("no argument: exit 1 and usage on stderr", r.status === 1 && /Usage: oc-new-android/.test(r.stderr), r.stdout + r.stderr)

r = run(["demo", TMP, "extra"])
check("too many arguments: exit 1", r.status === 1 && /Too many arguments/.test(r.stderr), r.stderr)

for (const bad of ["Demo", "1project", "my project", "my/project", "../escape", "demo.app"]) {
  r = run([bad, path.join(TMP, "invalid")])
  check(`invalid name refused: ${bad}`, r.status === 1 && /Invalid name/.test(r.stderr), r.stderr)
}
check("invalid name: no directory created", !exists(path.join(TMP, "invalid")))

r = run([""])
check("empty name: exit 1", r.status === 1 && /Usage: oc-new-android/.test(r.stderr), r.stderr)

// --- nominal generation (the parent directory does not exist yet) ---
const genParent = path.join(TMP, "output", "nested")
const project = path.join(genParent, "demo-app")
r = run(["demo-app", genParent])
check("generation: exit 0", r.status === 0, r.stdout + r.stderr)
check("generation: parent directory created", exists(genParent))
check("generation: project created", exists(project))
check("generation: output with absolute path", r.stdout.includes(`Android project created: ${fs.realpathSync(project)}`), r.stdout)

const EXPECTED = [
  "settings.gradle.kts", "build.gradle.kts", "gradle.properties", "gradle/libs.versions.toml",
  "gradle/wrapper/gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.properties",
  "gradlew", "gradlew.bat", "AGENTS.md", "README.md", ".gitignore",
  "app/build.gradle.kts", "app/proguard-rules.pro", "app/src/main/AndroidManifest.xml",
  "app/src/main/res/values/strings.xml", "app/src/main/res/values/themes.xml",
  "app/src/main/res/values-night/themes.xml",
  "app/src/main/java/com/example/demo_app/MainActivity.kt",
  "app/src/main/java/com/example/demo_app/AppInfo.kt",
  "app/src/main/java/com/example/demo_app/ui/theme/Theme.kt",
  "app/src/test/java/com/example/demo_app/AppInfoTest.kt",
]
const missing = EXPECTED.filter((f) => !exists(path.join(project, f)))
check("expected files present", missing.length === 0, `missing: ${missing.join(", ")}`)

// No placeholder left behind (the wrapper jar is binary, .git is ignored).
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (e.name === ".git") return []
  const p = path.join(dir, e.name)
  return e.isDirectory() ? walk(p) : [p]
})
const leftovers = walk(project).filter((f) => !f.endsWith(".jar") && read(f).includes("{{"))
check("no placeholder left", leftovers.length === 0, leftovers.join(", "))

check("settings.gradle.kts: project name", read(path.join(project, "settings.gradle.kts")).includes('rootProject.name = "demo-app"'))
const appGradle = read(path.join(project, "app/build.gradle.kts"))
check("app/build.gradle.kts: namespace substituted", appGradle.includes('namespace = "com.example.demo_app"'))
check("app/build.gradle.kts: applicationId substituted", appGradle.includes('applicationId = "com.example.demo_app"'))
check("app/build.gradle.kts: compileSdk/targetSdk 36", appGradle.includes("compileSdk = 36") && appGradle.includes("targetSdk = 36") && appGradle.includes("minSdk = 24"))

const activity = read(path.join(project, "app/src/main/java/com/example/demo_app/MainActivity.kt"))
check("MainActivity.kt: package and theme import", activity.startsWith("package com.example.demo_app") && activity.includes("import com.example.demo_app.ui.theme.AppTheme"))
check("MainActivity.kt: Text with testTag", activity.includes("testTag(AppInfo.TEST_TAG)") && activity.includes("text = AppInfo.TITLE"))

const info = read(path.join(project, "app/src/main/java/com/example/demo_app/AppInfo.kt"))
check("AppInfo.kt: title derived from the name", info.includes('TITLE = "Demo app"'))
const testSrc = read(path.join(project, "app/src/test/java/com/example/demo_app/AppInfoTest.kt"))
check("AppInfoTest.kt: package and title substituted", testSrc.startsWith("package com.example.demo_app") && testSrc.includes('assertEquals("Demo app", AppInfo.TITLE)'))

check("strings.xml: application name", read(path.join(project, "app/src/main/res/values/strings.xml")).includes("<string name=\"app_name\">demo-app</string>"))
check("Manifest: exported activity and label", read(path.join(project, "app/src/main/AndroidManifest.xml")).includes("android:exported=\"true\"") && read(path.join(project, "app/src/main/AndroidManifest.xml")).includes("@string/app_name"))

const toml = read(path.join(project, "gradle/libs.versions.toml"))
check("pinned versions: AGP 9.5.0 / Kotlin 2.2.10 / BOM 2026.06.01",
  toml.includes('agp = "9.5.0"') && toml.includes('kotlin = "2.2.10"') && toml.includes('composeBom = "2026.06.01"') && toml.includes('activityCompose = "1.13.0"'))
check("versions: dated verification comment", toml.includes("2026-11-04") && toml.includes("oc-versions"))

const wrapperProps = read(path.join(project, "gradle/wrapper/gradle-wrapper.properties"))
check("wrapper: Gradle 9.8.2", wrapperProps.includes("gradle-9.8.2-bin.zip"))
check("wrapper: jar present", fs.statSync(path.join(project, "gradle/wrapper/gradle-wrapper.jar")).size > 10_000)
check("wrapper: gradlew executable", (fs.statSync(path.join(project, "gradlew")).mode & 0o111) !== 0)

check("README: build commands", read(path.join(project, "README.md")).includes("oc-android gradle assembleDebug") && read(path.join(project, "README.md")).includes("oc-android emulator start --wait"))
check("AGENTS.md: Android reminders", read(path.join(project, "AGENTS.md")).includes("oc-android gradle") && read(path.join(project, "AGENTS.md")).includes("oc-versions android") && read(path.join(project, "AGENTS.md")).includes("Compose BOM ≤ 2026.06.01"))

// --- initial git ---
const git = (args) => spawnSync("git", ["-C", project, ...args], { encoding: "utf8" })
r = git(["log", "--format=%s", "-1"])
check("git: initial commit", r.status === 0 && r.stdout.trim() === "Initial commit", r.stdout + r.stderr)
r = git(["status", "--porcelain"])
check("git: clean tree", r.status === 0 && r.stdout.trim() === "", r.stdout)
r = git(["branch", "--show-current"])
check("git: main branch", r.stdout.trim() === "main", r.stdout)

// --- refuse to overwrite an existing directory ---
const occupied = path.join(TMP, "occupied", "demo-app")
fs.mkdirSync(occupied, { recursive: true })
fs.writeFileSync(path.join(occupied, "marker.txt"), "intact")
r = run(["demo-app", path.join(TMP, "occupied")])
check("existing directory: refused", r.status === 1 && /already exists/.test(r.stderr), r.stderr)
check("existing directory: intact", read(path.join(occupied, "marker.txt")) === "intact" && !exists(path.join(occupied, "settings.gradle.kts")))

// --- edge case: project named "app" (the package directory keeps its name) ---
r = run(["app", path.join(TMP, "edge")])
check("name \"app\": generated", r.status === 0 && exists(path.join(TMP, "edge/app/app/src/main/java/com/example/app/MainActivity.kt")), r.stderr)
check("name \"app\": package com.example.app", read(path.join(TMP, "edge/app/app/build.gradle.kts")).includes('namespace = "com.example.app"'))

// --- simulated install: launcher in BIN, template in OPENCODE_CONFIG_DIR ---
const installBin = path.join(TMP, "install", "bin")
const installCfg = path.join(TMP, "install-config")
fs.mkdirSync(installBin, { recursive: true })
fs.copyFileSync(TOOL, path.join(installBin, "oc-new-android"))
fs.chmodSync(path.join(installBin, "oc-new-android"), 0o755)
fs.cpSync(TEMPLATE, path.join(installCfg, "templates", "android-project"), { recursive: true })
const installedProject = path.join(TMP, "installed-output", "demo-installed")
r = spawnSync(path.join(installBin, "oc-new-android"), ["demo-installed", path.join(TMP, "installed-output")], {
  encoding: "utf8",
  env: { ...env, OPENCODE_CONFIG_DIR: installCfg },
  timeout: 60_000,
})
check("install: template found in OPENCODE_CONFIG_DIR", r.status === 0 && exists(path.join(installedProject, "settings.gradle.kts")), r.stdout + r.stderr)
check("install: package substituted", exists(path.join(installedProject, "app/src/main/java/com/example/demo_installed/MainActivity.kt")))
check("install: git initialized", spawnSync("git", ["-C", installedProject, "log", "--format=%s", "-1"], { encoding: "utf8" }).stdout.trim() === "Initial commit")

// --- template forced by environment variable ---
const forced = path.join(TMP, "forced-template")
fs.cpSync(TEMPLATE, forced, { recursive: true })
r = run(["demo-forced", path.join(TMP, "forced-output")], { env: { ...env, OC_NEW_ANDROID_TEMPLATE: forced } })
check("OC_NEW_ANDROID_TEMPLATE: forced template used", r.status === 0 && exists(path.join(TMP, "forced-output/demo-forced/app/build.gradle.kts")), r.stdout + r.stderr)

// --- optional real build ---
if (process.env.OC_NEW_ANDROID_BUILD === "1") {
  const buildParent = path.join(TMP, "real-build")
  r = run(["demo-build", buildParent])
  const buildProject = path.join(buildParent, "demo-build")
  check("real build: generation", r.status === 0 && exists(buildProject), r.stdout + r.stderr)
  const seconds = Number(process.env.OC_NEW_ANDROID_BUILD_TIMEOUT || 900)
  const started = Date.now()
  const gradle = spawnSync("oc-android", ["gradle", "assembleDebug"], {
    cwd: buildProject,
    encoding: "utf8",
    env: { ...process.env },
    timeout: seconds * 1000,
  })
  const elapsed = Math.round((Date.now() - started) / 1000)
  check(`real build: assembleDebug (${elapsed} s)`, gradle.status === 0, gradle.stdout + gradle.stderr)
  const apk = path.join(buildProject, "app/build/outputs/apk/debug/app-debug.apk")
  check("real build: APK produced", exists(apk) && fs.statSync(apk).size > 100_000, exists(apk) ? `${fs.statSync(apk).size} bytes` : "APK missing")
  if (exists(apk)) console.log(`   APK: ${apk} (${fs.statSync(apk).size} bytes)`)
} else {
  console.log("ℹ️  real build skipped — set OC_NEW_ANDROID_BUILD=1 to enable it (oc-android + Podman required)")
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(failed ? `\n❌ ${failed} check(s) failed out of ${checks}` : `\n✅ oc-new-android OK — ${checks} checks`)
process.exitCode = failed ? 1 : 0
