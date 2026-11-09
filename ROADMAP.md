# Roadmap

Status as of 2026-11-09. Version 1.0.0 (`VERSION`); no git tag is published yet.

## Shipped and verified

- Full installation, `--lite`, `--no-tools`, `--memory-only`, `--shell-env`, `--android`, `--pentest` (`install.sh`).
- Packs and profiles: `profiles/packs.tsv` is the single source of truth; `--profile core|full|lite`, `--with`/`--without`, `--no-pack`, remembered choice in `<config>/.opencode-prerequisites.profile`; core and lite are derived by `scripts/make-lite.mjs`.
- 28 agents (30 with `--android`), 27 specialists (29 with `--android`), 11 MCP servers, 11 skills (12 with `--android`), 10 commands.
- UI/UX layer: `designer` agent, vendored `ui-ux-pro-max` (2.15.0, MIT) and `impeccable` (4.8.1, Apache-2.0) skills, `/impeccable` command, `chrome-devtools` MCP (1.12.0, `chrome-devtools_*` denied globally, allowed to `designer` and `frontend`); `--lite` drops the agent, both skills and the command.
- Project generators: `oc-new-rust` (`templates/rust-project/`), `oc-new-android` (`templates/android-project/`, 46 checks, real `assembleDebug` build succeeded with an 11.5 MB APK) and `oc-new-web` (`templates/web-project/`: Vite + React + TypeScript + Tailwind CSS v4, design tokens, light/dark theme, Playwright smoke tests, `scripts/test-new-web.mjs`).
- Operational tools: `oc-backup` (timestamped archive, sha256 sidecar, last 5 kept), `oc-restore`, `oc-usage` and `oc-deps check|update` (`scripts/test-ops.mjs`); `doctor.sh --fix` and `--fix --dry-run` re-enable MCPs and tighten permissions without editing shell files.
- Claude Code export: `oc-export-claude` (`config/bin/oc-export-claude`, `scripts/export-claude.mjs`) writes a deterministic, idempotent `.claude/` tree (agents, skills, commands, settings, guard and notification hooks) plus `.mcp.json` at the project root; haiku/sonnet/opus routing and fixed variants (`rust-haiku`, `review-opus`, `architect-opus`); `scripts/test-claude-export.mjs`, `docs/claude-code.md`.
- Native Windows (config-only): `install.ps1`, `uninstall.ps1`, `doctor.ps1`, `.cmd` shims, user `PATH` (`HKCU\Environment`), PowerShell profile and `opencode.jsonc` path rewrite; the full toolchain and Android/Podman stay on WSL2 (`scripts/test-windows.ps1`, 66 helper checks plus the end-to-end native path; `.github/workflows/ci-windows.yml`, `docs/windows.md`).
- `oc-versions` (latest versions, 24 h cache) and `oc-deps check` (pin drift, **read-only**, 34 checks); four drifts found on 2026-11-04 (see "Open work").
- Diagnostics: `doctor.sh` and `doctor.sh --offline` (`OC_DOCTOR_OFFLINE=1`, no network requests) — `scripts/test-doctor.mjs` (15 checks).
- Validation: `scripts/validate-kit.mjs`, the official OpenCode JSON schema (`scripts/validate-schema.py`), `test-mcp-state` (25), `test-lite` (29), `test-doctor` (15), `test-deps` (34), `test-new-android` (46), `test-uiux` (36), `test-chrome-devtools` (14), `test-ops` (47), `test-new-web` (116), `test-claude-export` (170), and the Android `Containerfile` with hadolint `v2.15.1`.
- Linux CI (`.github/workflows/ci.yml`): validation, tests, ShellCheck, Rust template, dry-run installation (with `pipefail`) on Arch, Debian 12/13, Ubuntu 24.04/26.04, Fedora and Rocky 9; `test-new-android`, `test-deps`, `test-chrome-devtools`, `test-ops`, `test-new-web` and `test-claude-export` wired into `validate` and `distros`. CI diet: pull requests run 3 distributions, pushes to `main` run all 7; `concurrency` cancels outdated runs.
- macOS CI (`.github/workflows/ci-macos.yml`): `macos-latest`, `/bin/bash` 3.2 enforced, ShellCheck via Homebrew, validation and dry-run installations.
- Windows CI (`.github/workflows/ci-windows.yml`): `windows-latest` runs validation, plugins and the full PowerShell suite; `ubuntu-24.04` runs the helpers-only suite with PowerShell 7.
- Nightly CI (`.github/workflows/ci-nightly.yml`): cron `03:17`, real `--pentest` installation on Ubuntu 24.04, checks for the tools, MemPalace, `oc-semgrep-mcp --check` and `doctor.sh --offline`.
- Supply chain and releases: textual guard, pinned versions, sha256 of downloaded binaries, Renovate custom managers (`.github/renovate.json`) for `install.sh` pins, launchers, `opencode.jsonc`, workflow actions/images and the Android `Containerfile`; `VERSION` 1.0.0 and `./install.sh --version`.
- Modules: Android (Podman), pentest, reverse engineering (REA), memory (MemPalace).

## Open work

Indicative order, no date commitment.

1. **Android module end to end** — start the emulator under Podman/KVM and validate the full path. The image was built locally and an `assembleDebug` build succeeded (11.5 MB APK); the rest is tested with a fake Podman (`scripts/test-android.mjs`), and CI cannot start an emulator. See "Android applications" in `README.md`.
2. **Evals** — no evaluation harness measures agent or skill output quality; the suite checks structure, behavior and non-regression only.
3. **Secrets and OS keyring** — keys stay in environment variables or OpenCode's secret manager; no integration with macOS Keychain, Windows Credential Manager or libsecret.
4. **Real Chrome session** — the `chrome-devtools` MCP is tested headless and isolated (fake `npx`/browsers); it has not been exercised against a real, logged-in Chrome profile.
5. **Tag 1.0.0** — `VERSION` is 1.0.0; create and push the git tag once the open items are settled.
6. **Pin GitHub Actions by SHA** — `actions/checkout@v7`, `actions/setup-node@v7`, `actions/cache@v6` and `dtolnay/rust-toolchain@stable` are referenced by tag, not by digest.
7. **Four version drifts** reported by `oc-deps check`: `kubernetes-mcp-server` 0.1.1 → 0.1.2, `pydantic` 2.11.10 → 2.14.2, `setuptools` 80.10.2 → 84.2.1, `@mobilenext/mobile-mcp` 1.0.15 → 1.0.16. Manual update after review (tests must pass again).
8. **`--with-matt`** — Matt Pocock's full skills, untested. See "Installation".
9. **Non-blocking CEO delegation on a real OpenCode** — `background: true` is documented in OpenCode v2.2.5, but the kit has not been exercised with OpenCode in its development environment. See "How it works".
10. **MCP and configuration points to confirm** — arguments of the `terraform`/`kubernetes` MCPs, the ``!`cmd` `` syntax of `/usage`, the exact meaning of `compaction.buffer`. See "What is not verified".

## Out of scope

- Native Windows full toolchain: WSL2 required (the Bash installer and Linux-only tools); native Windows is config-only.
- Installing Ghidra, IDA or Hopper: REA uses those already present.
- OWASP ZAP bundled by default; offensive MCPs aggregated.
- ARM Android emulator: the image is x86_64.

## Proposing work

Open an issue or a PR (see `CONTRIBUTING.md`). An item only moves to "shipped" with a cited test or verification command.
