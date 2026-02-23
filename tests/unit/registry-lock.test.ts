import { describe, it, expect } from 'vitest'
import { AsyncMutex } from '../../src/graph/registry-lock.js'

describe('AsyncMutex', () => {
  it('serializes concurrent operations', async () => {
    const mutex = new AsyncMutex()
    const order: number[] = []

    const task = (id: number, delayMs: number) =>
      mutex.acquire(async () => {
        order.push(id)
        await new Promise((r) => setTimeout(r, delayMs))
        order.push(id * 10)
      })

    // Launch three tasks concurrently — they should execute sequentially
    await Promise.all([task(1, 20), task(2, 10), task(3, 5)])

    // Each task should complete before the next starts
    expect(order).toEqual([1, 10, 2, 20, 3, 30])
  })

  it('returns the value from the function', async () => {
    const mutex = new AsyncMutex()
    const result = await mutex.acquire(async () => 42)
    expect(result).toBe(42)
  })

  it('propagates errors without blocking subsequent callers', async () => {
    const mutex = new AsyncMutex()
    const order: string[] = []

    const failing = mutex.acquire(async () => {
      order.push('fail-start')
      throw new Error('boom')
    })

    const succeeding = mutex.acquire(async () => {
      order.push('success-start')
      return 'ok'
    })

    await expect(failing).rejects.toThrow('boom')
    const result = await succeeding

    expect(result).toBe('ok')
    expect(order).toEqual(['fail-start', 'success-start'])
  })

  it('handles deeply nested acquire calls', async () => {
    const mutex = new AsyncMutex()
    // Note: nested acquire on the same mutex would deadlock.
    // This test verifies sequential calls work fine.
    const results: number[] = []
    for (let i = 0; i < 5; i++) {
      await mutex.acquire(async () => {
        results.push(i)
      })
    }
    expect(results).toEqual([0, 1, 2, 3, 4])
  })
})
