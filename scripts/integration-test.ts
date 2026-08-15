/**
 * Integration test — exercises the REAL extension source (HarnessClient +
 * SessionModel) against the running dsh web, without the webview/VS Code layer.
 *
 * Run:  npx tsx scripts/integration-test.ts
 *
 * Validates that the production code path (not just the spike's mini-client)
 * completes the §2 closed loop: connect → workspace → session → history →
 * prompt → live events fold → snapshot → cancel.
 */

import { HarnessClient } from '../src/harness/client.ts'
import { SessionModel, type RenderItem } from '../src/session.ts'

const HOST = process.env.DSH_HOST ?? '127.0.0.1'
const PORT = Number(process.env.DSH_PORT ?? 3080)
const TEST_CWD = process.env.TEST_CWD ?? 'e:\\deepseek\\workspace_test'

const log: string[] = []
const client = new HarnessClient({ host: HOST, port: PORT, log: (m) => log.push(m) })

let step = 0
function check(name: string, ok: boolean, detail = ''): void {
  step += 1
  console.log(`${ok ? '✓' : '✗'} ${String(step).padStart(2, '0')} ${name}: ${detail}`)
  if (!ok) { console.log('\nINTEGRATION TEST FAILED'); process.exit(1) }
}

async function main(): Promise<void> {
  console.log(`\nDeepSeek Harness integration test → http://${HOST}:${PORT}\n`)

  // 1. Security boundary: non-loopback is refused.
  const evil = new HarnessClient({ host: '0.0.0.0', port: PORT, log: () => {} })
  try { await evil.connect(); check('loopback fence', false, '0.0.0.0 was accepted') }
  catch (e) { check('loopback fence', /local DeepSeek Harness/i.test((e as Error).message), (e as Error).message) }

  // 2. Connect + state.
  await client.connect()
  const conn = client.getState()
  check('connect', conn.kind === 'connected', conn.kind === 'connected' ? `v${conn.describe.version}` : conn.kind)

  // 3. Resolve (or create) a workspace for the test cwd.
  const { items } = await client.listWorkspaces()
  let ws = items.find(w => w.path.toLowerCase().replace(/\//g, '\\') === TEST_CWD.toLowerCase())
  if (!ws) {
    const created = await client.createWorkspace(TEST_CWD)
    ws = created.workspace
    check('create workspace', true, `created=${created.created} id=${ws.workspaceId.slice(0, 8)}`)
  } else {
    check('create workspace', true, `resolved existing id=${ws.workspaceId.slice(0, 8)}`)
  }

  // 4. Create a fresh session in this workspace (so the test is hermetic).
  const created = await client.createSession({ workspaceId: ws.workspaceId })
  const sessionId = created.sessionId
  check('create session', true, `id=${sessionId.replace(/^session-/, '').slice(0, 8)}`)

  // 5. Load history (empty for a brand-new session) and subscribe.
  const model = new SessionModel(sessionId)
  const history = await client.getHistory(sessionId, { maxMessages: 50 })
  model.loadHistory(history.events.map(e => e.event))
  check('history load', true, `${history.events.length} event(s)`)

  // 6. Subscribe to live frames; fold into the model.
  let receivedAssistant = false
  let receivedTurnEnd = false
  const sub = client.subscribe(sessionId, (frames) => {
    for (const f of frames) {
      const frame = f as { type?: string; sessionId?: string; event?: { type?: string } }
      if (frame.type === 'session/event' && frame.sessionId === sessionId && frame.event) {
        model.applyEvent(frame.event as never)
        if (frame.event.type === 'assistant/message' || frame.event.type === 'assistant/chunk') receivedAssistant = true
        if (frame.event.type === 'turn/end') receivedTurnEnd = true
      }
    }
  })

  // 7. Send a prompt and wait for the turn to end (or timeout).
  const promptText = `[integration-test] reply with exactly: pong ${Date.now()}`
  await client.prompt(sessionId, promptText, 'UTC')
  check('prompt sent', true, `"${promptText.slice(0, 40)}…"`)

  const deadline = Date.now() + 30000
  while (!receivedTurnEnd && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
  }
  check('live events folded', receivedAssistant, receivedAssistant ? 'assistant frames received' : 'no assistant frames')
  check('turn/end observed', receivedTurnEnd, receivedTurnEnd ? 'turn ended' : 'timed out at 30s (may still be running)')

  // 8. Snapshot the model and verify it contains our prompt.
  const snap = model.snapshot()
  const userItem = snap.items.find(i => i.kind === 'user' && i.text.includes('[integration-test]'))
  const assistantItem = snap.items.find(i => i.kind === 'assistant' && !i.streaming)
  check('snapshot has user msg', !!userItem, `seq=${userItem?.seq ?? -1}`)
  check('snapshot has assistant msg', !!assistantItem, `seq=${assistantItem?.seq ?? -1} text="${(assistantItem as { text?: string })?.text?.slice(0, 40) ?? ''}…"`)

  console.log('\n--- final snapshot items ---')
  for (const item of snap.items as RenderItem[]) {
    const preview = 'text' in item ? item.text.slice(0, 60) : ''
    console.log(`  [${item.kind}] seq=${item.seq} ${preview ? '· ' + preview : ''}`)
  }

  // 9. Cancel (no-op if already ended) to validate the wire.
  await client.cancel(sessionId)
  check('cancel', true, 'accepted')

  sub.dispose()
  client.dispose()

  console.log('\n────────────────────────────────────────')
  console.log('  integration test passed — Browser ↔ Harness ↔ VS Code closed loop OK')
  console.log('────────────────────────────────────────\n')
}

main().catch((e) => {
  console.error('\nINTEGRATION TEST ERROR:', e)
  try { client.dispose() } catch { /* noop */ }
  process.exit(1)
})
