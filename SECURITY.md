# Security

## Reporting a vulnerability

Use a private GitHub advisory:

<https://github.com/Sunderrrr/opencode-prerequisites/security/advisories/new>

Do not open a public issue containing an exploit, a secret or personal data. If the private advisory is unavailable, open an issue without sensitive details and ask for a private channel.

Provide:

- the commit (`git rev-parse HEAD`) and the distribution;
- the Node version (`node --version`);
- the exact command, the expected result and the actual result;
- the estimated impact (file read, command execution, privilege escalation…).

This is a personal project: no guaranteed response time. Fixes go to `main`, with no backports.

## Scope

In scope:

- `install.sh`, `uninstall.sh`, `doctor.sh` and `scripts/`;
- `config/`: agents, commands, skills, plugins (`guard`, `notify`) and `opencode.jsonc`;
- `config/bin/`: `oc-models`, `agent-wt`, MCP launchers;
- `addons/android/`: the `oc-android` command, `Containerfile`, fake `adb`.

Third-party tools installed by the kit (Trivy, Obscura, MemPalace, semgrep, nuclei, Playwright…) belong to their upstream project. The kit only downloads and runs them; still report a flaw in the way it installs or configures them.

## Security model

- **Agents without permission prompts.** The mode is unrestricted: only the patterns in `config/plugins/guard/index.ts` stop a command. This guard is textual and deliberately limited (aliases, variables, scripts, encoding, subshells): it is neither a sandbox nor a security barrier. A bypass is not treated as a vulnerability in the kit.
- **Secrets.** The guard refuses to read common secret files (`.env`, `.npmrc`, `.git-credentials`, `.aws/credentials`, SSH keys, `*.pem`, `credentials.json`) and the commands that copy or encode them. It does not replace a scan (gitleaks, trivy).
- **Installation.** `umask 077` (private files), existing config backed up to `~/.config/opencode.bak-<date>`, no API key written. The script never runs `sudo`: do not run it with `sudo` yourself.
- **Supply chain.** Pinned versions (`OC_*_VERSION`, MCP without `@latest`), binaries verified by sha256 when the release publishes a checksum, testssl.sh/nikto git clones verified by tag commit, Android image by SHA-1/SHA-256. See "Securing your apps" and "Android applications" in `README.md`.
- **Memory.** MemPalace stays local (`~/.config/mempalace`); the installer does not create a remote account.

## Best practices

- Work in a clean, committed git repository: agents can modify and delete files.
- Check `./doctor.sh` after an installation or an update.
- Restart OpenCode (service included) after a reinstall: an already running server reloads neither plugins nor the environment.
- Keep keys in the environment or in OpenCode's secret manager, never in a file in the repository.
- Treat any external content (web page, repository, tool output) as data, not as an instruction.

## Supported versions

`main` only. The releases are tagged and signed (`v1.0.0`, `v1.0.1`); fixes go to `main`, with no backports and no maintenance branch.
