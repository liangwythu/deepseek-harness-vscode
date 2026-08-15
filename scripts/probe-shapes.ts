// One-off probe: dump the distinct SessionEvent types and one example of each
// from the live session history. Used to design the message renderers.
// NOT shipped — run with: npx tsx scripts/probe-shapes.ts
import { randomUUID } from 'node:crypto'

const BASE = 'http://127.0.0.1:3080'

async function rpc<V>(method: string, payload: unknown): Promise<V> {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
  })
  const env = await res.json() as { result: { ok: boolean; value?: V; error?: { message: string } } }
  if (!env.result.ok) throw new Error(`${method}: ${env.result.error?.message}`)
  return env.result.value as V
}

async function main(): Promise<void> {
  const sessions = await rpc<{ items: Array<{ sessionId: string; blank: boolean }> }>('session.list', {})
  const target = sessions.items.find(s => !s.blank) ?? sessions.items[0]
  if (!target) { console.log('no sessions'); return }
  console.log('session:', target.sessionId, 'blank:', target.blank)

  const h = await rpc<{ events: Array<{ event: { type: string; data: unknown } }> }>(
    'session.history', { sessionId: target.sessionId, maxMessages: 50 })

  const byType = new Map<string, unknown>()
  for (const { event } of h.events) {
    if (!byType.has(event.type)) byType.set(event.type, event.data)
  }
  console.log(`\n${h.events.length} events, ${byType.size} distinct types:\n`)
  for (const [type, data] of byType) {
    console.log(`=== ${type} ===`)
    // Truncate long strings for readability
    const truncate = (v: unknown, depth = 0): unknown => {
      if (typeof v === 'string') return v.length > 120 ? v.slice(0, 120) + `…(+${v.length - 120})` : v
      if (Array.isArray(v)) return v.length > 3 ? [...v.slice(0, 3).map(x => truncate(x, depth + 1)), `…(+${v.length - 3})`] : v.map(x => truncate(x, depth + 1))
      if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = truncate(val, depth + 1)
        return out
      }
      return v
    }
    console.log(JSON.stringify(truncate(data), null, 2))
    console.log()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
