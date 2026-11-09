#!/usr/bin/env node
// Hermetic oc-secrets tests: temp config, fake keyring tools on PATH.
// The real OS keyring is never touched: every keyring test uses a fake
// secret-tool / security / powershell binary that stores values under TMP.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TOOL = path.join(ROOT, "config", "bin", "oc-secrets")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oc-secrets-test-"))

const BIN = path.join(TMP, "bin")
const FAKE_LINUX = path.join(TMP, "fake-linux")
const FAKE_DARWIN = path.join(TMP, "fake-darwin")
const FAKE_WINDOWS = path.join(TMP, "fake-windows")

const CONFIG = path.join(TMP, "config")
const SECRETS = path.join(CONFIG, "secrets")
const CONFIG_KR = path.join(TMP, "config-kr")
const CONFIG_MAC = path.join(TMP, "config-mac")
const CONFIG_WIN = path.join(TMP, "config-win")
const CONFIG_MIG = path.join(TMP, "config-mig")
const CONFIG_MIG_FAIL = path.join(TMP, "config-mig-fail")
const CONFIG_FALLBACK = path.join(TMP, "config-fallback")
const CONFIG_EMPTY = path.join(TMP, "config-empty")

const KEYRING_LINUX = path.join(TMP, "keyring-linux")
const KEYRING_MAC = path.join(TMP, "keyring-mac")
const KEYRING_MIG = path.join(TMP, "keyring-mig")
const KEYRING_MIG_FAIL = path.join(TMP, "keyring-mig-fail")

const which = (cmd) => (process.env.PATH || "").split(path.delimiter).filter(Boolean)
  .map((dir) => path.join(dir, cmd))
  .find((file) => {
    try { fs.accessSync(file, fs.constants.X_OK); return true } catch { return false }
  })
const BASH = process.env.BASH || which("bash") || "/bin/bash"

// A sanitized PATH: only the commands oc-secrets and the fakes need. This
// hides any real secret-tool/security/powershell installed on the machine.
const NEEDED = ["awk", "basename", "bash", "cat", "chmod", "cut", "date", "dirname", "mkdir",
  "mktemp", "mv", "rm", "sort", "stat", "tar", "uname"]
fs.mkdirSync(BIN, { recursive: true })
for (const cmd of NEEDED) {
  const found = which(cmd)
  if (!found) throw new Error(`missing required test command: ${cmd}`)
  fs.symlinkSync(found, path.join(BIN, cmd))
}

const writeExe = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!${BASH}\nset -eu\n${body}`)
  fs.chmodSync(file, 0o755)
}

// Fake secret-tool: values live in $FAKE_KEYRING_DIR/<service>/<name>.
// search mimics libsecret: the secret goes to stdout (discarded by oc-secrets)
// and the attributes go to stderr (the only stream oc-secrets parses).
writeExe(path.join(FAKE_LINUX, "secret-tool"), String.raw`dir="$FAKE_KEYRING_DIR"
action="$1"
if [ "$#" -gt 0 ]; then shift; fi
service=""
name=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --label=*) shift ;;
    --all) shift ;;
    service)
      if [ "$#" -ge 2 ]; then service="$2"; fi
      shift
      if [ "$#" -gt 0 ]; then shift; fi
      ;;
    username)
      if [ "$#" -ge 2 ]; then name="$2"; fi
      shift
      if [ "$#" -gt 0 ]; then shift; fi
      ;;
    *) shift ;;
  esac
done
case "$action" in
  store)
    if [ -z "$service" ] || [ -z "$name" ]; then exit 2; fi
    mkdir -p "$dir/$service"
    if [ "$FAKE_KEYRING_CORRUPT" = "$name" ]; then
      printf '%s' "corrupted-by-test" >"$dir/$service/$name"
    else
      cat >"$dir/$service/$name"
    fi
    ;;
  lookup)
    if [ -z "$service" ] || [ -z "$name" ]; then exit 2; fi
    if [ ! -f "$dir/$service/$name" ]; then exit 1; fi
    cat "$dir/$service/$name"
    ;;
  clear)
    if [ -z "$service" ] || [ -z "$name" ]; then exit 2; fi
    rm -f "$dir/$service/$name"
    ;;
  search)
    if [ -z "$service" ]; then exit 2; fi
    for file in "$dir/$service"/*; do
      if [ ! -f "$file" ]; then continue; fi
      base=$(basename "$file")
      printf '%s\n' "[fake]"
      printf '%s\n' "label = opencode-prerequisites: $base"
      printf '%s' "secret = "
      cat "$file"
      printf '\n'
      printf '%s\n' "attribute.username = $base" >&2
    done
    ;;
  *) exit 2 ;;
esac`)

// Fake security: same layout, macOS Keychain command shapes and exit 44.
writeExe(path.join(FAKE_DARWIN, "security"), String.raw`dir="$FAKE_KEYRING_DIR"
action="$1"
if [ "$#" -gt 0 ]; then shift; fi
service=""
name=""
password=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -s)
      if [ "$#" -ge 2 ]; then service="$2"; fi
      shift
      if [ "$#" -gt 0 ]; then shift; fi
      ;;
    -a)
      if [ "$#" -ge 2 ]; then name="$2"; fi
      shift
      if [ "$#" -gt 0 ]; then shift; fi
      ;;
    -w)
      if [ "$#" -ge 2 ]; then
        password="$2"
        shift 2
      else
        shift
      fi
      ;;
    -U) shift ;;
    *) shift ;;
  esac
done
case "$action" in
  find-generic-password)
    if [ ! -f "$dir/$service/$name" ]; then exit 44; fi
    cat "$dir/$service/$name"
    ;;
  add-generic-password)
    mkdir -p "$dir/$service"
    printf '%s' "$password" >"$dir/$service/$name"
    ;;
  delete-generic-password)
    if [ ! -f "$dir/$service/$name" ]; then exit 44; fi
    rm -f "$dir/$service/$name"
    ;;
  dump-keychain)
    for file in "$dir"/*/*; do
      if [ ! -f "$file" ]; then continue; fi
      base=$(basename "$file")
      svc=$(dirname "$file")
      svc=$(basename "$svc")
      printf '%s\n' 'keychain: "/fake"'
      printf '%s\n' 'version: 512'
      printf '%s\n' 'class: 0x00000010'
      printf '%s\n' 'attributes:'
      printf '    "acct"<blob>="%s"\n' "$base"
      printf '    "svce"<blob>="%s"\n' "$svc"
    done
    ;;
  *) exit 2 ;;
esac`)

// Fake PowerShell: a reversible "dpapi:" prefix, enough to prove the script
// pipes stdin, writes a .dpapi file and reads it back without a plain file.
writeExe(path.join(FAKE_WINDOWS, "powershell"), String.raw`file="$OC_SECRETS_DPAPI_FILE"
last=""
for arg in "$@"; do last="$arg"; done
case "$last" in
  *"ConvertFrom-SecureString -SecureString"*)
    printf '%s' "dpapi:" >"$file"
    cat >>"$file"
    ;;
  *"ConvertTo-SecureString (Get-Content"*)
    if [ ! -f "$file" ]; then exit 1; fi
    content=$(cat "$file")
    case "$content" in
      dpapi:*) printf '%s' "$content" | cut -c7- ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 2 ;;
esac`)

writeExe(path.join(FAKE_DARWIN, "uname"), String.raw`printf '%s\n' "Darwin"`)
writeExe(path.join(FAKE_WINDOWS, "uname"), String.raw`printf '%s\n' "MINGW64_NT-10.0"`)

const baseEnv = { ...process.env }
delete baseEnv.OPENCODE_CONFIG_DIR
delete baseEnv.OC_SECRETS_BACKEND
delete baseEnv.DBUS_SESSION_BUS_ADDRESS
delete baseEnv.FAKE_KEYRING_DIR
delete baseEnv.FAKE_KEYRING_CORRUPT
delete baseEnv.OC_SECRETS_DPAPI_FILE
delete baseEnv.USERPROFILE

const run = (args, input, extra = {}) => spawnSync(BASH, [TOOL, ...args], {
  encoding: "utf8",
  env: { ...baseEnv, OPENCODE_CONFIG_DIR: CONFIG, ...extra },
  input,
  timeout: 20_000,
})
const runFile = (args, input) => run(args, input, { OC_SECRETS_BACKEND: "file" })

const linuxEnv = (config, extra = {}) => ({
  OPENCODE_CONFIG_DIR: config,
  PATH: `${FAKE_LINUX}${path.delimiter}${BIN}`,
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/fake-session-bus",
  FAKE_KEYRING_DIR: KEYRING_LINUX,
  FAKE_KEYRING_CORRUPT: "",
  ...extra,
})
const macEnv = (config, extra = {}) => ({
  OPENCODE_CONFIG_DIR: config,
  PATH: `${FAKE_DARWIN}${path.delimiter}${BIN}`,
  FAKE_KEYRING_DIR: KEYRING_MAC,
  ...extra,
})
const winEnv = (config, extra = {}) => ({
  OPENCODE_CONFIG_DIR: config,
  PATH: `${FAKE_WINDOWS}${path.delimiter}${BIN}`,
  ...extra,
})
const runLinux = (args, input, extra = {}) => run(args, input, linuxEnv(CONFIG_KR, extra))
const runMac = (args, input, extra = {}) => run(args, input, macEnv(CONFIG_MAC, extra))
const runWin = (args, input, extra = {}) => run(args, input, winEnv(CONFIG_WIN, extra))

const evalRun = (command, extra) => spawnSync(BASH, ["-c", command, "bash", TOOL], {
  encoding: "utf8",
  env: { ...baseEnv, OPENCODE_CONFIG_DIR: CONFIG, ...extra },
  timeout: 20_000,
})

let checks = 0
let failed = 0
const check = (name, cond, detail = "") => {
  checks++
  if (!cond) failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`)
}
const modeOf = (file) => (fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : -1)
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null)
const secretFile = (name) => path.join(SECRETS, name)
const keyringFile = (dir, name) => path.join(dir, "opencode-prerequisites", name)
const dpapiFile = (config, name) => path.join(config, "secrets", `${name}.dpapi`)
const backupFiles = (config) => (fs.existsSync(config) ? fs.readdirSync(config) : [])
  .filter((name) => /^secrets-backup-.*\.tar$/.test(name))
  .map((name) => path.join(config, name))

try {
  // --- help and usage (file backend forced: the host may have a real keyring) ---
  let r = runFile(["--help"])
  check("--help: exit 0 and lists the commands",
    r.status === 0 && /Usage: oc-secrets/.test(r.stdout) && /set <NAME>/.test(r.stdout)
    && /export/.test(r.stdout) && /not encrypted at rest/i.test(r.stdout), r.stderr)

  r = runFile([])
  check("missing command: exit 2 and usage", r.status === 2 && /missing command/.test(r.stderr), r.stderr)

  r = runFile(["nope"])
  check("unknown command: exit 2", r.status === 2 && /unknown command/.test(r.stderr), r.stderr)

  // --- set from stdin, permissions ---
  r = runFile(["set", "CONTEXT7_API_KEY"], "ctx-secret-123\n")
  check("set: stores the value read from stdin",
    r.status === 0 && read(secretFile("CONTEXT7_API_KEY")) === "ctx-secret-123", r.stderr)
  check("set: secrets directory is mode 700", modeOf(SECRETS) === 0o700, String(modeOf(SECRETS)))
  check("set: secret file is mode 600", modeOf(secretFile("CONTEXT7_API_KEY")) === 0o600,
    String(modeOf(secretFile("CONTEXT7_API_KEY"))))
  check("set: warns that the file backend is not encrypted at rest",
    /not encrypted at rest/.test(r.stderr))

  r = runFile(["set", "ARGV_TEST", "value"])
  check("set: refuses a value on argv (stdin only)",
    r.status === 2 && !fs.existsSync(secretFile("ARGV_TEST")), r.stderr)

  // --- get / list / check ---
  r = runFile(["get", "CONTEXT7_API_KEY"])
  check("get: prints the value only",
    r.status === 0 && r.stdout === "ctx-secret-123\n" && r.stderr === "", r.stdout + r.stderr)

  r = runFile(["list"])
  check("list: prints the name only",
    r.status === 0 && r.stdout === "CONTEXT7_API_KEY\n", r.stdout + r.stderr)
  check("list: never prints the value",
    !r.stdout.includes("ctx-secret-123") && !r.stderr.includes("ctx-secret-123"), r.stdout + r.stderr)

  r = runFile(["check"])
  check("check: prints the name, never the value",
    r.status === 0 && r.stdout === "CONTEXT7_API_KEY\n"
    && !r.stdout.includes("ctx-secret-123") && !r.stderr.includes("ctx-secret-123"),
    r.stdout + r.stderr)

  // --- export, including shell quoting and eval round-trip ---
  r = runFile(["export"])
  check("export: emits a single-quoted export line",
    r.status === 0 && r.stdout === "export CONTEXT7_API_KEY='ctx-secret-123'\n", r.stdout + r.stderr)

  r = evalRun('eval "$("$1" export)"; printf "%s" "$CONTEXT7_API_KEY"', { OC_SECRETS_BACKEND: "file" })
  check("export: eval sets the environment variable",
    r.status === 0 && r.stdout === "ctx-secret-123", r.stdout + r.stderr)

  r = runFile(["set", "QUOTED"], "a'b c\n")
  check("set: accepts spaces and single quotes", r.status === 0, r.stderr)
  r = runFile(["export"])
  check("export: escapes single quotes",
    r.status === 0 && r.stdout.includes("export QUOTED='a'\\''b c'\n"), r.stdout + r.stderr)
  r = evalRun('eval "$("$1" export)"; printf "%s" "$QUOTED"', { OC_SECRETS_BACKEND: "file" })
  check("export: eval round-trips spaces and single quotes",
    r.status === 0 && r.stdout === "a'b c", r.stdout + r.stderr)

  // --- invalid names, missing secrets, empty value ---
  r = runFile(["set", "bad-name"], "x\n")
  check("set: refuses a name outside [A-Z0-9_]+",
    r.status === 2 && /invalid secret name/.test(r.stderr)
    && !fs.existsSync(secretFile("bad-name")), r.stderr)

  r = runFile(["set", "lowercase"], "x\n")
  check("set: refuses lowercase names",
    r.status === 2 && /invalid secret name/.test(r.stderr), r.stderr)

  r = runFile(["get", "MISSING"])
  check("get: missing secret exits 1",
    r.status === 1 && /no such secret/.test(r.stderr) && r.stdout === "", r.stderr)

  r = runFile(["rm", "MISSING"])
  check("rm: missing secret exits 1",
    r.status === 1 && /no such secret/.test(r.stderr), r.stderr)

  r = runFile(["set", "EMPTY"], "")
  check("set: refuses an empty value",
    r.status === 1 && /empty value/.test(r.stderr) && !fs.existsSync(secretFile("EMPTY")), r.stderr)

  // --- idempotent overwrite ---
  r = runFile(["set", "CONTEXT7_API_KEY"], "new-value\n")
  check("set: overwrites the same file atomically",
    r.status === 0 && read(secretFile("CONTEXT7_API_KEY")) === "new-value"
    && modeOf(secretFile("CONTEXT7_API_KEY")) === 0o600, r.stderr)
  r = runFile(["list"])
  check("list: still one entry per name after overwrite",
    r.status === 0 && r.stdout === "CONTEXT7_API_KEY\nQUOTED\n", r.stdout + r.stderr)

  // --- permission check ---
  fs.chmodSync(secretFile("CONTEXT7_API_KEY"), 0o644)
  r = runFile(["check"])
  check("check: warns on a 644 file, exits 1 and never prints the value",
    r.status === 1 && /mode 644/.test(r.stderr) && r.stdout.includes("CONTEXT7_API_KEY")
    && !r.stdout.includes("new-value") && !r.stderr.includes("new-value"), r.stdout + r.stderr)
  fs.chmodSync(secretFile("CONTEXT7_API_KEY"), 0o600)

  fs.chmodSync(SECRETS, 0o755)
  r = runFile(["check"])
  check("check: warns on a 755 directory and exits 1",
    r.status === 1 && /mode 755/.test(r.stderr), r.stdout + r.stderr)
  fs.chmodSync(SECRETS, 0o700)

  // --- rm ---
  r = runFile(["rm", "CONTEXT7_API_KEY"])
  check("rm: removes the file",
    r.status === 0 && !fs.existsSync(secretFile("CONTEXT7_API_KEY")) && /Removed/.test(r.stdout),
    r.stdout + r.stderr)
  r = runFile(["get", "CONTEXT7_API_KEY"])
  check("rm: get fails afterwards", r.status === 1 && /no such secret/.test(r.stderr), r.stderr)

  r = runFile(["rm", "QUOTED"])
  check("rm: removes the second secret", r.status === 0, r.stderr)
  r = runFile(["list"])
  check("list: empty after removing every secret", r.status === 0 && r.stdout === "", r.stdout + r.stderr)

  // --- backend selection ---
  r = runFile(["backend"])
  check("backend: forced file reports the reason",
    r.status === 0 && /^Backend: file$/m.test(r.stdout)
    && /forced by OC_SECRETS_BACKEND=file/.test(r.stdout), r.stdout + r.stderr)

  r = run(["backend"], undefined, { OC_SECRETS_BACKEND: "auto", PATH: BIN })
  check("backend: auto falls back to file when secret-tool is absent",
    r.status === 0 && /^Backend: file$/m.test(r.stdout)
    && /secret-tool is not installed/.test(r.stdout), r.stdout + r.stderr)

  r = run(["backend"], undefined, {
    OC_SECRETS_BACKEND: "auto",
    PATH: `${FAKE_LINUX}${path.delimiter}${BIN}`,
  })
  check("backend: auto falls back to file without a session bus",
    r.status === 0 && /^Backend: file$/m.test(r.stdout)
    && /DBUS_SESSION_BUS_ADDRESS is not set/.test(r.stdout), r.stdout + r.stderr)

  r = run(["backend"], undefined, linuxEnv(CONFIG_KR))
  check("backend: auto selects the Linux keyring with secret-tool and a session bus",
    r.status === 0 && /^Backend: keyring$/m.test(r.stdout)
    && /secret-tool is installed and DBUS_SESSION_BUS_ADDRESS is set/.test(r.stdout),
    r.stdout + r.stderr)

  r = run(["backend"], undefined, { OC_SECRETS_BACKEND: "keyring", PATH: BIN })
  check("backend: forced keyring fails when secret-tool is absent",
    r.status === 1 && /^Backend: unavailable$/m.test(r.stdout)
    && /secret-tool is not installed/.test(r.stdout), r.stdout + r.stderr)

  r = run(["backend"], undefined, { OC_SECRETS_BACKEND: "bogus" })
  check("backend: invalid OC_SECRETS_BACKEND exits 2",
    r.status === 2 && /invalid OC_SECRETS_BACKEND/.test(r.stderr), r.stderr)

  r = run(["backend"], undefined, macEnv(CONFIG_MAC))
  check("backend: auto selects the macOS Keychain",
    r.status === 0 && /^Backend: keyring$/m.test(r.stdout)
    && /macOS Keychain/.test(r.stdout), r.stdout + r.stderr)

  r = run(["backend"], undefined, winEnv(CONFIG_WIN))
  check("backend: auto selects Windows DPAPI",
    r.status === 0 && /^Backend: keyring$/m.test(r.stdout)
    && /Windows DPAPI/.test(r.stdout), r.stdout + r.stderr)

  // --- Linux keyring round-trip (fake secret-tool) ---
  r = runLinux(["set", "LINUX_TOKEN"], "linux-secret\n")
  check("keyring (linux): set stores in secret-tool, not in a file",
    r.status === 0 && read(keyringFile(KEYRING_LINUX, "LINUX_TOKEN")) === "linux-secret"
    && !fs.existsSync(path.join(CONFIG_KR, "secrets", "LINUX_TOKEN")), r.stdout + r.stderr)

  r = runLinux(["get", "LINUX_TOKEN"])
  check("keyring (linux): get prints the value",
    r.status === 0 && r.stdout === "linux-secret\n" && r.stderr === "", r.stdout + r.stderr)

  r = runLinux(["list"])
  check("keyring (linux): list prints the name only",
    r.status === 0 && r.stdout === "LINUX_TOKEN\n"
    && !r.stdout.includes("linux-secret"), r.stdout + r.stderr)

  r = runLinux(["check"])
  check("keyring (linux): check prints the name only and exits 0",
    r.status === 0 && r.stdout === "LINUX_TOKEN\n"
    && !r.stdout.includes("linux-secret") && !r.stderr.includes("linux-secret"), r.stdout + r.stderr)

  r = runLinux(["export"])
  check("keyring (linux): export emits a single-quoted line",
    r.status === 0 && r.stdout === "export LINUX_TOKEN='linux-secret'\n", r.stdout + r.stderr)

  r = evalRun('eval "$("$1" export)"; printf "%s" "$LINUX_TOKEN"', linuxEnv(CONFIG_KR))
  check("keyring (linux): export eval round-trip",
    r.status === 0 && r.stdout === "linux-secret", r.stdout + r.stderr)

  r = runLinux(["set", "LINUX_TOKEN"], "linux-secret-2\n")
  check("keyring (linux): set overwrites the entry",
    r.status === 0 && read(keyringFile(KEYRING_LINUX, "LINUX_TOKEN")) === "linux-secret-2", r.stderr)

  r = runLinux(["set", "LINUX_QUOTED"], "a'b c\n")
  check("keyring (linux): accepts spaces and single quotes", r.status === 0, r.stderr)

  r = runLinux(["set", "LINUX_MULTI"], "line1\nline2\n")
  check("keyring (linux): accepts a multi-line value", r.status === 0, r.stderr)

  r = runLinux(["list"])
  check("keyring (linux): list is sorted and complete",
    r.status === 0 && r.stdout === "LINUX_MULTI\nLINUX_QUOTED\nLINUX_TOKEN\n", r.stdout + r.stderr)

  r = runLinux(["export"])
  check("keyring (linux): export escapes single quotes and preserves newlines",
    r.status === 0 && r.stdout.includes("export LINUX_QUOTED='a'\\''b c'\n")
    && r.stdout.includes("export LINUX_MULTI='line1\nline2'\n"), r.stdout + r.stderr)

  r = evalRun('eval "$("$1" export)"; printf "%s|%s" "$LINUX_QUOTED" "$LINUX_MULTI"', linuxEnv(CONFIG_KR))
  check("keyring (linux): eval round-trips quotes and newlines",
    r.status === 0 && r.stdout === "a'b c|line1\nline2", r.stdout + r.stderr)

  r = runLinux(["get", "LINUX_MULTI"])
  check("keyring (linux): get preserves the newline",
    r.status === 0 && r.stdout === "line1\nline2\n", r.stdout + r.stderr)

  r = runLinux(["set", "LINUX_EMPTY"], "")
  check("keyring (linux): refuses an empty value",
    r.status === 1 && /empty value/.test(r.stderr)
    && !fs.existsSync(keyringFile(KEYRING_LINUX, "LINUX_EMPTY")), r.stderr)

  r = runLinux(["set", "bad-name"], "x\n")
  check("keyring (linux): refuses an invalid name",
    r.status === 2 && /invalid secret name/.test(r.stderr)
    && !fs.existsSync(keyringFile(KEYRING_LINUX, "bad-name")), r.stderr)

  r = runLinux(["rm", "LINUX_TOKEN"])
  check("keyring (linux): rm removes the entry",
    r.status === 0 && !fs.existsSync(keyringFile(KEYRING_LINUX, "LINUX_TOKEN"))
    && /Removed/.test(r.stdout), r.stdout + r.stderr)
  r = runLinux(["get", "LINUX_TOKEN"])
  check("keyring (linux): get fails after rm",
    r.status === 1 && /no such secret/.test(r.stderr), r.stderr)

  r = runLinux(["rm", "LINUX_QUOTED"])
  check("keyring (linux): rm removes the quoted entry", r.status === 0, r.stderr)
  r = runLinux(["rm", "LINUX_MULTI"])
  check("keyring (linux): rm removes the multi-line entry", r.status === 0, r.stderr)
  r = runLinux(["list"])
  check("keyring (linux): list is empty after rm",
    r.status === 0 && r.stdout === "", r.stdout + r.stderr)

  r = runLinux(["set", "EXPLICIT_KR"], "explicit\n", { OC_SECRETS_BACKEND: "keyring" })
  check("keyring (linux): explicit OC_SECRETS_BACKEND=keyring works", r.status === 0, r.stderr)
  r = runLinux(["get", "EXPLICIT_KR"], undefined, { OC_SECRETS_BACKEND: "keyring" })
  check("keyring (linux): explicit backend get works",
    r.status === 0 && r.stdout === "explicit\n", r.stdout + r.stderr)
  r = runLinux(["rm", "EXPLICIT_KR"], undefined, { OC_SECRETS_BACKEND: "keyring" })
  check("keyring (linux): explicit backend rm works", r.status === 0, r.stderr)

  // --- macOS Keychain round-trip (fake security) ---
  r = runMac(["set", "MAC_TOKEN"], "mac-secret\n")
  check("keyring (macOS): set stores in security, not in a file",
    r.status === 0 && read(keyringFile(KEYRING_MAC, "MAC_TOKEN")) === "mac-secret"
    && !fs.existsSync(path.join(CONFIG_MAC, "secrets", "MAC_TOKEN")), r.stdout + r.stderr)

  r = runMac(["get", "MAC_TOKEN"])
  check("keyring (macOS): get prints the value",
    r.status === 0 && r.stdout === "mac-secret\n", r.stdout + r.stderr)

  r = runMac(["list"])
  check("keyring (macOS): list prints the name only",
    r.status === 0 && r.stdout === "MAC_TOKEN\n"
    && !r.stdout.includes("mac-secret"), r.stdout + r.stderr)

  r = runMac(["export"])
  check("keyring (macOS): export works",
    r.status === 0 && r.stdout === "export MAC_TOKEN='mac-secret'\n", r.stdout + r.stderr)

  r = runMac(["rm", "MAC_TOKEN"])
  check("keyring (macOS): rm removes the entry",
    r.status === 0 && !fs.existsSync(keyringFile(KEYRING_MAC, "MAC_TOKEN")), r.stdout + r.stderr)
  r = runMac(["get", "MAC_TOKEN"])
  check("keyring (macOS): get fails after rm",
    r.status === 1 && /no such secret/.test(r.stderr), r.stderr)

  // --- Windows DPAPI round-trip (fake powershell) ---
  r = runWin(["set", "WIN_TOKEN"], "win-secret\n")
  check("keyring (windows): set writes a .dpapi file, not a plain file",
    r.status === 0 && fs.existsSync(dpapiFile(CONFIG_WIN, "WIN_TOKEN"))
    && !fs.existsSync(path.join(CONFIG_WIN, "secrets", "WIN_TOKEN")), r.stdout + r.stderr)
  check("keyring (windows): the .dpapi file is mode 600",
    modeOf(dpapiFile(CONFIG_WIN, "WIN_TOKEN")) === 0o600,
    String(modeOf(dpapiFile(CONFIG_WIN, "WIN_TOKEN"))))

  r = runWin(["get", "WIN_TOKEN"])
  check("keyring (windows): get prints the value",
    r.status === 0 && r.stdout === "win-secret\n", r.stdout + r.stderr)

  r = runWin(["list"])
  check("keyring (windows): list prints the name only",
    r.status === 0 && r.stdout === "WIN_TOKEN\n"
    && !r.stdout.includes("win-secret"), r.stdout + r.stderr)

  r = runWin(["check"])
  check("keyring (windows): check prints the name only",
    r.status === 0 && r.stdout === "WIN_TOKEN\n"
    && !r.stdout.includes("win-secret"), r.stdout + r.stderr)

  r = runWin(["export"])
  check("keyring (windows): export works",
    r.status === 0 && r.stdout === "export WIN_TOKEN='win-secret'\n", r.stdout + r.stderr)

  r = runWin(["rm", "WIN_TOKEN"])
  check("keyring (windows): rm removes the .dpapi file",
    r.status === 0 && !fs.existsSync(dpapiFile(CONFIG_WIN, "WIN_TOKEN")), r.stdout + r.stderr)
  r = runWin(["get", "WIN_TOKEN"])
  check("keyring (windows): get fails after rm",
    r.status === 1 && /no such secret/.test(r.stderr), r.stderr)

  // --- auto fallback to the file backend ---
  r = run(["set", "FALLBACK_TOKEN"], "fallback\n", {
    OC_SECRETS_BACKEND: "auto",
    PATH: BIN,
    OPENCODE_CONFIG_DIR: CONFIG_FALLBACK,
  })
  check("auto fallback: set writes a mode 600 file when no keyring exists",
    r.status === 0
    && read(path.join(CONFIG_FALLBACK, "secrets", "FALLBACK_TOKEN")) === "fallback"
    && modeOf(path.join(CONFIG_FALLBACK, "secrets", "FALLBACK_TOKEN")) === 0o600, r.stderr)
  r = run(["get", "FALLBACK_TOKEN"], undefined, {
    OC_SECRETS_BACKEND: "auto",
    PATH: BIN,
    OPENCODE_CONFIG_DIR: CONFIG_FALLBACK,
  })
  check("auto fallback: get reads the file",
    r.status === 0 && r.stdout === "fallback\n", r.stdout + r.stderr)

  r = run(["set", "FALLBACK_NODBUS"], "no-bus\n", {
    OC_SECRETS_BACKEND: "auto",
    PATH: `${FAKE_LINUX}${path.delimiter}${BIN}`,
    OPENCODE_CONFIG_DIR: CONFIG_FALLBACK,
  })
  check("auto fallback: secret-tool without a session bus uses the file backend",
    r.status === 0
    && read(path.join(CONFIG_FALLBACK, "secrets", "FALLBACK_NODBUS")) === "no-bus", r.stderr)

  // --- migrate: file -> keyring, one by one, with a plaintext tar backup ---
  r = run(["set", "MIG_ONE"], "one\n", { OC_SECRETS_BACKEND: "file", OPENCODE_CONFIG_DIR: CONFIG_MIG })
  check("migrate setup: first file secret", r.status === 0, r.stderr)
  r = run(["set", "MIG_TWO"], "two'quote\n", { OC_SECRETS_BACKEND: "file", OPENCODE_CONFIG_DIR: CONFIG_MIG })
  check("migrate setup: second file secret", r.status === 0, r.stderr)

  r = runLinux(["migrate"], undefined, {
    OPENCODE_CONFIG_DIR: CONFIG_MIG,
    FAKE_KEYRING_DIR: KEYRING_MIG,
  })
  check("migrate: exits 0 and reports two migrated secrets",
    r.status === 0 && /Migrated 2 secret\(s\), 0 failed/.test(r.stdout), r.stdout + r.stderr)
  check("migrate: removes the migrated files",
    !fs.existsSync(path.join(CONFIG_MIG, "secrets", "MIG_ONE"))
    && !fs.existsSync(path.join(CONFIG_MIG, "secrets", "MIG_TWO")))
  check("migrate: values are readable from the keyring",
    read(keyringFile(KEYRING_MIG, "MIG_ONE")) === "one"
    && read(keyringFile(KEYRING_MIG, "MIG_TWO")) === "two'quote")

  const backups = backupFiles(CONFIG_MIG)
  check("migrate: writes one backup tar",
    backups.length === 1, JSON.stringify(backups))
  check("migrate: the backup is mode 600",
    backups.length === 1 && modeOf(backups[0]) === 0o600,
    backups.length === 1 ? String(modeOf(backups[0])) : "no backup")
  check("migrate: the backup contains the original names",
    backups.length === 1
    && fs.readFileSync(backups[0]).includes("MIG_ONE")
    && fs.readFileSync(backups[0]).includes("MIG_TWO"))

  r = runLinux(["get", "MIG_TWO"], undefined, {
    OPENCODE_CONFIG_DIR: CONFIG_MIG,
    FAKE_KEYRING_DIR: KEYRING_MIG,
  })
  check("migrate: get reads the migrated value through the keyring",
    r.status === 0 && r.stdout === "two'quote\n", r.stdout + r.stderr)

  r = runLinux(["list"], undefined, {
    OPENCODE_CONFIG_DIR: CONFIG_MIG,
    FAKE_KEYRING_DIR: KEYRING_MIG,
  })
  check("migrate: list shows the migrated names",
    r.status === 0 && r.stdout === "MIG_ONE\nMIG_TWO\n", r.stdout + r.stderr)

  r = runLinux(["export"], undefined, {
    OPENCODE_CONFIG_DIR: CONFIG_MIG,
    FAKE_KEYRING_DIR: KEYRING_MIG,
  })
  check("migrate: export quotes the migrated values",
    r.status === 0 && r.stdout.includes("export MIG_TWO='two'\\''quote'\n"), r.stdout + r.stderr)

  r = runLinux(["migrate"], undefined, {
    OPENCODE_CONFIG_DIR: CONFIG_MIG,
    FAKE_KEYRING_DIR: KEYRING_MIG,
  })
  check("migrate: a second run reports nothing to migrate",
    r.status === 0 && /Nothing to migrate/.test(r.stdout), r.stdout + r.stderr)

  // --- migrate failure: verification mismatch keeps the file ---
  r = run(["set", "MIG_FAIL"], "keep-me\n", { OC_SECRETS_BACKEND: "file", OPENCODE_CONFIG_DIR: CONFIG_MIG_FAIL })
  check("migrate failure setup: file secret", r.status === 0, r.stderr)

  r = runLinux(["migrate"], undefined, {
    OPENCODE_CONFIG_DIR: CONFIG_MIG_FAIL,
    FAKE_KEYRING_DIR: KEYRING_MIG_FAIL,
    FAKE_KEYRING_CORRUPT: "MIG_FAIL",
  })
  check("migrate failure: exits 1 and keeps the file",
    r.status === 1 && /failed to migrate MIG_FAIL/.test(r.stderr)
    && fs.existsSync(path.join(CONFIG_MIG_FAIL, "secrets", "MIG_FAIL")), r.stdout + r.stderr)
  check("migrate failure: still writes a backup",
    backupFiles(CONFIG_MIG_FAIL).length === 1)

  r = run(["migrate"], undefined, {
    OC_SECRETS_BACKEND: "file",
    OPENCODE_CONFIG_DIR: CONFIG_MIG_FAIL,
  })
  check("migrate: refuses the file backend",
    r.status === 1 && /migrate needs the keyring backend/.test(r.stderr), r.stderr)

  r = run(["migrate"], undefined, {
    OC_SECRETS_BACKEND: "auto",
    PATH: BIN,
    OPENCODE_CONFIG_DIR: CONFIG_MIG_FAIL,
  })
  check("migrate: refuses when auto falls back to file",
    r.status === 1 && /migrate needs the keyring backend/.test(r.stderr), r.stderr)

  r = runLinux(["migrate"], undefined, {
    OPENCODE_CONFIG_DIR: CONFIG_EMPTY,
    FAKE_KEYRING_DIR: path.join(TMP, "keyring-empty"),
  })
  check("migrate: nothing to migrate exits 0",
    r.status === 0 && /Nothing to migrate/.test(r.stdout), r.stdout + r.stderr)
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(failed ? `\n❌ ${failed} check(s) failed out of ${checks}` : `\n✅ secrets OK — ${checks} checks`)
process.exitCode = failed ? 1 : 0
