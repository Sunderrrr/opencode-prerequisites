# Reverse engineering with REA

The kit ships an optional **reverse** pack around [REA (Reverse Engineer Anything)](https://github.com/morluto/rea), an MIT-licensed CLI and MCP server (npm package `rea-agents`, pinned here at **6.8.0**). REA inspects shipped artifacts — native binaries, JavaScript/Electron applications, .NET assemblies, Android APKs, firmware and network captures — and returns Evidence for every observation. The `reverse-engineer` agent drives it and writes the analysis.

The pack contains three parts:

| Part | What it is |
| --- | --- |
| `reverse-engineer` agent | The kit's own read-only analyst: legal scope, method, report format. |
| `reverse-engineer-anything` skill | Vendored **unmodified** from `rea-agents@6.8.0` (`config/skills/reverse-engineer-anything/`, MIT, see `UPSTREAM.md`). |
| `rea` MCP + `oc-rea` CLI | The pinned REA server (stdio) and the same toolset from a terminal. |

## Legal scope

Authorized analysis only: software you own or are authorized to examine, security research and coordinated disclosure, defensive malware analysis and incident response, CTF/training, interoperability, software preservation, and auditing your own applications.

The agent **refuses** to bypass a DRM, a license check, an anti-cheat or another technical protection measure; to produce cracks, keygens or license patches; to make game cheats; to bypass authentication on a system you are not authorized to test; to copy protected code; or to build malware or exploits against third parties. Unknown samples are never executed on the host: dynamic observation happens only in an isolated environment you designate. See REA's [DISCLAIMER](https://github.com/morluto/rea/blob/main/DISCLAIMER.md).

## Install and enable

```bash
./install.sh                    # full profile: the reverse pack is included
./install.sh --with reverse     # add it to a core/lite selection
./install.sh --without reverse  # remove the agent, skill and MCP from the selection
```

The pack is remembered in `<config>/.opencode-prerequisites.profile`. Restart OpenCode after installing: a running server does not reload agents or MCP servers.

### Node requirement

REA requires **Node `^22.23.4 || ^24.22.1 || >=26.12.1`**. The installer checks it and, if the version is too old, writes `"disabled": true` on the `rea` MCP (the rest of the kit still installs). Update Node and re-enable:

```bash
mise use -g node@26.12.1
./install.sh --no-tools
```

`oc-rea-mcp --check` and `oc-rea --check` test the version without downloading anything (exit 0/1).

## `oc-rea` CLI

`oc-rea` runs the pinned package through `npx -y`, so no global npm install is needed. The first run downloads `rea-agents` (the npm cache is reused afterwards).

```bash
oc-rea --version
oc-rea --help
oc-rea analyze-javascript-application /absolute/path/to/app --json
oc-rea inspect /absolute/path/to/binary --json
oc-rea --check                    # Node gate only: no download, no analysis
```

All arguments are passed through unchanged. The agent uses this CLI when the MCP server is unavailable (for example Node too old) and says so in its report.

## MCP server

`rea` is declared in `config/opencode.jsonc` and launched by `oc-rea-mcp`:

```jsonc
"rea": {
  "type": "local",
  "command": ["{env:HOME}/.local/bin/oc-rea-mcp"]
}
```

Its ~229 tools (`rea_*`) are **denied globally** and allowed only to the `reverse-engineer` agent, so other sessions do not carry that tool catalog. The MCP is part of the reverse pack: `./install.sh --without reverse` disables it.

## Skill and agent

- Skill: `config/skills/reverse-engineer-anything/` — method, tool catalog and per-target references (native, JavaScript, Android, firmware, runtime). It is a byte-for-byte copy of the upstream skill; `UPSTREAM.md` records the version and origin.
- Agent: `config/agents/reverse-engineer.md` — read-only, bash allowed, `rea_*` allowed, refuses out-of-scope work, separates observations, derivations, inferences and unknowns.

Keep the skill and the MCP at the same version: the skill describes the tools of `rea-agents@6.8.0`.

## Native engines are optional

REA uses the analysis engines already installed on the machine. The kit installs none of them:

- **Ghidra** (`ghidra`, `analyzeHeadless`), **IDA** (`ida`, `ida64`, `idat`, `idat64`) and **Hopper** (`hopper`) are detected by `./doctor.sh`; their absence is a warning, not an error.
- Static JavaScript/Electron, .NET and APK analysis needs no native engine.
- On Linux, REA expects a procps-compatible `ps` on `PATH` for process-ownership checks.

## Do not run `rea setup`

The kit owns the integration: `mcp.servers.rea` in `opencode.jsonc` and the vendored skill. `rea setup` (and `rea setup --install-hopper`) would write its own agent/skill files and can install Hopper; do not run it here. A read-only diagnostic is fine:

```bash
npx -y rea-agents@6.8.0 doctor --client opencode --json
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `oc-rea-mcp --check` exits 1 | Node is outside `^22.23.4 || ^24.22.1 || >=26.12.1`: update Node, then `./install.sh --no-tools`. |
| `rea` shows as disabled in `opencode.jsonc` | Same Node fix, then `./install.sh --no-tools` (or `./doctor.sh --fix`). |
| `opencode mcp list` does not show `rea` | The reverse pack is not selected (`./install.sh --with reverse`) or OpenCode was not restarted. |
| `oc-rea --version` is slow the first time | `npx` downloads `rea-agents` into the npm cache; later runs are fast. |
| MCP tools missing but CLI works | Restart OpenCode; check `oc-rea-mcp --check` and `./doctor.sh`. |
| No Ghidra/IDA/Hopper | Expected on a fresh machine: static JavaScript/.NET/APK analysis still works; install an engine only if you need native decompilation. |

`./doctor.sh` checks `oc-rea`, `oc-rea-mcp`, the Node gate and the optional engines when the reverse pack is selected. `oc-rea --version` is skipped in `--offline` mode because the first run may use the network.
