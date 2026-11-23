# Upstream provenance - code-mode

This skill is original content for this kit. Nothing is vendored or reproduced.

## Source

- Article: "Code Mode: the better way to use MCP", Cloudflare Blog.
- URL: <https://blog.cloudflare.com/code-mode/>
- Authors: Kenton Varda and Sunil Pai.
- Published: 2025-09-26. Last modified: 2026-11-09 (from the page's `BlogPosting` metadata,
  checked 2026-11-23).
- Product documentation: <https://developers.cloudflare.com/agents/tools/codemode/>,
  with the MCP integration at <https://developers.cloudflare.com/agents/tools/codemode/mcp/>.
  The documentation marks Code Mode as experimental.

## Summary in original wording

- Exposing tool definitions directly to a model is limited: the tool-call tokens are rare in
  training data, complex catalogs are hard to use, and every result must travel back through
  the model.
- Cloudflare converts an MCP server's schema into a TypeScript API with doc comments, gives
  the model a single code-execution tool, and lets it write the program that composes the
  calls.
- The program runs in a V8 isolate with no Internet access. It reaches the connected MCP
  servers through RPC bindings; the supervisor adds the access tokens, so the generated code
  never holds a key.
- The isolate is created per execution and discarded, which makes the sandbox cheap; the
  Worker Loader API is what allows code to be loaded on demand.
- Cloudflare reports that models handle more tools, and more complex ones, this way, and that
  the gain grows when calls must be chained.

## What this skill changes

The article describes the Agents SDK implementation (Workers, isolates, bindings). OpenCode
and Claude Code expose each MCP server as individual tools and offer no code-execution API.
The skill therefore keeps the pattern, not the implementation: a short script calls the API
or CLI under the server, and the agent reads only the summary. The sandbox and the
credential-hiding binding must be recreated with a container and an environment variable, or
accepted as missing; `SKILL.md` states this limit.

## License

No explicit license is stated on the article page or in its footer (checked 2026-11-23);
the general Cloudflare website terms apply. This directory therefore contains a summary and
original recommendations only, with no reproduction of the article. The product
documentation is referenced by URL, not copied.

The text in this directory is original to this kit and covered by the repository's MIT
license (copyright 2026 Sunderrrr, see `LICENSE`); it is not a Cloudflare work. The local
`LICENSE` file is the kit license, kept here so every vendored or original skill with an
`UPSTREAM.md` carries its terms.

## Maintenance

- Written: 2026-11-23.
- Revisit if Cloudflare moves the documentation URL, or if OpenCode or Claude Code gain a
  Code Mode surface. In that case update `SKILL.md` and `docs/code-mode.md` together.
