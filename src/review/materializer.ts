/**
 * Materializer — performs the actual filesystem operations for Reject.
 *
 * Accept is a no-op (the change is already on disk; we just mark accepted).
 * Reject reverses the applied change:
 *   - For existing files: replace afterText → beforeText
 *   - For new files (beforeText === null): delete the file
 *   - Per hunk: replace just the hunk's newText → oldText within the file
 *
 * Stale Guard (goal.md §9):
 *   Before reverting, verify the current file content matches the captured
 *   afterText. If the user (or another tool) has modified the file since the
 *   review was created, we refuse to revert and mark the file as conflicted.
 *
 * Dirty Editor Guard (goal.md §10):
 *   If a VS Code editor for the file is dirty (unsaved changes), we refuse
 *   to auto-revert and mark as conflicted.
 */

import * as crypto from 'node:crypto'
import * as vscode from 'vscode'
import type { ReviewFile, ReviewHunk, ReviewTransaction } from './types.ts'

export type MaterializeResult =
  | { ok: true }
  | { ok: false; reason: 'stale' | 'dirty' | 'read-error' | 'write-error'; message: string }

export class ReviewMaterializer {
  constructor(private readonly workspace: typeof vscode.workspace) {}

  /** Reject an entire file — revert to beforeText or delete if new file. */
  async rejectFile(review: ReviewTransaction, file: ReviewFile): Promise<MaterializeResult> {
    const guard = await this.staleGuard(file)
    if (!guard.ok) return guard

    if (file.beforeText === null) {
      // New file — delete it
      return this.deleteFile(file.path)
    }

    // Existing file — replace content with beforeText
    return this.writeFile(file.path, file.beforeText)
  }

  /** Reject a single hunk — reverse patch just that hunk. */
  async rejectHunk(review: ReviewTransaction, file: ReviewFile, hunk: ReviewHunk): Promise<MaterializeResult> {
    const guard = await this.staleGuard(file)
    if (!guard.ok) return guard

    if (file.hunks.length === 1 || file.beforeText === null) {
      // Single hunk or new file — revert the whole file
      if (file.beforeText === null) return this.deleteFile(file.path)
      return this.writeFile(file.path, file.beforeText)
    }

    // Multi-hunk: replace just this hunk's newText with oldText in the file
    const current = await this.readFile(file.path)
    if (current === undefined) {
      return { ok: false, reason: 'read-error', message: `Cannot read ${file.path}` }
    }

    const idx = current.indexOf(hunk.newText)
    if (idx === -1) {
      return {
        ok: false,
        reason: 'stale',
        message: `Hunk content not found in current file — file may have been modified.`,
      }
    }

    const reverted = current.slice(0, idx) + (hunk.oldText ?? '') + current.slice(idx + hunk.newText.length)
    return this.writeFile(file.path, reverted)
  }

  // ─── stale guard ──────────────────────────────────────────────────────────

  private async staleGuard(file: ReviewFile): Promise<MaterializeResult> {
    // 1. Dirty editor check — fail closed if VS Code has unsaved changes
    const docs = this.workspace.textDocuments
    for (const doc of docs) {
      if (doc.fileName === file.path && doc.isDirty) {
        return {
          ok: false,
          reason: 'dirty',
          message: `${file.path} has unsaved editor changes. Save or discard them before rejecting.`,
        }
      }
    }

    // 2. Content staleness check
    if (file.afterText === null) {
      // File was deleted by the tool — nothing to guard
      return { ok: true }
    }

    const current = await this.readFile(file.path)
    if (current === undefined) {
      // File doesn't exist on disk anymore — stale
      return {
        ok: false,
        reason: 'stale',
        message: `${file.path} no longer exists on disk.`,
      }
    }

    if (hash(current) !== hash(file.afterText)) {
      return {
        ok: false,
        reason: 'stale',
        message: `${file.path} has been modified since this review was created.`,
      }
    }

    return { ok: true }
  }

  // ─── low-level file I/O ────────────────────────────────────────────────────

  private async readFile(path: string): Promise<string | undefined> {
    try {
      const uri = vscode.Uri.file(path)
      const buf = await this.workspace.fs.readFile(uri)
      return Buffer.from(buf).toString('utf8')
    } catch {
      return undefined
    }
  }

  private async writeFile(path: string, content: string): Promise<MaterializeResult> {
    try {
      const uri = vscode.Uri.file(path)
      await this.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'))
      return { ok: true }
    } catch (e) {
      return {
        ok: false,
        reason: 'write-error',
        message: `Failed to write ${path}: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }

  private async deleteFile(path: string): Promise<MaterializeResult> {
    try {
      const uri = vscode.Uri.file(path)
      await this.workspace.fs.delete(uri)
      return { ok: true }
    } catch (e) {
      return {
        ok: false,
        reason: 'write-error',
        message: `Failed to delete ${path}: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }
}

function hash(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex')
}
