/**
 * Workspace mapping (§9): resolve the active VS Code folder to a Harness
 * WorkspaceView by canonical path. v0.0.1 does not build a second workspace
 * registry — the Harness workspace list is the single source of truth.
 *
 * Resolution order:
 *   1. single folder → its fsPath
 *   2. multi-root → the folder owning the active editor
 *   3. cannot determine → QuickPick
 * Then match against Harness workspaces by canonical path; if absent, the user
 * may create one through workspace.create (the harness owns the id).
 */

import * as path from 'node:path'
import type * as vscode from 'vscode'
import type { HarnessClient } from './harness/client.ts'
import type { WorkspaceView } from './harness/protocol.ts'

/** Normalize a directory path for matching against harness canonical paths. */
function normalizeFsPath(p: string): string {
  // The harness uses host-side realpath canon; on Windows we only lower-case
  // the drive letter and collapse separators — full realpath resolution stays
  // with the harness. Good enough for the common same-machine case.
  let norm = p.replace(/\//g, '\\')
  if (/^[a-z]:/.test(norm)) {
    const head = norm[0]
    if (head !== undefined) norm = head.toUpperCase() + norm.slice(1)
  }
  if (norm.length > 2 && norm.endsWith('\\')) norm = norm.slice(0, -1)
  return norm
}

/**
 * Pick the VS Code workspace folder to bind to, using §9's order.
 * Returns undefined when no folder is open or the user cancelled the QuickPick.
 */
export async function pickVsCodeFolder(
  workspace: typeof vscode.workspace,
  window: typeof vscode.window,
): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = workspace.workspaceFolders
  if (!folders || folders.length === 0) return undefined
  if (folders.length === 1) return folders[0]

  // Multi-root: prefer the folder owning the active editor.
  const active = window.activeTextEditor
  if (active) {
    const owning = workspace.getWorkspaceFolder(active.document.uri)
    if (owning) return owning
  }

  // Fallback: QuickPick.
  const picked = await window.showQuickPick(
    folders.map(f => ({ label: f.name, description: f.uri.fsPath, folder: f })),
    { placeHolder: 'Select the workspace folder to bind to DeepSeek Harness', title: 'DeepSeek Harness: Workspace' },
  )
  return picked?.folder
}

/**
 * Resolve a Harness workspace for the given VS Code folder. Matches by
 * canonical path; if none exists, offers to create one (the harness owns the
 * resulting id — we never mint a second one).
 */
export async function resolveHarnessWorkspace(
  client: HarnessClient,
  folder: vscode.WorkspaceFolder,
  window: typeof vscode.window,
): Promise<WorkspaceView | undefined> {
  const target = normalizeFsPath(folder.uri.fsPath)
  const { items } = await client.listWorkspaces()
  const match = items.find(w => normalizeFsPath(w.path) === target)
  if (match) return match

  // No matching workspace — ask before creating (v0.0.1 allows create, §9).
  const create = await window.showWarningMessage(
    `No DeepSeek Harness workspace found for "${folder.name}".`,
    { modal: false },
    'Create workspace',
  )
  if (create !== 'Create workspace') return undefined
  const { workspace } = await client.createWorkspace(folder.uri.fsPath)
  return workspace
}

/** Format a workspace path for display (basename when short, else abbreviated). */
export function shortWorkspacePath(ws: WorkspaceView): string {
  const base = path.basename(ws.path) || ws.path
  return ws.title && ws.title !== base ? `${ws.title} (${base})` : base
}
