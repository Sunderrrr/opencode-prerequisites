# Changelog

Format [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning [SemVer](https://semver.org/). No published tags: entries describe `main`.

## [Unreleased]

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

No tags. `git log --oneline` is authoritative; the README describes the functional state.
