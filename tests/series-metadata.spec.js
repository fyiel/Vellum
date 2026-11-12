import { test, expect } from '@playwright/test'

test('a quick title response stays usable without caching unfinished metadata', async ({ page }) => {
    let calls = 0
    await page.route('**/read/api/series/nf%3Ametadata-fixture', route => {
        calls += 1
        return route.fulfill({ json: {
            key: 'nf:metadata-fixture', title: 'Readable immediately',
            ...(calls === 1 ? { metadataPending: true } : { rating: 4.8 }),
        } })
    })
    await page.goto(`http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`)
    const load = () => page.evaluate(async () => {
        const { getSeries } = await import('/src/lib/api.js')
        return getSeries('nf:metadata-fixture')
    })
    expect((await load()).title).toBe('Readable immediately')
    expect((await load()).rating).toBe(4.8)
    expect((await load()).rating).toBe(4.8)
    expect(calls).toBe(2)
})
