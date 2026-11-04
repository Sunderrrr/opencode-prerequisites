# opencode-prerequisites

My starter kit for [OpenCode](https://opencode.ai) with the **OpenCode Go** subscription: a CEO that leads 26 specialist agents (27 in total; 29 with the Android module), skills, commands, MCPs, memory, multi-agent git safety and a Rust project template.

> ⚠️ Agents run in **unrestricted mode** (no permission prompts). Work in a clean, committed git repository. Only the blocks from `config/plugins/guard/` remain.

## Installation

```bash
git clone https://github.com/Sunderrrr/opencode-prerequisites.git
cd opencode-prerequisites
./install.sh              # full: config + Playwright, Obscura, Trivy, MemPalace
./install.sh --lite       # lightweight: 12 agents, context7 + grep_app MCPs, no heavy tools
./install.sh --no-tools   # config only: nothing is installed (no tools, no MemPalace)
./install.sh --with-matt  # + full Matt Pocock skills (untested)
./install.sh --android    # + Android module (optional, remembered): agents, mobile MCP, Podman toolchain
```

**Do not run `install.sh` with `sudo`**: everything would be installed in `/root`. The installer also refuses to run via sudo. It validates the kit before copying, backs up the existing setup to `~/.config/opencode.bak-<date>`, and writes no key.

`--no-tools` reinstalls no tool: remembered options are not replayed (`--no-tools --pentest` still works to force one), only the remembered Android module is copied (files only, no download). MCPs disabled for missing prerequisites (`kubernetes`, `rea`, `mobile`, `semgrep`) are re-enabled automatically on the next `./install.sh` once the prerequisite is back: `scripts/lib/mcp-state.mjs` removes the `"disabled"` line from the block, without `sed` and without losing comments. The `semgrep` MCP check depends on the mode: with `--no-tools`, `oc-semgrep-mcp --check-quick` only checks that `uvx`/`pipx` is present (no download); the real `--check`, reserved for a normal installation, may download ~50 MB into the `uv` cache on first launch.

Then: `opencode` → `/connect` → **OpenCode Go** → paste your key. In the OpenCode console: *Settings › Privacy › Regions › Global* (required for the DeepSeek models). Then:

```bash
./doctor.sh      # diagnostic: config, agents, MCPs, tools, models, real read by OpenCode
./uninstall.sh   # restores the last backup
```

`./doctor.sh --offline` (or `OC_DOCTOR_OFFLINE=1`) runs the same diagnostic with no network request at all (models, `gh` and MCP servers are not checked): useful in CI or without a connection.

Requirements: Node.js 18+ (CI runs on Node 26, see `.nvmrc`). Windows: use WSL (the scripts are Bash). MemPalace installs into its own venv (Python 3.10–3.13, or 3.12 downloaded via `uv` if your Python is too recent); then add `export MEMPALACE_ADAPTER_PYTHON="$HOME/.mempalace/venv/bin/python"` to your `~/.bashrc`. The plugin sets `MEMPALACE_ADAPTER_PYTHON` itself (template `libexec/mempalace-plugin.ts.tpl`): it depends neither on your shell nor on how OpenCode is started, which avoids `ModuleNotFoundError: No module named 'mempalace'` (the case where the plugin fell back to the system `python3`). The npm plugin `@rvboris/opencode-mempalace` does not install inside OpenCode (a `peerDependencies` conflict, ERESOLVE error): the installer installs it itself with `--legacy-peer-deps` in `~/.mempalace/plugin` and loads it as a local plugin (`plugins/mempalace/`). The Python managed by `uv` (when yours is too recent) is stored in `~/.mempalace/python`, together with the venv, out of reach of a `uv python prune`. The MemPalace palace creates itself on the first save, in `~/.config/mempalace` (the installer no longer runs `mempalace init` on a bogus folder); the `mempalace` command is linked in `~/.local/bin`, which the plugin uses as a fallback to find the right Python. **After a (re)installation, restart OpenCode, service included**: an already-running server re-reads neither the plugins nor the environment, and remembers the Python interpreter chosen on the first call; `./doctor.sh` flags an OpenCode started before the last installation. To rerun only this step: `./install.sh --memory-only`. `./install.sh --shell-env` writes a tagged block (`# >>> opencode-prerequisites >>>`) **at the very top of `~/.bashrc`** (before the `return` of non-interactive shells, otherwise a service never sees it) and in **`~/.zshenv`** for zsh (`~/.zshrc` is not read outside an interactive terminal). It adds `~/.local/bin` **at the end** of `PATH` (never at the front: at the front, it can make the `mise` shims loop) and defines `MEMPALACE_ADAPTER_PYTHON`. When rerun, it replaces its block without duplication; `./uninstall.sh` removes it and restores the file identically. A service started by systemd reads none of these files: that is why the MemPalace plugin sets its own Python.

## Supported distributions

Tested in CI (dry-run installation, validation, launchers) on **Arch Linux (Omarchy base)**, **Debian 12 and 13**, **Ubuntu 24.04 and 26.04**, **Fedora** and **Rocky Linux 9 (RHEL)**. **macOS** (Intel and ARM) is covered by a dedicated CI (`.github/workflows/ci-macos.yml`, `macos-latest`, system `/bin/bash` 3.2): validation, ShellCheck via Homebrew and dry-run installations. A nightly workflow (`.github/workflows/ci-nightly.yml`, cron `03:17`) performs a **real installation** with `--pentest` on Ubuntu 24.04 every night and checks the tools, MemPalace, `oc-semgrep-mcp --check` and `doctor.sh --offline`. The installer detects your distribution and gives you the matching package command when something is missing.

| | Arch / Omarchy | Debian / Ubuntu | Fedora / RHEL |
|---|---|---|---|
| Node.js | `pacman -S nodejs npm` (or `mise use -g node`, already present on Omarchy) | `apt install nodejs npm` | `dnf install nodejs npm` |
| Containers (terraform MCP) | `docker` (+ `systemctl enable --now docker`, `docker` group) or `podman` | `docker.io` or `podman` | `podman` (already there) or Docker CE |
| GitHub CLI | `github-cli` | `gh` | `gh` |
| Browser (playwright MCP) | System Chromium (Omarchy has one) | Chromium, or Playwright's own | Chromium, or Playwright's own |
| Python venv (MemPalace) | included; Python 3.14+ → `uv` | `python3-venv`; otherwise `uv` | included; otherwise `uv` |

Distribution-specific notes:
- **Omarchy / Arch**: Playwright does not officially support Arch. The `oc-playwright-mcp` launcher therefore uses the **system Chromium** (headless; `OC_PLAYWRIGHT_HEADED=1` to see the window) and the installer downloads nothing. `opencode` installed by `mise` is handled by `doctor.sh`.
- **Debian / Ubuntu**: without a system browser, Playwright downloads its own Chromium; if libraries are missing: `sudo npx playwright install-deps chromium`.
- **Fedora / RHEL**: Docker is not provided, `oc-terraform-mcp` chooses **Podman** automatically (and ignores a Docker whose daemon is stopped). The Obscura and Trivy binaries are generic Linux executables: `doctor.sh` checks that they start.
- The **kubernetes** MCP exits at startup if there is no `kubectl` context: the installer disables it (`"disabled": true`) in that case; remove the line when you have a cluster.
- The `oc-playwright-mcp` and `oc-terraform-mcp` launchers are installed in `~/.local/bin` (the folder must be in `PATH`).

## Choosing models

By default everything runs on `opencode-go/deepseek-v4.1-flash`. To change it, without editing a file:

```bash
oc-models list                          # each agent's model (◀ = own model)
oc-models set ceo deepseek-v4-pro       # one agent (the opencode-go/ prefix is optional)
oc-models set security opencode-go/glm-5.2
oc-models set default kimi-k2.7-code    # the model of every agent without its own model
oc-models set small glm-5.3-flash       # the small model (titles, summaries)
oc-models set all deepseek-v4.1-flash   # everything on a single model (removes per-agent models)
oc-models reset ceo                     # removes an agent's own model (reset all: everything)
oc-models available                     # list of OpenCode Go models (online)
```

Your choices are saved in `~/.config/opencode/oc-models.json` and **re-applied on every `./install.sh`**: a kit update does not overwrite them. Restart OpenCode after a change. If OpenCode still shows the old model, type `/models`: it may remember your last manual choice.

## Reverse engineering (REA)

**`reverse-engineer`** agent + **`rea`** MCP + **`reverse-engineer-anything`** skill, based on [REA (Reverse Engineer Anything)](https://github.com/morluto/rea) (MIT, npm package `rea-agents` pinned at 6.8.0). It analyzes native binaries (Ghidra, IDA, Hopper), JavaScript/Electron applications, .NET, Android APKs, firmware and network captures, separating observations, derivations, inferences and unknowns.

- **No agent of this kind existed** in the collections we looked at (VoltAgent: nothing on reverse engineering or malware). REA only provides a skill, used as-is in `config/skills/reverse-engineer-anything/` (MIT license kept, see `UPSTREAM.md`); the agent is the kit's own.
- **Legal scope**, taken from [REA's DISCLAIMER](https://github.com/morluto/rea/blob/main/DISCLAIMER.md) and written into the agent: your own software, CTFs, malware under defensive analysis, interoperability, authorized research. It **refuses** to bypass licenses, DRM or anti-cheat, to make cheats, to bypass the authentication of an unauthorized system, to copy protected code, or to create malware/exploits against third parties. Unknown samples are never executed on your machine.
- **Node required: ≥ 26.12.1** (or 24.22.1 / 22.23.4). If your version is older, the installer disables the MCP (`"disabled": true`) and the agent uses the `npx -y rea-agents@6.8.0 …` CLI; update Node (`mise use -g node@26.12.1`) then rerun `./install.sh --no-tools`. `oc-rea-mcp --check` tests your version.
- The MCP's ~229 tools are only visible to this agent (`rea_*` rule in `opencode.jsonc`), to avoid weighing down the other sessions. Ghidra, IDA and Hopper are not installed by the kit: REA uses the ones already present. Never use `rea setup`: the configuration is managed by the kit.

## Securing your apps (pentest agent, real tools installed on the machine)

**`pentest`** agent (in addition to `security`/`review`, which stay passive and make no changes). **Main goal: secure the apps you develop (vibecoding) before exposing them**, with the same command-line tools as AppSec professionals — not just MCPs: `./install.sh --pentest` really installs them on the machine (remembered option, like `--android`; `./install.sh --no-pentest` forgets the choice without removing binaries already installed):

- **`gitleaks`** ([gitleaks/gitleaks](https://github.com/gitleaks/gitleaks), MIT): secrets/keys left in code or git history — binary downloaded from the latest GitHub release and **verified by sha256** before installation (same rigor as Trivy).
- **`semgrep`** (SAST, [semgrep/semgrep](https://github.com/semgrep/semgrep)): installed as a CLI via `uv tool install semgrep` (no sudo). The **`semgrep`** MCP (official server, `uvx semgrep-mcp`) also remains available, reserved for the `pentest`/`security` agents (`semgrep_*` rule in `opencode.jsonc`, like `rea_*`/`mobile_*`). The `oc-semgrep-mcp` launcher pins `semgrep-mcp==0.9.0`, `pydantic==2.11.10` and `setuptools==80.10.2`, and enforces Python **3.10–3.13** (`uv` downloads one if your Python is outside that range); the first launch downloads the packages (~50 MB, plus ~30 MB of managed CPython if needed), later ones reuse the `uv` cache. `oc-semgrep-mcp --check` really tests the MCP handshake.
- **`nuclei`** ([ProjectDiscovery](https://github.com/projectdiscovery/nuclei), MIT): CVEs and known misconfigurations, via templates — same sha256 verification.
- **`httpx`** ([ProjectDiscovery](https://github.com/projectdiscovery/httpx), MIT): HTTP probe (status, title, tech, headers) over a list of URLs, before running `nuclei` on them.
- **`ffuf`** ([ffuf/ffuf](https://github.com/ffuf/ffuf), MIT): content discovery by brute force (directories, files, parameters, subdomains).
- **`osv-scanner`** ([google/osv-scanner](https://github.com/google/osv-scanner), Apache-2.0): vulnerable dependencies via the [OSV](https://osv.dev) database — complements `trivy`, does not replace it.
- **`testssl.sh`** ([testssl/testssl.sh](https://github.com/testssl/testssl.sh), GPLv2): TLS/SSL configuration (versions, ciphers, certificates).
- **`nikto`** ([sullo/nikto](https://github.com/sullo/nikto), GPLv2, requires `perl`): web server scanner (dangerous files, versions, known bad configs).
- **`nmap`** and **`sqlmap`**: common system packages (apt/dnf/pacman/brew) — the installer never runs `sudo` itself, it just tells you the command if either is missing.
- **OWASP ZAP** (optional): if you run it yourself (Docker/Podman) and expose an MCP like [`pierre3/dotnet-zap-mcp`](https://github.com/pierre3/dotnet-zap-mcp), the agent uses it. Not integrated by default (extra .NET dependency, for occasional use).

The first six are downloaded from the latest official GitHub release and verified by **sha256** before installation (`scripts/pentest-discover.mjs`, generic: version/URL/sha256 discovery reusable for other tools). A quirk found while building the kit: nuclei, httpx and ffuf name their macOS asset `macOS` (capital M), while gitleaks and osv-scanner use `darwin` — handled correctly by `install.sh`, a trap to avoid if you extend the list. testssl.sh and nikto have no binary release: `install_git_tool()` clones their latest tag then **checks that the resulting commit is the one GitHub announces for that tag** (`git ls-remote`) before making them usable.

**Non-negotiable scope** (as for `reverse-engineer`): static analysis (gitleaks, semgrep) is always allowed on your own project. Active tests (nuclei, nmap, sqlmap) require an explicit scope — your app in local/staging, a CTF/lab, or an engagement with a written scope. Without that, the agent refuses and limits itself to static analysis. No DoS, no mass attack, no brute force in production, no exploitation beyond a proof of concept, no supply-chain tampering.

**Alternatives considered and rejected**: MCP servers that bundle several offensive tools at once (the "pentestMCP" kind, > 20 raw tools including Nmap/Nuclei/ZAP/SQLMap) give the agent attack primitives too broad for fine-grained permission control; the MCP wrappers for Nmap (`mcp-server-nmap`, `nmap-mcp`, `nmap-mcp-http`…) are too young for a real gain over a CLI that is already simple to script. The kit prefers binaries installed directly, verified by sha256, that the agent runs itself in bash.

**What is tested**: `scripts/test-pentest.mjs` (CI, all distros) — version/sha256 discovery with fake GitHub releases, installation with fake `curl`/`sha256sum`/`unzip`/`tar`/`uv` (no real download), rejection of an invalid checksum, remembering the option, `--no-pentest`, `--lite`.

## Android applications (optional module, Podman)

**Install option**: `./install.sh --android` (disabled by default; the choice is remembered across updates, `./install.sh --no-android` removes the module). It adds the **`android`** (Kotlin, Jetpack Compose, Gradle) and **`mobile-tester`** (checks the app on the emulator, read-only) agents, the **`android-dev`** skill, the **`mobile`** MCP ([mobile-mcp](https://github.com/mobile-next/mobile-mcp) 1.0.15, Apache-2.0, ~10,000 stars: 34 tools to read the screen through the accessibility tree, tap, swipe, install, launch, read logs and crashes; telemetry off) and the **`oc-android`** command. Nothing is added to your CEO or to `AGENTS.md` without this option. Android applications are written in **Kotlin + Compose, not Rust**; AGP, Kotlin and Compose versions are checked against the docs by the agent.

**Everything runs in Podman (rootless), nothing is installed on your machine**: JDK 17, the Android SDK, Gradle and the emulator live in the `localhost/oc-android` image.

```bash
sudo pacman -S podman                       # (Debian/Ubuntu: apt install podman · Fedora: dnf install podman)
./install.sh --android
oc-android build-image --accept-licenses    # 10 to 20 min, several GB; YOU accept the Android SDK licenses
cd ~/Projects/monapp
oc-android gradle assembleDebug             # build / tests / lint in the container (Gradle cache kept)
oc-android emulator start --wait            # headless emulator (requires /dev/kvm)
oc-android gradle installDebug              # or: oc-android adb install -r app/build/outputs/apk/debug/app-debug.apk
oc-android adb logcat -d -s AndroidRuntime:E
oc-android emulator stop
oc-android doctor                           # rootless Podman, image, KVM, emulator
```

How it is built: the image starts from Ubuntu 24.04, downloads the Android tools and Gradle **from the official sources (dl.google.com, services.gradle.org) with SHA-1/SHA-256 verification**, and refuses to build without `--accept-licenses`. Your **project is mounted into the container** (the current directory: run the commands from the project root); the emulator sees it read-only for installing APKs. A fake `adb` placed in `~/.local/share/oc-android/sdk/platform-tools/` redirects calls to the container's emulator, which lets mobile-mcp work without an SDK on the machine. The `mobile_*` tools are only visible to `android` and `mobile-tester` (permission rule).

**Prerequisites and limits**: rootless Podman (ranges in `/etc/subuid` and `/etc/subgid`); on Linux, an accessible `/dev/kvm` (virtualization enabled in the BIOS, `kvm` group): without hardware acceleration the emulator is refused, not emulated in software; x86_64 system image (so no ARM); default image on **API 36**: use `compileSdk 36` and a Compose BOM ≤ 2026.06.01 (otherwise `checkDebugAarMetadata` fails), or rebuild with `oc-android build-image --accept-licenses --api 37` for a more recent BOM; for a physical phone or iOS, install `android-tools` or use macOS and set `ANDROID_HOME` so mobile-mcp uses that SDK. The `mobile` MCP is disabled automatically if the module or Podman is missing.

**What is tested**: `oc-android`'s commands, mounts and safeguards with a fake Podman, official version discovery and the fake `adb` (`scripts/test-android.mjs`, in CI), the `Containerfile` with hadolint `v2.15.1`. The `oc-new-android` generator is covered by `scripts/test-new-android.mjs` (46 checks: template, substitutions, git, refusal to overwrite); the image was built locally and a real `oc-android gradle assembleDebug` build produced an 11.5 MB APK. **Not tested in CI**: building the image and starting the emulator (GitHub runners have no KVM); the full emulator path remains to be validated locally, and on failure `oc-android doctor` and `oc-android emulator logs` tell you where to look.

**Alternatives considered**: AndroidBuildMCP (0 stars, 8 commits), rnett's `gradle-mcp` (JDK 21 + JBang for little gain), Appium/Maestro/Patrol (useful if you already use them).

## Profiles

| | Full | Light (`--lite`) |
|---|---|---|
| Agents | 27 (+2 with `--android`) | 12 (`ceo`, `architect`, `rust`, `backend`, `frontend`, `qa`, `security`, `debugger`, `researcher`, `review`, `verify-app`, `integrator`) |
| MCP | context7, grep_app, terraform, kubernetes, rea, trivy, semgrep, playwright, obscura, mobile (`--android`) | context7, grep_app |
| Memory | MemPalace (venv `~/.mempalace/venv`, ≈ 500 MB) | — |

The light profile is derived from the full one by `scripts/make-lite.mjs`: there are no two configs to maintain. It also removes `plugins/mempalace/` (otherwise OpenCode would load memory even though its config file is gone) and the `reverse-engineer-anything` / `android-dev` skills.

## Contents

- `config/opencode.jsonc`: single model `opencode-go/deepseek-v4.1-flash` for ALL agents (large quota; no agent has its own model, to change one: add `model: opencode-go/<id>` in its `agents/<name>.md` file), unrestricted permissions, auto-formatting, compaction.
- `config/AGENTS.md`: global rules (≈ 800 words, read on every session): CEO, Rust by default, "done = proven", multi-agent git, internet safety, quota.
- `config/agents/`: `ceo` (default), domain (`architect`, `backend`, `frontend`, `database`, `devops`, `security`, `pentest`, `qa`, `docs`, `debugger`, `researcher`, `web-researcher`, `reverse-engineer`), languages/tools (`rust`, `python`, `typescript`, `go`, `shell`, `docker`, `ansible`, `terraform`, `kubernetes`), control (`review`, `code-simplifier`, `verify-app`), git (`integrator`).
- `config/skills/`: `git-commit`, `project-onboarding`, `safe-refactor`, `grill-me`, `tdd`, `handoff`, `web-research`, `reverse-engineer-anything`.
- `config/commands/` (9): `/check`, `/plan-first`, `/simplify`, `/verify`, `/learn`, `/remember`, `/ship`, `/pr`, `/usage`.
- `config/plugins/`: `guard/` (textual safeguard: blocks reading secret files and common destructive commands; **it is not a barrier** and does not replace a security review) and `notify/` (notification when a session is waiting), in the **OpenCode plugin v2 format** (a folder, `export default Plugin.define({ id, setup })`); tested by `scripts/test-plugins.mjs`. Compaction at 90% is native: `compaction.buffer: "10%"`.
- `config/bin/oc-models`: per-agent model choice; `config/bin/agent-wt`: one git worktree per agent (`new`, `merge`, `remove`, `list`, `registry`, `integration`, `sync`). `agent-wt list --porcelain` gives the machine state (one line per worktree, 7 tab-separated fields); `agent-wt registry --out .worktrees/REGISTRY.md` maintains the CEO's persistent registry (table rewritten, existing `## History` section kept, legacy `## Historique` also preserved).
- MCP versions pinned, no implicit `@latest`: `@playwright/mcp@0.0.84`, `rea-agents@6.8.0`, `kubernetes-mcp-server@0.1.1`, `@mobilenext/mobile-mcp@1.0.15`, `semgrep-mcp==0.9.0`, image `terraform-mcp-server:1.4.1`.
- `config/bin/oc-versions <ecosystem> <package>`: the real latest version (24 h cache, `android` preset). `config/bin/oc-deps check` compares the kit's pins with those versions and **reports drift without changing anything** (`--json`, `--only`, `--offline`, `--dry-run`); `oc-deps fix` does not exist, updating is done by hand after review.
- `templates/rust-project/` + `oc-new-rust <name>`: Rust project with `AGENTS.md`, tests, GitHub Actions CI and `git init`.
- `templates/android-project/` + `oc-new-android <name>`: Android Kotlin + Jetpack Compose project (`com.example.<name>`, Gradle wrapper, `git init`), ready for `oc-android gradle assembleDebug` (`--android` module required).
- `scripts/validate-kit.mjs`: validation (used by the installer and CI); `.github/workflows/ci.yml`: validation, dry-run installation, ShellCheck, Rust template.

## How it works

**CEO.** It frames, breaks down, delegates with a complete brief (subagents have no history), then has the work validated by `verify-app` in a loop until **VALIDATED** (5 loops max). Subagents ask no questions: they go with their best assumption and note it in their report.

**The CEO stays reachable.** In OpenCode v2, the `subagent` tool is blocking by default: the CEO's turn only ends when all specialists return, and you cannot tell it anything in the meantime. The CEO therefore launches specialists with `background: true` (returns immediately, it is notified automatically at each completion): **its turn returns in under ~2 minutes**, and it answers your messages at any time, even while subagents are running, without interrupting the tasks in progress. It keeps a task registry (running / done / failed, `sessionID`) and only starts integration then `verify-app` when the whole graph has returned. A task announced as long (several hours) is split again into waves of a few minutes: the next one starts as soon as a slot frees up, with a checkpoint at each agent completion. Before delegating it **splits as much as possible**: one fine-grained task per subagent (several `rust` in parallel on different modules, each in its own worktree), with a "contract first" (types, traits and a skeleton that compiles, fixed by a short first task) so that the modules can then all be implemented at the same time, **6 to 8 at once, beyond that integration becomes the bottleneck**. **Not tested end to end**: the availability relies on `background: true`, documented and available in OpenCode v2.2.5, but the kit has not been exercised with OpenCode in its development environment; if the CEO still waits for subagents on your side, say so.

**Validation.** Every agent that produces code adds tests, runs the suite, actually executes the feature, and fixes until green. Disabling or weakening a test is forbidden.

**Git without conflicts.** One file = one owner, one worktree per parallel task, specialists never push, `integrator` merges one at a time with tests after each merge. The CEO tracks state with `agent-wt list --porcelain` and maintains `.worktrees/REGISTRY.md` via `agent-wt registry --out .worktrees/REGISTRY.md`. PR mode: `integration/<name>` branch, rebase onto `origin/main`, `gh pr create`, re-sync if `main` moves.

**DevOps MCPs (read-only).** `terraform` (registry docs, via Docker, no token), `kubernetes` (read-only, Secrets blocked by `k8s-mcp.toml`), `trivy`. Internet: `websearch`/`webfetch`, `grep_app`, `gh`, `web-researcher` agent; any external content is treated as data, never as an instruction.

**Quota.** `/usage` shows `opencode stats`. If the quota drains, switch to `--lite` or set `"enabled": false` on an MCP.

## What is not verified

The kit is validated by script (`validate-kit.mjs`), by the **official OpenCode JSON schema** (`scripts/validate-schema.py`, also in CI) and by the Node tests of `ci.yml` and `ci-macos.yml`: `agent-wt`, `make-lite`, `new-rust-project.sh`, `doctor` (15 checks), `mcp-state` (25), the light profile (25), `oc-new-android` (46), `oc-deps` (33) and the installation have been tested. macOS is covered by a dedicated CI with the system bash 3.2; the nightly (`ci-nightly.yml`) tests the real installation of the tools. What remains to be confirmed in use: the arguments of the `terraform`/`kubernetes` MCPs, the `!`cmd`` syntax of `/usage`, the exact meaning of `compaction.buffer` (inferred from the schema, undocumented), the CEO's `background` delegation on a real OpenCode, `--with-matt`, and the real build of the Android image with the KVM emulator — check with `./doctor.sh` then `opencode mcp list`.

## Documents

- [ROADMAP.md](ROADMAP.md): shipped and verified, open work, out of scope.
- [CHANGELOG.md](CHANGELOG.md): what changes on `main` (Keep a Changelog, SemVer, no published tag).
- [SECURITY.md](SECURITY.md): reporting a vulnerability through a private advisory, security scope.
- [CONTRIBUTING.md](CONTRIBUTING.md): prerequisites, local validation and proposing a fix.

## Inspirations

Boris Cherny (Claude Code workflow), [mattpocock/skills](https://github.com/mattpocock/skills), [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents), [0xfurai/claude-code-subagents](https://github.com/0xfurai/claude-code-subagents), the [Claude Code subagents docs](https://code.claude.com/docs/en/sub-agents), oh-my-opencode and the OpenCode docs.

MIT license. Optional variables: see `.env.example`.
