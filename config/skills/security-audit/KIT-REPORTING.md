# Reporting in the kit

Two outputs coexist: the run artefacts in `findings.json` (governed by **`report-schema.json`
and the two validators, which stay authoritative**) and the short report a hunter or verifier
returns to the CEO. This file only fixes the shape of the second one.

## The finding block: four fields, in French

Each **confirmed** finding carries these four lines, in this order, written for a French
reader (the rest of the short report stays in the user's language):

```text
Gravité : critique | élevée | moyenne | faible
Où : <chemin/relatif/fichier>:<ligne> (ou fichier:ligne-ligne)
Scénario : <qui, avec quel accès, franchit quelle frontière, et obtient quoi — 1 à 2 phrases>
Correctif : <le plus petit changement de source qui rétablit l'invariant, + test de régression>
```

- **Gravité** exists only for a `confirmed` record. It maps to the schema's
  `critical|high|medium|low` and must not exceed the demonstrated impact (the skill's
  anchors in `SKILL.md`, "Separate priority from certainty").
- **Où** is a repository-relative `file:line`, never an absolute path, never a whole file.
- **Scénario** names the lower-trust principal, the accepted input, the control that should
  have stopped it, and the concrete result. "Could be dangerous" is not a scenario.
- **Correctif** is specific: the invariant, the point where it is enforced, and the test.

A `needs_validation` record replaces `Gravité` with `Bloqué par :` (the exact missing fact)
and gets **no severity at all**. That is an upstream rule, not a style choice.

## Verdicts mapped to the CEO's short report

| Verdict | Where it goes in the short report | What it looks like |
| --- | --- | --- |
| `confirmed` | **Findings** (or the "Done" summary when the CEO asked for a list) | the four-field block, most severe first |
| `needs_validation` | **Remaining / risks** | one line: the hypothesis, the blocking fact, the safe way to resolve it, no severity |
| `rejected` | **Proof**, as a one-line tally | `rejected: 4 candidates (2 by missing caller, 1 intended behavior, 1 unreachable)` — never as a finding |

The short report keeps the kit's four sections and stays short:

- **Done** — what ran, in 3 to 6 lines (phases covered, units, counts).
- **Proof** — the commands actually run with their real result counts (`semgrep: 2 high`,
  `validate-findings.cjs: exit 0`), `file:line` for each finding, and the tally of verdicts.
- **Remaining / risks** — `needs_validation` entries, coverage gaps, missing tools, and what
  the sandbox rule prevented from running.
- **Questions / assumptions** — decisions taken alone, in one line each.

## No huge logs

- Never paste a raw scanner report, a stack trace or a payload in the short report. Put the
  file in the run directory (outside the repository) and cite its path plus a 3-line digest.
- At most 5 quoted lines from any output, and only when they are the evidence.
- The full `findings.json`, `REPORT.md` and `NEEDS-VALIDATION.md` belong to the run
  directory; the CEO gets the summary, the paths and the counts.
- Secrets are never quoted: `[redacted]` plus the rule ID and the location.

## Relationship with the schema

`report-schema.json` and `validate-findings.cjs` define and check the machine record; this
file never replaces them and never adds a field. If a rule here contradicts the schema or the
skill text, the schema and the skill win, and the difference is reported as a kit bug.
