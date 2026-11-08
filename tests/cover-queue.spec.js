import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

for (const stallAt of ['request', 'body']) {
    test(`a stalled cover ${stallAt} releases queue slots so later covers can be kept`, async ({ page }) => {
        await page.goto(app)
        await page.clock.install()
        await page.evaluate(async stallAt => {
            const { storeCover } = await import('/src/lib/cover-cache.js')
            const { setTransport } = await import('/src/lib/http.js')
            const art = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>'
            window.coverCalls = []
            setTransport((url, options) => {
                const title = new URL(url, location.href).searchParams.get('t')
                const call = { title, aborted: false }
                window.coverCalls.push(call)
                options?.signal?.addEventListener('abort', () => { call.aborted = true }, { once: true })
                if (title !== 'healthy') {
                    if (stallAt === 'request') return new Promise(() => {}) // transport ignores cancellation
                    return Promise.resolve(new Response(new ReadableStream({}), {
                        headers: { 'content-type': 'image/svg+xml' },
                    })) // headers arrive, but the body never completes
                }
                return Promise.resolve(new Response(art, { headers: { 'content-type': 'image/svg+xml' } }))
            })
            storeCover('https://covers.example/stalled-a.jpg', 'stalled-a')
            storeCover('https://covers.example/stalled-b.jpg', 'stalled-b')
            storeCover('https://covers.example/healthy.jpg', 'healthy')
        }, stallAt)
        await expect.poll(() => page.evaluate(() => window.coverCalls.map(call => call.title))).toEqual(['stalled-a', 'stalled-b'])
        await page.clock.fastForward(15_100)
        await expect.poll(() => page.evaluate(() => window.coverCalls.map(call => call.title))).toContain('healthy')
        await expect.poll(async () => page.evaluate(async () => {
            const { localCover } = await import('/src/lib/cover-cache.js')
            return (await localCover('https://covers.example/healthy.jpg'))?.text() || null
        })).toContain('<svg')
        expect(await page.evaluate(() => window.coverCalls.slice(0, 2).every(call => call.aborted))).toBe(true)
    })
}
