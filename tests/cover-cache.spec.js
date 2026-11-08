import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

test('reuses an unchanged cover registry and observes updates from another tab', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { storeCover } = await import('/src/lib/cover-cache.js')
        const { setTransport } = await import('/src/lib/http.js')
        const first = 'https://covers.example/1.jpg'
        const second = 'https://covers.example/2.jpg'
        const entries = Object.fromEntries(Array.from({ length: 240 }, (_, i) =>
            [`https://covers.example/${i}.jpg`, `covers/${i}.jpg`]))
        const raw = JSON.stringify(entries)
        localStorage.setItem('vellum:covers', raw)
        let requests = 0
        setTransport(() => { requests++; return Promise.reject(new Error('fixture miss')) })

        const parse = JSON.parse
        let parses = 0
        JSON.parse = function (text, ...args) {
            if (text === raw || text === replacement) parses++
            return parse.call(this, text, ...args)
        }
        let replacement = ''
        try {
            const timesMs = []
            for (let run = 0; run < 3; run++) {
                const start = performance.now()
                for (let i = 0; i < 10_000; i++) storeCover(first, 'First')
                timesMs.push(performance.now() - start)
            }
            const parsesBefore = parses
            replacement = JSON.stringify({ [second]: 'covers/second.jpg' })
            localStorage.setItem('vellum:covers', replacement)
            storeCover(second, 'Second')
            const parsesAfter = parses
            storeCover(first, 'First')
            return { parsesBefore, parsesAfter, requests, timesMs }
        } finally { JSON.parse = parse }
    })
    console.log('Cover registry 240 entries, 3 × 10k cached lookups (ms):', result.timesMs.map(n => n.toFixed(1)))
    expect(result.parsesBefore).toBe(1)
    expect(result.parsesAfter).toBe(2)
    expect(result.requests).toBe(1)
})

for (const kind of ['missing', 'empty']) {
    test(`re-downloads a ${kind} offline cover after finding its stale registry entry`, async ({ page }) => {
        await page.goto(app)
        const initial = await page.evaluate(async kind => {
            const { storeCover, localCover } = await import('/src/lib/cover-cache.js')
            const { dlPath, dlRemove, dlWrite } = await import('/src/lib/downloads.js')
            const { setTransport } = await import('/src/lib/http.js')
            const url = `https://covers.example/${kind}.jpg`
            const path = dlPath.cover(`${kind}.png`)
            if (kind === 'empty') await dlWrite(path, new Blob([]))
            else await dlRemove(path)
            localStorage.setItem('vellum:covers', JSON.stringify({ [url]: path }))

            const copy = await localCover(url)
            const registered = JSON.parse(localStorage.getItem('vellum:covers'))[url] ?? null
            window.coverFetches = 0
            setTransport(async () => {
                window.coverFetches++
                return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="4"/>', {
                    headers: { 'content-type': 'image/svg+xml' },
                })
            })
            storeCover(url, 'Recovered cover')
            return { url, size: copy?.size ?? null, registered }
        }, kind)

        expect(initial).toMatchObject({ size: null, registered: null })
        await expect.poll(() => page.evaluate(async url => {
            const { localCover } = await import('/src/lib/cover-cache.js')
            return (await localCover(url))?.text() || null
        }, initial.url)).toContain('<svg')
        expect(await page.evaluate(() => window.coverFetches)).toBe(1)
    })
}
