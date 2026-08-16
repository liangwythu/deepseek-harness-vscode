/**
 * Review types — the core abstraction for Diff Review.
 *
 * A ReviewTransaction represents one tool mutation (write/edit) that Harness
 * has already applied to disk. The review UI allows the user to:
 *   - Accept = keep the applied change (mark accepted, no filesystem op)
 *   - Reject = revert the change (reverse patch via WorkspaceEdit)
 *
 * Data source priority (per goal.md §4):
 *   1. tool/result.meta.diffs  ← most authoritative
 *   2. tool/call arguments     ← fallback (new file: oldText=null, newText=args.content)
 *   3. workspace file           ← materialize/revert target
 *   4. Git                      ← NOT involved
 */

import type { CallId, SessionId } from '../harness/protocol.ts'

export type ReviewState =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'partial'
  | 'conflicted'

export type HunkState = 'pending' | 'accepted' | 'rejected'

export interface ReviewHunk {
  id: string
  /** Original text (null = new content, no prior version). */
  oldText: string | null
  /** New text after the tool mutation. */
  newText: string
  state: HunkState
}

export interface ReviewFile {
  /** Workspace-relative or absolute file path. */
  path: string
  /** Full file content before mutation (null = file did not exist). */
  beforeText: string | null
  /** Full file content after mutation (null = file was deleted). */
  afterText: string | null
  hunks: ReviewHunk[]
  state: ReviewState
}

export interface ReviewTransaction {
  id: string
  sessionId: SessionId
  callId: CallId
  /** Tool that produced this mutation — only 'write' and 'edit' in v1. */
  toolName: 'write' | 'edit'
  files: ReviewFile[]
  state: ReviewState
  /** Timestamp (ms) when the review was created. */
  createdAt: number
}

/** Opaque review summary for UI serialization (no large text blobs). */
export interface ReviewSummary {
  id: string
  callId: CallId
  toolName: string
  files: Array<{
    path: string
    state: ReviewState
    addedLines: number
    removedLines: number
    hunks: Array<{ id: string; state: HunkState }>
  }>
  state: ReviewState
  createdAt: number
}

/** Callback when a review transaction's state changes. */
export type ReviewChangeListener = (review: ReviewTransaction) => void
