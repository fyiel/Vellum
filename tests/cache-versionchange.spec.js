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
