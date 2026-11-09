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

// Windows toast without an npm dependency or the BurntToast module: Windows PowerShell 5.1
// loads the WinRT notification API. The registered PowerShell AUMID lets the toast appear
// without registering an application in the Start menu. Best effort: on Server Core or a
// locked-down host the call fails and we fall back to the terminal bell.
function notifyWindows() {
  const quote = (value) => `'${value.replace(/'/g, "''")}'`
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$nodes = $template.GetElementsByTagName('text')",
    `$nodes.Item(0).AppendChild($template.CreateTextNode(${quote("OpenCode")})) | Out-Null`,
    `$nodes.Item(1).AppendChild($template.CreateTextNode(${quote(MESSAGE)})) | Out-Null`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($template)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
  ].join("; ")
  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    { timeout: 5000, windowsHide: true },
    (error) => {
      if (error) process.stdout.write("\x07") // fallback: terminal bell
    },
  )
}

function notify() {
  if (process.platform === "darwin") {
    execFile("osascript", ["-e", `display notification "${MESSAGE}" with title "OpenCode"`], () => {})
  } else if (process.platform === "win32") {
    notifyWindows()
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
