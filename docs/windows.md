# Windows (native, config-only)

The kit runs on native Windows in **config-only** mode: agents, skills, commands, plugins,
the OpenCode configuration, `.cmd` launchers and the PowerShell integration are installed;
tools and runtimes that only exist on Linux are not. The full toolchain (Trivy, Obscura,
Playwright Chromium, Semgrep, pentest binaries, MemPalace, Android/Podman) needs **WSL2**.

| | Native Windows (`install.ps1`) | WSL2 (`./install.sh`) |
|---|---|---|
| OpenCode config, agents, skills, commands, plugins | yes | yes |
| `.cmd` shims in `%USERPROFILE%\.local\bin` | yes | no (Linux launchers in `~/.local/bin`) |
| User `PATH` (`HKCU\Environment`, no admin) | yes | shell files in the distro |
| PowerShell profile block | yes | `~/.bashrc` / `~/.zshenv` |
| Trivy, Obscura, Semgrep, pentest tools, Playwright Chromium | no | yes |
| MemPalace venv and plugin | no | yes |
| Android module runtime (Podman, `/dev/kvm`, emulator) | no (files only with `-Android`) | yes |
| Terraform MCP | only with Docker Desktop or Podman | yes |

Use native Windows when you want the OpenCode configuration and the Node-based MCP servers on
Windows itself. Use WSL2 when you want the same environment as Linux, including the tools.

## Requirements

- Windows 10 / Windows 11 / Server 2019+.
- **PowerShell 5.1** (built in) or **PowerShell 7+** (`winget install Microsoft.PowerShell`).
  `install.ps1`, `uninstall.ps1`, `doctor.ps1` and `scripts/test-windows.ps1` require 5.1+.
- **Node.js 18+**, 26 recommended (the version used by CI, see `.nvmrc`):
  `winget install OpenJS.NodeJS.LTS`, or install Node 26 with `mise use -g node@26`.
- **Git for Windows**, with the *"Git from the command line and also from 3rd-party software"*
  option (this provides `bash.exe` and `cygpath`). The kit needs **Git Bash (MSYS/Cygwin)**;
  a WSL `bash.exe` is detected and rejected on purpose.
- **OpenCode**, pinned for reproducibility:

  ```powershell
  npm i -g opencode-ai@1.19.5
  opencode --version
  ```

  `1.19.5` was the latest published version when this page was written; check with
  `npm view opencode-ai version` before upgrading. `scoop install opencode`,
  `choco install opencode` and `mise use -g github:anomalyco/opencode` also work.

No administrator rights are needed: the installer writes only under `%USERPROFILE%` and
`HKCU\Environment`. It never edits the machine-wide `PATH`.

> Line endings: the Bash scripts must stay LF. If Git for Windows is configured with
> `core.autocrlf=true` (the default), clone with `git -c core.autocrlf=false clone ...` or run
> `git config --global core.autocrlf input` first. Otherwise `install.sh` fails in Git Bash with
> `$'\r': command not found`.

## Install

From a PowerShell prompt, in the repository checkout:

```powershell
# PowerShell 7
pwsh -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -NoTools

# Windows PowerShell 5.1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -NoTools
```

`-ExecutionPolicy Bypass` applies to this process only; it does not change the machine policy.

The installer:

1. runs `install.sh` through Git Bash with `--no-tools` (the configuration is copied to
   `%USERPROFILE%\.config\opencode`, with the usual `<config>.bak-<date>` backup);
2. creates a **`.cmd` shim** in `%USERPROFILE%\.local\bin` for every launcher found in
   `<config>\bin`, plus `oc-new-rust` and the Android launchers when present;
3. adds `%USERPROFILE%\.local\bin` to the **user `PATH`** (`HKCU\Environment`, `ExpandString`,
   no admin). Existing terminals do not see it: open a new one;
4. rewrites `opencode.jsonc` to Windows-native paths (see below), with a timestamped backup;
5. writes an idempotent block in the **PowerShell profile** (`$PROFILE.CurrentUserAllHosts`);
6. disables the MCP servers whose native prerequisites are missing (see below).

## Options

All options are forwarded to `install.sh`, except `-DryRun`, `-RepairOnly` and `-ProfilePath`.

| Option | Effect |
|---|---|
| *(none)* | Full configuration (`install.sh` default profile), tools skipped with a WSL2 warning |
| `-NoTools` | Explicit config-only; this is the tested native path (implied on Windows anyway) |
| `-Lite` | Alias of `-Profile lite`: 12 agents, context7 + grep_app, no heavy tools |
| `-Profile core` | Core profile: 12 agents, 8 skills, 7 commands, 7 MCP servers |
| `-Profile core -With design` | Core plus the `design` pack (designer agent, `ui-ux-pro-max` and `impeccable` skills) |
| `-With devops,languages` | Add packs to the selected profile |
| `-Without design` | Remove packs (the `core` pack cannot be removed) |
| `-Full` | Ask for the full profile; tools are still skipped with a WSL2 warning |
| `-Android` | Copy the Android module files; Podman, `/dev/kvm` and the emulator still need WSL2 |
| `-Force` | Overwrite kit files you modified (`install.sh --force-config`) |
| `-DryRun` | Print the planned actions, write nothing |
| `-RepairOnly` | Do not run `install.sh`; only repair shims, `PATH`, profile and `opencode.jsonc` (used by `doctor.ps1 -Fix`) |
| `-ProfilePath <file>` | Override the PowerShell profile path (testing/advanced) |

`-Lite` with `-Profile`, `-Full` with `-Profile`, and `-Full` with `-Lite` are rejected.

Examples:

```powershell
.\install.ps1 -Lite
.\install.ps1 -Profile core -With design
.\install.ps1 -NoTools -DryRun
.\install.ps1 -NoTools -Android
```

## What the installer changes

### `.cmd` shims

Each shim calls Git Bash on the POSIX launcher, so the Bash launchers keep working unchanged:

```bat
@echo off
@rem opencode-prerequisites: generated Windows shim for oc-playwright-mcp (do not edit)
setlocal
if not defined OC_PLAYWRIGHT_BROWSER set "OC_PLAYWRIGHT_BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe"
"C:\Program Files\Git\bin\bash.exe" "C:\Users\me\.config\opencode\bin\oc-playwright-mcp" %*
exit /b %ERRORLEVEL%
```

- `oc-playwright-mcp` gets `OC_PLAYWRIGHT_BROWSER` when Chrome/Chromium is found.
- `oc-chrome-devtools-mcp` gets `OC_CHROME_PATH` instead.
- A variable already set in your environment is never overwritten.
- Shims carry the `@rem opencode-prerequisites` marker: `uninstall.ps1` uses it to identify the
  files it generated (the known launcher names are a fallback).

A launcher outside `<config>\bin` is not shimmed. Put a custom launcher there and rerun
`install.ps1 -RepairOnly` so it gets a `.cmd` wrapper too.

### `opencode.jsonc` rewrite

OpenCode starts local MCP servers without a shell, and a Bash script is not executable on
Windows. The installer therefore rewrites the launcher paths:

```jsonc
// before (Linux/macOS)
"command": ["{env:HOME}/.local/bin/oc-playwright-mcp"]

// after (native Windows)
"command": ["{env:USERPROFILE}/.local/bin/oc-playwright-mcp.cmd"]
```

Rules:

- `{env:HOME}/.local/bin/<launcher>` becomes `{env:USERPROFILE}/.local/bin/<launcher>.cmd` for
  every known launcher (prefix names such as `oc-playwright-mcp-extra` are not truncated);
- any remaining `{env:HOME}/.local/bin/` and `{env:HOME}/.config/opencode` are rewritten to
  `{env:USERPROFILE}` equivalents; custom `OPENCODE_CONFIG_DIR` / `OBSCURA_BIN_DIR` become
  absolute forward-slash paths;
- any other `{env:HOME}` becomes `{env:USERPROFILE}`;
- the rewrite is idempotent (a second run changes nothing) and leaves a
  `opencode.jsonc.bak-<yyyyMMdd-HHmmss>` backup.

`HOME` is often unset in PowerShell while Git Bash derives it from `USERPROFILE`. Using
`{env:USERPROFILE}` removes the ambiguity; `doctor.ps1` warns when `HOME` and `USERPROFILE`
differ.

### PowerShell profile block

The installer appends one block to `$PROFILE.CurrentUserAllHosts` (usually
`Documents\PowerShell\profile.ps1` with PowerShell 7, `Documents\WindowsPowerShell\profile.ps1`
with Windows PowerShell 5.1):

```powershell
# >>> opencode-prerequisites (windows) >>>
$env:OPENCODE_CONFIG_DIR = 'C:\Users\me\.config\opencode'
# <<< opencode-prerequisites (windows) <<<
```

When `%USERPROFILE%\.mempalace\venv\Scripts\python.exe` exists, it also sets
`$env:MEMPALACE_ADAPTER_PYTHON`. The block is replaced in place on every run (never duplicated);
`uninstall.ps1` removes it. The previous file is kept as
`<profile>.bak-opencode-prerequisites`.

`cmd.exe` sessions do not read the profile. They still get the user `PATH` from the registry;
the default configuration path works without `OPENCODE_CONFIG_DIR`. Set the variable manually
(or in the system environment) only if you use a custom config directory.

### MCP servers disabled on native Windows

`install.ps1` marks a server `"disabled": true` with a comment when its prerequisite is missing,
using `scripts/lib/mcp-state.mjs` (comments and formatting preserved):

| MCP server | Disabled when |
|---|---|
| `trivy` | no `trivy` command on `PATH` |
| `obscura` | no `obscura` command (no native Windows build: use WSL2) |
| `terraform` | neither `docker` nor `podman` is available (Docker Desktop or WSL2), or the devops pack is not selected (`install.sh`) |
| `kubernetes` | no kubectl context (`install.sh`, all platforms) |
| `rea` | Node version too old for REA (`install.sh`) |
| `semgrep` | neither `uvx` nor `pipx` (`install.sh --check-quick`) |
| `mobile` | Android module not installed or Podman missing (`install.sh`) |

`terraform` is re-enabled on the next `install.ps1` once Docker Desktop or Podman is detected.
`trivy` and `obscura` are only disabled by the Windows installer: after installing the binary,
remove their `"disabled"` line manually or run:

```powershell
node scripts\lib\mcp-state.mjs enable "$env:USERPROFILE\.config\opencode\opencode.jsonc" trivy
```

## Paths

| What | Default | Override |
|---|---|---|
| Configuration | `%USERPROFILE%\.config\opencode` | `OPENCODE_CONFIG_DIR` |
| Shims | `%USERPROFILE%\.local\bin` | `OBSCURA_BIN_DIR` |
| PowerShell profile | `$PROFILE.CurrentUserAllHosts` | `-ProfilePath` |
| User `PATH` | `HKCU\Environment` value `Path` | — |
| Kit backup (install) | `<config>.bak-<yyyyMMdd-HHmmss>` | — |
| Config rewrite backup | `opencode.jsonc.bak-<yyyyMMdd-HHmmss>` | — |
| Profile backup | `<profile>.bak-opencode-prerequisites` | — |
| Uninstall backup | `<config>.removed-<yyyyMMdd-HHmmss>` | — |

The kit keeps the Linux layout (`~/.config/opencode`) on purpose: OpenCode and Git Bash both
resolve `~` to `%USERPROFILE%`, so the same layout works in PowerShell, `cmd.exe` and Git Bash
(Git Bash shows it as `/c/Users/<you>/...`). A WSL2 distro has its own home directory and
therefore its own copy of the configuration.

## Verify

```powershell
# No network request: config, shims, PATH, profile, jsonc, browser, opencode
pwsh -NoProfile -File .\doctor.ps1 -Offline

# Full diagnostic through Git Bash (models, gh, MCP servers: network allowed)
pwsh -NoProfile -File .\doctor.ps1

# Repair shims, PATH, profile and the jsonc rewrite (does not install tools)
pwsh -NoProfile -File .\doctor.ps1 -Fix
```

`doctor.ps1` checks Git Bash, Node 18+, every `.cmd` shim and its marker, the `HKCU` `PATH`
entry, `HOME` vs `USERPROFILE`, the profile block markers, the absence of `{env:HOME}` and the
`.cmd` suffix in `opencode.jsonc`, Chrome/Chromium (including the Playwright cache),
`MEMPALACE_ADAPTER_PYTHON` and the `opencode` command. It exits `1` on errors; warnings (for
example "open a new terminal") do not fail the run.

OpenCode must be restarted after an installation or a repair: a running server does not re-read
its plugins or environment.

## Uninstall and backups

```powershell
.\uninstall.ps1 -DryRun   # show what would be removed
.\uninstall.ps1           # remove
```

The uninstaller runs `uninstall.sh` through Git Bash (restores the latest `<config>.bak-*`),
removes the generated `.cmd` shims (marker or known launcher name; unrelated `.cmd` files are
kept), removes the profile block and the `HKCU` `PATH` entry, and updates the current process
`PATH`. It prints the backups it keeps: `<config>.bak-*`, `<config>.removed-*`,
`opencode.jsonc.bak-*` and `<profile>.bak-opencode-prerequisites`. Nothing is deleted outside
`%USERPROFILE%` and `HKCU\Environment`.

## What still needs WSL2

Install WSL2 (`wsl --install`, then a Debian/Ubuntu distro) and run the normal Bash installer
inside it when you need:

- the **full toolchain**: Trivy, Obscura, Semgrep, the pentest binaries, Playwright's Chromium
  download and MemPalace (venv + plugin);
- the **Android module runtime**: Podman, `/dev/kvm` and the emulator (`oc-android`,
  `oc-mobile-mcp`, `mobile` MCP). `install.ps1 -Android` copies the files only;
- the **Terraform MCP** without Docker Desktop or Podman;
- a Linux-like shell for scripts that assume `/bin/bash`, `apt`/`pacman`, etc.

Inside WSL2, use `./install.sh` and `./doctor.sh` as on Linux; do not run the PowerShell
installer there. The WSL2 distro has its own home directory: a native Windows install and a
WSL2 install are independent, so pick one side per OpenCode instance.

Native Windows still runs the Node-based MCP servers (context7, grep_app, Playwright through
`npx`, chrome-devtools) and the notification plugin, which uses a Windows toast through
`powershell.exe` and falls back to the terminal bell on locked-down hosts.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `... cannot be loaded because running scripts is disabled` | Run with `-ExecutionPolicy Bypass` (process scope), or `Unblock-File .\install.ps1` |
| `Git Bash not found` | Install Git for Windows; keep the "Git from the command line" option. A WSL `bash.exe` is not accepted |
| `install.sh failed with exit code 1` | Check line endings (`core.autocrlf=false`), then run `bash -n install.sh` in Git Bash |
| `$'\r': command not found` | The checkout has CRLF in the Bash scripts; re-clone with `core.autocrlf=false` |
| `Node.js not found` / `too old` | `node --version` must be 18+; open a new terminal after `winget`/`mise` |
| `opencode` not found | `npm i -g opencode-ai@1.19.5`; check `npm prefix -g` is on `PATH` (usually `%APPDATA%\npm`) |
| A shim does nothing or `oc-*` is not found | `%USERPROFILE%\.local\bin` is missing from `PATH`: open a new terminal, or run `.\doctor.ps1 -Fix` |
| MCP fails with `ENOENT` on a `.local/bin/...` path | `opencode.jsonc` still has a POSIX path: run `.\install.ps1 -RepairOnly` or `.\doctor.ps1 -Fix` |
| Playwright MCP cannot find a browser | Install Google Chrome (the shim sets `OC_PLAYWRIGHT_BROWSER`), or set `OC_PLAYWRIGHT_BROWSER` / `OC_CHROME_PATH` (chrome-devtools) manually |
| `doctor.ps1` warns "Current PowerShell PATH does not contain the bin directory" | Normal after an install: open a new terminal |
| Toast notifications never appear | Server Core or a locked-down host: the plugin falls back to the terminal bell |
| Profile changes ignored | The block is in `$PROFILE.CurrentUserAllHosts`; start a new PowerShell session or dot-source the profile |

## Tests and CI

- `scripts/test-windows.ps1 -HelpersOnly` parses the four PowerShell scripts and unit-tests the
  pure helpers (paths, shims, JSONC rewrite, profile block, `PATH`, argument building,
  `doctor.ps1` config validation). It runs on any OS with PowerShell 5.1+/7; 66 checks.
- Without `-HelpersOnly`, the same script runs the native path end to end in a temporary home:
  `install.ps1 -DryRun`, config-only install, shim/profile/`PATH` checks, `doctor.ps1 -Offline`
  and `uninstall.ps1`. It requires native Windows, Git Bash, Node and a writable
  `HKCU\Environment`.
- `.github/workflows/ci-windows.yml` runs the full suite on `windows-latest` (Node 26) and the
  helpers-only suite on `ubuntu-24.04` (PowerShell 7).

```powershell
pwsh -NoProfile -File .\scripts\test-windows.ps1 -HelpersOnly   # any OS
pwsh -NoProfile -File .\scripts\test-windows.ps1                # native Windows only
```

## Limitations

- Native Windows is **config-only**: no tool is downloaded or installed, by design.
- The installer does not use `sudo`/UAC and does not touch the machine `PATH`, services or
  scheduled tasks.
- `.cmd` shims depend on Git Bash staying installed at the path recorded at install time;
  reinstall after moving Git for Windows.
- The `opencode.jsonc` rewrite is textual: a custom MCP launcher not listed in `<config>\bin`
  is rewritten to `{env:USERPROFILE}` but gets no `.cmd` suffix.
- `cmd.exe` users get the `PATH` entry but not the PowerShell profile block.
- Windows Server Core, locked-down PowerShell policies and hosts without a browser may need
  manual adjustments (see Troubleshooting).
