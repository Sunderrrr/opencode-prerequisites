#!/usr/bin/env node
// oc-models test on a copy of the config (no network access).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync, execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { parseJsonc } from "./lib/jsonc.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dest = fs.mkdtempSync(path.join(os.tmpdir(), "oc-models-test-"))
execFileSync("cp", ["-a", path.join(ROOT, "config") + "/.", dest])
const env = { ...process.env, OPENCODE_CONFIG_DIR: dest, OC_MODELS_OFFLINE: "1" }
const oc = (...a) => spawnSync(process.execPath, [path.join(dest, "libexec", "oc-models.mjs"), ...a], { encoding: "utf8", env })
let failed = 0
const check = (name, cond, detail = "") => { if (!cond) failed++; console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`) }
const model = (n) => fs.readFileSync(path.join(dest, "agents", `${n}.md`), "utf8").match(/^model:\s*(.+)$/m)?.[1]
const cfg = () => parseJsonc(fs.readFileSync(path.join(dest, "opencode.jsonc"), "utf8"))

check("start: Flash everywhere, no per-agent model", cfg().model === "opencode-go/deepseek-v4.1-flash" && !model("ceo") && !model("security"))

let r = oc("set", "ceo", "deepseek-v4-pro")
check("set ceo (shortcut without provider)", r.status === 0 && model("ceo") === "opencode-go/deepseek-v4-pro", r.stderr)
check("set ceo: other agents unchanged", !model("rust") && !model("security"))
check("set ceo: agent file stays valid (mode/permission intact)", /^mode: primary$/m.test(fs.readFileSync(path.join(dest, "agents", "ceo.md"), "utf8")) && /^permission:$/m.test(fs.readFileSync(path.join(dest, "agents", "ceo.md"), "utf8")))
r = oc("set", "security", "opencode-go/glm-5.2"); check("set security (full identifier)", model("security") === "opencode-go/glm-5.2")
r = oc("list"); check("list: shows per-agent models", r.stdout.includes("ceo") && r.stdout.includes("own model") && r.stdout.includes("opencode-go/glm-5.2"))
r = oc("set", "default", "opencode-go/kimi-k2.7-code"); check("set default: changes the global model", cfg().model === "opencode-go/kimi-k2.7-code" && cfg().small_model === "opencode-go/deepseek-v4.1-flash")
r = oc("set", "small", "opencode-go/glm-5.3-flash"); check("set small: changes the small model", cfg().small_model === "opencode-go/glm-5.3-flash")
check("config stays readable (JSONC) after modification", typeof cfg().default_agent === "string" && cfg().mcp?.servers)

// survives a reinstall: copy the kit config over everything, then apply
execFileSync("cp", ["-a", path.join(ROOT, "config") + "/.", dest]); // libexec/ copied too; oc-models.json is not part of the kit
check("reinstall: the kit overwrites the settings…", !model("ceo") && cfg().model === "opencode-go/deepseek-v4.1-flash")
r = oc("apply"); check("…and apply restores them from oc-models.json", model("ceo") === "opencode-go/deepseek-v4-pro" && model("security") === "opencode-go/glm-5.2" && cfg().model === "opencode-go/kimi-k2.7-code" && cfg().small_model === "opencode-go/glm-5.3-flash", r.stderr)

r = oc("reset", "ceo"); check("reset ceo: removes its per-agent model", r.status === 0 && !model("ceo") && model("security") === "opencode-go/glm-5.2")
r = oc("set", "all", "opencode-go/deepseek-v4.1-flash")
check("set all: everything on one model, no per-agent model left", r.status === 0 && !model("security") && cfg().model === "opencode-go/deepseek-v4.1-flash" && cfg().small_model === "opencode-go/deepseek-v4.1-flash")
r = oc("reset", "all"); check("reset all: deletes oc-models.json", r.status === 0 && !fs.existsSync(path.join(dest, "oc-models.json")))

check("unknown agent: clear error", oc("set", "nonexistent", "x/y").status !== 0)
check("invalid identifier: clear error", oc("set", "ceo", "not valid!").status !== 0)
check("unknown command: error", oc("nope").status !== 0)

fs.rmSync(dest, { recursive: true, force: true })
console.log(failed ? `\n❌ ${failed} test(s) failed` : "\n✅ oc-models OK")
process.exit(failed ? 1 : 0)
