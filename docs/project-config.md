# Project-specific configuration (MCPs and overrides)

The kit installs a **global** OpenCode configuration in `~/.config/opencode` (agents, skills,
commands, plugins and the default MCP servers). Some MCP servers only make sense for one machine
or one repository: a document server bound to `~/Documents/notes`, an internal API, a database
client. Those belong in the **project** configuration, not in the kit.

This page explains how OpenCode merges the two, with the WordCraft server as an example.

## Where OpenCode reads configuration

OpenCode combines configuration sources; later sources override earlier ones **only for
conflicting keys**, everything else is preserved:

1. Remote config (`.well-known/opencode`), organizational defaults
2. **Global config** (`~/.config/opencode/opencode.json` or `opencode.jsonc`) — what this kit installs
3. Custom config (`OPENCODE_CONFIG` environment variable)
4. **Project config** (`opencode.json` / `opencode.jsonc` in the project root)
5. `.opencode/` directories (project agents, commands, plugins)
6. Inline config (`OPENCODE_CONFIG_CONTENT`)
7. Managed configuration (administrator / MDM), highest priority

The project file is looked up in the current directory, then in the parent directories up to the
nearest Git root. It uses the same schema as the global file and supports JSONC (comments and
trailing commas). It can be committed: it must not contain a secret.

## WordCraft example

The WordCraft server is a local MCP whose documents are confined to `~/Documents/notes`; it was
deliberately kept out of the kit because that path is specific to one machine. Put it in the
project that needs it — here `~/Documents/notes/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "wordcraft": {
      "type": "local",
      "command": [
        "/usr/bin/wordcraft-cli",
        "mcp",
        "--automation-read-root", "{env:HOME}/Documents/notes",
        "--automation-write-root", "{env:HOME}/Documents/notes"
      ]
    }
  }
}
```

`{env:HOME}` is expanded by OpenCode from the environment (an unset variable becomes an empty
string). Absolute paths also work; `~` is **not** expanded inside `command`, so write
`/home/<user>/...` or use `{env:HOME}`.

Only the `mcp.wordcraft` key is added: the kit's other MCP servers, agents and permissions are
still inherited from the global config. That is the deep-merge rule: adding a server does not
replace the `mcp` object.

## Overriding or disabling a global setting

A project can override a conflicting key, for example its own model:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode-go/glm-5.2"
}
```

It can also disable a global MCP server it does not need (the `kubernetes` server, for instance,
exits when there is no `kubectl` context):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "kubernetes": { "disabled": true }
  }
}
```

Do not copy the whole global `opencode.jsonc` into the project: that freezes the kit's agents,
permissions and MCP versions at the day of the copy. Override only the keys you need.

## Precedence versus `~/.config/opencode`

- **Global** (`~/.config/opencode`): the kit's defaults, shared by every project. Updated by
  `./install.sh`.
- **Project** (`opencode.jsonc` in the repository): wins on conflicting keys, adds project-only
  MCPs, agents, commands and plugins. It is versioned with the project.
- **`OPENCODE_CONFIG`**: a machine-only file loaded between the two; useful when the override
  must not be committed (personal paths, credentials read from the environment).
- **`OPENCODE_CONFIG_DIR`**: changes where `install.sh` writes the global config. It is not a
  project config and does not change what OpenCode reads.

## Why the kit stays portable

- `config/` contains no personal absolute path and no secret: everything machine-specific goes in
  a project config or in `OPENCODE_CONFIG`.
- Secrets are read from the environment (`{env:VAR}`) or from a file (`{file:~/.secrets/...}`),
  never committed and never written by the installer.
- The installer validates the kit before copying it, and the CI installs it on seven distributions
  without a WordCraft-like server: a new machine only needs the kit plus its own project configs.

## Checklist

- File name: `opencode.jsonc` (or `opencode.json`) at the project root, same `$schema`.
- Add only the keys you need; let the global config provide the rest.
- No secret in the file; use `{env:...}` or `{file:...}`.
- Validate after editing: `opencode debug config` (also run by `./doctor.sh`), then `opencode mcp list`.
