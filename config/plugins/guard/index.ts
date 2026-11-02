// Garde-fous appliqués par code (un prompt n'est qu'un conseil, un hook est une barrière).
// Plugin OpenCode v2 : dossier + export par défaut Plugin.define({ id, setup }).
import { Plugin } from "@opencode/plugin"

const SECRET_FILES = /(^|\/)(\.env(\..+)?|id_rsa|id_ed25519|.*\.pem|credentials\.json)$/i
const DANGEROUS = [
  /\brm\s+-rf?\s+(\/|~|\$HOME)(\s|$)/,
  /\bgit\s+push\b.*--force(?!-with-lease)/,
  /\bgit\s+reset\s+--hard\b.*origin/,
  /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE)\b/i,
  /\bcurl\b[^|]*\|\s*(ba)?sh\b/,
  /\bgit\s+stash\b/, // la pile de stash est partagée entre worktrees
  /\bgit\s+clean\s+-[a-z]*f[a-z]*x/,
]
// Le nom de l'outil shell est "shell" en v2 ("bash" en v1) : on accepte les deux.
const SHELL_TOOLS = new Set(["shell", "bash"])
const FILE_TOOLS = new Set(["read", "edit", "write", "apply_patch", "patch"])

export default Plugin.define({
  id: "opencode-prerequisites.guard",
  async setup(ctx) {
    const registration = await ctx.tool.hook("execute.before", (event) => {
      const input = event.input ?? {}
      const file = String(input.filePath ?? input.path ?? "")
      if (FILE_TOOLS.has(event.tool) && file && SECRET_FILES.test(file) && !file.endsWith(".env.example")) {
        throw new Error(`Accès refusé à un fichier de secrets : ${file}`)
      }
      const command = String(input.command ?? input.cmd ?? "")
      if (SHELL_TOOLS.has(event.tool) && command) {
        for (const re of DANGEROUS) {
          if (re.test(command)) throw new Error(`Commande bloquée par guard : ${command}`)
        }
      }
    })
    return () => registration.dispose()
  },
})
