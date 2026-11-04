#!/usr/bin/env node
// State of the MCP servers in opencode.jsonc, without sed: portable (Linux/macOS), idempotent,
// and respectful of the file's comments and formatting.
//
//   node scripts/lib/mcp-state.mjs disable <opencode.jsonc> <server> [reason]
//   node scripts/lib/mcp-state.mjs enable  <opencode.jsonc> <server>
//
// disable: adds `"disabled": true, // install.sh: <reason>` at the top of the block (never twice).
// enable:  removes the `"disabled": true` line (and its comment) from the block.
// Exit codes: 0 = done (or already in the requested state), 1 = error, 2 = server absent from the file.
import fs from "node:fs"
import { parseJsonc } from "./jsonc.mjs"

const [action, file, name, ...reasonParts] = process.argv.slice(2)
const usage = "usage: node scripts/lib/mcp-state.mjs <disable|enable> <opencode.jsonc> <server> [reason]"
if (!["disable", "enable"].includes(action) || !file || !name) {
  console.error(usage)
  process.exit(1)
}
const reason = (reasonParts.join(" ") || "disabled by install.sh").replace(/\s+/g, " ").trim()

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Counts braces on a JSONC line, ignoring strings, // and /* */ (state kept across lines).
function braceDelta(line, st) {
  let delta = 0, inStr = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i], n = line[i + 1]
    if (st.block) { if (c === "*" && n === "/") { st.block = false; i++ } continue }
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue }
    if (c === '"') { inStr = true; continue }
    if (c === "/" && n === "/") break
    if (c === "/" && n === "*") { st.block = true; i++; continue }
    if (c === "{") delta++
    else if (c === "}") delta--
  }
  return delta
}

// Returns { open, close, indent } (line indexes) or { error } or null if the server is absent.
function findBlock(lines, server) {
  const openRe = new RegExp(`^(\\s*)"${escapeRe(server)}"\\s*:\\s*\\{`)
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(openRe)
    if (!m) continue
    const st = { block: false }
    let depth = braceDelta(lines[i], st)
    if (depth <= 0) return { error: `block "${server}" is on a single line: unsupported edit` }
    for (let j = i + 1; j < lines.length; j++) {
      depth += braceDelta(lines[j], st)
      if (depth === 0) return { open: i, close: j, indent: m[1] }
      if (depth < 0) return { error: `unbalanced braces in block "${server}"` }
    }
    return { error: `block "${server}" not terminated` }
  }
  return null
}

const original = fs.readFileSync(file, "utf8")
const withNewline = original.endsWith("\n")
const lines = original.split("\n")
if (withNewline) lines.pop()

const block = findBlock(lines, name)
if (block === null) {
  console.error(`mcp-state: server "${name}" not found in ${file}`)
  process.exit(2)
}
if (block.error) {
  console.error(`mcp-state: ${block.error}`)
  process.exit(1)
}

const disabledRe = /^\s*"disabled"\s*:\s*true\b/
let changed = false

if (action === "disable") {
  const keyRe = /^(\s*)"disabled"\s*:\s*(true|false)(\s*,?)(.*)$/
  let found = -1
  for (let i = block.open + 1; i < block.close; i++) {
    if (keyRe.test(lines[i])) { found = i; break }
  }
  if (found === -1) {
    lines.splice(block.open + 1, 0, `${block.indent}  "disabled": true, // install.sh: ${reason}`)
    changed = true
  } else {
    const m = lines[found].match(keyRe)
    const rest = m[4]
    if (m[2] === "false" || !rest.includes("//")) {
      const comma = m[3]
      const comment = rest.includes("//") ? rest : ` // install.sh: ${reason}`
      lines[found] = `${m[1]}"disabled": true${comma}${comment}`
      changed = true
    }
  }
} else {
  for (let i = block.close - 1; i > block.open; i--) {
    if (disabledRe.test(lines[i])) {
      lines.splice(i, 1)
      changed = true
    }
  }
}

const next = lines.join("\n") + (withNewline ? "\n" : "")
try {
  parseJsonc(next)
} catch (e) {
  console.error(`mcp-state: the result would no longer be valid JSONC (${e.message}) — file unchanged`)
  process.exit(1)
}
if (changed) fs.writeFileSync(file, next)
