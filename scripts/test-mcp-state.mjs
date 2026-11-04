#!/usr/bin/env node
// Tests for the JSONC editor scripts/lib/mcp-state.mjs: idempotent disabling of an MCP server,
// re-enabling, preservation of comments and formatting, exit codes (2 = absent,
// 1 = invalid JSONC or unsupported block) and refusal to write a file that would become invalid.
// Fixtures under /tmp only, no network, no external binary.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { parseJsonc, mcpServers } from "./lib/jsonc.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SCRIPT = path.join(ROOT, "scripts/lib/mcp-state.mjs")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-mcpstate-"))
let passed = 0, failed = 0
const check = (name, cond, detail = "") => {
  cond ? passed++ : failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`)
}
const fixture = (name, text) => {
  const f = path.join(tmp, name)
  fs.writeFileSync(f, text)
  return f
}
const read = (f) => fs.readFileSync(f, "utf8")
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" })
const parses = (text) => { try { parseJsonc(text); return true } catch { return false } }

// ---------- 1. disable: a single line, at the top of the block, rest of the file intact ----------
// Realistic JSONC: // and /* */ comments, trailing commas, other servers and a nested object.
const original = `{
  // General settings of the test profile.
  "model": "opencode-go/deepseek-v4.1-flash",
  "mcp": {
    "timeout": { "startup": 120000 },
    "servers": {
      // Up-to-date documentation.
      "context7": {
        "type": "remote",
        "url": "https://mcp.context7.com/mcp",
      },
      /* grep_app: GitHub search
         (multi-line comment) */
      "grep_app": {
        "type": "remote",
        "url": "https://mcp.grep.app"
      },
      "kubernetes": {
        "type": "local",
        "command": ["npx", "-y", "kubernetes-mcp-server@0.1.1"],
        "environment": { "KUBECONFIG": "{env:HOME}/.kube/config" }
      }
    }
  }
}
`
const f1 = fixture("full.jsonc", original)
let r = run("disable", f1, "kubernetes", "no", "kubectl", "context")
const afterDisable = read(f1)
const inserted = `        "disabled": true, // install.sh: no kubectl context`
check("disable: exit code 0", r.status === 0, r.stderr)
check("disable: exactly one line added", afterDisable.split("\n").length === original.split("\n").length + 1,
  `${original.split("\n").length} → ${afterDisable.split("\n").length}`)
check("disable: a single occurrence of \"disabled\": true", (afterDisable.match(/"disabled"\s*:\s*true/g) ?? []).length === 1,
  String((afterDisable.match(/"disabled"\s*:\s*true/g) ?? []).length))
check("disable: line inserted at the top of the block, at the server's indentation", afterDisable.replace(`${inserted}\n`, "") === original
  && afterDisable.includes(`"kubernetes": {\n${inserted}\n        "type": "local"`), afterDisable)
check("disable: // and /* */ comments and other servers preserved",
  afterDisable.includes("// General settings of the test profile.")
  && afterDisable.includes("/* grep_app: GitHub search")
  && afterDisable.includes("// Up-to-date documentation.")
  && afterDisable.includes('"grep_app"') && afterDisable.includes('"context7"'))
check("disable: result is still valid JSONC", parses(afterDisable))
const cfg1 = parseJsonc(afterDisable)
check("disable: targeted server has disabled=true, others do not",
  mcpServers(cfg1).kubernetes.disabled === true && mcpServers(cfg1).context7.disabled === undefined
  && mcpServers(cfg1).grep_app.disabled === undefined)

// ---------- 2. idempotence: a second pass changes not a single byte ----------
r = run("disable", f1, "kubernetes", "different", "reason")
check("disable: 2nd pass identical (no duplicate, original comment preserved)",
  r.status === 0 && read(f1) === afterDisable, read(f1))

// ---------- 3. enable: the line is removed, file restored byte for byte ----------
r = run("enable", f1, "kubernetes")
check("enable: code 0 and file strictly identical to the original", r.status === 0 && read(f1) === original, r.stderr)
check("enable: no \"disabled\" left in the file", !/"disabled"/.test(read(f1)))

// ---------- 4. "disabled": false: treated as an active server ----------
const withFalse = `{
  "mcp": { "servers": {
    "obscura": {
      "type": "local",
      "disabled": false, // manual choice
      "command": ["obscura", "mcp"]
    }
  } }
}
`
const f2 = fixture("false.jsonc", withFalse)
r = run("disable", f2, "obscura", "test")
const falseToTrue = read(f2)
check("disabled:false → disable sets the value to true (code 0)", r.status === 0 && parseJsonc(falseToTrue).mcp.servers.obscura.disabled === true)
check("disabled:false → a single disabled field, end-of-line comment preserved",
  (falseToTrue.match(/"disabled"\s*:/g) ?? []).length === 1
  && falseToTrue.includes('"disabled": true, // manual choice'), falseToTrue)

// enable removes the line (the server becomes active again, without reintroducing "false")
r = run("enable", f2, "obscura")
check("enable after false→true: disabled line removed, valid JSONC",
  r.status === 0 && !/"disabled"/.test(read(f2)) && parseJsonc(read(f2)).mcp.servers.obscura.disabled === undefined, read(f2))

// ---------- 5. server already disabled: disable changes nothing, enable cleans up ----------
const already = `{
  "mcp": { "servers": {
    "kubernetes": {
      "disabled": true, // install.sh: old reason
      "type": "local",
      "command": ["kubernetes-mcp-server"]
    }
  } }
}
`
const f3 = fixture("already.jsonc", already)
r = run("disable", f3, "kubernetes", "new reason")
check("already disabled: 2nd disable has no effect, existing comment intact",
  r.status === 0 && read(f3) === already, read(f3))
r = run("enable", f3, "kubernetes")
check("already disabled: enable removes the line and leaves valid JSONC",
  r.status === 0 && !/"disabled"/.test(read(f3)) && parses(read(f3)), read(f3))

// ---------- 6. server absent: code 2, no write ----------
const f4 = fixture("absent.jsonc", original)
const before4 = read(f4)
r = run("disable", f4, "nonexistent-server", "test")
check("server absent: exit code 2", r.status === 2, `code ${r.status}`)
check("server absent: explicit message and file unchanged",
  /server "nonexistent-server" not found/.test(r.stderr) && read(f4) === before4, r.stderr)

// ---------- 7. invalid JSONC: refused, code 1, no write ----------
// Missing comma between two properties: the block is findable but the result would stay invalid.
const invalid = `{
  "mcp": { "servers": {
    "foo": {
      "type": "remote"
    }
    "bar": {}
  } }
}
`
const f5 = fixture("invalid.jsonc", invalid)
check("invalid fixture: correctly rejected by the JSONC reader", !parses(invalid))
r = run("disable", f5, "foo", "test")
check("invalid JSONC: code 1 without writing", r.status === 1 && read(f5) === invalid, `code ${r.status} | ${read(f5)}`)
check("invalid JSONC: \"file unchanged\" message", /file unchanged/.test(r.stderr), r.stderr)

// ---------- 8. single-line block: edit refused cleanly ----------
const oneLine = `{\n  "mcp": { "servers": {\n    "foo": { "type": "remote" }\n  } }\n}\n`
const f6 = fixture("oneline.jsonc", oneLine)
r = run("disable", f6, "foo", "test")
check("single-line block: code 1, file unchanged, clear message",
  r.status === 1 && read(f6) === oneLine && /single line/.test(r.stderr), `code ${r.status} | ${r.stderr}`)

// ---------- 9. file without a final newline: preserved ----------
const noNewline = `{\n  "mcp": { "servers": {\n    "grep_app": {\n      "type": "remote"\n    }\n  } }\n}`
const f7 = fixture("nonewline.jsonc", noNewline)
r = run("disable", f7, "grep_app", "test")
const noNewlineAfter = read(f7)
check("no final newline: still no newline after disable",
  r.status === 0 && !noNewlineAfter.endsWith("\n") && parses(noNewlineAfter), noNewlineAfter)
r = run("enable", f7, "grep_app")
check("no final newline: enable restores it byte for byte", r.status === 0 && read(f7) === noNewline, read(f7))

// ---------- 10. bad usage ----------
r = run("disable")
check("missing arguments: code 1 and usage displayed", r.status === 1 && /usage:/.test(r.stderr), r.stderr)
r = run("toggle", f1, "context7")
check("unknown action: code 1 and usage displayed", r.status === 1 && /usage:/.test(r.stderr), r.stderr)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n❌ ${failed} check(s) failed` : `\n✅ mcp-state OK (${passed} checks)`)
process.exit(failed ? 1 : 0)
