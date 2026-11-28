# Origin

Vendored from **Impeccable** — https://github.com/pbakaus/impeccable — at commit
`2fc5e1459efbbf06d92c7306517c286bf12490cf` (2026-11-26, tag `skill-v4.11.1`).

- Skill version: **4.11.1** (`SKILL.md` frontmatter).
- Engine version: **0.1.31** (`scripts/VERSION`, `scripts/engine-checksums.txt`),
  from commit `ce0733287403d77e1017612ec0bc9f5a9251b52a` (tag `engine-v0.1.31`).
- License: **Apache-2.0** (`LICENSE`) with the upstream **`NOTICE.md`** retained.
- Vendored on: **2026-11-28**, from a shallow clone (`git clone --depth 1`).

## Vendored files

The OpenCode variant of the skill, copied from `.opencode/skills/impeccable/`:

- `SKILL.md`.
- `reference/` — 50 files (45 upstream plus five additions in 4.11.1):
  `critique-rubric.md`, `foundations.md`, `new-work-comp.md`, `new-work-world.md`,
  and `degraded/motion-reviewer.md`.
- `scripts/impeccable` (POSIX `sh` launcher), `scripts/impeccable.cmd` (Windows),
  `scripts/VERSION`, `scripts/engine-checksums.txt`, `scripts/command-metadata.json`,
  `scripts/live-browser*.js`, `scripts/modern-screenshot.umd.js`.
- `scripts/data/font-index.json` (1.1 MB) and `scripts/data/font-index-failures.json`.

Added at the skill root: `LICENSE`, `NOTICE.md`, this `UPSTREAM.md`.
Total: 66 files, about 2.3 MB. Upstream tests and fixtures are not vendored
(`scripts/tests` is absent; the repository's test suite is not part of the skill).

## Local modifications

- Rewrote the 97 hardcoded command paths `.opencode/skills/impeccable/scripts/impeccable`
  (96 commands plus one `.cmd` reference) to `oc-impeccable` (the portable launcher in
  `config/bin/`) across `SKILL.md` and 22 files under `reference/`. The Windows
  `.cmd` reference in `Setup` now points at
  `~/.config/opencode/skills/impeccable/scripts/impeccable.cmd`.
- Rewrote the engine checksum path in `reference/hooks.md` to
  `~/.config/opencode/skills/impeccable/scripts/engine-checksums.txt`.
- Rewrote `Setup` step 1 of `SKILL.md` to describe the `oc-impeccable` lookup order
  (`<config>/skills/impeccable`, then `$OPENCODE_CONFIG_DIR/skills/impeccable`, then
  `~/.config/opencode/skills/impeccable`) and added the launcher note above it.
- Removed the `Bash(npx impeccable *)` entry from `allowed-tools`; the kit never uses
  the unpinned npm CLI. Kept `Bash(oc-impeccable *)`.

No other content was changed. `NOTICE.md` is kept verbatim. It gained the upstream
browser-extension font and consent notices in 4.11.1; those components are not
vendored, but the notice is retained as the license requires.

Two upstream Claude Code settings paths remain in `reference/hooks.md` as host-only
harness documentation (`.claude/settings.local.json`, `.claude/settings.json`): both
lines are explicitly labelled as upstream host paths, not OpenCode install paths.
Upstream's `npx impeccable install` / `npx impeccable update` guidance was neutralized:
`reference/hooks.md` and `reference/doctor.md` now say to update by reinstalling the
kit and to install the Hermes hook manually. Two incidental `npx` mentions were
reworded as well (`reference/foundations.md` scaffolding counter-example,
`reference/routing.md` no-network note), so no live file of this skill references an
npm or remote installer; only this provenance file mentions `npx`.

## Engine download and runtime requirements

- **No engine binary is vendored.** The first real command — including `oc-impeccable
  --help` — downloads the pinned `engine-v0.1.31` asset for the current platform
  (about **26 MB**) from
  `https://github.com/pbakaus/impeccable/releases/download/engine-v0.1.31/`
  into `~/.impeccable/bin/0.1.31/`, verifies its SHA-256 against
  `scripts/engine-checksums.txt`, then caches it. Later runs reuse the cache.
- Pinned assets and digests (from `scripts/engine-checksums.txt`):

  | Asset | SHA-256 |
  | --- | --- |
  | `impeccable-darwin-arm64` | `0d96cf802af6c52f3ed0925a409c7f4a1eda6a4c4b8274ff545b1d23e8dd6ae6` |
  | `impeccable-darwin-x64` | `af28d77242fc345f11ade5075c304beef2e938a3df70905a95f9864708ee0a2a` |
  | `impeccable-linux-x64` | `01c642862b0e505277bb8810b1a74aacc42b2b38eb24bc69bc0bcf324089be77` |
  | `impeccable-linux-arm64` | `fd488471ae6df728e260bb54c26d0f7fa9235765777f8ee2ff28e9d3dba0dc6b` |
  | `impeccable-windows-x64.exe` | `f6606bbf6bd8993e2b0dab98261c27659a865e7dcbc775986d40e8808527ff47` |

- The download needs `curl` or `wget` and write access to `~/.impeccable` (override
  with `IMPECCABLE_HOME`, or point `IMPECCABLE_BIN` at a preinstalled engine).
- **`live` and `generate` need a running dev server and a browser.** `live` only works
  on a local checkout; it does not inject into deployed production sites. `generate`
  drives the live browser helper as well.
- The engine runs unsandboxed with the agent's environment and network access (see
  upstream `reference/hooks.md`). Do not run it in a sandbox.
- Upstream's `npx impeccable install` / `npx impeccable update` instructions in
  `reference/hooks.md` and `reference/doctor.md` do not apply to this vendored copy:
  updates come from reinstalling this kit, which replaces the whole skill directory.
- Nothing was run and nothing was downloaded while vendoring: the engine and the
  upstream installer were not executed.
