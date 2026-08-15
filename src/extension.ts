/**
 * DeepSeek Harness Connector v0.0.2 — extension entry point.
 *
 * WIRING ONLY. This file should contain nothing beyond:
 *   • activate() / deactivate()
 *   • readConfig()
 *   • command registration
 *   • dependency instantiation + wiring
 *
 * Orchestration → AppController (src/app/controller.ts)
 * Conversation projection → ConversationModel (src/conversation/model.ts)
 * Workspace resolve/ensure → workspace/binding.ts
 * Webview composition → src/view/{provider,styles,html,client}.ts
 */

import * as vscode from 'vscode'
import { HarnessClient } from './harness/client.ts'
import { AppController } from './app/controller.ts'
import type { WebviewAction } from './view/provider.ts'
import { HarnessWebviewViewProvider, type UiState } from './view/provider.ts'
import { CompositeDisposable } from './disposable.ts'

const SECTION = 'deepseekHarness'
const OUTPUT_CHANNEL = 'DeepSeek Harness'

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel(OUTPUT_CHANNEL, { log: true })
  context.subscriptions.push(log)
  log.info('DeepSeek Harness v0.0.2 activating')

  const disposables = new CompositeDisposable()
  context.subscriptions.push(disposables)

  // ─── config + client ────────────────────────────────────────────────────────
  const cfg = readConfig()
  let client = new HarnessClient({ host: cfg.host, port: cfg.port, log: (m) => log.info(m) })

  // ─── mutable UiState (owned here; controller + provider share via accessor)
  const state: UiState = {
    connection: 'disconnected',
    sessions: [],
    sending: false,
    canStop: false,
    showSystemMessages: cfg.showSystemMessages,
    systemMessageCount: 0,
    renderVersion: 0,
  }
  const stateListeners = new Set<(s: UiState) => void>()

  function getState(): UiState { return state }
  function setState(patch: Partial<UiState>): void {
    Object.assign(state, patch)
  }
  function bump(): void { state.renderVersion++ }
  function pushState(): void {
    bump()
    for (const l of stateListeners) { try { l(state) } catch { /* swallow listener errors */ } }
  }

  // ─── provider + controller ──────────────────────────────────────────────────
  const provider = new HarnessWebviewViewProvider({
    client,
    extensionUri: context.extensionUri,
    getState,
    onState: (listener) => {
      stateListeners.add(listener)
      return { dispose: () => { stateListeners.delete(listener) } }
    },
    dispatch: (action: WebviewAction) => { void controller.dispatch(action) },
  })
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(
    HarnessWebviewViewProvider.viewType, provider,
    { webviewOptions: { retainContextWhenHidden: true } },
  ))

  const controller = new AppController({
    client,
    vscodeAPI: { window: vscode.window, workspace: vscode.workspace },
    getState,
    setState,
    bump,
    pushState,
    notifyError: (m) => vscode.window.showErrorMessage(`DeepSeek Harness: ${m}`),
    notifyInfo: (m) => vscode.window.showInformationMessage(m),
    openHarnessHome: () => {
      const c = readConfig()
      void vscode.env.openExternal(vscode.Uri.parse(`http://${c.host}:${c.port}/`))
    },
    moveToSecondarySideBar: async () => {
      try {
        await vscode.commands.executeCommand('workbench.action.moveViews', {
          viewIds: ['deepseekHarness.sessionView'],
          destinationId: 'workbench.view.auxiliarybar',
        })
      } catch {
        void vscode.window.showInformationMessage(
          'Right-click the "DeepSeek Harness" view title and choose "Move to Secondary Side Bar" to dock it on the right.',
        )
      }
    },
    log: { info: (m) => log.info(m), error: (m) => log.error(m) },
  })
  disposables.add(controller.start())

  // ─── commands ───────────────────────────────────────────────────────────────
  const wireAction = <T extends WebviewAction['type']>(type: T) =>
    () => void controller.dispatch({ type } as WebviewAction)

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.connect', wireAction('connect')),
    vscode.commands.registerCommand('deepseekHarness.disconnect', wireAction('disconnect')),
    vscode.commands.registerCommand('deepseekHarness.openWebUI', () => {
      const c = readConfig()
      void vscode.env.openExternal(vscode.Uri.parse(`http://${c.host}:${c.port}/`))
    }),
    vscode.commands.registerCommand('deepseekHarness.showLogs', () => log.show()),
    vscode.commands.registerCommand('deepseekHarness.newSession', wireAction('newSession')),
    vscode.commands.registerCommand('deepseekHarness.refreshSessions', wireAction('refreshSessions')),
    vscode.commands.registerCommand('deepseekHarness.openInSecondarySideBar', wireAction('moveToSecondarySideBar')),
  )

  // ─── config-change handler (§17: reconnect + re-wire) ──────────────────────
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration(SECTION)) return
    const next = readConfig()
    if (next.host !== cfg.host || next.port !== cfg.port) {
      vscode.window.showInformationMessage(
        'DeepSeek Harness: configuration changed — reconnecting.',
      )
      client.dispose()
      cfg.host = next.host
      cfg.port = next.port
      client = new HarnessClient({ host: cfg.host, port: cfg.port, log: (m) => log.info(m) })
      controller.replaceClient(client)
      disposables.add(controller.start())
      void controller.doConnect()
    }
    if (next.showSystemMessages !== cfg.showSystemMessages) {
      cfg.showSystemMessages = next.showSystemMessages
      controller.applyConfigShowSystem(next.showSystemMessages)
    }
  }))

  // Auto-connect on activation (spike-validated loopback default).
  void controller.doConnect()
}

export function deactivate(): void {
  // Disposables owned by context.subscriptions; nothing to do here.
}

function readConfig(): { host: string; port: number; showSystemMessages: boolean } {
  const cfg = vscode.workspace.getConfiguration(SECTION)
  const host = cfg.get<string>('host') ?? '127.0.0.1'
  const port = cfg.get<number>('port') ?? 3080
  const showSystemMessages = cfg.get<boolean>('showSystemMessages') ?? false
  return { host, port, showSystemMessages }
}
