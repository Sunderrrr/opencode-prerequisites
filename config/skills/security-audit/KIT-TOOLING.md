# Kit tooling for the security audit

What is actually installed on a kit machine, the exact command to run, and what to say when a
tool is missing. The audit never installs anything and never lets a build fetch dependencies;
tools listed here are host tools installed beforehand by `./install.sh` (core) or
`./install.sh --pentest` (dynamic set).

## Installed tools and exact commands

Versions observed on the reference machine (2026-11-23): `gitleaks` 8.30.1, `semgrep`,
`osv-scanner` 2.7.0, `trivy` 0.76.1, `nuclei` 3.11.1, `httpx`, `ffuf` 2.3.0. Treat the versions
as indicative: report the one you ran (`<tool> --version`), never a remembered version.

### Static, safe on any source (no target execution)

| Tool | Command | Use |
| --- | --- | --- |
| `gitleaks` (MIT) | `gitleaks detect --source . --no-banner --redact` | committed secrets, including git history. `--redact` keeps the value out of the log: cite the rule ID and the location, never the secret |
| `semgrep` (LGPL-2.1) | `semgrep --config p/owasp-top-ten --error <path>` | SAST. `--config auto` downloads rules from the Semgrep registry: it needs network and sends nothing about the target except rule selection, but prefer a pinned config file for reproducible runs |
| `osv-scanner` (Apache-2.0) | `osv-scanner scan source -r .` | vulnerable dependencies via the OSV database (v2 syntax; `-r` is still accepted) |
| `trivy` (Apache-2.0) | `trivy fs --scanners vuln,secret,misconfig --quiet .` | dependencies, secrets in the tree, IaC misconfiguration. `trivy image <image>` for a container |
| `trivy` MCP | `scan_filesystem`, `scan_repository`, `scan_image`, `findings_list`, `findings_get`, `trivy_version` | same scans from the agent, results kept in batches (read-only: it scans, it does not modify the target) |

Static tools read files. They are allowed on the user's own code without a sandbox; they must
still never be pointed at a third party's source you were not given.

### Dynamic, only inside the authorization scope

`@pentest` owns these; `@security` does not run them. Every one of them needs the owner of the
target and the authorization basis in the brief, and the sandbox rule below.

| Tool | Command | Use |
| --- | --- | --- |
| `httpx` | `httpx -u <url> -status-code -title -tech-detect` | is it up, what does it answer, which technology |
| `nuclei` | `nuclei -u <url> -tags cve,exposure,misconfig -severity high,critical` | known CVEs and frequent exposures. Never the `dos`/`fuzz` tags |
| `ffuf` | `ffuf -u <url>/FUZZ -w <wordlist> -rate 20 -mc 200,204,301,302,403` | hidden content; keep the rate low |
| `testssl.sh` (GPLv2) | `testssl.sh --quiet --severity HIGH <host:port>` | TLS/SSL configuration |
| `nikto` (GPLv2) | `nikto -h <url> -nointeractive` | server-side bad configs and dangerous files |
| `nmap` | `nmap -sV -T4 --open <host>` | exposed services. Never `-A` or intrusive scripts without an explicit request |
| `sqlmap` | `sqlmap -u '<url>?id=1' --batch --risk=1 --level=1` | one parameter already identified as suspicious. Never raise `--risk`/`--level`, never `--os-shell`/`--sql-shell` |

## Sandbox rule before executing anything local

Before running a target-controlled build, test, server, fuzzer or fixture processor:

1. An OS-enforced sandbox must be available and named: no external network, an allowlisted
   environment, a scratch-only write area, and CPU/memory/process/wall-clock limits.
2. The kit does not provide one (`KIT-ENVIRONMENT.md`). If the user did not supply one, do
   **not** execute: fall back to static analysis and record the missing control in the
   report.
3. The dynamic tools above run against a **local/staging** target inside the scope, with the
   rate limited, never against production, never against a shared service.

## Missing tool fallback

Check before using, never assume:

```bash
command -v gitleaks semgrep osv-scanner trivy nuclei httpx ffuf testssl.sh nikto nmap sqlmap >/dev/null 2>&1 || true
for t in gitleaks semgrep osv-scanner trivy nuclei httpx ffuf testssl.sh nikto nmap sqlmap; do
  command -v "$t" >/dev/null 2>&1 && printf 'ok      %s\n' "$t" || printf 'missing %s\n' "$t"
done
```

For each missing tool, write one line in the report:

```text
missing tool: <name> — not on PATH — get it with <./install.sh --pentest | your package manager>
```

and say which check it was supposed to answer, so the gap is visible as a coverage gap, not a
silent "nothing found". `nmap` and `sqlmap` are system packages: the kit prints a hint but
never installs them with `sudo`.

## MCP inventory

| Server | Shape | Audit use |
| --- | --- | --- |
| `trivy` | local, `trivy mcp`, scan-only | dependency, secret and IaC scans; findings kept in batches |
| `semgrep` | local, official Semgrep MCP 0.9.0 (`oc-semgrep-mcp`) | SAST. `semgrep_*` is `deny` globally in `opencode.jsonc` and allowed only for `@pentest`; `@security` uses the `semgrep` binary |
| `kubernetes` | local, `kubernetes-mcp-server@0.1.3` with `config/k8s-mcp.toml` | **read-only** cluster inspection: `read_only = true`, and the `Secret` kind is in `denied_resources`, so a Secret is never returned |
| `terraform` | local | provider/module documentation, not target scanning |
| `context7`, `grep_app` | remote | library docs and code examples |
| `rea` | local, reverse pack | shipped-artifact analysis only, `@reverse-engineer` only |
| `playwright`, `chrome-devtools`, `obscura` | local | UI/browser work; dynamic web testing needs the scope rule above |

Anything not in this list is not installed: do not invent an MCP tool name, do not call one
you have not seen in the tool list.

## Traceability format

Every executed check produces one ledger line, written in the report or the run's
`coverage-ledger.json`:

```text
<UTC ISO-8601> | <agent-id> | <tool> | <exact command> | <target> | exit <code> | <result digest> | <path to raw output>
```

Rules:

- The command is recorded **verbatim**, including flags: a reader must be able to rerun it.
- The digest is a count and a severity spread (`3 high, 1 medium; 2 confirmed, 1 needs_validation`),
  never the payload. Raw output stays in the run directory, outside the repository.
- One tool run = one line. A command that failed is recorded with its exit code and the first
  error line: a missing tool is a result, not a silence.
- Secrets are redacted in the line (`[redacted]`) and the location is kept.
- A claim without a ledger line is not evidence: it goes to `needs_validation`.
