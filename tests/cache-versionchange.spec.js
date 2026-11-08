import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

test('a cache read falls back to the network after another tab upgrades IndexedDB', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { cached } = await import('/src/lib/cache.js')
        await cached('before-db-upgrade', 60_000, async () => 'seed')

        // A newer app version on another tab requests a newer schema. The old
        // connection receives versionchange and must be retired for future reads.
        const request = indexedDB.open('vellum', 3)
        await new Promise((resolve, reject) => {
            request.onsuccess = () => { request.result.close(); resolve() }
            request.onerror = () => reject(request.error)
        })

        try {
            return await cached('after-db-upgrade', 60_000, async () => 'network result')
        } catch (error) { return error.name }
    })

    expect(result).toBe('network result')
})

test('a closed IndexedDB connection does not prevent a network cache miss', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { cached } = await import('/src/lib/cache.js')
        // Open the connection and complete its initial stale-row sweep.
        await cached('transaction-failure-seed', 60_000, async () => 'seed')
        const original = IDBDatabase.prototype.transaction
        let failures = 0
        let loads = 0
        IDBDatabase.prototype.transaction = function (store, mode, ...rest) {
            if (store === 'cache' && mode === 'readonly') {
                failures++
                throw new DOMException('Database connection is closing', 'InvalidStateError')
            }
            return original.call(this, store, mode, ...rest)
        }
        try {
            const value = await cached('transaction-failure-recover', 60_000, async () => {
                loads++
                return 'network fallback'
            })
            return { value, loads, failures }
        } catch (error) {
            return { error: error.name, loads, failures }
        } finally {
            IDBDatabase.prototype.transaction = original
        }
    })
    expect(result).toEqual({ value: 'network fallback', loads: 1, failures: 1 })
})

test('a closed IndexedDB connection during eviction does not raise a page error', async ({ page }) => {
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { cached } = await import('/src/lib/cache.js')
        await cached('eviction-closed-connection-seed', 60_000, async () => 'seed')
        const original = IDBDatabase.prototype.transaction
        let failures = 0
        IDBDatabase.prototype.transaction = function (store, mode, ...rest) {
            if (store === 'cache' && mode === 'readonly') {
                failures++
                throw new DOMException('Database connection is closing', 'InvalidStateError')
            }
            return original.call(this, store, mode, ...rest)
        }
        try {
            await new Promise(resolve => setTimeout(resolve, 2700))
            return { failures }
        } finally {
            IDBDatabase.prototype.transaction = original
        }
    })
    expect(result.failures).toBeGreaterThanOrEqual(1)
    expect(errors).toEqual([])
})

test('a closed IndexedDB connection during eviction writes does not raise a page error', async ({ page }) => {
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { cached } = await import('/src/lib/cache.js')
        await cached('eviction-write-closed-connection-seed', 60_000, async () => 'seed')

        // Populate the actual store above its limit so eviction reaches the write transaction.
        const d = await new Promise((resolve, reject) => {
            const req = indexedDB.open('vellum', 2)
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error)
        })
        await new Promise((resolve, reject) => {
            const tx = d.transaction('cache', 'readwrite')
            const store = tx.objectStore('cache')
            for (let i = 0; i < 810; i++) store.put({ v: i, at: i, exp: Date.now() + 60_000 }, `eviction-fill-${i}`)
            tx.oncomplete = resolve
            tx.onerror = () => reject(tx.error)
        })
        d.close()

        const original = IDBDatabase.prototype.transaction
        let failures = 0
        IDBDatabase.prototype.transaction = function (store, mode, ...rest) {
            if (store === 'cache' && mode === 'readwrite') {
                failures++
                throw new DOMException('Database connection is closing', 'InvalidStateError')
            }
            return original.call(this, store, mode, ...rest)
        }
        try {
            await new Promise(resolve => setTimeout(resolve, 2700))
            return { failures }
        } finally {
            IDBDatabase.prototype.transaction = original
        }
    })
    expect(result.failures).toBeGreaterThanOrEqual(1)
    expect(errors).toEqual([])
})

test('disk caching resumes once an older tab releases a blocked upgrade', async ({ page, context }) => {
    const holder = await context.newPage()
    await holder.goto(app)
    await holder.evaluate(async () => {
        await new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase('vellum')
            request.onsuccess = resolve
            request.onerror = () => reject(request.error)
        })
        window.heldDb = await new Promise((resolve, reject) => {
            const request = indexedDB.open('vellum', 1)
            request.onupgradeneeded = () => request.result.createObjectStore('cache')
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
    })

    await page.goto(app)
    const fallback = await page.evaluate(async () => {
        const { cached } = await import('/src/lib/cache.js')
        return cached('while-upgrade-blocked', 60_000, async () => 'network fallback')
    })
    expect(fallback).toBe('network fallback')

    await holder.evaluate(() => window.heldDb.close())
    await page.evaluate(async () => {
        // Wait until the original blocked open has finished upgrading the database.
        await new Promise((resolve, reject) => {
            const request = indexedDB.open('vellum', 2)
            request.onsuccess = () => { request.result.close(); resolve() }
            request.onerror = () => reject(request.error)
        })
        const { cached } = await import('/src/lib/cache.js')
        await cached('after-blocked-upgrade', 60_000, async () => 'saved on disk')
    })

    await page.reload()
    const result = await page.evaluate(async () => {
        const { cached } = await import('/src/lib/cache.js')
        let loads = 0
        const value = await cached('after-blocked-upgrade', 60_000, async () => {
            loads++
            return 'unexpected network reload'
        })
        return { value, loads }
    })
    expect(result).toEqual({ value: 'saved on disk', loads: 0 })
})
