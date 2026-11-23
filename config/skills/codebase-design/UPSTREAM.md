# Origin

Vendored from **mattpocock/skills** — https://github.com/mattpocock/skills — at commit
`abeeaf95660ba9e8b7c753eb38f441ca707a8823` (MIT, © 2026 Matt Pocock).

- Upstream path: `skills/engineering/codebase-design/`.
- Vendored on: **2026-11-23**, from the clone at `/tmp/opencode/matt-skills`.
- License: **MIT** (`LICENSE`, kept verbatim, © 2026 Matt Pocock).
- Pack: `architecture` (opt-in, included in the full profile, absent from core/lite).

## Vendored files

- `SKILL.md` (6,446 bytes): deep-module vocabulary (module, interface, implementation,
  depth, seam, adapter, leverage, locality) and principles.
- `DEEPENING.md` (2,553 bytes): dependency categories (in-process,
  local-substitutable, ports & adapters, mock) and seam discipline.
- `DESIGN-IT-TWICE.md` (2,699 bytes): parallel subagent pattern to compare radically
  different interfaces for one module.
- `agents/openai.yaml` (102 bytes): Codex metadata, ignored by OpenCode, kept as-is.
- Added locally: `LICENSE`, this `UPSTREAM.md`.

## Local modifications

None: every upstream file is byte-identical. The text keeps the Claude Code wording
(`/codebase-design` slash reference, "sub-agent"); in OpenCode, load it with the
`skill` tool and delegate with `subagent`.

No script, binary or remote installer is vendored.

## Dependencies

- A subagent tool (OpenCode `subagent`) for `DESIGN-IT-TWICE.md`, which asks for 3+
  parallel subagents with fresh context windows and one design constraint each.
- Optionally the sibling `improve-codebase-architecture` skill (it calls this one for
  vocabulary) and `domain-modeling` (the project `GLOSSARY.md` names the domain).

## Risks

- **Cost**: the design-it-twice pattern multiplies the work by the number of subagents
  (3 or 4); use it on one module, not on a whole codebase.
- **Vocabulary discipline**: the skill deliberately forbids "component", "service",
  "API" and "boundary"; applying it to an existing glossary with other terms can
  create friction. That is the point, but it should be a decision, not an accident.
- **No measurement**: the deep/shallow assessment is a design judgement; the diagrams
  in the sibling architecture skill are illustrative.
- **`--with-matt` duplication**: `install.sh --with-matt` runs
  `npx skills add mattpocock/skills`, which installs same-named skills into the same
  OpenCode skills directory and can overwrite this vendored copy. Do not combine
  `--with-matt` with `--with architecture`.
