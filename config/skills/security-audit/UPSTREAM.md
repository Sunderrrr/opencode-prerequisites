# Origin

Vendored from **security-audit-skill** — https://github.com/cloudflare/security-audit-skill —
at commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` ("Clarify guidance and full audit modes").

- Vendored on: **2026-11-23**, from a full clone checked out at that SHA.
- License: **MIT**, © 2025-2026 Cloudflare, Inc. (`LICENSE`, kept verbatim from the repo root).
- Skill directory: `skills/security-audit/`.
- Size: **20 files, 314,670 bytes** (15 `.md`, `report-schema.json`, 4 `.cjs`). The complete
  upstream checkout is 22 files / 322,698 bytes: the same 20 files plus `README.md`
  (6,950 B) and `LICENSE` (1,078 B).

## Vendored files

Copied verbatim from the upstream `skills/security-audit/` directory:

- `SKILL.md` (only local change: a "Kit additions" section appended at the end).
- `RECONNAISSANCE.md`, `HUNTING.md`, `ATTACK-CLASSES.md`, `VALIDATION-AND-REPORTING.md`.
- Domain companions: `MEMORY-SAFETY-AND-BINARY.md`, `AI-AND-LLM.md`,
  `WEB-PROTOCOL-AND-AUTH.md`, `CLIENT-SIDE.md`, `SUPPLY-CHAIN-AND-RELEASE.md`,
  `CLOUD-AND-DEPLOYMENT.md`, `PROTOCOLS-RPC-AND-MESSAGING.md`,
  `RESOURCE-EXHAUSTION-AND-AVAILABILITY.md`, `DATA-ISOLATION-AND-LIFECYCLE.md`,
  `DESKTOP-MOBILE-AND-LOCAL-IPC.md`.
- `report-schema.json` — the contract for `findings.json`, **the reference**: the kit adds
  no schema of its own.
- `validate-findings.cjs` and `validate-coverage-ledger.cjs` (executable bits kept, `0755`).
- `validate-findings.test.cjs` and `validate-coverage-ledger.test.cjs` (`0644`).

Verified byte-identical to upstream with `diff -r`; only the added `LICENSE` differs.

Excluded from upstream:

- `README.md` — the upstream overview is replaced by the kit's `docs/security-audit.md`,
  which also covers the kit-specific mapping (packs, agents, sandbox limits, Node version).

Added at the skill root: `LICENSE`, this `UPSTREAM.md`, `KIT-ENVIRONMENT.md`,
`KIT-TOOLING.md`, `KIT-REPORTING.md`.

## Local modifications

- Appended a short **"Kit additions"** section at the end of `SKILL.md` that points to the
  three `KIT-*.md` files. No upstream sentence was changed.
- Nothing else. The validators, the schema and every hunting prompt are upstream text.

## Risks

- **No OS sandbox in the kit.** The upstream safety model requires an OS-enforced sandbox
  (no network, empty environment, read-only target, resource limits) before running
  target-controlled code. OpenCode provides none, so the kit opens **static mode only**
  unless the user supplies one. See `KIT-ENVIRONMENT.md`.
- **322 KB / 20 files** in a skill directory: loading the full skill and its companions is
  expensive in context. Load `SKILL.md` plus only the companions the target needs.
- **POSIX test paths.** Both test files skip their FIFO and symlink cases on Windows, and
  they call `mkfifo` for the FIFO test; `O_NOFOLLOW`/`O_NONBLOCK` availability is checked at
  runtime. The validators reject FIFOs, symlinks and hard links.
- **Needs subagents.** Phases 2, 3 and 5 delegate hunters, verifiers and record verifiers to
  fresh agents. The kit runs with `experimental.subagent_depth: 1` and `security`/`pentest`
  have `task: deny`, so the **CEO** must be the parent and spawn fresh `security` sessions.
- **Output defaults outside the repo** (`~/security-audit-skill/<repo>/run-<N>`). Never let a
  run write inside the audited repository unless the user explicitly chooses a path that
  version control ignores.
- **No network primitive in the vendored files.** They contain no HTTP client, no downloader
  and no JavaScript `fetch` call: the skill never reaches the network by itself, it only
  instructs the agent. Tool invocation and network reach therefore depend entirely on the
  host agent and on the authorization scope.
