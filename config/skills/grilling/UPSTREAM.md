# Origin

Vendored from **mattpocock/skills** — https://github.com/mattpocock/skills — at commit
`abeeaf95660ba9e8b7c753eb38f441ca707a8823` (MIT, © 2026 Matt Pocock).

- Upstream path: `skills/productivity/grilling/`.
- Vendored on: **2026-11-23**, from the clone at `/tmp/opencode/matt-skills`.
- License: **MIT** (`LICENSE`, kept verbatim, © 2026 Matt Pocock).
- Pack: `architecture` (opt-in, included in the full profile, absent from core/lite).

## Vendored files

- `SKILL.md` (2,077 bytes): relentless one-round-at-a-time interview over a design
  tree; every question carries a recommended answer; facts are looked up, not asked.
- `agents/openai.yaml` (113 bytes): Codex metadata, ignored by OpenCode, kept as-is.
- Added locally: `LICENSE`, this `UPSTREAM.md`.

## Local modifications

None: every upstream file is byte-identical. The text keeps the Claude Code wording
("sub-agent", fresh context window); in OpenCode, delegate with `subagent`.

No script, binary or remote installer is vendored.

## Dependencies

- A subagent tool (OpenCode `subagent`) to find facts in the repository or the
  environment without asking the user.
- A user available to answer rounds. The skill is interactive by design: it waits for
  answers before the next round and does not act until the user confirms a shared
  understanding.

## Risks

- **Long interactive sessions**: the frontier can take many rounds on a large design;
  the skill is a poor fit for a headless run with no one to answer.
- **Question fatigue**: "relentlessly" is deliberate; the recommended answer on each
  question keeps the user able to accept quickly, but the round format costs tokens.
- **Fact-finding subagents**: each round can dispatch explorations; scope them to the
  open frontier question, not the whole codebase.
- **`--with-matt` duplication**: `install.sh --with-matt` runs
  `npx skills add mattpocock/skills`, which installs same-named skills into the same
  OpenCode skills directory and can overwrite this vendored copy. Do not combine
  `--with-matt` with `--with architecture`.
