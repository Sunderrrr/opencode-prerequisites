#!/usr/bin/env node
// Hermetic tests for the vendored ui-ux-pro-max skill and its oc-uiux-search launcher:
// exact file set, path rewrites, frontmatter, provenance, repo/installed resolution,
// a real offline design-system search, --help, missing-skill and missing-Python errors.
// No network, no installer, no write outside a /tmp fixture.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { frontmatter } from "./lib/jsonc.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SKILL = path.join(ROOT, "config/skills/ui-ux-pro-max")
const LAUNCHER = path.join(ROOT, "config/bin/oc-uiux-search")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-uiuxtest-"))
const emptyConfig = path.join(tmp, "empty-config")
fs.mkdirSync(emptyConfig, { recursive: true })
const env = { ...process.env, OPENCODE_CONFIG_DIR: emptyConfig, PYTHONDONTWRITEBYTECODE: "1" }
const read = (f) => fs.readFileSync(f, "utf8")
const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : [])
const walk = (d) => ls(d).flatMap((x) => {
  const p = path.join(d, x)
  return fs.lstatSync(p).isDirectory() ? walk(p) : [p]
})
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 120000, env, ...opts })
let passed = 0, failed = 0
const check = (name, cond, detail = "") => {
  cond ? passed++ : failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`)
}

const CORE_CSV = ["app-interface.csv", "charts.csv", "colors.csv", "google-fonts.csv", "icons.csv", "landing.csv",
  "motion.csv", "products.csv", "react-performance.csv", "styles.csv", "typography.csv", "ui-reasoning.csv",
  "ux-guidelines.csv"]
const STACK_CSV = ["angular", "astro", "avalonia", "flutter", "html-tailwind", "javafx", "jetpack-compose",
  "laravel", "nextjs", "nuxtjs", "nuxt-ui", "react", "react-native", "shadcn", "svelte", "swiftui", "threejs",
  "uno", "uwp", "vue", "winui", "wpf"]
const REQUIRED = [
  "SKILL.md", "LICENSE", "UPSTREAM.md",
  "references/pro-rules.md", "references/quick-reference.md",
  "scripts/search.py", "scripts/core.py", "scripts/design_system.py", "scripts/reasoning_contract.py",
  ...CORE_CSV.map((f) => `data/${f}`),
  ...STACK_CSV.map((f) => `data/stacks/${f}.csv`),
]

try {
  // ---------- 1. vendored file set ----------
  const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(SKILL, f)))
  check("skill: all vendored files present", missing.length === 0, `missing: ${missing.join(", ")}`)
  check("data: 13 core CSVs", ls(path.join(SKILL, "data")).filter((f) => f.endsWith(".csv")).length === 13)
  check("data: 22 stack CSVs", ls(path.join(SKILL, "data/stacks")).filter((f) => f.endsWith(".csv")).length === 22)
  const excluded = ["scripts/tests", "scripts/validate_data.py", "data/phosphor-icons-upstream.json",
    "data/google-font-licenses.json", "data/data-provenance.json", "data/catalog-summary.json"]
  check("skill: excluded upstream files absent", excluded.every((f) => !fs.existsSync(path.join(SKILL, f))))

  // ---------- 2. path rewrites and frontmatter ----------
  const md = read(path.join(SKILL, "SKILL.md"))
  check("SKILL.md: no ${CLAUDE_PLUGIN_ROOT} left", !md.includes("${CLAUDE_PLUGIN_ROOT}"))
  check("SKILL.md: no .claude/ path left", !md.includes(".claude/"))
  check("SKILL.md: the 11 script invocations use oc-uiux-search", (md.match(/^oc-uiux-search /gm) ?? []).length === 11,
    `${(md.match(/^oc-uiux-search /gm) ?? []).length} invocations`)
  const liveFiles = [path.join(SKILL, "SKILL.md"), ...walk(path.join(SKILL, "references")),
    ...walk(path.join(SKILL, "scripts")), ...walk(path.join(SKILL, "data"))]
  const leftovers = liveFiles.filter((f) => read(f).includes("${CLAUDE_PLUGIN_ROOT}") || read(f).includes(".claude/"))
  check("skill content: no plugin-root or .claude/ reference outside UPSTREAM.md",
    leftovers.length === 0, leftovers.map((f) => path.relative(SKILL, f)).join(", "))

  const fm = frontmatter(md)
  check("SKILL.md: valid frontmatter with the directory name",
    fm?.name === "ui-ux-pro-max", fm ? `name=${fm.name}` : "no frontmatter")
  check("SKILL.md: non-empty description under 1024 chars",
    !!fm?.description && fm.description.length <= 1024, fm ? `${fm.description?.length} chars` : "none")
  check("SKILL.md: non-empty body", !!md.split(/^---$/m)[2]?.trim())

  const license = read(path.join(SKILL, "LICENSE"))
  check("LICENSE: MIT, Next Level Builder", /^MIT License/.test(license) && license.includes("Next Level Builder"))
  const up = read(path.join(SKILL, "UPSTREAM.md"))
  check("UPSTREAM.md: source, commit, version, license and date",
    ["nextlevelbuilder/ui-ux-pro-max-skill", "4f2dbb67e64969a9a30ab00742f2d55d66ddec2b", "2.15.0", "MIT", "2026-11-08"]
      .every((s) => up.includes(s)))
  check("UPSTREAM.md: third-party code, --persist and --output-dir documented",
    up.includes("third-party code") && up.includes("--persist") && up.includes("--output-dir"))

  const py = walk(path.join(SKILL, "scripts")).filter((f) => f.endsWith(".py")).map(read).join("\n")
  check("scripts: stdlib only, no network client import",
    !/^\s*(?:import|from)\s+(?:requests|urllib|http|socket|aiohttp|httpx)\b/m.test(py))

  // ---------- 3. launcher ----------
  check("launcher: executable", (fs.statSync(LAUNCHER).mode & 0o111) !== 0)
  const syntax = run("bash", ["-n", LAUNCHER], { cwd: tmp })
  check("launcher: bash -n", syntax.status === 0, syntax.stderr)

  const help = run(LAUNCHER, ["--help"], { cwd: tmp })
  check("launcher: --help works from any cwd",
    help.status === 0 && /usage: search\.py/.test(help.stdout) && help.stdout.includes("--design-system"),
    help.stderr || help.stdout.slice(0, 200))

  const ds = run(LAUNCHER, ["saas dashboard", "--design-system", "--domain", "style"], { cwd: tmp })
  const out = ds.stdout
  check("search: design-system exits 0", ds.status === 0, ds.stderr.slice(0, 500))
  check("search: non-empty output", out.trim().length > 500, `${out.length} bytes`)
  for (const section of ["STYLE", "COLORS", "TYPOGRAPHY"]) {
    check(`search: ${section} section present`, new RegExp(`─── ${section} ───`).test(out))
  }
  check("search: palette has hex colors", /#[0-9A-Fa-f]{6}/.test(out))
  check("search: no error or empty-match marker", !/No matches|^Error:/m.test(out))

  const fonts = run(LAUNCHER, ["inter", "--domain", "google-fonts", "-n", "1"], { cwd: tmp })
  check("search: google-fonts domain reads google-fonts.csv",
    fonts.status === 0 && fonts.stdout.includes("google-fonts.csv"), fonts.stderr || fonts.stdout.slice(0, 200))
  check("search: no __pycache__ written into the vendored skill",
    !fs.existsSync(path.join(SKILL, "scripts/__pycache__")))

  // Installed layout: launcher in ~/.local/bin, skill under $OPENCODE_CONFIG_DIR/skills.
  const inst = path.join(tmp, "installed")
  fs.mkdirSync(path.join(inst, "bin"), { recursive: true })
  fs.mkdirSync(path.join(inst, "config/skills"), { recursive: true })
  fs.copyFileSync(LAUNCHER, path.join(inst, "bin/oc-uiux-search"))
  fs.chmodSync(path.join(inst, "bin/oc-uiux-search"), 0o755)
  fs.symlinkSync(SKILL, path.join(inst, "config/skills/ui-ux-pro-max"), "dir")
  const instHelp = run(path.join(inst, "bin/oc-uiux-search"), ["--help"], {
    cwd: tmp, env: { ...env, HOME: path.join(inst, "home"), OPENCODE_CONFIG_DIR: path.join(inst, "config") },
  })
  check("launcher: resolves the installed config layout",
    instHelp.status === 0 && /usage: search\.py/.test(instHelp.stdout), instHelp.stderr)

  // Missing skill: clear error and exit 127.
  const miss = path.join(tmp, "missing")
  fs.mkdirSync(path.join(miss, "bin"), { recursive: true })
  fs.mkdirSync(path.join(miss, "home"), { recursive: true })
  fs.copyFileSync(LAUNCHER, path.join(miss, "bin/oc-uiux-search"))
  fs.chmodSync(path.join(miss, "bin/oc-uiux-search"), 0o755)
  const noSkill = run(path.join(miss, "bin/oc-uiux-search"), ["--help"], {
    cwd: miss, env: { ...env, HOME: path.join(miss, "home"), OPENCODE_CONFIG_DIR: path.join(miss, "config") },
  })
  check("missing skill: exit 127", noSkill.status === 127, String(noSkill.status))
  check("missing skill: clear error naming the searched paths",
    /ui-ux-pro-max skill not found/.test(noSkill.stderr) && noSkill.stderr.includes("skills/ui-ux-pro-max"),
    noSkill.stderr)
  check("missing skill: nothing on stdout", noSkill.stdout === "")

  // Missing Python: PATH with dirname only (the shebang is bypassed with an absolute bash).
  const pathDir = path.join(tmp, "path-no-python")
  fs.mkdirSync(pathDir, { recursive: true })
  const dirname = (process.env.PATH ?? "").split(path.delimiter)
    .map((d) => path.join(d, "dirname")).find((p) => fs.existsSync(p))
  if (!dirname) throw new Error("dirname not found in PATH")
  fs.symlinkSync(dirname, path.join(pathDir, "dirname"))
  const bash = fs.existsSync("/bin/bash") ? "/bin/bash" : "bash"
  const noPy = run(bash, [LAUNCHER, "--help"], {
    cwd: tmp, env: { ...env, PATH: pathDir, HOME: path.join(tmp, "home"), OPENCODE_CONFIG_DIR: emptyConfig },
  })
  check("missing Python: exit 127", noPy.status === 127, String(noPy.status))
  check("missing Python: clear error", /Python 3 not found/.test(noPy.stderr), noPy.stderr)

  // ---------- 4. lite profile ----------
  const liteDir = path.join(tmp, "lite")
  const liteWrite = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t) }
  liteWrite(path.join(liteDir, "agents/ceo.md"), "---\ndescription: ceo\nmode: primary\n---\nLead.\n")
  for (const s of ["ui-ux-pro-max", "impeccable", "tdd"]) {
    liteWrite(path.join(liteDir, "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: ${s}\n---\n`)
  }
  liteWrite(path.join(liteDir, "AGENTS.md"), "# Rules\n")
  liteWrite(path.join(liteDir, "opencode.jsonc"),
    '{"mcp":{"servers":{"context7":{"type":"remote","url":"https://mcp.context7.com/mcp"}}}}\n')
  const liteRun = run(process.execPath, [path.join(ROOT, "scripts/make-lite.mjs"), liteDir], { cwd: tmp })
  check("make-lite: exit 0 on a minimal config", liteRun.status === 0, liteRun.stderr)
  check("make-lite: removes ui-ux-pro-max and impeccable, keeps tdd",
    !fs.existsSync(path.join(liteDir, "skills/ui-ux-pro-max"))
    && !fs.existsSync(path.join(liteDir, "skills/impeccable"))
    && fs.existsSync(path.join(liteDir, "skills/tdd/SKILL.md")))
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n❌ ${failed} check(s) failed` : `\n✅ ui-ux skill OK`)
process.exit(failed ? 1 : 0)
