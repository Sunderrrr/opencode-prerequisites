# Evals

Small, objective checks for agents and skills: copy a fixture to a temporary
directory, ask an OpenCode agent to do one task, then run the task's checks.

Full documentation: [`docs/evals.md`](../docs/evals.md).

## Quick start

```bash
# Free: validate the task and print the plan. No model call, no checks.
node scripts/eval.mjs --task rust-cli --dry-run

# Real run. This consumes model quota.
node scripts/eval.mjs --task rust-cli --agent rust
node scripts/eval.mjs --task web-ui --agent frontend
node scripts/eval.mjs --task bugfix --agent debugger --json
```

Results are written to `evals/results/<timestamp>.json` and a matching `.md`
summary. `--json` prints the same object to stdout. Add `--keep` to keep the
temporary work directory for inspection.

## Layout

| Path | Purpose |
| --- | --- |
| `evals/tasks/*.json` | Task prompt, fixture, timeout and checks |
| `evals/fixtures/<name>/` | Minimal starting project copied for each run |
| `evals/results/` | Generated JSON and Markdown reports (not committed) |
| `scripts/eval.mjs` | The harness |
| `scripts/test-eval.mjs` | Hermetic harness tests (fake agent, no network) |

## Tasks

| Task | Fixture | Checks |
| --- | --- | --- |
| `rust-cli` | Rust crate skeleton | `cargo fmt`, `cargo clippy`, `cargo test`, tests present, CLI output |
| `web-ui` | Empty static site | `index.html`, heading/button/label, `lang`/viewport |
| `bugfix` | Node project with a failing test | `node --test` |

A task passes only when the agent exits 0 and every check exits 0.

## Cost and quota

Every real run calls a model and can run for up to the task timeout (10 minutes
for `rust-cli`). It consumes quota. `--dry-run` is free and is the right command
for schema or fixture changes. There is no CI workflow by default: adding one
would spend quota on every push. Run evals manually, or schedule them with an
explicit budget.

## Test the harness

```bash
node scripts/test-eval.mjs
```

The test uses a fake `opencode` binary, temporary fixtures and no network. It
covers schema validation, dry-run, PASS/FAIL scoring, JSON output, timeouts,
agent crashes, `--keep` and result files.

## Adding a task

1. Add a tiny fixture under `evals/fixtures/<name>/`.
2. Add `evals/tasks/<name>.json` with `name`, `prompt`, `fixture`, `timeout`
   and a non-empty `checks` array.
3. Validate with `node scripts/eval.mjs --task <name> --dry-run`.
4. Run it with an agent and inspect the result. Use `--keep` when a check fails.

Keep fixtures self-contained and offline. Do not put secrets, credentials or
personal data in a fixture: the agent runs with `--auto` and can execute
commands in the temporary copy.
