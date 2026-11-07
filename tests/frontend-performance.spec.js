import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`
const gate = () => {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve }
}
const reply = (route, body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
const chapters = [{ n: 1, t: 'First chapter' }]

async function fixture(page, { listGate, textGate } = {}) {
    const calls = { list: 0, text: 0 }
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/read/api/**', async route => {
        const url = new URL(route.request().url())
        if (url.pathname.endsWith('/chapters')) {
            calls.list++
            if (listGate) await listGate.promise
            return reply(route, { chapters, total: chapters.length })
        }
        if (url.pathname.endsWith('/chapter')) {
            calls.text++
            if (textGate) await textGate.promise
            return reply(route, { n: 1, title: 'First chapter', html: '<p>Network chapter text</p>' })
        }
        if (url.pathname.includes('/series/')) return reply(route, { title: 'Timing fixture', nfSlug: 'timing' })
        return reply(route, { results: [] })
    })
    return { calls, errors }
}

test('cold reader overlaps chapter text with the list and shares the pending request', async ({ page }) => {
    const listGate = gate(), textGate = gate()
    const { calls, errors } = await fixture(page, { listGate, textGate })
    try {
        await page.goto(`${app}#/read/timing/1`)
        await expect.poll(() => calls.list).toBe(1)
        await expect.poll(() => calls.text).toBe(1)
        listGate.resolve()
        await expect(page.locator('#reader')).toHaveClass(/active/)
        textGate.resolve()
        await expect(page.locator('.ch-block')).toContainText('Network chapter text')
        expect(calls.text).toBe(1)
        expect(errors).toEqual([])
    } finally { listGate.resolve(); textGate.resolve() }
})

test('cold reader does not prefetch over an existing downloaded copy', async ({ page }) => {
    const { calls, errors } = await fixture(page)
    await page.goto(app)
    await expect(page.locator('.library-empty')).toBeVisible()
    await page.evaluate(async () => {
        const { dlWrite, dlPath, dlRegister } = await import('/src/lib/downloads.js')
        const text = JSON.stringify({ n: 1, title: 'Saved chapter', html: '<p>Saved chapter text</p>' })
        await dlWrite(dlPath.novelChapter('timing', 1), text)
        dlRegister({ kind: 'novel', key: 'timing', id: '1', title: 'Timing fixture', size: text.length })
        location.hash = '#/read/timing/1'
    })
    await expect(page.locator('.ch-block')).toContainText('Saved chapter text')
    expect(calls.text).toBe(0)
    expect(errors).toEqual([])
})

test('closing a cold reader discards both pending responses', async ({ page }) => {
    const listGate = gate(), textGate = gate()
    const { calls, errors } = await fixture(page, { listGate, textGate })
    try {
        await page.goto(`${app}#/read/timing/1`)
        await expect.poll(() => calls.text).toBe(1)
        await page.evaluate(() => { location.hash = '#/' })
        await expect(page.locator('#reader')).not.toHaveClass(/active/)
        listGate.resolve()
        textGate.resolve()
        await expect(page.locator('.library-empty')).toBeVisible()
        await expect(page.locator('.ch-block')).toHaveCount(0)
        expect(await page.evaluate(() => localStorage.getItem('vellum:lib'))).toBeNull()
        expect(errors).toEqual([])
    } finally { listGate.resolve(); textGate.resolve() }
})
