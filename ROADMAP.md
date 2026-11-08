# Roadmap

Status as of 2026-11-08. No version tags: the kit is tracked by commit (`git log`).

## Shipped and verified

- Full installation, `--lite`, `--no-tools`, `--memory-only`, `--shell-env`, `--android`, `--pentest` (`install.sh`).
- 28 agents (30 with `--android`), 27 specialists (29 with `--android`), 11 MCP servers, 11 skills (12 with `--android`), 10 commands.
- UI/UX layer: `designer` agent, vendored `ui-ux-pro-max` (2.15.0, MIT) and `impeccable` (4.8.1, Apache-2.0) skills, `/impeccable` command, `chrome-devtools` MCP (1.12.0, `chrome-devtools_*` denied globally, allowed to `designer` and `frontend`); `--lite` drops the agent, both skills and the command.
- Project generators: `oc-new-rust` (`templates/rust-project/`) and `oc-new-android` (`templates/android-project/`, 46 checks, real `assembleDebug` build succeeded with an 11.5 MB APK).
- `oc-versions` (latest versions, 24 h cache) and `oc-deps check` (pin drift, **read-only**, 34 checks); four drifts found on 2026-11-04 (see "Open work").
- Diagnostics: `doctor.sh` and `doctor.sh --offline` (`OC_DOCTOR_OFFLINE=1`, no network requests) — `scripts/test-doctor.mjs` (15 checks).
- Validation: `scripts/validate-kit.mjs`, the official OpenCode JSON schema (`scripts/validate-schema.py`), `test-mcp-state` (25), `test-lite` (29), `test-doctor` (15), `test-deps` (34), `test-new-android` (46), `test-uiux` (36), `test-chrome-devtools` (14), and the Android `Containerfile` with hadolint `v2.15.1`.
- Linux CI (`.github/workflows/ci.yml`): validation, tests, ShellCheck, Rust template, dry-run installation (with `pipefail`) on Arch, Debian 12/13, Ubuntu 24.04/26.04, Fedora and Rocky 9; `test-new-android`, `test-deps` and `test-chrome-devtools` steps wired into `validate` and `distros`.
- macOS CI (`.github/workflows/ci-macos.yml`): `macos-latest`, `/bin/bash` 3.2 enforced, ShellCheck via Homebrew, validation and dry-run installations.
- Nightly CI (`.github/workflows/ci-nightly.yml`): cron `03:17`, real `--pentest` installation on Ubuntu 24.04, checks for the tools, MemPalace, `oc-semgrep-mcp --check` and `doctor.sh --offline`.
- Security: textual guard, pinned versions, sha256 of downloaded binaries.
- Modules: Android (Podman), pentest, reverse engineering (REA), memory (MemPalace).

## Open work

Indicative order, no date commitment.

1. **`oc-doctor --fix`** — `doctor.sh` remains a diagnostic: it reports problems but does not fix anything automatically.
2. **Pin GitHub Actions by SHA** — `actions/checkout@v7`, `actions/setup-node@v7`, `actions/cache@v6` and `dtolnay/rust-toolchain@stable` are referenced by tag, not by digest.
3. **`concurrency` on `ci.yml`** — `ci-macos.yml` and `ci-nightly.yml` already cancel outdated runs; Linux CI does not yet.
4. **Four version drifts** reported by `oc-deps check`: `kubernetes-mcp-server` 0.1.1 → 0.1.2, `pydantic` 2.11.10 → 2.14.2, `setuptools` 80.10.2 → 84.2.1, `@mobilenext/mobile-mcp` 1.0.15 → 1.0.16. Manual update after review (tests must pass again).
5. **Android module end to end** — start the emulator under Podman/KVM and validate the full path. The image was built locally and an `assembleDebug` build succeeded (11.5 MB APK); the rest is tested with a fake Podman (`scripts/test-android.mjs`), and CI cannot start an emulator. See "Android applications" in `README.md`.
6. **`--with-matt`** — Matt Pocock's full skills, untested. See "Installation".
7. **Non-blocking CEO delegation on a real OpenCode** — `background: true` is documented in OpenCode v2.2.5, but the kit has not been exercised with OpenCode in its development environment. See "How it works".
8. **MCP and configuration points to confirm** — arguments of the `terraform`/`kubernetes` MCPs, the ``!`cmd` `` syntax of `/usage`, the exact meaning of `compaction.buffer`. See "What is not verified".

## Out of scope

- Native Windows: WSL required (the scripts are Bash).
- Installing Ghidra, IDA or Hopper: REA uses those already present.
- OWASP ZAP bundled by default; offensive MCPs aggregated.
- ARM Android emulator: the image is x86_64.

## Proposing work

Open an issue or a PR (see `CONTRIBUTING.md`). An item only moves to "shipped" with a cited test or verification command.
