// Compactage automatique à 90 % du contexte (réglable via OPENCODE_COMPACT_RATIO, ex. 0.85)
// Utilise l'événement message.updated (tokens du dernier message assistant) et client.session.summarize.
const RATIO = Number(process.env.OPENCODE_COMPACT_RATIO || 0.9)

export const AutoCompact = async ({ client }) => {
  const limits = new Map()      // "provider/model" -> taille de contexte
  const inFlight = new Set()    // sessions en cours de compactage

  async function contextLimit(providerID, modelID) {
    const key = `${providerID}/${modelID}`
    if (limits.has(key)) return limits.get(key)
    try {
      const res = await client.config.providers()
      for (const p of res.data?.providers ?? []) {
        for (const [id, m] of Object.entries(p.models ?? {})) {
          if (m?.limit?.context) limits.set(`${p.id}/${id}`, m.limit.context)
        }
      }
    } catch {}
    return limits.get(key)
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.compacted") {
        inFlight.delete(event.properties?.sessionID)
        return
      }
      if (event.type !== "message.updated") return
      const info = event.properties?.info
      if (!info || info.role !== "assistant" || !info.tokens) return

      const sessionID = info.sessionID
      if (!sessionID || inFlight.has(sessionID)) return

      const t = info.tokens
      const used = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) +
                   (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
      const limit = await contextLimit(info.providerID, info.modelID)
      if (!limit || used < limit * RATIO) return

      inFlight.add(sessionID)
      try {
        await client.session.summarize({
          path: { id: sessionID },
          body: { providerID: info.providerID, modelID: info.modelID },
        })
        await client.app.log({ body: { service: "auto-compact", level: "info",
          message: `Compactage lancé à ${Math.round((used / limit) * 100)} % du contexte` } })
      } catch (e) {
        inFlight.delete(sessionID)
        await client.app.log({ body: { service: "auto-compact", level: "warn", message: String(e) } })
      }
    },
  }
}
