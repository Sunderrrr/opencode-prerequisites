# Origin

Vendored from **mattpocock/skills** — https://github.com/mattpocock/skills — at commit
`abeeaf95660ba9e8b7c753eb38f441ca707a8823` (MIT, © 2026 Matt Pocock).

- Upstream path: `skills/engineering/domain-modeling/`.
- Vendored on: **2026-11-23**, from the clone at `/tmp/opencode/matt-skills`.
- License: **MIT** (`LICENSE`, kept verbatim, © 2026 Matt Pocock).
- Pack: `architecture` (opt-in, included in the full profile, absent from core/lite).

## Vendored files

- `SKILL.md` (3,346 bytes): challenge terms, invent edge-case scenarios, create or
  update the glossary and ADRs as decisions crystallise; single-context and
  multi-context (`GLOSSARY-MAP.md`) layouts.
- `GLOSSARY-FORMAT.md` (2,300 bytes): the `GLOSSARY.md` structure and entry format.
- `ADR-FORMAT.md` (2,733 bytes): `docs/adr/NNNN-slug.md`, minimal template.
- `agents/openai.yaml` (101 bytes): Codex metadata, ignored by OpenCode, kept as-is.
- Added locally: `LICENSE`, this `UPSTREAM.md`.

## Local modifications

None: every upstream file is byte-identical. No script, binary or remote installer is
vendored.

## Dependencies

- Write access to the audited repository: the skill creates or edits `GLOSSARY.md`,
  `GLOSSARY-MAP.md` and `docs/adr/` **in the repository** (by design).
- Optional: a subagent tool to explore code when checking how a term is actually used.

## Risks

- **Repository writes**: unlike the HTML report of `improve-codebase-architecture`
  (written to the temp directory), this skill edits tracked files. Use it on a branch,
  and review the glossary/ADR diff like any other change.
- **Model churn**: adding terms or ADRs mid-conversation can capture a decision that
  is still moving; the skill says to write the moment it crystallises, so confirm the
  decision before adding an ADR.
- **Layout assumption**: `docs/adr/` is the default path; a project using another ADR
  location (e.g. `.agents/adr/`, as upstream itself does) must pass it explicitly.
- **`--with-matt` duplication**: `install.sh --with-matt` runs
  `npx skills add mattpocock/skills`, which installs same-named skills into the same
  OpenCode skills directory and can overwrite this vendored copy. Do not combine
  `--with-matt` with `--with architecture`.
