// Garde-fous appliqués par code (un prompt n'est qu'un conseil, un hook est une barrière).
// Plugin OpenCode v2 : dossier + export par défaut Plugin.define({ id, setup }).
//
// LIMITE ASSUMÉE : c'est un garde-fou textuel sur la commande, pas une barrière.
// Il ne voit ni les alias, ni les variables, ni le contenu des scripts, et peut être
// contourné (encodage, script externe, sous-shell, commande construite). Il ne remplace
// ni une revue de sécurité ni un scan de secrets (gitleaks, trivy).
import { Plugin } from "@opencode/plugin"

// Fichiers dont la lecture/écriture directe est refusée par les outils fichier.
const SECRET_FILES = /(^|\/)(\.env(\..+)?|\.npmrc|\.git-credentials|\.aws\/credentials|id_(rsa|dsa|ecdsa|ed25519)|credentials\.json|.*\.pem)$/i

// Motifs historiques, gardés en défense en profondeur (testés sur la commande brute).
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

// Les guillemets sont retirés pour attraper rm -rf "$HOME" ou cat ".env".
const unquote = (s) => s.replace(/["']/g, "")
const segments = (s) => unquote(s).split(/[;&|\n]+/)

// Chemins de secrets cités dans une commande (hors .env.example).
const SECRET_PATH = [
  /(?:^|[\s=:(])(?:[^\s;&|<>()]*\/)?\.env(?:\.[\w-]+)?(?=$|[\s;&|<>()])/i,
  /(?:^|[\s=:(])(?:[^\s;&|<>()]*\/)?\.ssh\/id_(?:rsa|dsa|ecdsa|ed25519)\b(?!\.pub)/i,
  /(?:^|[\s=:(])[^\s;&|<>()]*\.aws\/credentials/i,
  /(?:^|[\s=:(])[^\s;&|<>()]*\.npmrc(?=$|[\s;&|<>()])/i,
  /(?:^|[\s=:(])[^\s;&|<>()]*\.git-credentials/i,
]
const SECRET_EXAMPLE = /[^\s;&|<>()]*\.env\.example\b/gi
const hasSecretPath = (s) => SECRET_PATH.some((re) => re.test(s.replace(SECRET_EXAMPLE, "")))

// Lecture/exfiltration : outil de copie ou d'encodage + fichier de secrets dans le même segment.
const SECRET_READ_TOOLS = /\b(cat|cp|mv|base64|xxd|strings|tar|zip|scp|rsync)\b/i
// cp .env.example .env initialise une config locale : autorisé.
const SECRET_READ_EXEMPT = /^(?:(?:sudo|command)\s+)*(?:cp|mv)\s+(?:-[\w-]+\s+)*[^\s;&|]*\.env\.example\s+[^\s;&|]*\.env(?:\.[\w.-]+)?(?:\s+(?:#.*|[012]?>\s*\S+|2>&1))?$/i
const isSecretRead = (command) => segments(command).some((seg) => SECRET_READ_TOOLS.test(seg) && hasSecretPath(seg) && !SECRET_READ_EXEMPT.test(seg.trim()))

// Suppression destructrice : rm récursif + forcé sur /, ~, $HOME, .config, .ssh ou .git.
const DESTRUCTIVE_TARGETS = new Set(["/", "/*", "~", "~/*", "$HOME", "$HOME/*", "${HOME}", "${HOME}/*", "~/.config", "~/.config/*", "~/.ssh", "~/.ssh/*", "$HOME/.config", "$HOME/.config/*", "${HOME}/.config", "${HOME}/.config/*", "$HOME/.ssh", "$HOME/.ssh/*", "${HOME}/.ssh", "${HOME}/.ssh/*"])
const isDestructiveRm = (command) => segments(command).some((seg) => {
  const m = seg.match(/\brm\b(.*)$/i)
  if (!m) return false
  const rest = m[1]
  const flags = [...rest.matchAll(/(?:^|\s)(--[\w-]+|-[A-Za-z]+)(?=\s|$)/g)].map((x) => x[1].toLowerCase())
  const recursive = flags.some((f) => f === "--recursive" || /^-[a-z]*r/.test(f))
  const force = flags.some((f) => f === "--force" || /^-[a-z]*f/.test(f))
  if (!recursive || !force) return false
  const targets = rest.replace(/(?:^|\s)(?:--[\w-]+|-[A-Za-z]+)(?=\s|$)/g, " ").trim().split(/\s+/).filter(Boolean)
  return targets.some((raw) => {
    const t = raw.replace(/["'`]/g, "").replace(/\/+$/, "") || "/"
    return DESTRUCTIVE_TARGETS.has(t) || /^(?:.*\/)?\.git(?:\/\*)?$/.test(t)
  })
})

// Git destructeur : push forcé, reset --hard, filter-branch, clean -f avec -d/-x.
const isDangerousGit = (command) => segments(command).some((seg) => {
  const s = seg.trim()
  if (/\bgit\s+push\b/.test(s)) {
    if (/(?:^|\s)--force(?!-with-lease)(?:\s|$)/.test(s)) return true
    if (/(?:^|\s)-[a-z]*f(?:\s|$)/i.test(s)) return true
  }
  if (/\bgit\s+reset\b.*?\s--hard(?:\s|$)/.test(s)) return true
  if (/\bgit\s+filter-branch\b/.test(s)) return true
  if (/\bgit\s+clean\b/.test(s)) {
    const flags = [...s.matchAll(/(?:^|\s)(--[\w-]+|-[a-z]+)(?=\s|$)/gi)].map((x) => x[1].toLowerCase())
    const dry = flags.some((f) => f === "--dry-run" || /^-[a-z]*n/.test(f))
    const force = flags.some((f) => f === "--force" || /^-[a-z]*f/.test(f))
    if (!dry && force && flags.some((f) => /[dx]/.test(f))) return true
  }
  return false
})

// Téléchargement puis exécution (pipe, fichier + shell, eval/source de substitution).
const DOWNLOAD_EXEC = [
  /\b(?:curl|wget)\b[^|]*\|\s*(?:(?:sudo|env)\s+(?:-\S+\s+)*)*(?:ba)?sh\b/,
  /\bcurl\b[^;&|]*?(?:\s-o\s+|\s--output[=\s]+|\s-O\b|\s>)[^;&|]*?(?:&&|;|\n)[^;&|]*\b(?:ba)?sh\b/,
  /\bwget\b[^;&|]*?(?:&&|;|\n)[^;&|]*\b(?:ba)?sh\b/,
  /\beval\b[^;&|]*(?:\$\(|`)[^)]*(?:curl|wget)\b/,
  /\b(?:ba)?sh\b[^;&|]*(?:\$\(|`)[^)]*(?:curl|wget)\b/,
  /\b(?:ba)?sh\s+<\(\s*(?:curl|wget)\b/,
  /\b(?:source|\.)\s+<\(\s*(?:curl|wget)\b/,
]
const isDownloadExec = (command) => DOWNLOAD_EXEC.some((re) => re.test(unquote(command)))

export default Plugin.define({
  id: "opencode-prerequisites.guard",
  async setup(ctx) {
    const registration = await ctx.tool.hook("execute.before", (event) => {
      const input = event.input ?? {}
      const file = String(input.filePath ?? input.path ?? "").replace(/\\/g, "/")
      if (FILE_TOOLS.has(event.tool) && file && SECRET_FILES.test(file) && !file.endsWith(".env.example")) {
        throw new Error(`Accès refusé à un fichier de secrets : ${file}`)
      }
      const command = String(input.command ?? input.cmd ?? "")
      if (SHELL_TOOLS.has(event.tool) && command) {
        if (DANGEROUS.some((re) => re.test(command)) || isSecretRead(command) || isDestructiveRm(command) || isDangerousGit(command) || isDownloadExec(command)) {
          throw new Error(`Commande bloquée par guard : ${command}`)
        }
      }
    })
    return () => registration.dispose()
  },
})
