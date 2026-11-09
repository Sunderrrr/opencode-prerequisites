# Secrets (oc-secrets)

`oc-secrets` keeps API keys out of shell history, configuration files and git. It is a small
file-backed store: values are read from stdin and written to
`$OPENCODE_CONFIG_DIR/secrets/<NAME>` (default `~/.config/opencode/secrets`).

The kit never generates, downloads or writes a key by itself. `install.sh` and `install.ps1`
only install the launcher; `oc-secrets set` is the only command that writes a value.

## Quick start

```bash
# Store a value without putting it on the command line.
# The prompt hides the input; type or paste the value, then press Enter.
oc-secrets set CONTEXT7_API_KEY

# Or pipe it from a password manager CLI.
op read 'op://Private/Context7/api-key' | oc-secrets set CONTEXT7_API_KEY

oc-secrets get CONTEXT7_API_KEY      # print the value (scripts)
oc-secrets list                      # names only
oc-secrets check                     # names plus permission warnings, never values
oc-secrets rm CONTEXT7_API_KEY
```

## Commands

| Command | Behavior |
| --- | --- |
| `set <NAME>` | Reads the value from stdin. Refuses an empty value. Creates or overwrites the file atomically. |
| `get <NAME>` | Prints the value to stdout. Exits 1 when the secret does not exist. |
| `list` | Prints the sorted names. Never prints values. |
| `check` | Prints the names and warns when the directory is not 700 or a file is not 600. Exits 1 on a permission warning. Never prints values. |
| `rm <NAME>` | Deletes the secret. Exits 1 when it does not exist. |
| `export` | Prints `export NAME='value'` lines for `eval "$(oc-secrets export)"`. |
| `--help` | Prints the usage. |

Names must match `[A-Z0-9_]+`, so every name is also a valid environment variable name.
`set` reads the value from stdin, never from argv: `oc-secrets set NAME VALUE` is refused.
This keeps the value out of `ps` and out of shell history.

## Storage and permissions

- Directory: `$OPENCODE_CONFIG_DIR/secrets` (default `~/.config/opencode/secrets`), mode 700.
- Each secret: one file per name, mode 600, no trailing newline.
- The script sets `umask 077` and writes through a temporary file in the same directory
  before an atomic rename.
- The file backend stores **plain text**. Mode 600 protects against other users on the
  machine; it is **not encryption at rest**. Root, a disk image, a backup or malware running
  as your user can read the values.
- `list` and `check` never print values. `get` and `export` do, by design.

To use another config root, set `OPENCODE_CONFIG_DIR` for every call:

```bash
OPENCODE_CONFIG_DIR=/path/to/config oc-secrets set CONTEXT7_API_KEY
```

## Wire a secret into OpenCode

OpenCode expands `{env:VARIABLE_NAME}` in configuration values. If the variable is unset,
it becomes an empty string. Add the header to the server in your global
`~/.config/opencode/opencode.jsonc` or in a project `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "context7": {
        "type": "remote",
        "url": "https://mcp.context7.com/mcp",
        "oauth": false,
        "headers": {
          "CONTEXT7_API_KEY": "{env:CONTEXT7_API_KEY}"
        }
      }
    }
  }
}
```

The same pattern works for any server that accepts a key in a header:

```jsonc
"headers": {
  "Authorization": "Bearer {env:MY_API_KEY}"
}
```

Do not put the literal key in `opencode.jsonc`, even in a project file that is not committed:
`{env:...}` keeps the configuration portable and the secret in one place.

## Load the variables before starting OpenCode

OpenCode inherits its environment from the shell that starts it. Export the secrets in that
shell, then start OpenCode:

```bash
eval "$(oc-secrets export)"
opencode
```

A wrapper keeps the variables out of your other shells:

```bash
opencode-with-secrets() {
  eval "$(oc-secrets export)"
  command opencode "$@"
}
```

Do not add `eval "$(oc-secrets export)"` to `.bashrc` or `.zshrc` unless you accept every
shell having every key. `export` prints shell code generated from your own files; never
`eval` output from an untrusted source.

## Windows PowerShell equivalent

`oc-secrets` is a Bash script. On native Windows the kit is config-only, so use Git Bash or
WSL for the launcher, or load the same files from PowerShell before starting OpenCode:

```powershell
$dir = Join-Path $env:USERPROFILE ".config\opencode\secrets"
if (Test-Path -LiteralPath $dir) {
  Get-ChildItem -LiteralPath $dir -File | ForEach-Object {
    if ($_.Name -match '^[A-Z0-9_]+$') {
      Set-Item -Path "Env:$($_.Name)" -Value (Get-Content -Raw -LiteralPath $_.FullName)
    }
  }
}
opencode
```

The variables live only in that PowerShell session. Do not use `setx` for secrets: it writes
them to the user registry, where they are easier to read and harder to rotate. On Windows the
POSIX 600 mode is not a guarantee; restrict the folder with NTFS ACLs or use a credential
manager.

## Security notes

- **Not encrypted at rest.** Mode 600/700 is the whole protection of the file backend. Use
  full-disk encryption, a password manager or an OS keyring if you need more. OS keyring
  integration (macOS Keychain, Windows Credential Manager, libsecret) is on the roadmap.
- **Backups contain the secrets.** `oc-backup`, `install.sh` backups (`~/.config/opencode.bak-*`)
  and `uninstall.sh` moved directories (`~/.config/opencode.removed-*`) include the secrets
  directory because it lives inside the config. Protect or encrypt those archives. The
  `sha256` sidecar of `oc-backup` checks integrity, not confidentiality.
- **Rotate by overwriting.** Run `oc-secrets set NAME` again, then revoke the old key at the
  provider. The old file is replaced atomically.
- **Avoid leaks.** `get` and `export` print values to stdout. Do not run them in shared
  terminals, CI logs or shell traces. `list` and `check` are safe to show.
- **Prefer the prompt or a pipe.** Typing `printf 'value' | oc-secrets set NAME` puts the
  value in shell history. Use the hidden prompt or a password manager CLI.
- **The kit does not write keys.** No installer step creates, fetches or rotates a secret.
  The guard plugin blocks common secret files, but it is a textual safeguard, not a barrier.

## Related documents

- [Project configuration](project-config.md): `{env:...}`, `{file:...}` and project overrides.
- [README](../README.md#contents): the operational tools, including `oc-backup` and `oc-restore`.
- [Roadmap](../ROADMAP.md): OS keyring and encryption work.
