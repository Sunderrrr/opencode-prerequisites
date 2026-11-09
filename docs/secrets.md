# Secrets (oc-secrets)

`oc-secrets` keeps API keys out of shell history, configuration files and git. It has two
backends: the **OS keyring** (encrypted at rest by the operating system) and a **plain file**
store under `$OPENCODE_CONFIG_DIR/secrets`. `auto` picks the keyring when it is available and
falls back to files otherwise.

The kit never generates, downloads or writes a key by itself. `install.sh` and `install.ps1`
only install the launcher; `oc-secrets set` is the only command that writes a value.

## Quick start

```bash
oc-secrets backend                   # which backend is active, and why

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

If you already used an older version of the kit, move the existing files into the keyring once:

```bash
oc-secrets migrate
```

## Backends

Select the backend with `OC_SECRETS_BACKEND`:

| Value | Behavior |
| --- | --- |
| `auto` (default) | Use the OS keyring when its tool and session are available, otherwise the file backend. |
| `keyring` | Require the OS keyring. Commands fail with a clear error when it is unavailable. |
| `file` | Force the plain file backend, even when a keyring is available. |

Detection per platform:

| Platform | Keyring implementation | Available when | Stored at rest |
| --- | --- | --- | --- |
| Linux | Secret Service via `secret-tool` (libsecret) | `secret-tool` is in `PATH` **and** `DBUS_SESSION_BUS_ADDRESS` is set | In GNOME Keyring, KWallet or another Secret Service provider, encrypted by that keyring. No file is written. |
| macOS | Keychain via `security` | `security` is in `PATH` | In the login Keychain, encrypted by macOS. No file is written. |
| Windows (Git Bash, MSYS2, Cygwin) | DPAPI via PowerShell | `powershell.exe` or `powershell` is in `PATH` | `%USERPROFILE%\.config\opencode\secrets\<NAME>.dpapi`, encrypted with the Windows user key. |
| Any | File fallback | Always | `$OPENCODE_CONFIG_DIR/secrets/<NAME>`, mode 700/600, **plain text**. |

On Windows, `OPENCODE_CONFIG_DIR` overrides the directory; the default is
`$HOME/.config/opencode`, and Git Bash sets `HOME` to the user profile. The `.dpapi` files are
not plain text, but they are tied to the Windows user account and machine: copying them to
another account or computer does not work.

`oc-secrets backend` prints the active backend and the reason. It never prints a value:

```console
$ oc-secrets backend
Backend: keyring
Requested: auto
Reason: auto: secret-tool is installed and DBUS_SESSION_BUS_ADDRESS is set (linux secret-tool)
```

```console
$ oc-secrets backend
Backend: file
Requested: auto
Reason: auto: DBUS_SESSION_BUS_ADDRESS is not set; using the file backend
```

When `OC_SECRETS_BACKEND=keyring` is forced but the keyring is unavailable, `backend` exits 1
and reports `Backend: unavailable` with the reason.

## Commands

| Command | Behavior |
| --- | --- |
| `set <NAME>` | Reads the value from stdin. Refuses an empty value. Overwrites an existing entry. |
| `get <NAME>` | Prints the value to stdout. Exits 1 when the secret does not exist. |
| `list` | Prints the sorted names. Never prints values. |
| `check` | Prints the names. On the file backend, warns when the directory is not 700 or a file is not 600, and exits 1 on a warning. Never prints values. |
| `rm <NAME>` | Deletes the secret. Exits 1 when it does not exist. |
| `export` | Prints `export NAME='value'` lines for `eval "$(oc-secrets export)"`. Works with every backend. |
| `backend` | Prints the active backend and why. Never prints values. |
| `migrate` | Moves file secrets into the OS keyring, one by one, with verification and a backup. |
| `--help` | Prints the usage. |

Names must match `[A-Z0-9_]+`, so every name is also a valid environment variable name.
`set` reads the value from stdin, never from argv: `oc-secrets set NAME VALUE` is refused.
This keeps the value out of `ps` and out of shell history on Linux and Windows. On macOS the
`security` command itself only accepts the value on its command line (see the limitations).

## Migration from the file backend

`oc-secrets migrate` requires the keyring backend (explicitly selected, or chosen by `auto`).
It refuses to run when the active backend is the plain file store.

For each file secret it:

1. writes a backup of the whole secrets directory to
   `$OPENCODE_CONFIG_DIR/secrets-backup-<UTC timestamp>.tar` (mode 600, plain text);
2. stores the value in the keyring;
3. reads it back and compares it with the file;
4. deletes the file only when the values match.

A failed verification keeps the file in place, continues with the other names, and makes the
command exit 1 at the end. Running `migrate` again is safe: it reports `Nothing to migrate`
when the file store is empty.

```bash
oc-secrets backend                  # must say keyring
oc-secrets migrate
oc-secrets list                     # names now come from the keyring
oc-secrets get CONTEXT7_API_KEY     # value read from the keyring

# The backup is a plaintext tar: verify it, then delete it.
tar -tf ~/.config/opencode/secrets-backup-*.tar
rm ~/.config/opencode/secrets-backup-*.tar
```

To go back to the file backend, restore the backup and force the file backend:

```bash
mkdir -p ~/.config/opencode/secrets
tar -xf ~/.config/opencode/secrets-backup-<timestamp>.tar -C ~/.config/opencode/secrets
OC_SECRETS_BACKEND=file oc-secrets get CONTEXT7_API_KEY
```

## Storage and permissions

File backend:

- Directory: `$OPENCODE_CONFIG_DIR/secrets` (default `~/.config/opencode/secrets`), mode 700.
- Each secret: one file per name, mode 600, no trailing newline.
- The script sets `umask 077` and writes through a temporary file in the same directory
  before an atomic rename.
- The file backend stores **plain text**. Mode 600 protects against other users on the
  machine; it is **not encryption at rest**. Root, a disk image, a backup or malware running
  as your user can read the values.

Keyring backend:

- Linux and macOS write no secret file: values live in the OS keyring.
- Windows writes one encrypted `.dpapi` file per name in
  `%USERPROFILE%\.config\opencode\secrets`; the directory is mode 700 and the file mode 600
  on POSIX layers, but NTFS ACLs are the real access control.
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
shell having every key. `export` prints shell code generated from your own store; never
`eval` output from an untrusted source.

## Windows PowerShell equivalent

`oc-secrets` is a Bash script. Use Git Bash or WSL to run it. In Git Bash, `auto` uses Windows
DPAPI through `powershell.exe`, so no plain secret file is written. From native PowerShell,
call it through Git Bash or use a credential manager; the `.dpapi` blob is not portable.

The old plaintext snippet below only applies to the **file** backend. It reads
`%USERPROFILE%\.config\opencode\secrets` into the current PowerShell session:

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
them to the user registry, where they are easier to read and harder to rotate.

## Security notes

- **File backend: not encrypted at rest.** Mode 600/700 is the whole protection. Use full-disk
  encryption, a password manager or the keyring backend if you need more. The keyring raises
  the bar for stolen disks and backups; it does not protect against malware or a process
  running as your user while the keyring is unlocked.
- **Keyring availability is not a security boundary.** `auto` falls back to plain files when
  the keyring tool or session is missing (for example over SSH, in a container, or without a
  D-Bus session). Run `oc-secrets backend` to check what is actually active, and set
  `OC_SECRETS_BACKEND=keyring` to fail closed instead of silently falling back.
- **Backups contain secrets.** The `migrate` backup is a plaintext tar. `oc-backup`,
  `install.sh` backups (`~/.config/opencode.bak-*`) and `uninstall.sh` moved directories
  (`~/.config/opencode.removed-*`) include the file secrets directory because it lives inside
  the config. Keyring entries are not in the config directory, except the encrypted Windows
  `.dpapi` files. Protect or encrypt those archives. The `sha256` sidecar of `oc-backup`
  checks integrity, not confidentiality.
- **macOS passes the value in argv.** `security add-generic-password -w VALUE` is the only
  non-interactive form; for a brief moment the value is visible to `ps` for processes of the
  same user. Linux pipes the value to `secret-tool` on stdin and Windows pipes it to PowerShell
  on stdin, so it does not appear in a process argument list.
- **Rotate by overwriting.** Run `oc-secrets set NAME` again, then revoke the old key at the
  provider. The old entry is replaced.
- **Avoid leaks.** `get` and `export` print values to stdout. Do not run them in shared
  terminals, CI logs or shell traces. `list`, `check` and `backend` are safe to show.
- **Prefer the prompt or a pipe.** Typing `printf 'value' | oc-secrets set NAME` puts the
  value in shell history. Use the hidden prompt or a password manager CLI.
- **The kit does not write keys.** No installer step creates, fetches or rotates a secret.
  The guard plugin blocks common secret files, but it is a textual safeguard, not a barrier.

## Limitations

- **Linux** needs a running Secret Service and a session bus. Headless SSH sessions, minimal
  containers and some CI runners have neither; `auto` then uses plain files. `list` uses
  `secret-tool search` without `--unlock`, so locked entries may be omitted until unlocked.
  `get` unlocks on demand.
- **macOS** listing uses `security dump-keychain` metadata (never `-d`), so it can be slower
  on large keychains and only sees keychains the session can read. The value is passed to
  `security` on argv during `set`.
- **Windows** needs PowerShell 5+ for `ConvertFrom-SecureString`/`ConvertTo-SecureString`.
  Paths are converted with `cygpath -w`; Git Bash provides it. DPAPI blobs are tied to the
  user account and machine and cannot be moved to another profile.
- **Values are text.** The store is line-oriented shell data: names are `[A-Z0-9_]+` and
  values cannot contain NUL bytes. Multi-line values are supported by the keyring backends
  and by `export`.
- **The script is Bash 3.2-compatible** (macOS ships Bash 3.2). It does not use `mapfile`,
  associative arrays or `inherit_errexit`.

## Related documents

- [Project configuration](project-config.md): `{env:...}`, `{file:...}` and project overrides.
- [README](../README.md#contents): the operational tools, including `oc-backup` and `oc-restore`.
- [Security policy](../SECURITY.md): how to report a vulnerability.
