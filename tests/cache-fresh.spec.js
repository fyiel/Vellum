import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

test('a forced cache refresh replaces the disk value for future sessions', async ({ page }) => {
    await page.goto(app)
    const key = `force-disk-${crypto.randomUUID()}`
    await page.evaluate(async key => {
        const { cached } = await import('/src/lib/cache.js')
        await cached(key, 60_000, async () => 'old chapters')
    }, key)

    // A new session can only find the old value on disk; fresh must bypass it.
    await page.reload()
    const initial = await page.evaluate(async key => {
        const { cached } = await import('/src/lib/cache.js')
        return cached(key, 60_000, async () => 'new chapters', { fresh: true })
    }, key)
    expect(initial).toBe('new chapters')

    await page.reload()
    const persisted = await page.evaluate(async key => {
        const { cached } = await import('/src/lib/cache.js')
        let loads = 0
        const value = await cached(key, 60_000, async () => { loads++; return 'unexpected network call' })
        return { value, loads }
    }, key)
    expect(persisted).toEqual({ value: 'new chapters', loads: 0 })
})
