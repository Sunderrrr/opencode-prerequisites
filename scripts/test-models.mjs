#!/usr/bin/env node
// Test de oc-models sur une copie de la config (aucun accès réseau).
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

check("départ : Flash partout, aucun modèle propre", cfg().model === "opencode-go/deepseek-v4.1-flash" && !model("ceo") && !model("security"))

let r = oc("set", "ceo", "deepseek-v4-pro")
check("set ceo (raccourci sans fournisseur)", r.status === 0 && model("ceo") === "opencode-go/deepseek-v4-pro", r.stderr)
check("set ceo : les autres agents ne changent pas", !model("rust") && !model("security"))
check("set ceo : le fichier agent reste valide (mode/permission intacts)", /^mode: primary$/m.test(fs.readFileSync(path.join(dest, "agents", "ceo.md"), "utf8")) && /^permission:$/m.test(fs.readFileSync(path.join(dest, "agents", "ceo.md"), "utf8")))
r = oc("set", "security", "opencode-go/glm-5.2"); check("set security (identifiant complet)", model("security") === "opencode-go/glm-5.2")
r = oc("list"); check("list : montre les modèles propres", r.stdout.includes("ceo") && r.stdout.includes("modèle propre") && r.stdout.includes("opencode-go/glm-5.2"))
r = oc("set", "default", "opencode-go/kimi-k2.7-code"); check("set default : change le modèle global", cfg().model === "opencode-go/kimi-k2.7-code" && cfg().small_model === "opencode-go/deepseek-v4.1-flash")
r = oc("set", "small", "opencode-go/glm-5.3-flash"); check("set small : change le petit modèle", cfg().small_model === "opencode-go/glm-5.3-flash")
check("la config reste lisible (JSONC) après modification", typeof cfg().default_agent === "string" && cfg().mcp?.servers)

// survie à une réinstallation : on recopie la config du kit (écrase tout) puis apply
execFileSync("cp", ["-a", path.join(ROOT, "config") + "/.", dest]); // libexec/ recopié aussi ; oc-models.json n'est pas dans le kit
check("réinstallation : le kit écrase les réglages…", !model("ceo") && cfg().model === "opencode-go/deepseek-v4.1-flash")
r = oc("apply"); check("…et apply les restaure depuis oc-models.json", model("ceo") === "opencode-go/deepseek-v4-pro" && model("security") === "opencode-go/glm-5.2" && cfg().model === "opencode-go/kimi-k2.7-code" && cfg().small_model === "opencode-go/glm-5.3-flash", r.stderr)

r = oc("reset", "ceo"); check("reset ceo : retire son modèle propre", r.status === 0 && !model("ceo") && model("security") === "opencode-go/glm-5.2")
r = oc("set", "all", "opencode-go/deepseek-v4.1-flash")
check("set all : tout sur un modèle, plus aucun modèle propre", r.status === 0 && !model("security") && cfg().model === "opencode-go/deepseek-v4.1-flash" && cfg().small_model === "opencode-go/deepseek-v4.1-flash")
r = oc("reset", "all"); check("reset all : supprime oc-models.json", r.status === 0 && !fs.existsSync(path.join(dest, "oc-models.json")))

check("agent inconnu : erreur claire", oc("set", "nimportequoi", "x/y").status !== 0)
check("identifiant invalide : erreur claire", oc("set", "ceo", "pas valide!").status !== 0)
check("commande inconnue : erreur", oc("bidule").status !== 0)

fs.rmSync(dest, { recursive: true, force: true })
console.log(failed ? `\n❌ ${failed} test(s) en échec` : "\n✅ oc-models OK")
process.exit(failed ? 1 : 0)
