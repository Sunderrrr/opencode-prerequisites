# OpenCode Desktop on Linux

OpenCode Desktop (Electron: `.deb`, `.rpm`, AppImage) can run the kit, but it is started by the
session manager, not by a terminal. `./install.sh --desktop` makes the GUI see the same `node`,
`npx`, `bash`, MCP servers and launchers as your shell.

## Why the GUI PATH differs

A terminal sources `~/.bashrc` or `~/.zshenv`. A desktop app inherits the systemd user-session
environment only: it never reads those files. Tools in `~/.local/bin` or a `mise` shim are then
missing, and MCP servers fail with `spawn ENOENT` or `npx not found` even though the same command
works in a terminal.

## Install

```bash
./install.sh --desktop              # add the wiring to an existing installation
./install.sh --no-tools --desktop   # config only
```

It writes two independent fixes:

- `~/.config/environment.d/90-opencode-prerequisites.conf` (mode 600): the `PATH` of the systemd
  user session, applied at the next login. It also exports `MEMPALACE_ADAPTER_PYTHON` when the
  venv exists. Only the tagged block belongs to the kit.
- `~/.local/share/applications/<app-id>.desktop`: a complete user override whose `Exec` starts
  with `env PATH="…"`, effective immediately. A pre-existing file is backed up as
  `<file>.bak-opencode-prerequisites`.

The launchers in `~/.local/bin` also source `libexec/desktop-env.sh`, so they work when started
from the GUI with a minimal `PATH`.

## After installing

**Fully quit OpenCode Desktop** (window *and* tray icon), then relaunch it: plugins and the
environment are read at startup. Open **Settings → Extensions** and check that the kit plugins are
listed. `./doctor.sh --desktop` verifies the wiring without network access.

## Wayland

If the window is blank or never appears, launch with `OC_ALLOW_WAYLAND=1 opencode-desktop`.

## AppImage and FUSE

An AppImage needs FUSE 2 (`libfuse2` on Debian/Ubuntu, `fuse2` on Arch/Fedora). Without it, use the
`.deb`/`.rpm`, or run `./opencode-desktop.AppImage --appimage-extract-and-run`. The installer
detects `opencode-desktop*.AppImage` in `~/Applications` and `~/Downloads` and points `Exec` and
`TryExec` at the absolute path.

## Flatpak / Snap

Unofficial and not supported by the kit: a sandbox cannot read `~/.local/bin` or
`~/.config/environment.d`, and `--desktop` cannot inject its `PATH` into the sandbox. Prefer the
official `.deb`, `.rpm` or AppImage.

## Troubleshooting

- `spawn ENOENT` or `npx not found` in an MCP server: run `./install.sh --desktop`, fully quit and
  relaunch, then `./doctor.sh --desktop` (`node`, `npx` and `bash` must resolve).
- Playwright MCP `MODULE_NOT_FOUND` or corrupt shared npx cache: the kit installs it in
  `~/.local/share/opencode-prerequisites/mcp/playwright`; run `oc-playwright-mcp --repair`
  (immediate workaround: `rm -rf ~/.npm/_npx/<hash>`, the hash shown in the error).
- The new `PATH` is not picked up: log out and back in, or run
  `systemctl --user import-environment PATH` and restart the app.
- Logs: `~/.config/ai.opencode.desktop/logs`.
- `./uninstall.sh` removes the wiring (with timestamped backups) and restores a pre-install
  `.desktop` file; reinstall to put it back.
