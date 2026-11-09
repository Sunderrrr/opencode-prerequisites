#!/usr/bin/env node
// Tests of the oc-new-web generator: hermetic generation under /tmp (no network),
// npm-safe name validation, overwrite refusal, placeholders, pinned versions,
// template lookup (repository, OPENCODE_CONFIG_DIR, ~/.config/opencode), git.
//
// Optional real build (requires network, installs in a throwaway project):
//   OC_NEW_WEB_BUILD=1 node scripts/test-new-web.mjs
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TOOL = path.join(ROOT, "config", "bin", "oc-new-web")
const TEMPLATE = path.join(ROOT, "templates", "web-project")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oc-new-web-test-"))

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

// Hermetic environment: the user's installed config and git identity are ignored.
const baseEnv = { ...process.env }
for (const key of [
  "OC_NEW_WEB_TEMPLATE",
  "OPENCODE_CONFIG_DIR",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
]) delete baseEnv[key]

const HOME = path.join(TMP, "home-empty")
fs.mkdirSync(HOME, { recursive: true })
const env = {
  ...baseEnv,
  HOME,
  OPENCODE_CONFIG_DIR: path.join(TMP, "no-installed-config"),
  GIT_AUTHOR_NAME: "Test oc-new-web",
  GIT_AUTHOR_EMAIL: "oc-new-web@example.invalid",
  GIT_COMMITTER_NAME: "Test oc-new-web",
  GIT_COMMITTER_EMAIL: "oc-new-web@example.invalid",
}

const run = (args, opts = {}) =>
  spawnSync(TOOL, args, { encoding: "utf8", env, timeout: 60_000, ...opts })
const runTool = (tool, args, extraEnv, opts = {}) =>
  spawnSync(tool, args, {
    encoding: "utf8",
    env: { ...env, ...extraEnv },
    timeout: 60_000,
    ...opts,
  })
const git = (args, cwd) =>
  spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env, timeout: 30_000 })
const read = (file) => fs.readFileSync(file, "utf8")
const exists = (file) => fs.existsSync(file)

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

// --- generator itself ---
check("generator: exists and is executable", exists(TOOL) && (fs.statSync(TOOL).mode & 0o111) !== 0)
let r = spawnSync("bash", ["-n", TOOL], { encoding: "utf8" })
check("generator: bash -n passes", r.status === 0, r.stderr)

// --- help and invalid arguments ---
r = run(["--help"])
check("--help: exit 0 and usage", r.status === 0 && r.stdout.includes("Usage: oc-new-web"), r.stdout + r.stderr)
check(
  "--help: documents template variables",
  r.stdout.includes("OPENCODE_CONFIG_DIR") && r.stdout.includes("OC_NEW_WEB_TEMPLATE"),
)

r = run([])
check(
  "no argument: exit 1 and usage on stderr",
  r.status === 1 && /Usage: oc-new-web/.test(r.stderr),
  r.stdout + r.stderr,
)

r = run([""])
check("empty name: exit 1", r.status === 1 && /Usage: oc-new-web/.test(r.stderr), r.stderr)

r = run(["demo", TMP, "extra"])
check("too many arguments: exit 1", r.status === 1 && /Too many arguments/.test(r.stderr), r.stderr)

const invalidNames = [
  "Demo",
  "1project",
  "my project",
  "my/app",
  "../escape",
  ".hidden",
  "_private",
  "node_modules",
  "favicon.ico",
  "package.json",
  "app..js",
  "app!",
  "café",
  "a".repeat(215),
]
for (const bad of invalidNames) {
  r = run([bad, path.join(TMP, "invalid")])
  check(`invalid name refused: ${bad.length > 30 ? `${bad.slice(0, 20)}…` : bad}`, r.status === 1 && /Invalid name/.test(r.stderr), r.stderr)
}
check("invalid name: no directory created", !exists(path.join(TMP, "invalid")))

// --- nominal generation (the parent directory does not exist yet) ---
const genParent = path.join(TMP, "output", "nested")
const project = path.join(genParent, "demo-app")
r = run(["demo-app", genParent])
check("generation: exit 0", r.status === 0, r.stdout + r.stderr)
check("generation: parent directory created", exists(genParent))
check("generation: project created", exists(project))
check(
  "generation: absolute path printed",
  r.stdout.includes(`Web project created: ${fs.realpathSync(project)}`),
  r.stdout,
)
check("generation: package name printed", r.stdout.includes("package: demo-app"), r.stdout)

const EXPECTED = [
  "package.json",
  "vite.config.ts",
  "tsconfig.json",
  "playwright.config.ts",
  "index.html",
  "src/main.tsx",
  "src/App.tsx",
  "src/useTheme.ts",
  "src/styles/tokens.css",
  "src/styles/global.css",
  "public/favicon.svg",
  "tests/e2e.spec.ts",
  "AGENTS.md",
  "README.md",
  ".gitignore",
]
for (const file of EXPECTED) {
  check(`file present: ${file}`, exists(path.join(project, file)))
}
check("generated project: no node_modules", !exists(path.join(project, "node_modules")))

// --- placeholders ---
const generatedFiles = walk(project)
const leftover = generatedFiles.filter((file) => read(file).includes("{{"))
check("placeholders: none left", leftover.length === 0, leftover.join(", "))
check("placeholders: both values replaced", generatedFiles.every((file) => !read(file).includes("{{package}}") && !read(file).includes("{{name}}")))

// --- package.json and pinned versions ---
let pkg
try {
  pkg = JSON.parse(read(path.join(project, "package.json")))
} catch (error) {
  pkg = undefined
  check("package.json: valid JSON", false, error.message)
}
if (pkg) {
  check("package.json: valid JSON", true)
  check("package.json: name replaced", pkg.name === "demo-app", String(pkg.name))
  check("package.json: private", pkg.private === true)
  check("package.json: type module", pkg.type === "module")
  check(
    "package.json: scripts",
    ["dev", "build", "typecheck", "test:e2e"].every((name) => typeof pkg.scripts?.[name] === "string"),
  )
  check(
    "package.json: build runs the typecheck",
    pkg.scripts?.build?.includes("tsc --noEmit") && pkg.scripts?.build?.includes("vite build"),
  )

  const PINS = {
    react: "19.3.1",
    "react-dom": "19.3.1",
    "@playwright/test": "1.65.0",
    "@tailwindcss/vite": "4.3.5",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "6.2.1",
    tailwindcss: "4.3.5",
    typescript: "7.0.2",
    vite: "8.3.6",
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  for (const [dep, version] of Object.entries(PINS)) {
    check(`pin: ${dep}@${version}`, deps[dep] === version, String(deps[dep]))
  }
  const unpinned = Object.entries(deps).filter(
    ([, version]) => typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version),
  )
  check("pins: every dependency is an exact version", unpinned.length === 0, JSON.stringify(unpinned))
  check(
    "pins: no range, latest or workspace protocol",
    !Object.values(deps).some((version) => /[\^~*]|latest|workspace:|file:/.test(String(version))),
  )
}

// --- template content ---
const html = read(path.join(project, "index.html"))
check("index.html: title replaced", html.includes("<title>demo-app</title>"))
check("index.html: lang and root element", html.includes('lang="en"') && html.includes('id="root"'))
check(
  "index.html: theme bootstrap before paint",
  html.includes("oc-web-theme") && html.includes("dataset.theme"),
)

const app = read(path.join(project, "src", "App.tsx"))
check("App.tsx: project name substituted", app.includes("demo-app"))
check("App.tsx: primary button", app.includes("Try the interaction"))
check("App.tsx: live region", app.includes('aria-live="polite"'))
check("App.tsx: theme toggle is labelled", app.includes("aria-pressed") && app.includes("aria-label"))
check("App.tsx: no raw hex colors", !/#[0-9a-fA-F]{3,8}\b/.test(app))

const tokens = read(path.join(project, "src", "styles", "tokens.css"))
check(
  "tokens: color tokens",
  /--ds-color-ink:/.test(tokens) && /--ds-color-primary:/.test(tokens) && /--ds-color-focus:/.test(tokens),
)
check("tokens: spacing scale", /--ds-space-4:/.test(tokens))
check("tokens: radius scale", /--ds-radius-lg:/.test(tokens))
check("tokens: typography scale", /--ds-text-4xl:/.test(tokens))
check("tokens: font stacks", /--ds-font-display:/.test(tokens) && /--ds-font-sans:/.test(tokens))
check("tokens: light and dark via light-dark()", tokens.includes("light-dark("))

const globalCss = read(path.join(project, "src", "styles", "global.css"))
check("global.css: imports Tailwind", globalCss.includes('@import "tailwindcss"'))
check("global.css: imports tokens", globalCss.includes('@import "./tokens.css"'))
check("global.css: @theme inline mapping", globalCss.includes("@theme inline"))
check("global.css: token mapped to a utility", globalCss.includes("--color-canvas: var(--ds-color-canvas)"))
check("global.css: reduced motion", globalCss.includes("prefers-reduced-motion"))

const spec = read(path.join(project, "tests", "e2e.spec.ts"))
check("e2e: title assertion", spec.includes("toHaveTitle"))
check("e2e: console error collection", spec.includes('"console"') && spec.includes("pageerror"))
check("e2e: viewport 375", spec.includes("375"))
check("e2e: viewport 1440", spec.includes("1440"))
check("e2e: primary button assertion", spec.includes("Try the interaction"))

const playwrightConfig = read(path.join(project, "playwright.config.ts"))
check("playwright config: webServer", playwrightConfig.includes("webServer"))
check("playwright config: chromium", playwrightConfig.includes("chromium"))
check("playwright config: baseURL", playwrightConfig.includes("baseURL"))

const agents = read(path.join(project, "AGENTS.md"))
const agentsRules = [
  "tokens.css",
  "oc-versions",
  "contrast",
  "prefers-reduced-motion",
  "375",
  "768",
  "1024",
  "1440",
  "oc-android",
]
for (const rule of agentsRules) {
  check(`AGENTS.md: mentions ${rule}`, agents.toLowerCase().includes(rule.toLowerCase()))
}

const readme = read(path.join(project, "README.md"))
for (const needle of ["npm run dev", "npm run build", "npm run test:e2e", "playwright install"]) {
  check(`README.md: mentions ${needle}`, readme.includes(needle))
}

const gitignore = read(path.join(project, ".gitignore"))
check(".gitignore: node_modules", gitignore.includes("node_modules/"))
check(".gitignore: dist", /^dist\/$/m.test(gitignore))
check(
  ".gitignore: Playwright output",
  gitignore.includes("test-results/") && gitignore.includes("playwright-report/"),
)

// --- git ---
check("git: repository initialized", exists(path.join(project, ".git")))
let g = git(["log", "-1", "--format=%s"], project)
check("git: initial commit", g.status === 0 && g.stdout.trim() === "Initial commit", g.stdout + g.stderr)
g = git(["status", "--porcelain"], project)
check("git: clean tree", g.status === 0 && g.stdout.trim() === "", g.stdout)
g = git(["rev-parse", "--abbrev-ref", "HEAD"], project)
check("git: branch main", g.status === 0 && g.stdout.trim() === "main", g.stdout + g.stderr)
g = git(["ls-files"], project)
check("git: no node_modules tracked", g.status === 0 && !g.stdout.includes("node_modules"))

// --- overwrite refusal ---
const packageBefore = read(path.join(project, "package.json"))
r = run(["demo-app", genParent])
check("overwrite: refused", r.status === 1 && /already exists/.test(r.stderr), r.stdout + r.stderr)
check("overwrite: project untouched", read(path.join(project, "package.json")) === packageBefore)

// --- template resolution: OC_NEW_WEB_TEMPLATE override ---
const customTemplate = path.join(TMP, "custom-template")
fs.cpSync(TEMPLATE, customTemplate, { recursive: true })
fs.writeFileSync(path.join(customTemplate, "CUSTOM_MARKER"), "custom template\n")
r = runTool(TOOL, ["custom-app", path.join(TMP, "custom-out")], {
  OC_NEW_WEB_TEMPLATE: customTemplate,
})
check(
  "template override: OC_NEW_WEB_TEMPLATE wins",
  r.status === 0 && exists(path.join(TMP, "custom-out", "custom-app", "CUSTOM_MARKER")),
  r.stdout + r.stderr,
)

// --- template resolution: simulated installation ($OPENCODE_CONFIG_DIR) ---
const fakeConfig = path.join(TMP, "fake-config")
fs.mkdirSync(path.join(fakeConfig, "bin"), { recursive: true })
fs.copyFileSync(TOOL, path.join(fakeConfig, "bin", "oc-new-web"))
fs.chmodSync(path.join(fakeConfig, "bin", "oc-new-web"), 0o755)
fs.cpSync(TEMPLATE, path.join(fakeConfig, "templates", "web-project"), { recursive: true })
r = runTool(
  path.join(fakeConfig, "bin", "oc-new-web"),
  ["installed-app", path.join(TMP, "installed-out")],
  { OPENCODE_CONFIG_DIR: fakeConfig, HOME: path.join(TMP, "home-fake") },
  { cwd: TMP },
)
check(
  "install fallback: OPENCODE_CONFIG_DIR template",
  r.status === 0 && exists(path.join(TMP, "installed-out", "installed-app", "package.json")),
  r.stdout + r.stderr,
)

// --- template resolution: simulated installation (~/.config/opencode) ---
const fakeHome = path.join(TMP, "home-install")
const fakeOc = path.join(fakeHome, ".config", "opencode")
fs.mkdirSync(path.join(fakeOc, "bin"), { recursive: true })
fs.copyFileSync(TOOL, path.join(fakeOc, "bin", "oc-new-web"))
fs.chmodSync(path.join(fakeOc, "bin", "oc-new-web"), 0o755)
fs.cpSync(TEMPLATE, path.join(fakeOc, "templates", "web-project"), { recursive: true })
const homeEnv = { ...env, HOME: fakeHome }
delete homeEnv.OPENCODE_CONFIG_DIR
delete homeEnv.OC_NEW_WEB_TEMPLATE
r = spawnSync(path.join(fakeOc, "bin", "oc-new-web"), ["home-app", path.join(TMP, "home-out")], {
  encoding: "utf8",
  env: homeEnv,
  cwd: TMP,
  timeout: 60_000,
})
check(
  "install fallback: ~/.config/opencode template",
  r.status === 0 && exists(path.join(TMP, "home-out", "home-app", "package.json")),
  r.stdout + r.stderr,
)

// --- optional real build (single run, network, behind OC_NEW_WEB_BUILD=1) ---
if (process.env.OC_NEW_WEB_BUILD === "1") {
  console.log("\n▶ Optional real build (OC_NEW_WEB_BUILD=1): npm install && npm run build")
  const buildEnv = { ...env, npm_config_cache: path.join(TMP, "npm-cache") }
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: project,
    env: buildEnv,
    encoding: "utf8",
    timeout: 900_000,
  })
  check(
    "build: npm install exit 0",
    install.status === 0,
    `${install.stdout ?? ""}\n${install.stderr ?? ""}`,
  )

  if (install.status === 0) {
    const build = spawnSync("npm", ["run", "build"], {
      cwd: project,
      env: buildEnv,
      encoding: "utf8",
      timeout: 600_000,
    })
    check(
      "build: npm run build exit 0",
      build.status === 0,
      `${build.stdout ?? ""}\n${build.stderr ?? ""}`,
    )

    const dist = path.join(project, "dist")
    check("build: dist/index.html emitted", exists(path.join(dist, "index.html")))
    if (exists(dist)) {
      const distFiles = walk(dist)
      const bytes = distFiles.reduce((total, file) => total + fs.statSync(file).size, 0)
      const assets = distFiles.filter((file) => file.includes(`${path.sep}assets${path.sep}`))
      console.log(
        `   dist: ${distFiles.length} files, ${(bytes / 1024).toFixed(1)} KiB, ${assets.length} assets`,
      )
      check(
        "build: hashed JS and CSS assets",
        assets.some((file) => file.endsWith(".js")) && assets.some((file) => file.endsWith(".css")),
      )
    }

    const tracked = git(["ls-files"], project)
    check("build: node_modules not tracked", !tracked.stdout.includes("node_modules"))
    const status = git(["status", "--porcelain"], project)
    check("build: node_modules ignored by git", !status.stdout.includes("node_modules"), status.stdout)
  }
}

// --- summary ---
console.log(`\n${failed === 0 ? "✅" : "❌"} oc-new-web: ${checks - failed}/${checks} checks passed`)
if (failed) {
  console.log(`   test directory kept for inspection: ${TMP}`)
  process.exitCode = 1
} else {
  fs.rmSync(TMP, { recursive: true, force: true })
}
