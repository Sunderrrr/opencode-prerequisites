# Origin

Vendored from **mattpocock/skills** — https://github.com/mattpocock/skills — at commit
`abeeaf95660ba9e8b7c753eb38f441ca707a8823` (MIT, © 2026 Matt Pocock).

- Upstream path: `skills/engineering/improve-codebase-architecture/`.
- Vendored on: **2026-11-23**, from the clone at `/tmp/opencode/matt-skills`.
- License: **MIT** (`LICENSE`, kept verbatim, © 2026 Matt Pocock).
- Pack: `architecture` (opt-in, included in the full profile, absent from core/lite).
- Related skills in the same quartet: `codebase-design`, `grilling`, `domain-modeling`.

## Vendored files

- `SKILL.md` (6,028 bytes upstream).
- `HTML-REPORT.md` (6,641 bytes).
- `agents/openai.yaml` (166 bytes): Codex metadata, ignored by OpenCode, kept as-is.
- Added locally: `LICENSE`, this `UPSTREAM.md`.

## Local modifications

- Removed the `disable-model-invocation` frontmatter key from `SKILL.md` so the
  model can auto-invoke the skill (OpenCode would otherwise hide it from automatic
  selection). Nothing else in the frontmatter changed; the rest of the file is verbatim.
- **Not** changed: `agents/openai.yaml` still carries
  `policy.allow_implicit_invocation: false`. Codex therefore keeps explicit-only
  invocation; OpenCode ignores that file and can auto-invoke. This divergence is
  intentional (the brief asked to keep the file verbatim).
- The body still uses Claude Code vocabulary: "Call the Skill tool with
  `codebase-design`", `/codebase-design`, "spawn a sub-agent". In OpenCode, load the
  sibling skills with the `skill` tool and delegate with the `subagent` tool; the
  intent is unchanged.

No script, binary or remote installer is vendored: the skill contains no executable
file and no network downloader command.

## Dependencies

- Sibling skills: `codebase-design` (vocabulary and design-it-twice pattern),
  `grilling` (decision-tree interview), `domain-modeling` (glossary and ADR upkeep).
  All three are in the same `architecture` pack.
- A subagent tool with a fresh context window (OpenCode `subagent`) for the
  exploration pass; `codebase-design`'s design-it-twice pattern asks for 3+ parallel
  subagents.
- `git log` (optional) to find hot spots when the user names no scope.
- A browser (or just a path) to read the generated HTML report.

## Report path and network / CSP risk

- The report is written **outside the repository**, to
  `<tmpdir>/architecture-review-<timestamp>.html`, where `<tmpdir>` is `$TMPDIR`,
  falling back to `/tmp` (or `%TEMP%` on Windows). The skill then opens it with
  `xdg-open` (Linux), `open` (macOS) or `start` (Windows) and prints the absolute
  path. In a headless environment, print the path instead of opening a browser.
- The HTML pulls **Tailwind** from `https://cdn.tailwindcss.com` and **Mermaid 11**
  from `https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs` **at view
  time**. There is no vendored copy.
  - Offline, or behind a restrictive CSP (`script-src 'self'`), the page renders
    unstyled and the Mermaid diagrams do not appear. The text content is still there.
  - `cdn.tailwindcss.com` is the Tailwind browser/CDN build, meant for prototypes, not
    production; it is only loaded in a local report.
  - Mermaid is initialised with `securityLevel: "loose"`, which allows HTML and click
    interactions inside diagram labels. The report is built from local code and model
    output, but code comments and glossary text can end up in it: do not point the
    audit at untrusted repositories and then open the report with a privileged browser
    profile. No data is uploaded by the report itself beyond the CDN requests.
- No evidence is collected by script: the model explores the codebase with its own
  tools and writes the HTML itself.

## Risks

- **Token cost**: the exploration pass reads a lot of the repository and renders a long
  HTML document; scope it to a named area when possible.
- **Report drift**: the "before/after" diagrams are model-drawn illustrations, not a
  measured dependency graph. Verify the proposed module boundaries before acting.
- **Repository writes during the grilling loop**: once a candidate is picked, the
  sibling `domain-modeling` skill can create or edit `GLOSSARY.md` and `docs/adr/` in
  the audited repository. The report itself stays outside the repository.
- **`--with-matt` duplication**: `install.sh --with-matt` runs
  `npx skills add mattpocock/skills`, which installs same-named skills into the same
  OpenCode skills directory and can overwrite this vendored copy (including the
  frontmatter edit above). Do not combine `--with-matt` with `--with architecture`.
