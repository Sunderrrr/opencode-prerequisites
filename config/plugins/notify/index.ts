// Notification quand une session est terminée ou attend (utile avec plusieurs sessions en parallèle).
// Plugin OpenCode v2 : dossier + export par défaut Plugin.define({ id, setup }).
import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"

const MESSAGE = "OpenCode a fini / attend ta réponse"
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
