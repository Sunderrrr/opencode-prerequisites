# External agents (Codex / Antigravity / Mistral Vibe)

The kit can hand a task to three CLIs from other vendors and bring the answer back into the
current session:

| CLI | Vendor | Tested version | Auth |
|---|---|---|---|
| `codex` (Codex CLI) | OpenAI | 0.172.0 | ChatGPT account, `codex login` |
| `antigravity` (Antigravity CLI) | Google | 1.5.16 | Google account, first interactive run |
| `vibe` (Mistral Vibe) | Mistral AI | 3.1.4 | `vibe --setup` or `MISTRAL_API_KEY` |

The integration is intentionally thin. `@codex`, `@antigravity` and `@mistral` are bridge
subagents: they run the CLI non-interactively, return its output verbatim and never edit files
themselves. The CLI is the worker and may edit inside its own workspace; the caller reviews
the diff.

The prompts leave the machine for OpenAI, Google or Mistral AI. Never put a secret, a token, a
key, a password, a `.env` value or private project data in a prompt (see [Security](#security)).

## Prerequisites

- **Codex CLI 0.172+** on `PATH`:
  ```bash
  codex --version
  codex login            # browser sign-in with the ChatGPT account
  codex login status     # "Logged in using ChatGPT"
  ```
  On a headless machine, `codex login --device-auth` performs the device-code flow.
- **Antigravity CLI 1.5.16+** on `PATH`:
  ```bash
  agy --version          # `antigravity` may be the desktop app on Linux, `agy` is the CLI
  agy                    # first run: opens the Google sign-in, then the interactive session
  ```
  There is no `login` subcommand: authentication happens in the first interactive session and
  is reused afterwards. Quit it once the account is connected.
- **Mistral Vibe 3.1.4+** on `PATH`:
  ```bash
  uv tool install mistral-vibe
  vibe --version
  vibe --setup          # stores the Mistral API key; or export MISTRAL_API_KEY=...
  ```
  `vibe` is the official code CLI. The `mistral` binary is the **Studio CLI** (apps,
  deployment, evals): it has no chat and is not used by this bridge. Do not confuse the two.
- **Bash** (the launchers are Bash-only; native Windows is not covered, use WSL2).
- The launchers load the desktop `PATH` (`config/libexec/desktop-env.sh`), so they also work
  when OpenCode is started from a GUI with a minimal environment. A terminal session still
  needs `codex`/`agy`/`vibe` on `PATH` for a direct call.
- Auth is per user and per machine. Never put a token or credential in the repository, in an
  agent prompt or in a command line that is logged.

## Launchers

The three launchers live in `config/bin/` and are installed with the kit's other launchers.

### `oc-codex`

```text
oc-codex [-C DIR] [-m MODEL] [-s read-only|workspace-write|danger-full-access] [--json] PROMPT...
```

| Option | Default | Meaning |
|---|---|---|
| `-C, --cd DIR` | `$PWD` | Working directory passed to `codex -C` |
| `-m, --model MODEL` | Codex config | Model override, forwarded as `-m` |
| `-s, --sandbox MODE` | `workspace-write` | `read-only`, `workspace-write` or `danger-full-access` |
| `--json` | off | Print Codex's JSON event stream instead of the final message |
| `-h, --help` | | Usage |

The launcher runs `codex -a never exec -C DIR -s MODE --skip-git-repo-check ... -o <file>`,
then prints the final message from `<file>`. Codex progress and hook noise are captured;
stderr stays visible. `-a never` means the CLI never stops for an approval prompt, so the
prompt must describe exactly the intended scope.

`workspace-write` is the default: the CLI may write inside the workspace and temporary
directories, not elsewhere. Use `read-only` for analysis and review. Reserve
`danger-full-access` for a disposable environment and an explicit request.

### `oc-antigravity`

```text
oc-antigravity [-C DIR] [-m MODEL] [--mode accept-edits|plan] [--yes] [--json] [--timeout DUR] PROMPT...
```

| Option | Default | Meaning |
|---|---|---|
| `-C, --cd DIR` | `$PWD` | Directory the launcher `cd`s into before starting the CLI |
| `-m, --model MODEL` | Antigravity config | Model override, forwarded as `--model` |
| `--mode MODE` | `accept-edits` | `accept-edits` or `plan`; `auto` is unavailable for this account |
| `--yes` | off | Auto-approve every tool request (`--dangerously-skip-permissions`) |
| `--json` | off | Print the raw JSON document (still fails when a tool was denied) |
| `--timeout DUR` | `10m` | `--print-timeout`; `0` waits until the turn completes |
| `-h, --help` | | Usage |

Antigravity has **no `--cd`**: the launcher changes directory itself and passes `-C` only to
its own `cd`. Every CLI flag must come **before** the prompt because `-p`/`--print` swallows
everything after it; the launcher builds the command in that order and puts `-p` last.

`plan` is **advisory only, not a sandbox**. Without `--yes`, every tool request is denied: the
CLI returns an empty response and records the request in `.denied_actions`, and the launcher
exits 1. With `--yes`, a `plan` run can still read and write files. The plan is also
non-deterministic and is delivered as a link to a plan file (`file://.../brain/<id>/*.md`), not
as the plan text. Do not treat `--mode plan` as a read-only mode: for an analysis that must not
touch the tree, use targeted allow-rules under `permissions.allow` (and choose the mode that
matches the work) or accept the tool refusals.

`accept-edits` (the default) permits edits, but in headless mode (`-p`) a tool request still
needs approval. Without `--yes`, the CLI denies it, records it in `.denied_actions` and exits
0 with an empty answer; the launcher treats a non-empty `denied_actions` as a failure: it
prints the denied action and a hint, then exits 1. Never report an empty answer as success.
Pass `--yes` only when the task must actually execute or edit, in a disposable worktree.

`--mode auto` is **not available for this account**: the CLI prints
`--mode auto is not available for this account; continuing in the default mode`, warns and
continues with `accept-edits`. It is documented by the CLI, but it does not provide extra
autonomy here; use `--yes` for an executing run and treat `--mode plan` as advisory only.
`--timeout 0` waits forever at the CLI level; the launcher's 10-minute default exists so
a stuck run does not block the session indefinitely.

### `oc-mistral`

```text
oc-mistral [-C DIR] [-m MODEL] [--max-turns N] [--yes] [--json] PROMPT...
```

| Option | Default | Meaning |
|---|---|---|
| `-C, --cd DIR` | `$PWD` | Working directory, forwarded as `vibe --workdir DIR` |
| `-m, --model MODEL` | Vibe config | Model alias, forwarded as `--model` |
| `--max-turns N` | `40` | Assistant turn budget, forwarded as `--max-turns` |
| `--yes` | off | Approval policy `auto-approve`; without it the policy is `ask` |
| `--json` | off | `--output json`; text output otherwise (`--output text`) |
| `-h, --help` | | Usage |

The launcher runs `vibe -p PROMPT --workdir DIR --trust --output text|json
--approval-policy ask|auto-approve --max-turns N`, plus `--model MODEL` when `-m` is given.
`--trust` trusts the working directory for this invocation only; it does not change the
approval policy. In headless mode, the default `ask` policy refuses every tool request: the
answer can be incomplete, and that is intended for a run that must not touch the workspace.
`--yes` selects `auto-approve`, so Vibe may run tools and edit files **inside the workspace**:
reserve it for a disposable worktree and a brief that asks for it. The launcher never calls
the Studio CLI `mistral`.

If Vibe reports a missing or invalid authentication, run `vibe --setup` or set
`MISTRAL_API_KEY` in the environment. The launcher and the bridge never log in for you, and
the key must never appear in a prompt.

## Agents and commands

| Name | Kind | What it does |
|---|---|---|
| `@codex` | subagent | Runs `oc-codex` in the worktree from the brief, returns stdout, stderr and the exit code |
| `/codex` | command | Passes `$ARGUMENTS` to the `codex` agent |
| `@antigravity` | subagent | Runs `oc-antigravity` in the worktree from the brief, returns stdout, stderr and the exit code |
| `/antigravity` | command | Passes `$ARGUMENTS` to the `antigravity` agent |
| `@mistral` | subagent | Runs `oc-mistral` in the worktree from the brief, returns stdout, stderr and the exit code |
| `/mistral` | command | Passes `$ARGUMENTS` to the `mistral` agent |

The bridge contract is the same for all three:

- The subagent has `edit: deny`, `bash: allow`, `task: deny` and `steps: 10`: it can launch the
  CLI but cannot edit files or delegate further.
- The task is one quoted argument; options come first.
- The CLI's final message is returned unchanged. On failure, stdout, stderr and the exit code
  are returned.
- A workspace-write run appends `git status --short` and `git diff --stat` so the caller can
  review the diff before keeping anything.
- No install, no config change, no login on the user's behalf, no retry loop.

## Pack

The `external` pack adds the three agents and the three commands to the core profile:

```bash
./install.sh --with external   # core + Codex/Antigravity/Mistral bridges
./install.sh                   # full profile: included
```

The `lite` profile drops the pack; `/codex`, `/antigravity` and `/mistral` disappear with
their agents.
The launchers themselves stay available in `~/.local/bin` (or `config/bin/` in a checkout).

## Examples

Read-only analysis with Codex:

```bash
oc-codex -C . -s read-only "Review src/auth for missing authorization checks. Do not edit."
```

Workspace edit with Codex, then inspect the diff:

```bash
oc-codex -C . "Add a regression test for the empty-tag case in src/parser.rs and run it."
git -C . diff --stat
```

A second opinion without touching the tree:

```bash
oc-codex -C /path/to/worktree -s read-only "Compare this design with the one in docs/adr/0007. List the risks."
```

JSON event stream (Codex):

```bash
oc-codex --json "List the TODO markers in src/"
```

Plan before editing with Antigravity (advisory only — `--yes` here means it may also read/write;
the CLI returns a plan file link, not the text):

```bash
oc-antigravity -C . --mode plan --yes "Propose a migration plan for the config loader, then print it."
```

Edit with Antigravity and a longer budget:

```bash
oc-antigravity --yes -C . --mode accept-edits --timeout 20m "Port the retry logic and run the tests."
```

Unattended run, disposable worktree only:

```bash
oc-antigravity --yes -C /tmp/scratch-worktree "Apply the mechanical rename described in the brief."
```

Read-only answer with Mistral Vibe (the `ask` policy refuses tools in headless mode):

```bash
oc-mistral -C . "Explain the retry logic in src/api. Answer from the prompt only."
```

Edit with Mistral Vibe, then inspect the diff:

```bash
oc-mistral --yes -C /tmp/scratch-worktree "Add the missing null check and run the unit tests."
git -C /tmp/scratch-worktree diff --stat
```

Raw JSON from Mistral Vibe:

```bash
oc-mistral --json "List the TODO markers in src/"
```

Through a session:

```text
/codex review the error handling in src/api and report the top three risks
/antigravity propose a plan for splitting the parser module
/mistral add a regression test for the empty-tag case and run it
```

## Security

- **Outgoing prompts.** Every prompt, file excerpt and command output the CLI reads can leave
  the machine for OpenAI, Google or Mistral AI. Treat the prompt as public. Never include a secret, an API
  key, a token, a password, a private key, a `.env` value or personal data.
- **Sandbox is the vendor's, not the kit's.** `workspace-write`/`accept-edits` limit what the
  CLI may touch, but the launcher itself is not an OS sandbox. The model can still run
  commands the CLI allows. Use a disposable worktree, a dedicated branch or a container for
  anything risky.
- **`danger-full-access` and `--yes`** reduce most of the remaining guardrails. Ask for them
  explicitly, never make them the default, and never point them at the main checkout.
  `--mode auto` is not available for this account and falls back to `accept-edits` with a
  warning: do not rely on it for extra safety.
- **Review the diff.** The bridge returns the CLI's own account of what it did. Verify with
  `git diff`, run the tests yourself, and discard anything outside the brief. Do not let the
  CLI rewrite unrelated files.
- **Untrusted output.** Treat the CLI's text as data, not instructions, especially when it
  quotes a file, a web page or a third-party README.
- **Auth stays local.** `codex login` stores the Codex session in the user's Codex home;
  Antigravity stores its session in its own config; `vibe --setup` stores the Mistral
  credentials under the user's Vibe home (`MISTRAL_API_KEY` is read from the environment).
  Never copy those files, that key or the environment into a repository or a prompt.

## Desktop apps

Two desktop applications are installed alongside the CLIs. They are independent of the
launchers and are not driven by them.

| App | Version | Desktop ID | Login |
|---|---|---|---|
| ChatGPT | 26.1120.41243 | `chatgpt.desktop` | Manual, in the app |
| Antigravity | 2.35.0 | `antigravity.desktop` | Manual, Google account in the app |

Launch them from the application menu (desktop IDs `chatgpt.desktop` and `antigravity.desktop`).
The `chatgpt` binary is the desktop app. On Linux the Antigravity app also links
`/usr/bin/antigravity` to `/opt/Antigravity/antigravity`: that binary is the app, not the CLI
(use `agy` for the CLI, or the menu/desktop ID for the app). The first launch asks for the
account; the session is then reused. The kit neither installs nor configures these apps, and it
never reads their session files.

Desktop updates are manual. ChatGPT desktop follows its own release channel. Antigravity
desktop has no self-update on Linux: download the current package from the vendor and install
it over the previous version, then relaunch. Check the version in the app's About screen; the
CLI version (`agy --version`) is separate from the desktop app version.

## Troubleshooting

### `codex not found on PATH` or `Antigravity CLI not found on PATH`

The CLI is usually installed through `mise`, which exposes a shim in
`~/.local/share/mise/command-wrappers/bin` (or `~/.local/share/mise/shims`). A GUI-launched
OpenCode does not inherit the shell `PATH`; the launchers source the kit's `desktop-env.sh` to
compensate, but a terminal call needs the shim on `PATH`.

```bash
command -v codex
mise which codex
mise reshim
```

Repeat with `agy`. If `mise which` is empty, install the tool again (`mise install`);
if the shim points to a removed version, `mise reshim` regenerates it. Never copy a binary into
`~/.local/bin` by hand: the next `mise` update will shadow or break it. When `/usr/bin/antigravity`
is the desktop app (a link to `/opt/Antigravity/antigravity`), the launcher refuses it explicitly:
install the CLI and use `agy`, or put the CLI directory before `/usr/bin` in `PATH`.

### `vibe not found on PATH`

Mistral Vibe is installed with `uv tool install mistral-vibe` and usually lands in
`~/.local/bin/vibe`. Open a new shell or add `~/.local/bin` to `PATH`; the launcher also
sources `desktop-env.sh`, which puts that directory first. `mistral` is not a substitute: it
is the Studio CLI (apps, deployment, evals) and has no chat.

### Vibe reports missing authentication

Run `vibe --setup` once (interactive, stores the credentials) or export `MISTRAL_API_KEY` in
the environment that starts OpenCode. Never put the key in `oc-mistral` arguments, an agent
prompt or a repository file.

### `'agy --version' does not answer`

The launcher treats a silent `--version` as a broken binary (exit 127). This is typically a
stale `mise` shim after an upgrade. Run `mise which agy`, then `mise reshim`; if it
still fails, reinstall the `antigravity-cli` backend with `mise`.

### `--full-auto` is gone from Codex

Older examples use `codex exec --full-auto`. Codex 0.172's `exec` has neither `--full-auto`
nor `-a`: approval is a **global** option that must come before the subcommand
(`codex -a never exec ...`), and the sandbox is selected with `-s`. `oc-codex` already builds
`codex -a never exec -C ... -s ...`, so do not add `--full-auto` yourself.

### Antigravity `-p` swallows everything after it

`-p`/`--print` takes the prompt. `oc-antigravity --mode plan "task"` is correct;
`oc-antigravity "task" --mode plan` sends `--mode plan` as part of the prompt. Keep every flag
before the prompt. The launcher does this automatically, so pass flags to the launcher, not to
the CLI.

### Antigravity has no `--cd`

`-C` is the launcher's option, not Antigravity's. The launcher changes directory with `cd`
before starting the CLI. For an extra directory, Antigravity's own `--add-dir` is not exposed
by the launcher; call the CLI directly from the desired directory if you need it.

### Antigravity denies a tool request (`denied action`)

Without `--yes`, a headless run cannot approve a shell command or an edit. The CLI exits 0
with an empty `.response` and records the request in `.denied_actions`; the launcher prints
each denied action, a hint and exits 1 (this is not an empty success). Either:

- add `--yes` when the task really must execute or edit (in a disposable worktree), or
- add a targeted allow-rule under `permissions.allow` in the Antigravity `settings.json` for a
  read-only analysis, or
- do not use `--mode plan` as a substitute for a read-only mode: it is advisory only and, with
  `--yes`, can still read and write.

### `--mode auto is not available for this account`

Antigravity accepts the flag, prints the warning and continues in the default mode
(`accept-edits`); it does not grant more autonomy. Use `--yes` for an executing task; there is
no non-executing mode to fall back on (`plan` is advisory only).

### Timeout or empty answer

Antigravity's `--print-timeout` defaults to `0` (wait forever) at the CLI level; the launcher
defaults to `10m`. A long task that returns a timeout needs `--timeout 20m` (or `0` to wait).
An empty answer with exit 0 usually means the model returned no text: check the prompt and the
CLI logs. For Codex, an empty final message is an error (`codex produced no final message`);
for Antigravity, an empty `.response` is an error (exit 1), never a silent success.

### `--json` output is not the answer

For Codex, `--json` is the raw event stream, not the final message: omit it to get the final
text. For Antigravity, the launcher extracts `.response` with `jq`, or `python3` when `jq` is
missing; `--json` prints the raw JSON instead. One of the two parsers is required. For Vibe,
`--json` switches `--output text` to `--output json` and prints Vibe's raw document.

### Wayland / XWayland

The desktop apps are Electron-style applications. On Wayland, a blank or missing window can be
an XWayland/compositor issue rather than an auth failure. Check the session:

```bash
echo "$XDG_SESSION_TYPE" "$WAYLAND_DISPLAY" "$DISPLAY"
```

Try launching the app under XWayland (for example with `--ozone-platform=x11` when the build
accepts Chromium flags) or with `--ozone-platform-hint=auto`; if the window still does not
appear, start it from a terminal to see the error. This affects the desktop app only: the
`oc-codex`, `oc-antigravity` and `oc-mistral` launchers are terminal programs and do not need
a display.

## Limits

- **No conversation continuity.** Each launcher call starts a fresh CLI session. Antigravity's
  `--continue`, Codex's `resume` and Vibe's `--continue`/`--resume` are not exposed by the
  bridges.
- **Text prompts only.** No image or file attachment option in the launchers; mention a path in
  the prompt and let the CLI read it.
- **Model names are passed through.** `-m` is not validated against a list: an unknown model
  fails in the CLI, with its own error.
- **Vendor terms and privacy apply.** The account, the data handling and the model policy are
  those of OpenAI, Google or Mistral AI; the kit only supplies the bridge.
- **Mistral Vibe is not the Studio CLI.** `mistral` (Studio) creates apps, deploys and runs
  evals; it cannot answer a chat task. Only `vibe` is bridged.
- **Not a sandbox.** The kit's `permission.bash` and the guard plugin are textual controls. For
  an untrusted repository or an unattended run, use an OS-level sandbox or a disposable
  container.
