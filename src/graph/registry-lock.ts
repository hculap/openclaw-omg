/**
 * registry-lock.ts — Promise-chain based async mutex.
 *
 * Serializes async operations without external dependencies.
 * Each call to `acquire` queues behind all previous callers,
 * ensuring mutual exclusion for the critical section.
 */

export class AsyncMutex {
  private chain: Promise<void> = Promise.resolve()

  /**
   * Acquires the lock, executes `fn`, then releases.
   * If `fn` throws, the error is propagated to the caller
   * but the lock is still released for subsequent callers.
   */
  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const waitFor = this.chain
    this.chain = gate

    await waitFor
    try {
      return await fn()
    } finally {
      release()
    }
  }
}
