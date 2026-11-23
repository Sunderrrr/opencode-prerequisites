---
description: Full security audit of a codebase with evidence
---
Run a **full security audit** of the target given in $ARGUMENTS (repository path, and the
scope: paths, diff/ref range or subsystem; default to the current repository and its full
tree if only a path is given).

Load the `security-audit` skill in **full audit mode** (`skill({ name: "security-audit" })`),
then read the skill's `KIT-ENVIRONMENT.md`, `KIT-TOOLING.md` and `KIT-REPORTING.md` before
the first phase: they define how the kit replaces the upstream sandbox and subagent model.

Rules for the orchestration:

- The **CEO is the parent**: it owns the run metadata, the coverage ledger, the assignment of
  ledger units, and every promotion or verdict change. It never hunts and never writes: a
  single dedicated writer session handles the shared files.
- Hunters and verifiers are **fresh `security` subagents**, one ledger unit each, each with
  its own `agents/<id>/` directory and a self-contained brief. `subagent_depth: 1`: they
  cannot delegate further.
- **Never the same agent to find and verify.** A candidate found by one session is validated
  by a different one, and each `confirmed` record passes independent record verification
  by a third, distinct session.
- **Sandbox.** The kit has no OS sandbox: static analysis only, unless the user explicitly
  provides a sandbox (no network, allowlisted environment, limits) and names it in the brief.
  Without it, target code is not executed and the gap is recorded as `needs_validation`.
- **Output outside the repository**: `~/security-audit-skill/<repo>/run-<N>`, never inside
  the audited tree unless the user explicitly chooses an ignored path.
- **Authorization scope**: the target must be the user's own code or an explicitly authorized
  engagement. No active testing of deployed endpoints, shared services or third parties; the
  audit stays source-first and local.
- Finish with the short report (Done / Proof / Remaining / Questions), the counts per verdict
  (`confirmed` / `needs_validation` / `rejected`), and the paths of `REPORT.md` and
  `findings.json`. Do not claim a complete run without both validators passing.
