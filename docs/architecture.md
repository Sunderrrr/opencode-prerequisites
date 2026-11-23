# Architecture audit skills

The **`architecture`** pack vendors Matt Pocock's architecture-audit quartet: four skills
that map a codebase, name its architectural friction with a shared vocabulary, stress-test
the chosen direction with the user, and keep the project's domain model current. They are
vendored from [mattpocock/skills](https://github.com/mattpocock/skills) at commit
`abeeaf95660ba9e8b7c753eb38f441ca707a8823` (MIT, © 2026 Matt Pocock). Each skill carries
the upstream `LICENSE` verbatim and an `UPSTREAM.md` with its exact file list, local
modifications, dependencies and risks:

| Skill | Upstream path | Files |
|---|---|---|
| `improve-codebase-architecture` | `skills/engineering/improve-codebase-architecture/` | `SKILL.md`, `HTML-REPORT.md`, `agents/openai.yaml` |
| `codebase-design` | `skills/engineering/codebase-design/` | `SKILL.md`, `DEEPENING.md`, `DESIGN-IT-TWICE.md`, `agents/openai.yaml` |
| `grilling` | `skills/productivity/grilling/` | `SKILL.md`, `agents/openai.yaml` |
| `domain-modeling` | `skills/engineering/domain-modeling/` | `SKILL.md`, `GLOSSARY-FORMAT.md`, `ADR-FORMAT.md`, `agents/openai.yaml` |

`agents/openai.yaml` is Codex metadata; OpenCode ignores it. It is kept because it costs
nothing and the same directories can be used by Codex.

## What the quartet does

1. **`improve-codebase-architecture`** — scans a scoped area for **deepening
   opportunities**: refactors that turn shallow modules into deep ones, for testability and
   AI-navigability. It writes the candidates as a visual HTML report with a before/after
   diagram, a problem, a solution, the wins in glossary terms, and a recommendation
   strength (`Strong`, `Worth exploring`, `Speculative`). Once the user picks one, it hands
   over to the other three skills.
2. **`codebase-design`** — the shared vocabulary: **module**, **interface**,
   **implementation**, **depth**, **seam**, **adapter**, **leverage**, **locality**, plus
   the deletion test, "the interface is the test surface", "one adapter = hypothetical
   seam, two = real", and the design-it-twice parallel-subagent pattern.
3. **`grilling`** — a relentless interview over a design tree, one round of frontier
   questions at a time, each with a recommended answer. Facts are looked up by a subagent,
   never asked of the user; decisions stay with the user.
4. **`domain-modeling`** — builds and sharpens the project's domain model: challenge terms,
   invent edge-case scenarios, and write `GLOSSARY.md` and `docs/adr/NNNN-slug.md` when a
   decision crystallises. It creates the files lazily and only when there is something to
   write.

All four are model-invoked: the `disable-model-invocation: true` line was removed from
`improve-codebase-architecture`'s frontmatter so OpenCode can select it from its
description. The other three were already model-invocable. See
[`config/AGENTS.md`](../config/AGENTS.md) and [`config/agents/ceo.md`](../config/agents/ceo.md)
for the auto-use rule: scan the skill list, load a matching skill without waiting for the
user to name it, and name it in each specialist brief.

## Pack and command

```bash
./install.sh --with architecture   # from core: the 4 skills + /architecture
./install.sh                       # full profile: included
```

The pack is declared in [`profiles/packs.tsv`](../profiles/packs.tsv):

```
architecture	skill	improve-codebase-architecture
architecture	skill	codebase-design
architecture	skill	grilling
architecture	skill	domain-modeling
architecture	command	architecture
```

`--with architecture` adds the four skills and the command to `core`; the full profile
includes them; `core` and `lite` do not. The command
[`config/commands/architecture.md`](../config/commands/architecture.md) maps or audits the
area given in `$ARGUMENTS` (default: the repository and its recently changed hot spots),
loads `improve-codebase-architecture`, gives a fresh subagent the exploration brief, and
writes the report outside the repository. It does **not** implement the refactor.

## Report, network and CSP limits

- The report is a single self-contained HTML file written **outside the audited
  repository**: `${TMPDIR:-/tmp}/architecture-review-<timestamp>.html` (or `%TEMP%` on
  Windows). Every run gets a fresh file; the skill opens it with `xdg-open`/`open`/`start`
  and tells the user the absolute path.
- **Headless**: no browser, no `$DISPLAY`/`$WAYLAND_DISPLAY`, or a failing open command →
  print the absolute path and stop there. A missing browser never fails the audit.
- The page loads **Tailwind** from `https://cdn.tailwindcss.com` and **Mermaid 11** from
  `https://cdn.jsdelivr.net/npm/mermaid@11/` at **view time**. Nothing is downloaded while
  producing the report. Offline, or behind a CSP that forbids remote scripts, the report
  keeps its text but loses its styling and Mermaid diagrams. `cdn.tailwindcss.com` is the
  Tailwind browser build for prototypes, not a production dependency.
- Mermaid runs with `securityLevel: "loose"`, so diagram labels can contain HTML and click
  interactions. The report is built from local code and model output: do not audit an
  untrusted repository and then open the report in a privileged browser profile.
- **No scripts and no `curl`**: the skill contains no executable file and no network
  primitive. The model explores with its own tools and writes the HTML itself.
- The HTML report stays outside the repository, but the grilling loop can ask
  `domain-modeling` to write `GLOSSARY.md` and `docs/adr/` **inside** it. Review those
  changes like any other diff, on a branch.

## Duplication with `--with-matt`

`./install.sh --with-matt` runs `npx skills add mattpocock/skills`, which installs the
upstream collection into the same OpenCode skills directory with the same skill names. It
can overwrite the vendored copies, including the frontmatter edit that makes
`improve-codebase-architecture` model-invocable. **Do not combine `--with-matt` with
`--with architecture`**; choose one. The `architecture` pack is the pinned, reviewed copy.

## Limits and risks

- The before/after diagrams are illustrative, not a measured dependency graph. Verify the
  proposed module boundaries before acting on a candidate.
- The scan costs tokens: scope it to a named module or subsystem, and let the fresh
  subagent do the reading.
- `codebase-design`'s design-it-twice pattern spawns 3+ parallel subagents; use it on one
  candidate, not on the whole codebase.
- The vocabulary is deliberately strict: "component", "service", "API" and "boundary" are
  replaced by "module", "interface" and "seam". Expect a short adjustment in projects
  whose glossary uses the other terms.
- The skills keep Claude Code wording ("Skill tool", `/codebase-design`, "sub-agent"). In
  OpenCode, load with the `skill` tool and delegate with `subagent`.
- Tests and CI for this pack are wired: `scripts/test-architecture.mjs` (34 checks) verifies
  the pack rows, frontmatter, `LICENSE`/`UPSTREAM.md` provenance, the absence of executables
  and network primitives, `$ARGUMENTS` in the command and `make-lite` on
  `core,architecture`, and runs in the `validate` and `distros` CI jobs.
