// Règles strictes appliquées par code (un prompt n'est qu'un conseil, un hook est une barrière)
const SECRET_FILES = /(^|\/)(\.env(\..+)?|id_rsa|id_ed25519|.*\.pem|credentials\.json)$/i
const DANGEROUS = [
  /\brm\s+-rf?\s+(\/|~|\$HOME)(\s|$)/,
  /\bgit\s+push\b.*--force(?!-with-lease)/,
  /\bgit\s+reset\s+--hard\b.*origin/,
  /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE)\b/i,
  /\bcurl\b[^|]*\|\s*(ba)?sh\b/,
]

export const Guard = async () => ({
  "tool.execute.before": async (input, output) => {
    const args = output.args ?? {}
    if (["read", "edit", "write"].includes(input.tool) && args.filePath && SECRET_FILES.test(args.filePath)
        && !args.filePath.endsWith(".env.example")) {
      throw new Error(`Accès refusé à un fichier de secrets : ${args.filePath}`)
    }
    if (input.tool === "bash" && typeof args.command === "string") {
      for (const re of DANGEROUS) {
        if (re.test(args.command)) throw new Error(`Commande bloquée par guard.js : ${args.command}`)
      }
    }
  },
})
