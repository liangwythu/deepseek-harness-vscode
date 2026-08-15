/**
 * Tool-item presentation — pure UI-presentation helpers, not session semantics.
 *
 * Produces a human-friendly title/summary for each tool call, so the sidebar
 * can show "Read src/foo.ts" instead of `read + {"path":"src/foo.ts"}`.
 *
 * This layer is intentionally pattern-based (cheap, stateless). If a tool
 * name isn't recognized, it falls back to the raw name — no exceptions.
 */
import type { ConversationItem } from '../conversation/types.ts'

export interface ToolPresentation {
  title: string
  summary?: string
}

export function presentTool(tool: Extract<ConversationItem, { kind: 'tool' }>): ToolPresentation {
  let args: Record<string, unknown> | undefined
  try {
    if (tool.arguments) args = JSON.parse(tool.arguments)
  } catch { /* ignore — use raw fallback */ }

  const name = tool.name
  const a = args ?? {}

  switch (name) {
    case 'read':
    case 'read_file':
      return t('Read', str(a.path) ?? str(a.file) ?? name)
    case 'write':
    case 'write_file':
      return t('Write', str(a.path) ?? str(a.file) ?? name)
    case 'edit':
    case 'edit_file':
      return t('Edit', str(a.path) ?? str(a.file) ?? name)
    case 'grep':
    case 'search':
    case 'search_code':
      return t('Search', str(a.pattern) ? `"${truncate(str(a.pattern)!, 40)}"` : name)
    case 'bash':
    case 'shell':
    case 'run_command':
      return t('Run', truncate(str(a.command) ?? name, 50))
    case 'ls':
    case 'list_dir':
    case 'list_directory':
      return t('List', str(a.path) ?? name)
    case 'cd':
      return t('cd', str(a.path) ?? name)
    case 'pwd':
    case 'cwd':
      return { title: 'Print working directory' }
    case 'http_get':
    case 'fetch':
    case 'curl':
      return t('Fetch', truncate(str(a.url) ?? name, 60))
    case 'http_post':
      return t('POST', truncate(str(a.url) ?? name, 60))
    case 'git_status':
      return { title: 'git status' }
    case 'git_log':
      return { title: 'git log' }
    case 'git_diff':
      return t('git diff', str(a.path) ?? 'worktree')
    case 'git_commit':
      return t('git commit', str(a.message) ? `"${truncate(str(a.message)!, 50)}"` : undefined)
    case 'create_workspace':
      return t('Create workspace', str(a.path) ?? name)
    case 'create_session':
      return { title: 'Create session' }
    default:
      // Fallback: pretty name (replace _ with space) + first arg value
      const pretty = name.replace(/_/g, ' ').replace(/(^\w|\s\w)/g, m => m.toUpperCase())
      const firstVal = firstPrimitive(a)
      return t(pretty, firstVal ? truncate(firstVal, 40) : undefined)
  }
}

function t(action: string, target?: string | number): ToolPresentation {
  if (target === undefined || target === '') return { title: action }
  return { title: `${action} ${target}` }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

function firstPrimitive(a: Record<string, unknown>): string | undefined {
  for (const k of Object.keys(a)) {
    const v = a[k]
    if (typeof v === 'string' && v.length > 0) return v
    if (typeof v === 'number') return String(v)
  }
  return undefined
}
