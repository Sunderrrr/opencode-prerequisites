// Minimal, safe JSONC reader: strips // and /* */ comments (outside strings) and trailing commas.
export function parseJsonc(text) {
  let out = ""
  let i = 0
  let inStr = false
  while (i < text.length) {
    const c = text[i], n = text[i + 1]
    if (inStr) {
      out += c
      if (c === "\\") { out += n ?? ""; i += 2; continue }
      if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') { inStr = true; out += c; i++; continue }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; continue }
    if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue }
    out += c
    i++
  }
  out = out.replace(/,(\s*[}\]])/g, "$1")
  return JSON.parse(out)
}

// Minimal YAML frontmatter: top-level "key: value" pairs.
// Accepts LF and CRLF (a Windows checkout may convert the Markdown files).
export function frontmatter(md) {
  const text = md.replace(/\r\n/g, "\n")
  const m = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (!m) return null
  const fm = {}
  for (const line of m[1].split("\n")) {
    const k = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (k) fm[k[1]] = k[2].trim()
  }
  return fm
}

// MCP servers: v2 form (mcp.servers) or legacy flat form (mcp.<name>), so both can be read.
export function mcpServers(cfg) {
  const m = cfg?.mcp ?? {}
  if (m.servers && typeof m.servers === "object") return m.servers
  return Object.fromEntries(Object.entries(m).filter(([k, v]) => k !== "timeout" && v && typeof v === "object"))
}
