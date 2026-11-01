// Lecteur JSONC minimal et sûr : retire commentaires // et /* */ (hors chaînes) et virgules finales.
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

// Frontmatter YAML minimal : clés de premier niveau "clé: valeur".
export function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/)
  if (!m) return null
  const fm = {}
  for (const line of m[1].split("\n")) {
    const k = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (k) fm[k[1]] = k[2].trim()
  }
  return fm
}
