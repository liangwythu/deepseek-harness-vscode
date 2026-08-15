/**
 * Shared, vscode-free Disposable contract so the harness layer stays testable
 * under plain Node and has no dependency on the VS Code API surface.
 */
export interface Disposable {
  dispose(): void
}

/** Compose many disposables into one; dispose runs in reverse order. */
export class CompositeDisposable implements Disposable {
  private readonly items: Disposable[] = []
  add(d: Disposable): this { this.items.push(d); return this }
  dispose(): void {
    while (this.items.length > 0) {
      const d = this.items.pop()
      try { d?.dispose() } catch { /* a dispose failure must not block the rest */ }
    }
  }
}
