# Code Mode

Code Mode is a tool-use pattern described by Cloudflare in September 2025: the model writes
one program against a typed API built from the MCP schema, in a sandbox with no Internet
access. Its only exit is a binding to each MCP server; the supervisor holds the credentials.
The model reads back only what the program logs.

## Why it helps

- **Tokens**: intermediate results stay in the script; chained calls no longer push each
  payload through the context window.
- **Reliability**: pagination, loops and filtering are ordinary code, so a saved script
  gives the same result next time.
- **Secrets**: generated code never holds a key, so it cannot leak one in a log or a commit.

## In this kit

OpenCode and Claude Code expose each MCP tool separately: there is no Code Mode API to call.
The practical equivalent is a short script against the API or CLI behind the server: prefer
`gh`, `curl` with `jq`, `oc-*` (`oc-secrets`, `oc-versions`), `aws`, `gcloud`, `bq`,
`kubectl` or `docker`, run it from the project or `/tmp/opencode`, and return a summary.
Keep credentials out of the code (`oc-secrets get NAME`, see [secrets.md](secrets.md));
the kit ships no sandbox, so isolate risky runs or accept your shell's permissions.

## Limits

No typed API is generated from the MCP schema: you drive the CLI or API yourself, with its
own auth and pagination; a script pays off beyond one or two calls. Cloudflare's no-network,
credential-hiding bindings must be rebuilt by hand. Rules, examples and checklist:
[code-mode skill](../config/skills/code-mode/SKILL.md).
