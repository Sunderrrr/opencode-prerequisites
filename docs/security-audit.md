# Security audit skill

The **`security-audit`** skill is the kit's source-first workflow for a code security review:
find a vulnerability that crosses a real trust boundary, then give the owner the source
evidence, a bounded reproduction, a priority and the smallest effective fix. It is vendored
from Cloudflare's [security-audit-skill](https://github.com/cloudflare/security-audit-skill)
(MIT, © 2025-2026 Cloudflare, Inc.) at commit
`c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`; the full text, companions and validators stay
byte-identical, and the provenance, file count and license are recorded in
[`UPSTREAM.md`](../config/skills/security-audit/UPSTREAM.md). The skill itself is
[`SKILL.md`](../config/skills/security-audit/SKILL.md).

## Two modes: guidance by default, full audit on request

Loading the skill does **not** start the complete workflow.

- **Guidance mode** — security questions, a focused review, triage, methodology, or one
  finding to investigate: read only the relevant parts. No output directory, no artefacts,
  no six-phase run. Focused agents may help, but they return to the current task.
- **Full audit mode** — only when the user explicitly asks to audit or pen-test a codebase,
  for a full/comprehensive/end-to-end review, or for report artefacts. All six phases run
  and the run writes `findings.json`, `coverage-ledger.json` and the reports.

When the request could mean either mode, the skill asks one focused question before creating
files.

## The six phases (full audit)

1. **Reconnaissance** — map the source, trust boundaries, build paths, companions, prior runs
   and the deterministic coverage ledger.
2. **Coverage-led hunting waves** — isolated hunters work one ledger unit each and return
   structured candidates.
3. **Candidate validation** — a fresh verifier tries to disprove every candidate; only a
   surviving, demonstrated boundary violation becomes `confirmed`.
4. **Structured output** — write `confirmed`, `needs_validation` and `rejected` records to
   `findings.json`, then validate both files with the vendored validators.
5. **Independent record verification** — another fresh agent re-checks the final source
   claims and reconciles corrections.
6. **Target-neutral report** — derive `REPORT.md`, `FINDINGS-DETAIL.md` and
   `NEEDS-VALIDATION.md` from the records, with no live-probe instructions.

A run ends in one of two states: all Phase 6 artefacts written and both validators passing,
or `run_status: "incomplete"` with the exact reason and the gap disclosed. Never in between.

## Artefacts

The parent (or the single dedicated writer) owns these files in the run directory:

| File | Role |
| --- | --- |
| `run-metadata.json` | run id, repository, source ref, profile, scope, budget, execution policy |
| `architecture.md` | reconnaissance output: surfaces, boundaries, call paths |
| `coverage-ledger.json` | one unit per surface × boundary × attack class, with status, owner, attempts and evidence; validated by `validate-coverage-ledger.cjs` |
| `findings.json` | the machine record (`confirmed` / `needs_validation` / `rejected`), governed by `report-schema.json` and validated by `validate-findings.cjs` |
| `REPORT.md` | short target-neutral report derived from the final records |
| `FINDINGS-DETAIL.md` | the confirmed findings with the four-field block (severity, where, scenario, fix) |
| `NEEDS-VALIDATION.md` | blocked hypotheses, each with the missing fact and a safe resolution plan |

Each hunter or verifier also gets its own `agents/<id>/` root with `scratch/` (the only
writable area) and parent-owned `artifacts/`. `report-schema.json` stays authoritative; the
kit adds no schema of its own.

## Output outside the repository

The default is `~/security-audit-skill/<repo-name>/run-<N>`, outside the audited tree. Logs,
scratch copies and promoted artefacts never land in the repository. An in-repo directory is
allowed only when the user explicitly chooses it **and** the whole directory is ignored by
version control; otherwise the run stops and asks.

## Platform limits

- **No OS sandbox.** OpenCode is not a sandbox, `permission.bash` is an allow/deny list and
  the guard plugin is textual. The upstream workflow requires an OS-enforced sandbox (no
  network, allowlisted environment, read-only target, resource limits) before running
  target-controlled code. The kit therefore runs **static mode only**: source reading,
  `grep`, `git log`, the validators and read-only scanners (`gitleaks`, `semgrep`,
  `osv-scanner`, `trivy fs`). If the user supplies and names a real sandbox, target builds
  and fixtures may run inside it; otherwise the missing control is recorded as
  `needs_validation` with a safe plan.
- **Subagent depth 1.** `experimental.subagent_depth: 1` means a hunter cannot delegate. The
  **CEO** is the parent: it picks the profile and budget, assigns units, authorizes verdict
  changes and never writes. A single dedicated writer session updates the shared files.
  Hunters, candidate verifiers and record verifiers are **fresh `security` subagents**, and
  the finder is never the verifier of its own finding.
- **Node 18+.** The two validators are dependency-free CommonJS scripts; the kit requires
  Node.js 18 or newer (CI uses Node 26).
- **POSIX tests.** The upstream `.test.cjs` suites use `mkfifo` and symlinks for the FIFO and
  no-follow cases. Those cases are skipped on Windows (`process.platform === "win32"`); the
  validators themselves reject FIFOs, symlinks and hard links on every platform.
- **Context cost.** The skill is about 315 KB / 20 upstream files plus the three `KIT-*.md`
  files. Load `SKILL.md` and only the companions the target needs.

## Install and command

The pack is `audit` and is opt-in for the reduced profiles:

```bash
./install.sh --with audit     # core (12 agents) + security-audit + /audit
./install.sh --profile core   # no audit pack: no security-audit skill, no /audit
./install.sh                  # full profile includes the audit pack
```

The `/audit` command runs a full audit of the target in `$ARGUMENTS`. It is available with the
`audit` pack (and in the full profile); core and lite do not install it. The command briefs
the CEO as orchestrator, requires fresh `security` hunters/verifiers, enforces the static-only
rule unless a sandbox is named, and finishes with the counts per verdict plus the paths of
`REPORT.md` and `findings.json`.

## Tooling and reporting

- [`KIT-TOOLING.md`](../config/skills/security-audit/KIT-TOOLING.md): installed scanners and
  exact commands, the `command -v` fallback and the "missing tool" line, the MCP inventory,
  and the traceability format.
- [`KIT-REPORTING.md`](../config/skills/security-audit/KIT-REPORTING.md): the four-field
  finding block, the verdict mapping and the rule that no huge log is pasted.
- [`KIT-ENVIRONMENT.md`](../config/skills/security-audit/KIT-ENVIRONMENT.md): the sandbox
  gap, the writer role, the CEO mapping and the OpenCode/Claude Code translation.

## Tests

`scripts/test-security-audit.mjs` is hermetic: pack rows, frontmatter, provenance license,
absence of network primitives, the upstream validator suites, and both validators on a
nominal fixture (exit 0) and an invalid one (exit 1). The FIFO tests skip on Windows.
`scripts/validate-kit.mjs` also requires a `LICENSE` beside every `UPSTREAM.md` and runs
`node --check` on every `.cjs` under `config/skills/`.
