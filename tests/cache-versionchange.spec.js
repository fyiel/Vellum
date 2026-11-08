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
