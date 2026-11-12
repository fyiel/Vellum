import { test, expect } from '@playwright/test'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`
const source = 'https://covers.example/library.jpg'
const DAY = 24 * 60 * 60 * 1000
const start = new Date('2026-11-12T00:00:00Z')
const art = color => `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="45"><rect width="30" height="45" fill="${color}"/></svg>`

async function fixture(page) {
    let calls = 0
    let color = 'red'
    let fail = false
    await page.clock.install({ time: start })
    await page.route('**/read/api/**', route => route.fulfill({ json: { results: [], chapters: [{ n: 1 }, { n: 2 }, { n: 3 }] } }))
    const cover = route => {
        calls++
        return route.fulfill(fail ? { status: 503, body: 'temporarily unavailable' }
            : { contentType: 'image/svg+xml', headers: { 'cache-control': 'no-store' }, body: art(color) })
    }
    await page.route('**/covers.example/**', cover)
    await page.route('**/read/api/cover?**', cover)
    await page.addInitScript(({ source }) => localStorage.setItem('vellum:lib', JSON.stringify([{
        slug: 'nf:cached-library', kind: 'novel', title: 'Cached library', author: 'Fixture author',
        cover: source, total: 3, readCount: 1, lastN: 2, updatedAt: 1,
    }])), { source })
    await page.goto(app)
    return { calls: () => calls, refresh: () => { color = 'blue' }, fail: () => { fail = true } }
}

const storedArt = page => page.evaluate(async source => {
    const { localCover } = await import('/src/lib/cover-cache.js')
    return (await localCover(source))?.text() || ''
}, source)

const painted = page => expect.poll(() => page.locator('#libtable .cv img').evaluate(img => ({
    local: img.src.startsWith('blob:'), natural: img.naturalWidth,
}))).toEqual({ local: true, natural: 30 })

test('library thumbnails survive reloads for 24 hours, then refresh once per cover', async ({ page }) => {
    const network = await fixture(page)
    await expect.poll(() => storedArt(page)).toContain('red')
    await painted(page)
    expect(network.calls()).toBe(1) // Continue and catalog share the same cover.

    await page.clock.setSystemTime(new Date(start.getTime() + 23 * 60 * 60 * 1000))
    await page.reload()
    await painted(page)
    expect(network.calls()).toBe(1)

    network.refresh()
    await page.clock.setSystemTime(new Date(start.getTime() + DAY + 60 * 60 * 1000))
    await page.reload()
    await expect.poll(() => storedArt(page)).toContain('blue')
    await painted(page)
    expect(network.calls()).toBe(2)
})

test('an expired library thumbnail stays visible if its refresh fails', async ({ page }) => {
    const network = await fixture(page)
    await expect.poll(() => storedArt(page)).toContain('red')
    await painted(page)
    network.fail()
    await page.clock.setSystemTime(new Date(start.getTime() + DAY + 60 * 60 * 1000))
    await page.reload()
    await painted(page)
    expect(await storedArt(page)).toContain('red')
    expect(network.calls()).toBe(2)
})

test('an expired library thumbnail remains usable offline', async ({ page }) => {
    const network = await fixture(page)
    await expect.poll(() => storedArt(page)).toContain('red')
    await painted(page)
    await page.clock.setSystemTime(new Date(start.getTime() + DAY + 60 * 60 * 1000))
    await page.evaluate(async () => {
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
        const entries = JSON.parse(localStorage.getItem('vellum:lib'))
        entries[0].author = 'Updated author'
        localStorage.setItem('vellum:lib', JSON.stringify(entries))
        const { showLibrary } = await import('/src/screens/library.js')
        showLibrary()
    })
    await painted(page)
    expect(network.calls()).toBe(1)
})
