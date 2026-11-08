import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

for (const stallAt of ['transport', 'response body']) {
    test(`API timeout settles when the ${stallAt} ignores abort`, async ({ page }) => {
        await page.goto(app)
        await page.clock.install()
        await page.evaluate(async stallAt => {
            const { apiGet, setTransport } = await import('/src/lib/http.js')
            const requests = []
            setTransport((_url, options) => {
                const request = { aborted: false }
                options.signal.addEventListener('abort', () => { request.aborted = true }, { once: true })
                requests.push(request)
                if (stallAt === 'transport') return new Promise(() => {})
                return Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) })
            })
            window.httpTimeoutProbe = { requests, result: 'pending' }
            apiGet('/read/api/stalled', { timeoutMs: 30 }).then(
                value => { window.httpTimeoutProbe.result = { value } },
                error => { window.httpTimeoutProbe.result = { name: error.name, message: error.message } },
            )
        }, stallAt)
        await page.clock.runFor(600)
        const state = await page.evaluate(() => window.httpTimeoutProbe)
        expect(state.requests).toEqual([{ aborted: true }, { aborted: true }])
        expect(state.result).toEqual({ name: 'Error', message: 'request timed out' })
    })
}

test('caller cancellation settles when the API transport ignores abort', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { apiGet, setTransport } = await import('/src/lib/http.js')
        const ctrl = new AbortController()
        let aborted = false
        let calls = 0
        setTransport((_url, options) => {
            calls++
            options.signal.addEventListener('abort', () => { aborted = true }, { once: true })
            return new Promise(() => {})
        })
        const request = apiGet('/read/api/cancelled', { signal: ctrl.signal }).then(
            () => 'resolved', error => error.name,
        )
        ctrl.abort()
        const outcome = await Promise.race([request, new Promise(resolve => setTimeout(() => resolve('pending'), 100))])
        return { outcome, aborted, calls }
    })
    expect(result).toEqual({ outcome: 'AbortError', aborted: true, calls: 1 })
})
