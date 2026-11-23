# Kit environment for the security audit skill

How this skill runs inside **opencode-prerequisites**. Read it before a full audit: the
upstream text assumes a platform with a sandbox and a delegating parent; the kit provides
neither in the same shape, and the differences below are not optional.

## 1. No OS sandbox in the kit

The skill's *Universal execution safety* section requires an OS-enforced sandbox before any
target-controlled code runs: no network, an allowlisted empty environment, a read-only
target and toolchain, writes confined to `scratch/`, and explicit CPU/memory/process/
file-size/disk/wall-clock limits. **The kit provides none of this.** OpenCode is not a
sandbox; `permission.bash` is an allow/deny list, and the guard plugin is textual.

Consequence, in order:

1. **Static mode only** by default: source reading, `grep`, `git log`, the vendored
   validators, and read-only scanners (`semgrep`, `trivy fs`, `osv-scanner`,
   `gitleaks detect`) that read files without executing the target.
2. If the user **provides** a sandbox (a container with `--network none`, a VM, a disposable
   user with `ulimit`/cgroup limits), the audit may run target-controlled builds and tests
   inside it, and only there. The brief must name the sandbox command.
3. If neither holds, do not execute target code: record the missing control as a
   `needs_validation` blocker with a safe validation plan, exactly as the skill prescribes.

Never approximate the sandbox with `timeout`, `env -i`, `unshare` without network isolation,
or a "clean" shell: a missing control is a missing control.

## 2. `experimental.subagent_depth: 1`

`config/opencode.jsonc` sets `experimental: { subagent_depth: 1 }`. A subagent cannot spawn
another subagent. Every hunter, verifier and record verifier is therefore a **direct child of
the orchestrator**, and there are no grand-children to hide work in.

## 3. Who orchestrates, who hunts

`config/agents/security.md` and `config/agents/pentest.md` both declare `task: deny` and
`edit: deny`: they cannot delegate and cannot write. The orchestrator is the **CEO**
(`default_agent: ceo`), which has `task: { "*": allow }` and no `edit`/`bash`.

| Upstream role | In the kit |
| --- | --- |
| Parent (orchestrator, shared-state owner) | **CEO**: picks the profile and budget, assigns ledger units, decides promotions, never writes |
| `general` hunter | a **fresh `security` subagent** with one ledger unit, one unique `agents/<id>/` root, and a self-contained brief |
| `research` agent | `researcher` (read-only) for source mapping, or `explore` for fast file discovery |
| Candidate verifier | a **fresh `security` subagent** that did not hunt the unit, told to disprove the candidate |
| Record verifier (Phase 5) | another **fresh `security` subagent**, distinct from the hunter and from the first verifier |

**Never the same agent to find and verify.** A candidate found by one session is validated by
another, and a `confirmed` record is re-checked by a third. Reusing a session for two roles
breaks the independence the skill depends on: refuse and report it.

### Who writes the shared files

Upstream, the parent is the only writer of `run-metadata.json`, `architecture.md`,
`coverage-ledger.json`, `findings.json`, `REPORT.md`, `FINDINGS-DETAIL.md` and
`NEEDS-VALIDATION.md`, and promotion from `scratch/` to `artifacts/` is parent-side code.
The CEO cannot write, so the kit keeps the *invariant* (exactly one trusted writer) and moves
the *role*: the CEO briefs **one dedicated writer session** (a `shell` subagent, `edit` and
`bash` allowed) with the exact payload and paths, and that writer alone creates or updates
those seven files and runs the two `.cjs` validators. Hunters and verifiers never touch
them; each writes only under its own assigned `agents/<id>/scratch/`. The CEO remains the
only role that authorizes a promotion or a verdict change.

## 4. The guard is textual, not a barrier

`config/plugins/guard/` inspects the **command string** before a shell tool runs. It is a
guardrail against obvious mistakes (destructive `rm`, dangerous git, secret reads, download
pipes), not a sandbox: encoding, a wrapper script, a subshell or a constructed command can
bypass it, as its own header states. Never present it as a containment control, and never
let a hunter treat "the guard would have blocked it" as evidence about the target.

## 5. Secrets

- Never a credential in a brief, a hunter prompt, `run-metadata.json` or a finding.
- `oc-secrets set NAME` / `oc-secrets get NAME` (OS keyring or `$OPENCODE_CONFIG_DIR/secrets`,
  mode 700/600, **not encrypted at rest** in file mode) is the only way to pass a value to a
  scanner that needs one. `oc-secrets list` shows names only.
- `gitleaks detect --source . --no-banner` reports committed secrets; redact the value in the
  finding, keep the location.
- The audit's dummy principals, fixtures and tokens stay dummy.

## 6. Output outside the repository

Default output is `~/security-audit-skill/<repo-name>/run-<N>`, outside the audited tree.
Multi-gigabyte logs, scratch copies and promoted artefacts never land in the repository. An
in-repo output directory is allowed only if the user explicitly chooses it **and** the whole
directory is ignored by version control; otherwise stop and ask.

## 7. Platform mapping (OpenCode / Claude Code)

The skill is agent-neutral: it says *Parent*, *Task tool*, `research`, `general` and
`subagent_type:`. Translate as follows.

| Skill term | OpenCode | Claude Code |
| --- | --- | --- |
| Parent | the `ceo` primary agent | the main session |
| Task tool | `task` permission + the `subagent` tool | `Task` tool |
| `general` delegated agent | `security` subagent (fresh session per unit) | `general-purpose` |
| `research` agent | `researcher` (read-only) or `explore` | `Explore` |
| `subagent_type:` heading | informational: put the role in the brief | same |
| Skill directory | `config/skills/security-audit/` (installed copy) | the exported skill directory |

Claude Code export (`oc-export-claude`) keeps the same skill text; only the tool names differ.
In both cases, keep the role, the write isolation, the prompt and the independence boundaries
the skill defines.
