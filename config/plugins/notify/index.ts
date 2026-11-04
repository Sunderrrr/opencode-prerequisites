// Notification quand une session rend la main (utile avec plusieurs sessions en parallèle).
// Plugin OpenCode v2 : dossier + export par défaut Plugin.define({ id, setup }).
import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"

// Message volontairement neutre : `session.idle` marque la fin d'un TOUR, pas la fin du travail.
// Le CEO délègue en arrière-plan et rend la main toutes les ~2 min alors que des sous-agents
// tournent encore ; l'événement ne permet pas de distinguer de façon fiable le tour d'une session
// parente de la fin d'une tâche. Annoncer « a fini » serait donc faux : on informe sans conclure.
const MESSAGE = "Tour rendu (vérifie les tâches en cours)"
const MIN_GAP_MS = 8000 // les sous-agents terminent aussi : on évite une notification par sous-agent

function notify() {
  if (process.platform === "darwin") {
    execFile("osascript", ["-e", `display notification "${MESSAGE}" with title "OpenCode"`], () => {})
  } else {
    execFile("notify-send", ["OpenCode", MESSAGE], (error) => {
      if (error) process.stdout.write("\x07") // à défaut : bip du terminal
    })
  }
}

export default Plugin.define({
  id: "opencode-prerequisites.notify",
  async setup(ctx) {
    const controller = new AbortController()
    let last = 0
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal, types: ["session.idle"] })) {
          const now = Date.now()
          if (event.type === "session.idle" && now - last > MIN_GAP_MS) {
            last = now
            notify()
          }
        }
      } catch {
        // abandon silencieux : une notification ne doit jamais gêner la session
      }
    })()
    return () => controller.abort()
  },
})
