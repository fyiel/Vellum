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
