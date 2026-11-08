import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

for (const stalled of ['request', 'body']) {
    test(`AniList ${stalled} that ignores abort still times out`, async ({ page }) => {
        await page.goto(app)
        const result = await page.evaluate(async stalled => {
            const realTimeout = window.setTimeout.bind(window)
            const realFetch = window.fetch.bind(window)
            window.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms === 15_000 ? 70 : ms, ...args)
            let started = 0
            window.fetch = (url, options) => {
                if (String(url) !== 'https://graphql.anilist.co') return realFetch(url, options)
                started++
                return stalled === 'request'
                    ? new Promise(() => {})
                    : Promise.resolve({ ok: true, json: () => new Promise(() => {}) })
            }
            const { anilistDiscover } = await import('/src/lib/anilist.js')
            const task = anilistDiscover({ q: 'timeout-probe' }).then(() => 'resolved', error => error.message)
            const outcome = await Promise.race([task, new Promise(resolve => realTimeout(() => resolve('pending'), 450))])
            window.fetch = realFetch
            window.setTimeout = realTimeout
            return { started, outcome }
        }, stalled)
        expect(result).toEqual({ started: 1, outcome: 'AniList request timed out' })
    })

    test(`abandoning an AniList ${stalled} that ignores abort settles cancellation`, async ({ page }) => {
        await page.goto(app)
        const result = await page.evaluate(async stalled => {
            const realTimeout = window.setTimeout.bind(window)
            const realFetch = window.fetch.bind(window)
            let entered
            const started = new Promise(resolve => { entered = resolve })
            window.fetch = (url, options) => {
                if (String(url) !== 'https://graphql.anilist.co') return realFetch(url, options)
                entered()
                return stalled === 'request'
                    ? new Promise(() => {})
                    : Promise.resolve({ ok: true, json: () => new Promise(() => {}) })
            }
            const { anilistDiscover } = await import('/src/lib/anilist.js')
            const controller = new AbortController()
            const task = anilistDiscover({ q: 'cancel-probe', signal: controller.signal }).then(() => 'resolved', error => error.name)
            await started
            controller.abort()
            const outcome = await Promise.race([task, new Promise(resolve => realTimeout(() => resolve('pending'), 450))])
            window.fetch = realFetch
            return { outcome }
        }, stalled)
        expect(result).toEqual({ outcome: 'AbortError' })
    })
}

test('Watch finishes its drama feed when AniList ignores the request timeout', async ({ page }) => {
    await page.addInitScript(() => {
        const realTimeout = window.setTimeout.bind(window)
        const realFetch = window.fetch.bind(window)
        window.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms === 15_000 ? 70 : ms, ...args)
        window.fetch = (url, options) => String(url) === 'https://graphql.anilist.co'
            ? new Promise(() => {}) : realFetch(url, options)
    })
    await page.route('**/read/api/video/discover?**', route => route.fulfill({
        contentType: 'application/json', body: JSON.stringify({
            results: [{ key: 'dc:working-drama', kind: 'drama', title: 'Working drama' }],
            hasMore: false, partial: false, errors: [],
        }),
    }))
    await page.goto(app)
    await page.locator('[data-nav="watch"]').click()
    await expect(page.locator('#vlist .watch-card')).toHaveCount(1)
    await expect(page.locator('#vlist')).toHaveAttribute('aria-busy', 'false')
    await expect(page.locator('.watch-notice')).toContainText('Miruro is temporarily unavailable; others still show')
})
