#!/usr/bin/env node
// Agent/skill evaluation harness: run one task in a throwaway copy of a fixture,
// invoke an OpenCode agent headlessly, then score objective checks.
//
// No dependencies. See evals/README.md and docs/evals.md.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EVALS_DIR = path.join(ROOT, "evals")
const TASKS_DIR = process.env.EVAL_TASKS_DIR ? path.resolve(process.env.EVAL_TASKS_DIR) : path.join(EVALS_DIR, "tasks")
const FIXTURES_DIR = process.env.EVAL_FIXTURES_DIR ? path.resolve(process.env.EVAL_FIXTURES_DIR) : path.join(EVALS_DIR, "fixtures")
const RESULTS_DIR = process.env.EVAL_RESULTS_DIR ? path.resolve(process.env.EVAL_RESULTS_DIR) : path.join(EVALS_DIR, "results")
const OPENCODE = process.env.EVAL_OPENCODE || "opencode"
const DEFAULT_AGENT = "ceo"
const MAX_OUTPUT = 2 * 1024 * 1024
const MAX_REPORT_OUTPUT = 20_000
const TASK_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

const USAGE = `Usage: node scripts/eval.mjs --task <name> [options]

Run one eval task in a throwaway copy of its fixture, invoke an OpenCode agent
headlessly, then score the task's checks.

Options:
  --task <name>    Task to run (see evals/tasks/)
  --agent <name>   OpenCode agent (default: ${DEFAULT_AGENT})
  --model <id>     Model in provider/model form (default: agent/config default)
  --dry-run        Validate and print the plan; no model call, no checks
  --json           Print the result as JSON on stdout
  --keep           Keep the temporary work directory
  --list           List available tasks
  -h, --help       Show this help

Exit codes: 0 pass (or dry run), 1 eval failed, 2 usage/config error.`

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { task: null, agent: DEFAULT_AGENT, model: null, dryRun: false, json: false, keep: false, list: false, help: false }
  const booleans = new Set(["--dry-run", "--json", "--keep", "--list", "-h", "--help"])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)
    if (booleans.has(flag) && inline !== undefined) throw new UsageError(`${flag} does not take a value`)
    const take = () => {
      if (inline !== undefined) return inline
      if (i + 1 >= argv.length) throw new UsageError(`${flag} requires a value`)
      return argv[++i]
    }
    switch (flag) {
      case "--task": opts.task = take(); break
      case "--agent": opts.agent = take(); break
      case "--model": opts.model = take(); break
      case "--dry-run": opts.dryRun = true; break
      case "--json": opts.json = true; break
      case "--keep": opts.keep = true; break
      case "--list": opts.list = true; break
      case "-h":
      case "--help": opts.help = true; break
      default: throw new UsageError(`unknown argument: ${arg}`)
    }
  }
  return opts
}

function taskFiles() {
  if (!fs.existsSync(TASKS_DIR)) return []
  return fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith(".json")).sort()
}

function listTaskNames() {
  return taskFiles().map((f) => f.slice(0, -".json".length))
}

function fixtureDir(task) {
  return path.resolve(FIXTURES_DIR, task.fixture)
}

function validateTask(task, file) {
  const errors = []
  const fileName = path.basename(file, ".json")
  if (!task || typeof task !== "object" || Array.isArray(task)) return ["task must be a JSON object"]
  if (typeof task.name !== "string" || !TASK_NAME_RE.test(task.name)) errors.push(`name must match ${TASK_NAME_RE}`)
  else if (task.name !== fileName) errors.push(`name "${task.name}" must match the file name "${fileName}"`)
  if (typeof task.prompt !== "string" || !task.prompt.trim()) errors.push("prompt must be a non-empty string")
  if (typeof task.fixture !== "string" || !task.fixture.trim()) errors.push("fixture must be a non-empty string")
  else if (path.isAbsolute(task.fixture) || task.fixture.split(/[\\/]/).includes("..")) errors.push("fixture must be a relative path without ..")
  else {
    const dir = path.resolve(FIXTURES_DIR, task.fixture)
    const rel = path.relative(FIXTURES_DIR, dir)
    if (rel.startsWith("..") || path.isAbsolute(rel)) errors.push(`fixture escapes ${path.relative(ROOT, FIXTURES_DIR)}`)
    else if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) errors.push(`fixture directory not found: ${path.relative(ROOT, dir)}`)
  }
  if (typeof task.timeout !== "number" || !Number.isFinite(task.timeout) || task.timeout <= 0 || task.timeout > 7200) {
    errors.push("timeout must be a number of seconds between 1 and 7200")
  }
  if (task.checkTimeout !== undefined && (typeof task.checkTimeout !== "number" || !Number.isFinite(task.checkTimeout) || task.checkTimeout <= 0 || task.checkTimeout > 3600)) {
    errors.push("checkTimeout must be a number of seconds between 1 and 3600")
  }
  if (!Array.isArray(task.checks) || task.checks.length === 0) errors.push("checks must be a non-empty array")
  else task.checks.forEach((check, i) => {
    const label = `checks[${i}]`
    if (!check || typeof check !== "object" || Array.isArray(check)) { errors.push(`${label} must be an object`); return }
    if (typeof check.name !== "string" || !check.name.trim()) errors.push(`${label}.name must be a non-empty string`)
    if (typeof check.command !== "string" || !check.command.trim()) errors.push(`${label}.command must be a non-empty string`)
    if (check.args !== undefined && (!Array.isArray(check.args) || !check.args.every((a) => typeof a === "string"))) errors.push(`${label}.args must be an array of strings`)
    if (check.timeout !== undefined && (typeof check.timeout !== "number" || !Number.isFinite(check.timeout) || check.timeout <= 0 || check.timeout > 3600)) {
      errors.push(`${label}.timeout must be a number of seconds between 1 and 3600`)
    }
  })
  if (task.description !== undefined && typeof task.description !== "string") errors.push("description must be a string")
  return errors
}

function loadTask(name) {
  if (!TASK_NAME_RE.test(name)) throw new UsageError(`invalid task name: ${name}`)
  const file = path.join(TASKS_DIR, `${name}.json`)
  if (!fs.existsSync(file)) throw new UsageError(`unknown task "${name}" (available: ${listTaskNames().join(", ") || "none"})`)
  let task
  try {
    task = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    throw new UsageError(`cannot parse ${path.relative(ROOT, file)}: ${error.message}`)
  }
  const errors = validateTask(task, file)
  if (errors.length) throw new UsageError(`invalid task ${path.relative(ROOT, file)}:\n  - ${errors.join("\n  - ")}`)
  return task
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

function shortArg(value) {
  const oneLine = String(value).replace(/\s+/g, " ").trim()
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine
}

function clip(text, max = MAX_REPORT_OUTPUT) {
  if (!text || text.length <= max) return text ?? ""
  const half = Math.floor(max / 2)
  return `${text.slice(0, half)}\n... [truncated ${text.length - max} chars] ...\n${text.slice(-half)}`
}

function killTree(child) {
  if (!child || child.pid === undefined) return
  try {
    if (process.platform === "win32") child.kill("SIGKILL")
    else process.kill(-child.pid, "SIGKILL")
  } catch {
    try { child.kill("SIGKILL") } catch { /* already gone */ }
  }
}

function runProcess(command, args, { cwd, timeoutMs, shell = false, env = process.env }) {
  return new Promise((resolve) => {
    const started = Date.now()
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      resolve({ exitCode: null, signal: null, timedOut: false, durationMs: 0, stdout, stderr, error: error.message })
      return
    }
    const append = (current, chunk) => {
      if (current.length >= MAX_OUTPUT) return current
      return current + chunk.toString("utf8").slice(0, MAX_OUTPUT - current.length)
    }
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk) })
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, timedOut, durationMs: Date.now() - started, stdout, stderr })
    }
    child.on("error", (error) => finish({ exitCode: null, signal: null, error: error.message }))
    child.on("close", (code, signal) => finish({ exitCode: code, signal }))
  })
}

function parseJsonLines(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) return []
  try {
    const one = JSON.parse(trimmed)
    return Array.isArray(one) ? one : [one]
  } catch {
    // Not a single JSON document: fall back to JSON Lines.
  }
  const events = []
  for (const line of trimmed.split(/\r?\n/)) {
    const candidate = line.trim()
    if (!candidate || (!candidate.startsWith("{") && !candidate.startsWith("["))) continue
    try {
      const value = JSON.parse(candidate)
      if (Array.isArray(value)) events.push(...value)
      else events.push(value)
    } catch {
      // Ignore non-JSON log lines mixed into stdout.
    }
  }
  return events
}

function num(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value)
  return null
}

function roundCost(value) {
  return Math.round(value * 1e6) / 1e6
}

function usageFromEvents(events) {
  const totals = { cost: 0, input: 0, output: 0, total: 0, steps: 0 }
  let found = false
  let costSeen = false
  const addTokens = (tokens) => {
    if (!tokens || typeof tokens !== "object") return false
    const input = num(tokens.input) ?? num(tokens.input_tokens) ?? num(tokens.inputTokens) ?? 0
    const output = num(tokens.output) ?? num(tokens.output_tokens) ?? num(tokens.outputTokens) ?? 0
    const total = num(tokens.total) ?? num(tokens.total_tokens) ?? num(tokens.totalTokens) ?? (input + output)
    totals.input += input
    totals.output += output
    totals.total += total
    return true
  }
  for (const event of events) {
    if (!event || event.type !== "step_finish") continue
    const part = event.part ?? event.properties?.part ?? event
    const cost = num(part?.cost)
    const hasTokens = addTokens(part?.tokens)
    if (cost === null && !hasTokens) continue
    found = true
    totals.steps++
    if (cost !== null) { costSeen = true; totals.cost += cost }
  }
  if (found) {
    return {
      cost: costSeen ? roundCost(totals.cost) : null,
      tokens: { input: totals.input, output: totals.output, total: totals.total },
      steps: totals.steps,
    }
  }
  // Fallback for versions that put usage on the final message instead of step_finish.
  let fallback = null
  const walk = (node) => {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.tokens && typeof node.tokens === "object") {
      const input = num(node.tokens.input) ?? num(node.tokens.input_tokens) ?? 0
      const output = num(node.tokens.output) ?? num(node.tokens.output_tokens) ?? 0
      const total = num(node.tokens.total) ?? num(node.tokens.total_tokens) ?? (input + output)
      fallback = { cost: num(node.cost), tokens: { input, output, total } }
    }
    for (const value of Object.values(node)) walk(value)
  }
  events.forEach(walk)
  return fallback
}

function extractText(events) {
  const parts = []
  for (const event of events) {
    const text = event?.part?.text ?? event?.properties?.part?.text
    if (event?.type === "text" && typeof text === "string") parts.push(text)
  }
  return parts.join("\n").trim()
}

function agentArgs(task, opts) {
  const args = ["run", "--agent", opts.agent, "--format", "json", "--auto", "--archived"]
  if (opts.model) args.push("--model", opts.model)
  args.push(task.prompt)
  return args
}

async function runAgent(task, opts, workdir) {
  const args = agentArgs(task, opts)
  const result = await runProcess(OPENCODE, args, {
    cwd: workdir,
    timeoutMs: task.timeout * 1000,
    shell: false,
    env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
  })
  const events = parseJsonLines(result.stdout)
  return {
    command: OPENCODE,
    args,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    usage: usageFromEvents(events),
    text: clip(extractText(events)),
    stdout: clip(result.stdout),
    stderr: clip(result.stderr),
    error: result.error ?? null,
  }
}

async function runCheck(check, task, workdir) {
  const timeoutSeconds = check.timeout ?? task.checkTimeout ?? 120
  const hasArgs = Array.isArray(check.args)
  const result = await runProcess(check.command, hasArgs ? check.args : [], {
    cwd: workdir,
    timeoutMs: timeoutSeconds * 1000,
    shell: !hasArgs,
    env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", CARGO_TERM_COLOR: "never" },
  })
  return {
    name: check.name,
    command: check.command,
    args: check.args ?? [],
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    pass: !result.timedOut && !result.error && result.exitCode === 0,
    stdout: clip(result.stdout),
    stderr: clip(result.stderr),
    error: result.error ?? null,
  }
}

function usageLine(usage) {
  if (!usage) return "not reported"
  const cost = usage.cost === null || usage.cost === undefined ? "cost n/a" : `$${usage.cost}`
  const tokens = usage.tokens ?? { input: 0, output: 0, total: 0 }
  return `${cost} · ${tokens.total ?? 0} tokens (in ${tokens.input ?? 0} / out ${tokens.output ?? 0})`
}

function fenced(text) {
  return ["```text", text || "(no output)", "```"].join("\n")
}

function renderMarkdown(result) {
  const lines = []
  lines.push(`# Eval: ${result.task} — ${result.pass ? "PASS" : "FAIL"}`, "")
  lines.push("| Field | Value |", "| --- | --- |")
  lines.push(`| Agent | \`${result.agent}\` |`)
  lines.push(`| Model | ${result.model ? `\`${result.model}\`` : "agent/config default"} |`)
  lines.push(`| Started | ${result.startedAt} |`)
  lines.push(`| Duration | ${formatDuration(result.durationMs)} |`)
  lines.push(`| Fixture | \`evals/fixtures/${result.fixture}\` |`)
  lines.push(`| Usage | ${usageLine(result.agentRun.usage)} |`)
  lines.push("", "## Agent run", "")
  lines.push(`- Exit code: ${result.agentRun.exitCode ?? "n/a"}`)
  lines.push(`- Timed out: ${result.agentRun.timedOut ? "yes" : "no"}`)
  lines.push(`- Duration: ${formatDuration(result.agentRun.durationMs)}`)
  if (result.agentRun.error) lines.push(`- Error: ${result.agentRun.error}`)
  if (result.agentRun.text) {
    lines.push("", "<details><summary>Agent text</summary>", "", fenced(result.agentRun.text), "", "</details>")
  }
  lines.push("", "## Checks", "", "| # | Check | Result | Duration |", "| --- | --- | --- | --- |")
  result.checks.forEach((check, i) => {
    lines.push(`| ${i + 1} | ${check.name} | ${check.pass ? "PASS" : "FAIL"} | ${formatDuration(check.durationMs)} |`)
  })
  lines.push("")
  result.checks.forEach((check, i) => {
    lines.push(`### ${i + 1}. ${check.name} — ${check.pass ? "PASS" : "FAIL"}`, "")
    const display = check.args?.length ? `${check.command} ${check.args.map(shortArg).join(" ")}` : check.command
    lines.push(`Command: \`${display}\``, "")
    if (check.timedOut) lines.push(`Timed out after ${formatDuration(check.durationMs)}.`, "")
    if (check.error) lines.push(`Error: ${check.error}`, "")
    if (check.stdout) lines.push("<details><summary>stdout</summary>", "", fenced(check.stdout), "", "</details>", "")
    if (check.stderr) lines.push("<details><summary>stderr</summary>", "", fenced(check.stderr), "", "</details>", "")
    if (!check.stdout && !check.stderr && !check.error) lines.push("(no output)", "")
  })
  lines.push("", `Result: **${result.pass ? "PASS" : "FAIL"}** — ${result.checks.filter((c) => c.pass).length}/${result.checks.length} checks passed.`, "")
  return lines.join("\n")
}

function resultStamp(startedAt) {
  const base = startedAt.toISOString().replace(/[:.]/g, "-")
  let stamp = base
  let suffix = 1
  while (fs.existsSync(path.join(RESULTS_DIR, `${stamp}.json`)) || fs.existsSync(path.join(RESULTS_DIR, `${stamp}.md`))) {
    stamp = `${base}-${suffix++}`
  }
  return stamp
}

function printDryRun(task, opts) {
  const fixture = fixtureDir(task)
  const payload = {
    dryRun: true,
    task: task.name,
    description: task.description ?? "",
    agent: opts.agent,
    model: opts.model,
    fixture: path.relative(ROOT, fixture),
    timeout: task.timeout,
    checks: task.checks.map((check) => ({
      name: check.name,
      command: check.command,
      args: check.args ?? [],
      timeout: check.timeout ?? task.checkTimeout ?? 120,
    })),
  }
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  console.log(`DRY RUN ${task.name}${task.description ? ` — ${task.description}` : ""}`)
  console.log(`  fixture: ${payload.fixture}`)
  console.log(`  agent: ${opts.agent}${opts.model ? ` (${opts.model})` : " (default model)"}`)
  console.log(`  agent timeout: ${task.timeout}s`)
  console.log("  checks:")
  for (const check of payload.checks) {
    const display = check.args.length ? `${check.command} ${check.args.map(shortArg).join(" ")}` : check.command
    console.log(`    - ${check.name}: ${display} (timeout ${check.timeout}s)`)
  }
  console.log("\nNo model call and no checks were run.")
}

function printHuman(result) {
  console.log(`\n▶ ${result.task}: ${result.pass ? "PASS" : "FAIL"}`)
  console.log(`  agent: ${result.agent}${result.model ? ` (${result.model})` : " (default model)"}`)
  console.log(`  duration: ${formatDuration(result.durationMs)}`)
  const agent = result.agentRun
  const agentStatus = agent.timedOut
    ? `TIMEOUT after ${formatDuration(agent.durationMs)}`
    : agent.error
      ? `ERROR: ${agent.error}`
      : `exit ${agent.exitCode} in ${formatDuration(agent.durationMs)}`
  console.log(`  agent run: ${agentStatus}`)
  if (agent.usage) console.log(`  usage: ${usageLine(agent.usage)}`)
  for (const check of result.checks) {
    console.log(`  ${check.pass ? "✅" : "❌"} ${check.name} (${formatDuration(check.durationMs)})`)
    if (!check.pass) {
      const output = (check.stderr || check.stdout || check.error || "").trim()
      if (output) console.log(output.split("\n").slice(-15).map((line) => `      ${line}`).join("\n"))
    }
  }
  console.log(`  checks: ${result.checks.filter((c) => c.pass).length}/${result.checks.length} passed`)
  console.log(`  results: ${path.relative(ROOT, result.resultFiles.json)}`)
  if (result.workdirKept) console.log(`  workdir (kept): ${result.workdirKept}`)
  console.log("")
}

async function execute(task, opts) {
  const startedAt = new Date()
  const started = Date.now()
  const fixture = fixtureDir(task)
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `oc-eval-${task.name}-`))
  const workdir = path.join(tempRoot, "work")
  try {
    fs.cpSync(fixture, workdir, { recursive: true })
    const agentRun = await runAgent(task, opts, workdir)
    const checks = []
    for (const check of task.checks) checks.push(await runCheck(check, task, workdir))
    const durationMs = Date.now() - started
    const agentOk = !agentRun.timedOut && !agentRun.error && agentRun.exitCode === 0
    const checksOk = checks.length > 0 && checks.every((check) => check.pass)
    const pass = agentOk && checksOk
    fs.mkdirSync(RESULTS_DIR, { recursive: true })
    const stamp = resultStamp(startedAt)
    const jsonPath = path.join(RESULTS_DIR, `${stamp}.json`)
    const markdownPath = path.join(RESULTS_DIR, `${stamp}.md`)
    const result = {
      version: 1,
      task: task.name,
      description: task.description ?? "",
      fixture: task.fixture,
      agent: opts.agent,
      model: opts.model,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs,
      pass,
      dryRun: false,
      agentRun,
      checks,
      resultFiles: { json: jsonPath, markdown: markdownPath },
      workdirKept: opts.keep ? workdir : null,
    }
    fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`)
    fs.writeFileSync(markdownPath, renderMarkdown(result))
    return result
  } finally {
    if (!opts.keep) fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(USAGE)
    return
  }
  if (opts.list) {
    for (const name of listTaskNames()) console.log(name)
    return
  }
  if (!opts.task) throw new UsageError("--task is required")
  const task = loadTask(opts.task)
  if (opts.dryRun) {
    printDryRun(task, opts)
    return
  }
  const result = await execute(task, opts)
  if (opts.json) console.log(JSON.stringify(result, null, 2))
  else printHuman(result)
  process.exitCode = result.pass ? 0 : 1
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`eval: ${error.message}\n\n${USAGE}`)
    process.exit(2)
  }
  console.error(`eval: ${error.stack || error.message}`)
  process.exit(2)
})
