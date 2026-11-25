# EGM (design and review)

The **Elephant-Goldfish Model** (EGM) is Google's open-source design-review workflow for
coding agents: an **elephant** holds the project context and drafts the specification, while
**goldfish** reviewers read the document and its selected sources with a fresh context and
challenge its assumptions. The human decides the trade-offs. Upstream:
[google/elephant-goldfish-model](https://github.com/google/elephant-goldfish-model)
(Apache-2.0, not an officially supported Google product).

The kit does not vendor EGM. It installs the upstream plugin in **Codex** and
**Antigravity**, then exposes it to the OpenCode CEO through the `oc-egm` launcher. The
reason is in [Limits](#limits): EGM's OpenCode adapter targets OpenCode **V1** only, while
the kit runs OpenCode **V2.4.1**.

## What is installed

| Host | Install | Components (EGM 0.1.1) |
|---|---|---|
| Codex CLI | `egm@egm` marketplace plugin | 8 skills; **no named personas** (general-purpose subagents read `agents/*.md`) |
| Antigravity CLI | `egm` plugin | 8 skills and the 10 named agents |

The skills are `egm-brainstorm`, `egm-draft`, `egm-review`, `egm-resolve`,
`egm-bootstrap`, `egm-lite`, `egm-drift-report` and `egm-review-loop`. The ten personas are
`egm-bootstrap-orchestrator`, `egm-codebase-details`, `egm-comprehension`, `egm-design`,
`egm-implementation-readiness`, `egm-inventive-catalyst`, `egm-structural`, `egm-style`,
`egm-synthesizer` and `egm-zoom-out`.

`oc-egm` exposes the seven workflow commands. `egm-review-loop` is not a command: it is the
configurable reviewer-set engine used inside `egm-review`; call the bridge directly with
“Use the `egm-review-loop` skill” if you need a custom group of reviewers.

## Workflow

```text
brainstorm ──► draft ──► review ──► resolve ──► implement
    │            │          │           │
concepts_     design_    stage        goldfish_
brief.md      draft.md   reports      review_report.md
```

1. **`brainstorm`** — explores the idea, challenges it with several reviewer lenses and
   writes `concepts_brief.md`. It requires a session that can create fresh subagents.
2. **`draft`** — turns the brief (or existing notes) into `design_draft.md`, section by
   section, pausing for approval.
3. **`review`** — runs the multi-stage Goldfish review (design, zoom-out, comprehension,
   critic, implementation readiness). It writes `zoom_out_report.md`,
   `comprehension_report.md`, `critic_report.md`, `intermediate_zoom_out_report.md`,
   `implementation_readiness_report.md` and a consolidated report. Human gates stay
   between stages.
4. **`resolve`** — classifies each finding (`PROPOSE FIX`, `CONTEST`, `ESCALATE`,
   `DECLINE`), applies the approved edits and writes `goldfish_review_report.md`.

The other commands are on-demand: **`bootstrap`** documents an existing codebase,
**`lite`** fast-tracks a small iteration, bug fix or refactor, and **`drift-report`**
compares checked-in documents with the current code.

## Review gates

EGM is wired into the CEO as gates: a document is reviewed **before** implementation at the
three moments below. The CEO (or the delegating agent) names the gate that applies, and says
why when one is skipped.

| Moment | Which skill | Exit criterion |
|---|---|---|
| **Project start**, after the `@architect` plan | `bootstrap` for an existing codebase; `brainstorm` → `draft` → `review` for a new project | Findings handled or explicitly waived before any implementation |
| **New brick**: module or component, public API, auth/keys/data, migration, more than 3 files, irreversible choice | `lite` (or `draft` + `review` for a large or risky brick) | One-page note in `.dev/docs/`; missing assumptions, failure modes and a simpler alternative addressed |
| **Milestone / sprint / step** | `review` on the plan, then `drift-report` (documented design vs code) | Gaps closed or accepted before the next step; outcome included in the report |

Rules:

- **Ask for a critique, not a validation.** The brief must request missing assumptions,
  failure modes and a simpler alternative. A report that only praises the design has not
  passed the gate.
- **Write the document first.** The gate reviews a file: the one-page note in `.dev/docs/`
  for a brick, the plan or the specification for a project start. `oc-egm` injects the
  artifact directory; approve specifications into `docs/designs/`.
- **Handle or waive every finding.** Fix the document or the design, or record an explicit
  waiver with its reason; `resolve` classifies each finding (`PROPOSE FIX`, `CONTEST`,
  `ESCALATE`, `DECLINE`). Silence is not a waiver.
- **No implementation before the gate reports.** An irreversible choice, a public API or a
  migration waits for the gate; do not start the code "while the review runs".
- **EGM reviews a document, not the program.** It does not run the code and does not replace
  tests, `@verify-app` or a security review of auth, personal data, secrets or network code.
- **No secrets in the document or the prompt**: the text leaves the machine for OpenAI
  (Codex) or Google (Antigravity).
- **Cost**: a full `review` spawns 8–15 reviewers; use `lite` for a small brick, and keep the
  full review for a project start, a migration or a significant design.

Examples:

```text
# Existing service, new public endpoint: document, then the light gate
@egm bootstrap src/                         # once, to map the existing code
@egm lite "POST /webhooks: idempotency, retries, signature"   # after the one-page note
@egm resolve                                # classify the findings, then implement

# New project: the full chain before the first line of code
@egm brainstorm "Local-first issue tracker"
@egm draft
@egm review

# Milestone end: plan review, then check the documents against the code
@egm review docs/designs/webhooks.md
@egm drift-report
```

A gate is **not** warranted for a typo, a comment or formatting change, a dependency bump
with no API change, a one-file local fix, a reversible change or a throwaway experiment. An
emergency hotfix goes out first; review the cause afterwards if it is structural. Skipping a
gate is a decision to state, not to hide.

## Installation

Install the whole plugin in the host that will run the review: copying `skills/` alone
breaks EGM, because the skills read `agents/` and `resources/` at run time.

### Codex CLI

```bash
codex plugin marketplace add google/elephant-goldfish-model
codex plugin add egm@egm
codex plugin list                 # egm@egm: installed, enabled
```

Start a new Codex session after installing. In Codex, select the `egm-*` skill from the
skill picker, or name it in a prompt (“Use the `egm-review` skill”).

### Antigravity CLI

```bash
agy plugin install https://github.com/google/elephant-goldfish-model
agy plugin list                   # - egm (enabled, 0.1.1): 8 skills, 10 agents
```

The Antigravity App and the VS Code extension share `~/.gemini/config/plugins/egm/`; the
standalone Antigravity IDE does not expose the fresh-context subagent tool and is **not
supported** for Goldfish reviews. In Antigravity the command form is prefixed, for example
`/egm:egm-review docs/designs/webhooks.md`.

### Verify from the kit

```bash
oc-egm check
# oc-egm: EGM plugin check
# ✅ codex: egm@egm OK
# ✅ antigravity: egm OK
```

`check` only proves that the plugins are installed. It does not run a review and does not
prove reviewer isolation. It reads the local `egm` marketplace only (`codex plugin list -m egm`),
so it does not wait on the remote catalog, and each probe is bounded by
`OC_EGM_PROBE_TIMEOUT` (seconds, default 15).

## `oc-egm`

```text
oc-egm [-C DIR] [--via codex|antigravity] [--artifact DIR] COMMAND [ARGS...]
oc-egm check
oc-egm -h
```

| Option | Default | Meaning |
|---|---|---|
| `-C, --cd DIR` | `$PWD` | Working directory passed to the bridge |
| `--via VIA` | `codex` | `codex` (`oc-codex -C DIR PROMPT`) or `antigravity` (`oc-antigravity --yes -C DIR PROMPT`) |
| `--artifact DIR` | `.dev/docs` | Absolute artifact directory injected into the prompt |
| `-h, --help` | | Usage |

The launcher builds one prompt and hands it to the bridge:

```text
Use the `egm-review` skill. EGM artifact directory: /abs/project/.dev/docs. docs/designs/webhooks.md. Return the reports' paths and a short summary.
```

`ARGS` are appended verbatim after the artifact sentence, so the document path, a folder or
a short brief are all valid. A relative `--artifact` is resolved against `-C`, and `.`/`..`
are normalised before the absolute path enters the prompt. The bridge output is returned
unchanged; with `--via antigravity`, `--yes` is required because EGM writes the reports.

Examples:

```bash
oc-egm review docs/designs/webhooks.md
oc-egm -C ~/src/app --artifact .dev/docs draft
oc-egm --via antigravity brainstorm "Add webhook delivery"
oc-egm bootstrap src/
oc-egm check
```

Exit codes: `0` success, `1` a plugin or the host CLI failed, `2` usage error, `127` the
CLI or bridge is missing. `oc-egm` loads `desktop-env.sh`, so it also works from a
GUI-launched OpenCode; the bridge is looked up on `PATH`, then next to `oc-egm`.

### Without the launcher

The same task can go through the general bridges:

```text
@codex Use the `egm-review` skill. EGM artifact directory: .dev/docs. docs/designs/webhooks.md. Return the reports' paths and a short summary.
@antigravity Use the `egm-review` skill. EGM artifact directory: .dev/docs. docs/designs/webhooks.md. Return the reports' paths and a short summary.
```

or in a terminal:

```bash
oc-codex -C . "Use the \`egm-review\` skill. Review docs/designs/webhooks.md."
oc-antigravity --yes -C . "Use the \`egm-review\` skill. Review docs/designs/webhooks.md."
```

## Artifacts

EGM writes briefs, drafts and reports to the working directory unless a line
`EGM artifact directory: <path>` is present in the prompt or in a loaded instructions file.
`oc-egm` injects it into every prompt; the default is `.dev/docs`. Set a project rule:

```markdown
EGM artifact directory: .dev/docs
```

in the project `AGENTS.md` (or `CLAUDE.md` for Claude Code). A relative path is resolved
against the working directory. If a path from an instructions file resolves outside the
working directory, EGM asks for confirmation; in a headless run it falls back to the working
directory.

Scratch drafts can stay in `.dev/docs` (add it to `.gitignore`); **approved** specifications
belong in `docs/designs/` and project rules in `AGENTS.md`, committed with the code. EGM
never moves an existing project file on its own.

## Limits

- **OpenCode adapter is V1-only.** Upstream's `adapters/opencode/install.py` declares
  `HOST_VERSION = "1.18.29"`, generates a V1 `agents`/`commands` bundle and refuses to
  overwrite an existing path. It does not target the V2 agent/plugin format used by the kit
  (OpenCode 2.4.1). Do not copy it into `~/.config/opencode`; use the Codex/Antigravity
  bridges.
- **Host instruction leaks (#237).** A fresh conversation context is not a fresh
  filesystem or memory. Codex CLI 0.166.0 was reported to inject project and user
  `AGENTS.md` despite `fork_turns: "none"`; the same issue reports project `AGENTS.md` and
  `GEMINI.md` in Antigravity reviewer context. Reviewer isolation evidence covers parent
  turns only. Treat instruction-file exclusion as **unverified**, and keep review criteria
  explicit so a leaked convention cannot silently pass as design context.
- **Isolation is not proven.** The read-only protocol comes from the persona plus the host's
  tool permissions, not from a sandbox. Codex has no named EGM personas: the skill spawns a
  general-purpose subagent and tells it to read `agents/<file>.md`. If a host cannot create
  fresh subagents, the review stops instead of simulating reviewers in the parent.
- **Cost.** A full review spawns **8–15 reviewers** and several stages, with several model
  calls each. Reserve it for a significant design, a risky migration or an architecture
  decision; use `lite` or a normal `@review` for a small change. `oc-egm` itself is free
  (a shell launcher), but each bridge call consumes the Codex or Antigravity quota.
- **Not a substitute for tests or security review.** EGM reviews a document. It does not
  run the code, prove a design correct, replace `@verify-app`, or replace a security review
  for auth, personal data, secrets or network changes.
- **No secrets in the document.** The prompt and the document leave the machine for OpenAI
  (Codex) or Google (Antigravity). Keep keys, tokens, passwords, `.env` values and personal
  data out of the document, the brief and `ARGS`.
- **Installation is not end-to-end proof.** `oc-egm check` verifies plugin presence only.
  Upstream reports installation and end-to-end fixtures for Codex and Antigravity, but
  reviewer isolation evidence is narrower; the kit did not run a full review (cost).

## Troubleshooting

- `oc-egm check` reports a missing plugin: rerun the host install command above, then
  `codex plugin list -m egm` / `agy plugin list`. Start a new Codex session after installing.
- `oc-egm check` reports a timeout: the CLI did not answer within `OC_EGM_PROBE_TIMEOUT`
  (default 15 s). Check the network, rerun the probe above, or raise the variable.
- `agy` is the CLI; `/usr/bin/antigravity` on Linux is the desktop app and hangs on CLI
  subcommands. `oc-antigravity` already refuses the desktop binary.
- “denied action” from `oc-antigravity`: add an allow-rule in the Antigravity
  `permissions.allow` settings or rerun with `--yes` (the launcher does this by default).
- A review stops with “cannot create fresh subagents”: the host session lacks the
  fresh-context delegation tool. Use Codex or Antigravity CLI, not the standalone
  Antigravity IDE.
- The plugin can write far more feedback than expected by design. Resolve only the findings
  that matter; `egm-resolve` records the decision for each one.

## Provenance

EGM is Apache-2.0, © Google LLC. The kit installs the upstream plugin and does not copy its
files; updates come from the host plugin manager. `oc-egm` is a small Bash launcher in
[`config/bin/oc-egm`](../config/bin/oc-egm); its tests are in
[`scripts/test-egm.mjs`](../scripts/test-egm.mjs).
