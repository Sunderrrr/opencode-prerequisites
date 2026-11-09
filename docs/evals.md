# Agent and skill evals

The eval harness answers a narrow question: when an agent is dropped into a
small, known project, does it produce a working result?

It is deliberately small: one fixture, one prompt, objective checks. It is not
a benchmark, it does not grade prose, and one PASS is not proof that an agent is
better than another. It is a repeatable smoke test for agent and skill changes.

## How it works

1. Copy `evals/fixtures/<fixture>/` to a temporary directory.
2. Run the agent headlessly in that directory:
   `opencode run --agent <agent> --format json --auto --archived "<prompt>"`.
3. Run each check in order in the same directory.
4. The task passes only if the agent exits 0 (no timeout, no spawn error) and
   every check exits 0.
5. Write `evals/results/<timestamp>.json` and a matching `.md` summary.

The agent runs with `--auto`, so it can use tools without interactive approval.
Fixtures are throwaway copies; the source fixture is never modified.

## Quick start

```bash
# Validate the task and print its plan. Free: no model call, no checks.
node scripts/eval.mjs --task rust-cli --dry-run

# Real runs. Each one consumes model quota.
node scripts/eval.mjs --task rust-cli --agent rust
node scripts/eval.mjs --task web-ui --agent frontend
node scripts/eval.mjs --task bugfix --agent debugger --json
```

Useful options:

| Option | Effect |
| --- | --- |
| `--task <name>` | Task to run (required) |
| `--agent <name>` | OpenCode agent; default `ceo` |
| `--model <id>` | Model in `provider/model` form; default from agent/config |
| `--dry-run` | Validate the task and print checks; no model call, no checks |
| `--json` | Print the result object to stdout (results are still written) |
| `--keep` | Keep the temporary work directory and print its path |
| `--list` | List available tasks |
| `-h`, `--help` | Show usage |

Exit codes: `0` pass or dry run, `1` eval failed, `2` usage or configuration
error.

## Tasks

| Task | Fixture | What the agent must do | Checks |
| --- | --- | --- | --- |
| `rust-cli` | `evals/fixtures/rust-cli/` | Implement a `greeting` library function, wire a CLI argument and add a test | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, tests present, CLI output |
| `web-ui` | `evals/fixtures/web-ui/` | Create one static `index.html` | File exists, heading/button/accessible label, `lang` and viewport |
| `bugfix` | `evals/fixtures/bugfix/` | Fix `src/sum.js` without changing the tests | `node --test` |

The `rust-cli` checks require a Rust toolchain with `rustfmt` and `clippy`
installed. `web-ui` and `bugfix` need only Node.js.

## Task format

```json
{
  "name": "example",
  "description": "One line shown in dry runs and reports.",
  "prompt": "What the agent must do. Be explicit about files and the finish line.",
  "fixture": "example",
  "timeout": 300,
  "checkTimeout": 60,
  "checks": [
    { "name": "test", "command": "node", "args": ["--test"] }
  ]
}
```

Validation rules:

- `name` must match the file name (`evals/tasks/<name>.json`) and use
  lowercase letters, digits and hyphens.
- `fixture` must be a relative directory under `evals/fixtures/`.
- `timeout` is the agent timeout in seconds, from 1 to 7200.
- `checks` must be a non-empty array. Each check needs a non-empty `name` and
  `command`. `args` is optional and must be an array of strings. A per-check
  `timeout` is optional.
- If a check has `args`, the command is spawned without a shell. Without `args`,
  the command string runs through the platform shell. Prefer `args`: it avoids
  quoting problems and is portable.
- The default check timeout is `checkTimeout`, or 120 seconds when neither is
  set.

## Results

Every real run writes two files under `evals/results/`:

- `<timestamp>.json`: machine-readable result with the agent command, exit
  code, duration, usage (cost/tokens when the provider reports them), every
  check with stdout/stderr, and the overall verdict.
- `<timestamp>.md`: a short human summary with a check table and captured
  output.

`--json` prints the same object to stdout. `--keep` keeps the temporary
directory and adds `workdirKept` to the result, so a failed run can be inspected
with the agent's changes still in place.

The result files are local artifacts. They are not meant to be committed and
may contain model output; review before sharing.

## Interpretation

- **PASS** means the agent exited cleanly and every check is green. It does not
  mean the code is elegant, secure or complete beyond the checks.
- **FAIL** can come from the agent, the fixture, the checks, or the local
  toolchain. Read the check output and the agent text before blaming the model.
- Checks are narrow and can be gamed. Add checks for the behavior you actually
  care about, and keep them deterministic.
- Agent output is nondeterministic. Run the same task several times before
  drawing conclusions, and compare agents on the same task, fixture and model.
- An agent that exits non-zero or times out fails even if the checks happen to
  pass: the task was not completed cleanly.

## Cost and quota

A real run calls a model and can last up to the task timeout (10 minutes for
`rust-cli`). It consumes quota on the configured provider. There is no CI
workflow by default, on purpose: a workflow would spend quota on every push.
Run evals manually, or schedule them with an explicit budget.

`--dry-run` is free: it validates the task and prints the checks without calling
a model. Use it while editing tasks or fixtures.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `opencode` not found | Install it or point `EVAL_OPENCODE` at the binary |
| Auth or quota error | Check the provider with `opencode models` / `opencode auth`; dry-run still works |
| Agent timeout | Increase `timeout`, or use `--keep` to inspect what it was doing |
| Check timeout | Increase the check `timeout` or `checkTimeout` |
| Usage missing | Not every provider reports cost/tokens; the verdict is still valid |
| Rust check fails immediately | Install `rustfmt` and `clippy` (`rustup component add rustfmt clippy`) |

## Testing the harness

```bash
node scripts/test-eval.mjs
```

The test is hermetic: it uses a fake `opencode` binary, temporary fixtures and
no network or model call. It covers task schema validation, `--dry-run`, PASS
and FAIL scoring, JSON output, agent and check timeouts, agent crashes, `--keep`
and result file creation. The final line is `✅ evals OK`.

## Internal environment variables

These exist for the harness tests and advanced use; normal runs do not need
them.

| Variable | Default | Purpose |
| --- | --- | --- |
| `EVAL_OPENCODE` | `opencode` | Binary or script to invoke instead of the real CLI |
| `EVAL_TASKS_DIR` | `evals/tasks` | Alternate task directory |
| `EVAL_FIXTURES_DIR` | `evals/fixtures` | Alternate fixture directory |
| `EVAL_RESULTS_DIR` | `evals/results` | Alternate result directory |
