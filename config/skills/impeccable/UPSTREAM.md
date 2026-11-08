# Origin

Vendored from **Impeccable** — https://github.com/pbakaus/impeccable — at commit
`924bbd194d02e5e15a227e75b5901fb0d7a4ecad` (2026-11-07, `release/skill-4.8.1`).

- Skill version: **4.8.1** (`SKILL.md` frontmatter).
- Engine version: **0.1.19** (`scripts/VERSION`, `scripts/engine-checksums.txt`).
- License: **Apache-2.0** (`LICENSE`) with the upstream **`NOTICE.md`** retained.
- Vendored on: **2026-11-08**, from a shallow clone (`git clone --depth 1`).

## Vendored files

The OpenCode variant of the skill, copied from `.opencode/skills/impeccable/`:

- `SKILL.md` (12 KB).
- `reference/*.md` — 45 files, including `reference/degraded/`.
- `scripts/impeccable` (POSIX `sh` launcher), `scripts/impeccable.cmd` (Windows),
  `scripts/VERSION`, `scripts/engine-checksums.txt`, `scripts/command-metadata.json`,
  `scripts/live-browser*.js`, `scripts/modern-screenshot.umd.js`.
- `scripts/data/font-index.json` (1.07 MB) and `scripts/data/font-index-failures.json`.

Added at the skill root: `LICENSE`, `NOTICE.md`, this `UPSTREAM.md`.
Total: 60 files, about 2.2 MB (2,226,692 bytes).

## Local modifications

- Rewrote the 80 hardcoded command paths `.opencode/skills/impeccable/scripts/impeccable`
  to `oc-impeccable` (the portable launcher in `config/bin/`) across `SKILL.md` and
  16 files under `reference/`.
- Rewrote the engine checksum path in `reference/hooks.md` to
  `~/.config/opencode/skills/impeccable/scripts/engine-checksums.txt`.
- Rewrote the Windows launcher path and the fallback `scripts` directory in
  `SKILL.md` to `~/.config/opencode/skills/impeccable/scripts/...`.
- Rewrote the `Setup` step 1 of `SKILL.md` to describe the `oc-impeccable` lookup order
  (`<config>/skills/impeccable`, then `$OPENCODE_CONFIG_DIR/skills/impeccable`, then
  `~/.config/opencode/skills/impeccable`).
- Removed the `Bash(npx impeccable *)` entry from `allowed-tools`; the kit never uses
  the unpinned npm CLI. Kept `Bash(oc-impeccable *)`.

No other content was changed. `NOTICE.md` is kept verbatim, including its upstream
`skill/reference/...` paths.

## Engine download and runtime requirements

- **No engine binary is vendored.** The first real command — including `oc-impeccable
  --help` — downloads the pinned `engine-v0.1.19` asset for the current platform
  (about **22 MB**) from
  `https://github.com/pbakaus/impeccable/releases/download/engine-v0.1.19/`
  into `~/.impeccable/bin/0.1.19/`, verifies its SHA-256 against
  `scripts/engine-checksums.txt`, then caches it. Later runs reuse the cache.
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
