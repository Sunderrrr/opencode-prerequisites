# Changelog

Format [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning [SemVer](https://semver.org/). Version 1.1.0 (`VERSION`); v1.0.0, v1.0.1 and v1.1.0 are tagged and signed. Entries describe `main`.

## [1.1.0] - 2026-11-25

### Added

- 2026-11-25: **Mistral Vibe bridge**: `oc-mistral` (`config/bin/`, copied by `install.sh`, removed by `uninstall.sh`) runs the official Mistral code CLI `vibe` (3.1.4+) in headless mode with `-C DIR`, `-m MODEL`, `--max-turns N` (default 40), `--yes` and `--json`. Without `--yes` the approval policy is `ask` (tools are refused in headless mode, by design); `--yes` selects `auto-approve` inside the workspace. The `@mistral` subagent and the `/mistral` command join the `external` pack; the bridge returns stdout verbatim, flags the exit code and tells the user to run `vibe --setup` or set `MISTRAL_API_KEY` when auth is missing, never a secret in the prompt. `mistral` is the separate Studio CLI (apps, deployment, evals, no chat), documented to avoid the confusion. `scripts/test-mistral.mjs` (22 checks, wired into the Linux and macOS CI jobs), a "Mistral (Vibe)" section in `docs/external-agents.md` and a Mistral Vibe entry in `config/AGENTS.md`; README/ROADMAP counts updated to 32 agents / 16 commands (34 with Android).
- 2026-11-24: **EGM (design/review) through the CLI bridges**: `oc-egm` (`config/bin/`, copied by `install.sh`, removed by `uninstall.sh`) runs the Elephant-Goldfish Model skills in Codex (`egm@egm`) or Antigravity (`egm`) because the upstream OpenCode adapter is V1-only: `brainstorm`, `draft`, `review`, `resolve`, `bootstrap`, `lite` and `drift-report`, with `-C DIR`, `--via codex|antigravity` and `--artifact DIR`; `oc-egm check` reports both plugins as ✅/❌. The prompt leaves the machine for OpenAI or Google (never a secret), and a full review starts 8-15 fresh-context reviewers: reserve it for a significant design. `scripts/test-egm.mjs` (26 checks, wired into the `validate` and macOS CI jobs), `docs/egm.md` and an "EGM (design/review)" section in `config/AGENTS.md`; review gates at project start, new brick and milestone (CEO, `config/AGENTS.md`, `docs/egm.md`), plus the `/egm` command and the `egm` bridge agent in the `external` pack.
- 2026-11-24: `oc-export-codex` and `oc-export-antigravity` (launchers in `config/bin/`, Node exporters in `scripts/`, copied by `install.sh` into `<config>/libexec/`): both read the same agents/skills/MCP sources, write a deterministic and idempotent export, merge MCP servers into an existing config (backup first) and preserve local edits as `<file>.new` unless `--force`. Codex writes `~/.codex/AGENTS.md`, 30 TOML agents with an exact model and reasoning effort per role (`gpt-6.2-astra`, `gpt-6.2-sol`, `gpt-6.1-terra`, `gpt-6-luna`), 18 skills under `~/.agents/skills`, `[mcp_servers.*]` and `fast`/`deep` profiles; Antigravity writes `~/.gemini/config/{AGENTS.md,agents,skills,mcp_config.json}` (or `<project>/.agents`), 30 Markdown agents limited to the `inherit`/`flash`/`pro` tier and `mcpServers`. Tests `scripts/test-codex-export.mjs` (119 checks) and `scripts/test-antigravity-export.mjs` (72 checks) run the real CLIs when present and skip those checks otherwise; docs in [docs/codex.md](docs/codex.md) and [docs/antigravity.md](docs/antigravity.md). README counts updated to 30 agents / 14 commands.
- 2026-11-24: **external agents** pack (`profiles/packs.tsv`): thin-bridge subagents `codex` and `antigravity` and the `/codex` / `/antigravity` commands drive Codex CLI 0.172.0 (ChatGPT auth) and Antigravity CLI 1.5.16 (Google auth) non-interactively. `oc-codex` defaults to `workspace-write` and prints the final message; `oc-antigravity` defaults to `accept-edits`/`10m`, changes directory itself (no `--cd`) and puts every flag before `-p`. The bridge returns stdout verbatim, flags stderr and the exit code, and forbids secrets in the prompt.
- 2026-11-24: `docs/external-agents.md` (prerequisites/auth, flags, pack, examples, outgoing-prompt and sandbox rules, desktop apps, troubleshooting: mise shim, removed `--full-auto`, Antigravity `-p`/no `--cd`, Wayland) and an "External agents" section in `config/AGENTS.md`; desktop apps ChatGPT 26.1120.41243 (`chatgpt.desktop`) and Antigravity 2.35.0 (`antigravity.desktop`) documented with manual login and manual updates.
- 2026-11-23: vendored Matt Pocock's **architecture-audit quartet** from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT, © 2026 Matt Pocock, commit `abeeaf95660ba9e8b7c753eb38f441ca707a8823`): `improve-codebase-architecture` (HTML report of deepening candidates), `codebase-design` (deep-module vocabulary), `grilling` (design-tree interview) and `domain-modeling` (glossary/ADR upkeep), 13 upstream files plus a `LICENSE` and an `UPSTREAM.md` per skill. `disable-model-invocation: true` was removed from `improve-codebase-architecture` so OpenCode can auto-invoke it; `agents/openai.yaml` is kept verbatim for Codex. New `architecture` pack (`profiles/packs.tsv`): `--with architecture` adds the four skills and the `/architecture` command to core, the full profile includes them. The report is written outside the repository (`${TMPDIR:-/tmp}/architecture-review-<timestamp>.html`) and loads Tailwind/Mermaid from CDNs at view time; headless runs print the path. `--with-matt` installs same-named upstream skills and can overwrite these copies: do not combine the two options. Documentation counts: 14→18 skills (15→19 with `--android`), 11→12 commands; details in [docs/architecture.md](docs/architecture.md). Tests: `scripts/test-architecture.mjs` (34 checks) wired into the `validate` and `distros` CI jobs.
- 2026-11-23: vendored **`security-audit`** skill from Cloudflare's [security-audit-skill](https://github.com/cloudflare/security-audit-skill) (MIT, © 2025-2026 Cloudflare, Inc., commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`): six-phase source-first security review with the upstream `report-schema.json` and validators kept byte-identical, 20 upstream files plus `LICENSE`, `UPSTREAM.md` and three `KIT-*.md` adaptations (about 315 KB). New `audit` pack (`profiles/packs.tsv`): `--with audit` on core adds the skill and the `/audit` command, the full profile includes them, core and lite leave them out. Guidance by default; the full run writes `findings.json`, `coverage-ledger.json`, `REPORT.md`, `FINDINGS-DETAIL.md` and `NEEDS-VALIDATION.md` outside the audited repository. Static mode only (the kit has no OS sandbox), CEO as parent, fresh `security` hunters and verifiers.
- 2026-11-23: vendored **`code-mode`** skill in the core pack (Cloudflare's pattern adapted to OpenCode and Claude Code: one script against the API or CLI behind an MCP server, only the useful result in context), with the kit's limits (no script sandbox, `oc-secrets` for credentials, input validation before a URL, a path or a shell) documented in `docs/code-mode.md`.
- 2026-11-23: `scripts/test-security-audit.mjs` (hermetic: pack rows, `name`/directory frontmatter, `LICENSE` and SHA in `UPSTREAM.md`, no network primitive in the vendored text, upstream `node --test` suites and both validators on nominal and invalid fixtures), wired into the `validate` and `distros` CI jobs. Documentation counts: 12→14 skills (13→15 with `--android`), 10→11 commands.
- 2026-11-12: vendored opt-in **`floci`** skill (floci-cli 0.4.0, MIT, commit `ae4bf9935280e98d713281666a8cf920db9e3ea8`): local AWS/GCP/Azure/OCI emulators driven by the `floci` CLI or Docker Compose, 16 upstream files plus `LICENSE` and `UPSTREAM.md`. New `floci` pack (`profiles/packs.tsv`): `--with floci` on core, included in full, absent from lite; no agent and no MCP. The kit vendors the skill only, removes `scripts/install-floci.sh`, never installs the CLI and never pipes a remote installer into a shell; `SKILL.md` and `references/ci.md` now use Homebrew or a sha256-verified pinned release, and `UPSTREAM.md` records the Docker socket mounts, `:latest` images and `~/.floci`/`~/.oci/config` writes with their mitigations. Core skills 11→12 (12→13 with `--android`); full install 11→12 skills.
- OpenCode Desktop on Linux (`.deb`, `.rpm`, AppImage): `./install.sh --desktop` writes the systemd user-session `PATH` (`~/.config/environment.d/90-opencode-prerequisites.conf`, mode 600, tagged block, plus `MEMPALACE_ADAPTER_PYTHON` when the venv exists) and a user `.desktop` override whose `Exec` starts with `env PATH="…"` (a pre-existing file is backed up). The kit launchers source `config/libexec/desktop-env.sh`, so they also work with a GUI-launched minimal `PATH`.
- `./doctor.sh --desktop`: checks the desktop app, the installed `desktop-env.sh`, the `environment.d` file (mode 600), the `.desktop` override (`Exec`, `TryExec`, `StartupWMClass`), `node`/`npx`/`bash` resolution and the Wayland hint; no network.
- `./uninstall.sh` removes the desktop wiring only when the kit marker is present (environment.d block stripped, file removed if nothing else remains; `.desktop` restored from the install-time backup), with timestamped backups; unrelated files are untouched.
- `scripts/test-desktop.mjs` (61 checks: `desktop-env.sh` PATH order/idempotence, every launcher, `install.sh --desktop` including AppImage and backups, uninstall, `doctor.sh --desktop`), wired into the `validate` and `distros` CI jobs; `docs/desktop.md`.

### Fixed

- 2026-11-25: `oc-egm check` no longer hangs: the Codex probe is scoped to `codex plugin list -m egm` (the unfiltered call waits on the remote marketplace catalog without a timeout) and both probes are bounded by `OC_EGM_PROBE_TIMEOUT` (default 15 s, through `timeout`/`gtimeout` when available), with a distinct timed-out message; `scripts/test-egm.mjs` grows to 26 checks.

## [1.0.1] - 2026-11-09

### Added

- `oc-secrets`: OS keyring backends (`OC_SECRETS_BACKEND=auto|file|keyring`: Linux Secret Service via `secret-tool`, macOS Keychain via `security`, Windows DPAPI via PowerShell) and the `backend` (active backend and why) and `migrate` (file to keyring, plaintext backup tar, read-back verification, file kept on mismatch) subcommands; `scripts/test-secrets.mjs` (96 checks), `docs/secrets.md`.
- Agent eval harness: `scripts/eval.mjs` + `evals/` with three tasks (`rust-cli`, `web-ui`, `bugfix`), one fixture per task, objective PASS/FAIL checks, JSON/Markdown results and `--dry-run`/`--json`/`--keep`; `scripts/test-eval.mjs` (63 hermetic checks), `docs/evals.md`; a real `rust-cli` run passed 5/5 checks on 2026-11-09 (39.6 s, 59,865 tokens).
- Android E2E validated locally on 2026-11-09: `scripts/e2e-android.sh` passed 11/11 steps in 112 s (KVM emulator, 11.5 MB debug APK installed and launched, no `AndroidRuntime:E`, 1080x2400 PNG screenshot); `.github/workflows/ci-android-e2e.yml` still needs a self-hosted KVM runner.
- Live Chrome DevTools MCP validated locally on 2026-11-09: `scripts/test-chrome-devtools-live.mjs` passed 17/17 checks against a real Chrome/Chromium binary (page, snapshot, PNG screenshot).

### Changed

- Pins refreshed after `oc-deps check`: trivy 0.76.2 (was 0.76.1), semgrep 1.184.0 (was 1.183.0), playwright 1.65.0 (was 1.64.1); README pin references corrected to mobile-mcp 1.0.16 and kubernetes-mcp-server 0.1.2.
- `versions.json` / intentional pins: `install.sh` writes `<config>/versions.json` (mode 600), so `oc-deps check` works outside the repository; pydantic and setuptools (constrained by `semgrep-mcp`) are reported as `intentional`, never drift; `oc-deps check` reports 17 packages, 15 up to date, 0 drift and 2 intentional pins.
- README, ROADMAP and CHANGELOG updated for 1.0.1 (keyring, evals, local validations, tag status).

### Fixed

- Documentation: stale `test-secrets` count (30 -> 96), mobile-mcp 1.0.15 -> 1.0.16 and kubernetes-mcp-server 0.1.1 -> 0.1.2; "What is not verified" now reflects the local Chrome/Android validations and the remaining KVM runner gap.

## [1.0.0] - 2026-11-09

### Added

- `oc-export-claude` (`config/bin/oc-export-claude`, `scripts/export-claude.mjs`): deterministic, idempotent Claude Code export of agents, skills, commands, MCP servers and the guard/notify hooks; haiku/sonnet/opus routing, fixed variants (`rust-haiku`, `review-opus`, `architect-opus`), project `.mcp.json` at the root; `scripts/test-claude-export.mjs` (170 checks), `docs/claude-code.md`.
- Native Windows support (config-only): `install.ps1`, `uninstall.ps1`, `doctor.ps1` and `scripts/test-windows.ps1` (66 helper checks plus the end-to-end native path), `.cmd` shims, user `PATH` (`HKCU\Environment`), PowerShell profile and `opencode.jsonc` path rewrite; `.github/workflows/ci-windows.yml` (`windows-latest` full suite, `ubuntu-24.04` helpers-only); `docs/windows.md`.
- Packs and profiles: `profiles/packs.tsv`, `--profile core|full|lite`, `--with`/`--without`, `--no-pack`, remembered profile; core and lite derived by `scripts/make-lite.mjs`.
- Operational tools: `oc-backup` (timestamped archive, sha256 sidecar, last 5 kept), `oc-restore`, `oc-usage`; `oc-deps update` (`--dry-run` by default, `--write --yes` with timestamped backups); `doctor.sh --fix` and `--fix --dry-run`.
- Web generator: `oc-new-web` and `templates/web-project/` (Vite, React, TypeScript, Tailwind CSS v4, design tokens, Playwright smoke tests); `scripts/test-new-web.mjs` (116 checks).
- Real Chrome session: `scripts/test-chrome-devtools-live.mjs` drives the pinned `chrome-devtools-mcp` against the Chrome/Chromium binary resolved by `oc-chrome-devtools-mcp` (JSON-RPC initialize, tools/list, page, snapshot, PNG screenshot); the hermetic `scripts/test-chrome-devtools.mjs` stays at 14 checks.
- Android E2E harness: `scripts/e2e-android.sh` (doctor, KVM emulator boot, project generation, `assembleDebug`, `installDebug`, launch, empty `AndroidRuntime:E` logcat, PNG screenshot), `.github/workflows/ci-android-e2e.yml` for a self-hosted `[self-hosted, linux, x64, kvm]` runner, `docs/android-e2e.md`.
- Installed pin record: `install.sh` writes `<config>/versions.json` (mode 600) so `oc-deps check` reads the `OC_*_VERSION` pins and launcher pins outside the repository; intentional pins (pydantic and setuptools for `semgrep-mcp`) are reported as `intentional`, never drift and never rewritten; `scripts/test-deps.mjs` (50 checks).
- `oc-secrets` (`config/bin/oc-secrets`): file-backed secrets (`set` from stdin, `get`, `list`, `rm`, `export`, `check`), mode 700/600, names `[A-Z0-9_]+`; `scripts/test-secrets.mjs` (30 checks), `docs/secrets.md`. The file backend is not encrypted at rest; OS keyring integration remains open.
- `VERSION` 1.0.0 and `./install.sh --version`.
- Renovate custom managers (`.github/renovate.json`) for `install.sh` pins, launchers, `opencode.jsonc`, workflow actions/images and the Android `Containerfile`.

### Changed

- CI diet: pull requests run 3 distributions (Arch, Debian 12, Rocky 9), pushes to `main` run all 7; `concurrency` cancels outdated runs; new steps for ops tools (`scripts/test-ops.mjs`, 47 checks), the web generator and the Claude Code export.
- README, ROADMAP and CHANGELOG document packs, operational tools, the web generator, `VERSION`, Renovate, Claude Code, native Windows, `oc-secrets`, the Chrome live test, the Android E2E harness and the installed pin record.

### Fixed

- Documentation: removed the stale "Windows requires WSL" claim (native config-only is supported; WSL2 is only needed for the full toolchain and Android/Podman); the version status now says `VERSION` 1.0.0.

### 2026-11-08

#### Added

- `designer` agent (art direction, design system, layout, typography, color, accessibility, responsive and interaction states), routed in the CEO and listed in `AGENTS.md`; `chrome-devtools_*` allowed to it and to `frontend`, denied globally. `scripts/test-uiux.mjs` covers the vendored skills and launchers.
- Vendored `ui-ux-pro-max` skill (2.15.0, MIT, launcher `oc-uiux-search`).
- Vendored `impeccable` skill (4.8.1, Apache-2.0, launcher `oc-impeccable`) and `/impeccable` command (`agent: designer`).
- `chrome-devtools` MCP (`chrome-devtools-mcp@1.12.0`, headless, isolated, telemetry off; launcher `oc-chrome-devtools-mcp`); `--lite` drops the `designer` agent, both skills and the `/impeccable` command.
- Documentation counts: 28 agents (30 with `--android`), 27 specialists (29 with `--android`), 11 skills (12 with `--android`), 10 commands, 11 MCP servers; test counts: `test-lite` 29, `test-deps` 34, `test-uiux` 36, `test-chrome-devtools` 14.

#### Fixed

- `--lite` now drops a command whose frontmatter `agent:` names a removed agent (`/impeccable` → `designer`), not only commands mentioning `@agent`; `scripts/test-lite.mjs` asserts that `commands/impeccable.md` is absent after `--lite`.

### 2026-11-04

#### Added

- `agent-wt`: `list --porcelain` (one line per worktree, 7 fields) and `registry --out` (persistent registry, `## History` section kept) — `6928178`.
- Global MemPalace rules and `/remember` command — `c67f788`.
- `oc-versions` (24 h cache) and sha256 verification of downloads — `d078b0b`.
- `oc-new-android` (`config/bin/oc-new-android`) and `templates/android-project/**`: Kotlin + Jetpack Compose project (`com.example.<name>`, Gradle 9.8.2 wrapper, `git init`); `scripts/test-new-android.mjs` (46 checks) and real `assembleDebug` build succeeded (11.5 MB APK).
- `oc-deps` (`config/bin/oc-deps`, `config/libexec/oc-deps.mjs`): `check` compares pinned versions with the latest versions and modifies no files; `scripts/test-deps.mjs` (33 checks).
- `doctor.sh --offline` (`OC_DOCTOR_OFFLINE=1`): diagnostics without network requests; `scripts/test-doctor.mjs` (15 checks).
- Tests `scripts/test-mcp-state.mjs` (25 checks) and `scripts/test-lite.mjs` (25 checks).
- macOS CI (`.github/workflows/ci-macos.yml`): `macos-latest`, `/bin/bash` 3.2 enforced, ShellCheck via Homebrew, validation and dry-run installations.
- Nightly CI (`.github/workflows/ci-nightly.yml`): cron `03:17`, real `--pentest` installation, checks for the tools, MemPalace, `oc-semgrep-mcp --check` and `doctor.sh --offline`.

#### Changed

- CEO: specialists launched with `background: true`, turn returns in under ~2 minutes, validation order code-simplifier → review+security → verify-app — `25d3588`, `753ebc5`.
- Transactional installation, permissions and migration of modified files (`--force-config`, `<file>.new`) — `e5e5b47`.
- CI: `test-new-android` and `test-deps` steps wired into `validate` and `distros`; `pipefail` on the dry-run installation; Android `Containerfile` checked with hadolint `v2.15.1`.
- Documentation: macOS and nightly CI described, `oc-deps check` and `/remember` documented.

#### Fixed

- Guard: additional patterns (secrets, destructive `rm`, forced git, download-and-execute) — `753ebc5`, `d078b0b`.
- MemPalace configuration repaired — `c67f788`.
- Documentation counts: 27 agents (29 with `--android`), 9 commands including `/remember`, 8 skills (9 with `--android`).

#### Security

- Pinned versions for Trivy, Obscura, uv, MemPalace, semgrep, Playwright and the skills; no more `latest` URLs.

### 2026-11-03

#### Fixed

- Reliable installation on Arch, Debian/Ubuntu and RHEL — `aec5b38`.
- Android module: `oc-android exec --` accepted; Compose/API constraint documented — `0c9dd34`.

## Earlier history

Tags: `v1.0.0`. `git log --oneline` is authoritative; the README describes the functional state.
