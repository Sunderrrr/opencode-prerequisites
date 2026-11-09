#!/usr/bin/env node
// Live test of config/bin/oc-chrome-devtools-mcp against a real browser.
//
// Unlike scripts/test-chrome-devtools.mjs (hermetic: fake npx and fake browsers), this
// test starts the real pinned chrome-devtools-mcp package, lets it launch the Chrome or
// Chromium binary resolved by the launcher, and speaks MCP JSON-RPC over stdio:
// initialize (2025-06-18), notifications/initialized, tools/list, new_page with a local
// data: URL, list_pages, take_snapshot, take_screenshot (PNG magic), close_page.
//
// No npm dependency. Network may be needed on the first run (npx downloads the pinned
// package). Timeout: 120 s by default (OC_CHROME_LIVE_TIMEOUT_MS).
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TIMEOUT_MS = Number(process.env.OC_CHROME_LIVE_TIMEOUT_MS ?? 120_000)
const REQUEST_TIMEOUT_MS = Number(process.env.OC_CHROME_LIVE_REQUEST_TIMEOUT_MS ?? 60_000)
const PROTOCOL = "2025-06-18"
const DATA_URL = "data:text/html,<h1 id=t>ok</h1>"
const PNG_MAGIC = "89504e470d0a1a0a" // \x89PNG\r\n\x1a\n

let checks = 0
let failed = 0
const check = (name, cond, detail = "") => {
  checks++
  if (!cond) failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`)
}
const textOf = (result) =>
  (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n")

// --- launcher: repository copy first (development), then the installed one ---------------
const resolveLauncher = () => {
  const candidates = [
    process.env.OC_CHROME_DEVTOOLS_MCP_BIN,
    path.join(ROOT, "config", "bin", "oc-chrome-devtools-mcp"),
    path.join(os.homedir(), ".local", "bin", "oc-chrome-devtools-mcp"),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }
  throw new Error(`oc-chrome-devtools-mcp not found or not executable (tried: ${candidates.join(", ")})`)
}

// --- minimal MCP client over newline-delimited JSON-RPC on stdio --------------------------
class McpClient {
  constructor(command) {
    this.pending = new Map()
    this.nextId = 1
    this.buffer = ""
    this.junk = []
    this.stderr = []
    this.closed = false
    this.child = spawn(command, [], { stdio: ["pipe", "pipe", "pipe"], env: process.env })
    this.exit = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.closed = true
        for (const [, entry] of this.pending) {
          entry.reject(new Error(`MCP server exited (code ${code}, signal ${signal}) before answering ${entry.method}`))
        }
        this.pending.clear()
        resolve({ code, signal })
      })
    })
    this.child.on("error", (e) => {
      for (const [, entry] of this.pending) entry.reject(e)
      this.pending.clear()
    })
    this.child.stdin.on("error", () => {}) // EPIPE after the server exits
    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (d) => this.onData(d))
    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (d) => {
      this.stderr.push(d)
      if (this.stderr.length > 80) this.stderr.shift()
    })
  }

  onData(chunk) {
    this.buffer += chunk
    let newline
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "")
      this.buffer = this.buffer.slice(newline + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.junk.push(line)
        if (this.junk.length > 20) this.junk.shift()
        continue
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) {
          entry.reject(new Error(`MCP ${entry.method}: ${message.error.message ?? JSON.stringify(message.error)}`))
        } else {
          entry.resolve(message.result)
        }
      }
      // Server notifications (logging, listChanged) carry no id and need no answer here.
    }
  }

  write(message) {
    if (this.closed) throw new Error("MCP server already exited")
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timeout after ${timeoutMs} ms waiting for ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.write({ jsonrpc: "2.0", id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  notify(method, params = {}) {
    this.write({ jsonrpc: "2.0", method, params })
  }

  async close() {
    if (this.closed) return
    try {
      this.child.stdin.end()
    } catch {}
    this.child.kill("SIGTERM")
    const killer = setTimeout(() => {
      try {
        this.child.kill("SIGKILL")
      } catch {}
    }, 3000)
    await this.exit
    clearTimeout(killer)
  }

  kill() {
    try {
      this.child.stdin.end()
    } catch {}
    try {
      this.child.kill("SIGTERM")
    } catch {}
  }
}

const callTool = async (client, name, args) => {
  const result = await client.request("tools/call", { name, arguments: args })
  if (result?.isError) {
    throw new Error(`tools/call ${name} returned an error: ${textOf(result) || "(no text)"}`)
  }
  return result
}

const stderrTail = (client) =>
  client.stderr.join("").trim().split("\n").slice(-20).join("\n")

let client
const globalTimer = setTimeout(() => {
  console.error(`❌ live test timed out after ${TIMEOUT_MS} ms`)
  if (client) {
    const tail = stderrTail(client)
    if (tail) console.error(`--- server stderr (last lines) ---\n${tail}`)
    client.kill()
  }
  process.exit(1)
}, TIMEOUT_MS)

try {
  const launcher = resolveLauncher()
  console.log(`launcher: ${launcher}`)

  // Cheap preflight: the launcher must find a real Chrome/Chromium binary before the
  // MCP server is started (a clear error beats a server timeout).
  const preflight = spawnSync(launcher, ["--check"], { encoding: "utf8", timeout: 20_000 })
  const preflightOut = `${preflight.stdout ?? ""}${preflight.stderr ?? ""}`.trim()
  check("launcher --check resolves a Chrome binary", preflight.status === 0, preflightOut)
  if (preflight.status !== 0) {
    throw new Error(`no usable Chrome/Chromium binary: ${preflightOut}`)
  }

  client = new McpClient(launcher)

  const init = await client.request("initialize", {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: "oc-chrome-devtools-live", version: "1.0.0" },
  })
  check(`initialize negotiates MCP ${PROTOCOL}`, init?.protocolVersion === PROTOCOL,
    `got ${init?.protocolVersion}`)
  check("initialize returns the chrome-devtools MCP server",
    /chrome/i.test(init?.serverInfo?.name ?? ""), JSON.stringify(init?.serverInfo ?? {}))

  client.notify("notifications/initialized")

  const listed = await client.request("tools/list", {})
  const toolNames = (listed?.tools ?? []).map((t) => t.name)
  for (const required of ["new_page", "list_pages", "take_snapshot", "take_screenshot", "close_page"]) {
    check(`tools/list exposes ${required}`, toolNames.includes(required))
  }

  const created = await callTool(client, "new_page", { url: DATA_URL })
  check("new_page returns a page listing", textOf(created).trim().length > 0, textOf(created))

  const pages = await callTool(client, "list_pages", {})
  const pagesText = textOf(pages)
  const pageLine = pagesText.split("\n").find((line) => line.includes("data:text/html"))
  const pageMatch = pageLine?.match(/^\s*(\d+):\s*/)
  check("list_pages finds the data: URL page", Boolean(pageMatch), pagesText)
  if (!pageMatch) throw new Error("the page opened by new_page is not listed")
  const pageId = Number(pageMatch[1])

  const snapshot = await callTool(client, "take_snapshot", { pageId })
  const snapshotText = textOf(snapshot)
  check("take_snapshot returns a non-empty accessibility tree", snapshotText.trim().length > 0)
  check("take_snapshot contains the page heading text", /\bok\b/i.test(snapshotText),
    snapshotText.slice(0, 300))

  const screenshot = await callTool(client, "take_screenshot", { pageId })
  const image = (screenshot?.content ?? []).find((c) => c.type === "image")
  const png = image?.data ? Buffer.from(image.data, "base64") : Buffer.alloc(0)
  check("take_screenshot returns an image", Boolean(image), JSON.stringify(screenshot).slice(0, 300))
  check("screenshot is non-empty", png.length > 100, `${png.length} bytes`)
  check("screenshot has the PNG magic bytes", png.subarray(0, 8).toString("hex") === PNG_MAGIC,
    png.subarray(0, 8).toString("hex"))

  await callTool(client, "close_page", { pageId })
  check("close_page accepts the page id", true)

  const after = await callTool(client, "list_pages", {})
  check("the data: URL page is gone after close_page", !textOf(after).includes("data:text/html"),
    textOf(after))
} catch (error) {
  check("live MCP session", false, error.message)
  if (client) {
    const tail = stderrTail(client)
    if (tail) console.error(`--- server stderr (last lines) ---\n${tail}`)
    if (client.junk.length) console.error(`--- non-JSON stdout (ignored) ---\n${client.junk.join("\n")}`)
  }
} finally {
  clearTimeout(globalTimer)
  if (client) await client.close()
}

console.log("")
if (failed) {
  console.log(`❌ chrome-devtools live test failed: ${failed}/${checks} checks failed`)
  process.exit(1)
}
console.log(`✅ chrome-devtools live test passed (${checks} checks)`)
