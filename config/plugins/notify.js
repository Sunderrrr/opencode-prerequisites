// Notification quand OpenCode a fini ou attend (utile avec plusieurs sessions en parallèle)
export const Notify = async ({ $ }) => ({
  event: async ({ event }) => {
    if (event.type !== "session.idle") return
    const msg = "OpenCode a fini / attend ta réponse"
    try {
      if (process.platform === "darwin") await $`osascript -e ${`display notification "${msg}" with title "OpenCode"`}`
      else await $`notify-send OpenCode ${msg}`
    } catch { process.stdout.write("\x07") } // à défaut : bip terminal
  },
})
