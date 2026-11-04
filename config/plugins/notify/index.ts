// Notification when a session hands back (useful with several sessions in parallel).
// OpenCode v2 plugin: folder + default Plugin.define({ id, setup }) export.
import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"

// Deliberately neutral message: `session.idle` marks the end of a TURN, not the end of the work.
// The CEO delegates in the background and hands back every ~2 min while subagents are still
// running; the event cannot reliably tell a parent session's turn from the end of a task.
// Announcing "finished" would be false: we inform without concluding.
const MESSAGE = "Turn finished (check running tasks)"
const MIN_GAP_MS = 8000 // subagents also finish: avoid one notification per subagent

function notify() {
  if (process.platform === "darwin") {
    execFile("osascript", ["-e", `display notification "${MESSAGE}" with title "OpenCode"`], () => {})
  } else {
    execFile("notify-send", ["OpenCode", MESSAGE], (error) => {
      if (error) process.stdout.write("\x07") // fallback: terminal bell
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
        // silent give-up: a notification must never disturb the session
      }
    })()
    return () => controller.abort()
  },
})
