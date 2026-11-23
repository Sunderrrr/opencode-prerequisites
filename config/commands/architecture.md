---
description: Map/audit the codebase architecture with an HTML report
---
Audit the architecture of the area or scope given in `$ARGUMENTS` (a module, a subsystem,
a path, or a pain point; default to the current repository and its recently changed
hot spots).

Load the `improve-codebase-architecture` skill (`skill({ name: "improve-codebase-architecture" })`)
and follow it. It brings the `codebase-design` vocabulary and, once a candidate is
picked, the `grilling` and `domain-modeling` skills.

Rules for the run:

- **Scope first.** Use the area named in `$ARGUMENTS`; otherwise walk `git log` for hot
  spots and say which paths you chose. Read `GLOSSARY.md` and the ADRs in the area
  before scanning.
- **Fresh subagent for exploration.** Give one `subagent` a self-contained brief (scope,
  vocabulary, what friction to look for, output format) and let it explore with a fresh
  context window. Do not scan the whole repository in the parent context.
- **Report outside the repository.** Write the self-contained HTML report to the OS
  temp directory (`${TMPDIR:-/tmp}/architecture-review-<timestamp>.html`, `%TEMP%` on
  Windows), never inside the audited tree. Tell the user the absolute path.
- **Headless**: if no display or browser is available (`$DISPLAY`/`$WAYLAND_DISPLAY`
  empty, or the open command fails), print the absolute path instead of opening a
  browser. Never fail the run because the report could not be opened.
- **No scripts, no downloads.** The report loads Tailwind and Mermaid from CDNs at view
  time; nothing is fetched while producing it. Offline or under a restrictive CSP the
  page is unstyled and the diagrams are missing, but the text remains.
- Finish with the short report (Done / Proof / Remaining / Questions), the report path,
  the candidate titles with their recommendation strength, and the top recommendation.
  Do not implement a refactor: the command maps and audits, it does not change code.
