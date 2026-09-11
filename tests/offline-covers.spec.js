import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`
const coverUrl = name => `https://covers.example/${name}.jpg`
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="100%" height="100%" fill="#345"/></svg>'
const entry = (slug, title, cover, readCount) => ({
    slug, kind: 'novel', key: `nu:${slug}`, id: '1', title, cover,
    total: 10, readCount, lastN: readCount, updatedAt: Date.now(),
})

// a series you downloaded is one you expect to open with no network, so its cover is kept;
// everything else in the library must not cost a network round trip on every render
test('keeps a downloaded series cover readable offline', async ({ page, context }) => {
    const errors = []
    page.on('pageerror', error => errors.push(error.message))

    await page.route('**/covers.example/**', route => route.fulfill({
        contentType: 'image/svg+xml',
        // no-store so the browser cache cannot fake a pass for a cover we never stored
        headers: { 'cache-control': 'no-store' },
        body: svg,
    }))
    // registered before the catch-all below: playwright matches the most recent handler first
    await page.route('**/read/api/**', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ results: [], chapters: [], errors: [] }),
    }))
    // the browser build asks the API to resolve the title and stream the bytes: same-origin in
    // dev, CORS-enabled on pages, and no cross-origin fetch is ever attempted
    await page.route('**/read/api/cover?**', route => route.fulfill({
        contentType: 'image/svg+xml',
        headers: { 'cache-control': 'no-store' },
        body: svg,
    }))

    const probe = name => page.evaluate(wanted => {
        const img = [...document.querySelectorAll('.cv img')].find(el => (el.dataset.cover || '').includes(wanted))
        return img ? { natural: img.naturalWidth, display: getComputedStyle(img).display, src: (img.getAttribute('src') || '').slice(0, 12) } : null
    }, name)
    const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('vellum:covers') || '{}'))

    await page.goto(app)
    await page.evaluate(({ lib, dl }) => {
        localStorage.setItem('vellum:lib', JSON.stringify(lib))
        localStorage.setItem('vellum:dl', JSON.stringify(dl))
    }, {
        lib: [entry('seen', 'Downloaded Series', coverUrl('seen'), 3), entry('unseen', 'Browsed Series', coverUrl('never-fetched'), 1)],
        dl: [{ kind: 'novel', key: 'seen', id: '1', title: 'Downloaded Series', label: 'Chapter 1', size: 1234 }],
    })
    await page.reload()

    await expect.poll(async () => (await probe('seen'))?.natural ?? 0, { timeout: 15_000 }).toBeGreaterThan(0)
    // the downloaded series gets a copy; the browsed one must not spend a round trip
    await expect.poll(async () => Object.keys(await stored()).some(key => key.includes('seen.jpg')), { timeout: 15_000 }).toBe(true)
    expect(Object.keys(await stored()).some(key => key.includes('never-fetched'))).toBe(false)

    // now the library is opened with no network at all: routes bypass offline emulation, so the
    // handlers are dropped to make both the cover host and the API genuinely unreachable
    await page.unroute('**/covers.example/**')
    await page.unroute('**/read/api/cover?**')
    await context.setOffline(true)
    await page.evaluate(() => { location.hash = '#/updates' })
    await page.waitForTimeout(200)
    await page.evaluate(() => { location.hash = '#/' })

    await expect.poll(async () => (await probe('seen'))?.natural ?? 0, { timeout: 15_000 }).toBeGreaterThan(0)
    expect((await probe('never-fetched'))?.natural ?? 0).toBe(0)
    expect(errors).toEqual([])
})
