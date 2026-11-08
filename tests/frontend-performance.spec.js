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

test('novel progress only checks newly crossed chapters in a large catalog', async ({ page }) => {
    const slug = 'progress-perf'
    const chapterList = Array.from({ length: 4000 }, (_, i) => ({ n: i + 1, t: `Chapter ${i + 1}` }))
    await page.route('**/read/api/chapters?slug=progress-perf', route => reply(route, { chapters: chapterList }))
    await page.route('**/read/api/chapter?slug=progress-perf&n=*', route => {
        const n = Number(new URL(route.request().url()).searchParams.get('n'))
        return reply(route, { n, title: `Chapter ${n}`, html: `<p>Reading chapter ${n}</p>` })
    })
    await page.route('**/read/api/series/nf%3Aprogress-perf', route => reply(route, {
        key: 'nf:progress-perf', nfSlug: slug, title: 'Progress performance',
    }))

    await page.goto(`${app}#/read/${slug}/3000`)
    await expect(page.locator('#r-title')).toHaveText('Chapter 3000')
    const readCount = () => page.evaluate(slug => JSON.parse(localStorage.getItem(`vellum:read:${slug}`) || '[]').length, slug)
    await expect.poll(readCount).toBe(3000)
    await page.evaluate(() => {
        window.numericReadChecks = 0
        const original = Set.prototype.has
        Set.prototype.has = function (value) {
            if (typeof value === 'number') window.numericReadChecks++
            return original.call(this, value)
        }
    })

    await page.keyboard.press('ArrowRight')
    await expect(page.locator('#r-title')).toHaveText('Chapter 3001')
    await expect.poll(readCount).toBe(3001)
    await page.keyboard.press('ArrowLeft')
    await expect(page.locator('#r-title')).toHaveText('Chapter 3000')
    expect(await readCount()).toBe(3001)
    const checks = await page.evaluate(() => window.numericReadChecks)
    console.log(`Novel two chapter changes after deep link: ${checks} numeric Set.has checks`)
    expect(checks).toBeLessThan(30)

    // A reset in another tab invalidates the in-memory frontier.
    await page.evaluate(slug => {
        window.readResetSeen = false
        window.addEventListener('storage', event => {
            if (event.key === `vellum:read:${slug}`) window.readResetSeen = true
        }, { once: true })
    }, slug)
    const otherTab = await page.context().newPage()
    try {
        await otherTab.goto(app)
        await otherTab.evaluate(slug => localStorage.removeItem(`vellum:read:${slug}`), slug)
        await expect.poll(() => page.evaluate(() => window.readResetSeen)).toBe(true)
        await page.keyboard.press('ArrowRight')
        await expect(page.locator('#r-title')).toHaveText('Chapter 3001')
        await expect.poll(readCount).toBe(3001)
    } finally { await otherTab.close() }
})

test('novel download updates avoid unrelated DOM mutations in a large catalog', async ({ page }) => {
    const slug = 'download-buttons-perf'
    const count = 3000
    const chapterList = Array.from({ length: count }, (_, i) => ({ n: i + 1, t: `Chapter ${i + 1}` }))
    await page.route('**/read/api/series/**', route => reply(route, { title: 'Large novel', nfSlug: slug }))
    await page.route('**/read/api/chapters?slug=download-buttons-perf', route => reply(route, { chapters: chapterList }))
    await page.route('**/read/api/chapter?slug=download-buttons-perf&n=*', route => reply(route, {
        title: 'Saved chapter', html: '<p>Offline text.</p>',
    }))
    await page.goto(`${app}#/series/nf%3Adownload-buttons-perf`)
    await expect(page.locator('#chlist .chdl')).toHaveCount(count)

    const result = await page.evaluate(async slug => {
        const list = document.querySelector('#chlist')
        const buttons = [...list.querySelectorAll('.chdl')]
        const untouched = buttons[0]
        let mutations = 0
        const observer = new MutationObserver(records => { mutations += records.length })
        observer.observe(list, { attributes: true, characterData: true, childList: true, subtree: true })
        const { downloadNovelChapter } = await import('/src/lib/dl-novel.js')
        await downloadNovelChapter(slug, 1, 'Large novel')
        mutations += observer.takeRecords().length
        observer.disconnect()
        return {
            mutations,
            unchangedLabel: untouched.textContent,
            changedLabel: buttons.at(-1).textContent,
        }
    }, slug)
    console.log(`Novel ${count} rows, one download: ${result.mutations} DOM mutations`)
    expect(result).toMatchObject({ unchangedLabel: '↓', changedLabel: '✓' })
    expect(result.mutations).toBeLessThan(20)
})

test('manga page turns reuse the chapter order of a large catalog', async ({ page }) => {
    const key = 'mf:page-order'
    const chapters = [
        { id: 'second-b', number: 2 },
        { id: 'chapter-3', number: 3 },
        ...Array.from({ length: 2000 }, (_, i) => ({ id: `chapter-${i + 10}`, number: i + 10 })),
        { id: 'chapter-1', number: 1 },
        { id: 'second-a', number: 2 },
        { id: 'special', number: null },
    ]
    await page.addInitScript(() => {
        window.catalogSorts = 0
        const sort = Array.prototype.sort
        Array.prototype.sort = function (compare) {
            if (this.length >= 1000) window.catalogSorts++
            return sort.call(this, compare)
        }
    })
    await page.route('**/read/api/manga/series/**', route => reply(route, {
        key, kind: 'manga', format: 'manga', title: 'Page Order',
    }))
    await page.route('**/read/api/manga/chapters?**', route => reply(route, { key, chapters }))
    await page.route('**/read/api/manga/chapter?**', route => {
        const id = new URL(route.request().url()).searchParams.get('id')
        return reply(route, {
            key, chapter: chapters.find(item => item.id === id),
            pages: Array.from({ length: 24 }, (_, i) => ({
                url: `/read/api/manga/image?key=mf%3Apage-order&id=${id}&page=${i}`,
                width: 800, height: 1200,
            })),
        })
    })
    await page.route('**/read/api/manga/image?**', route => route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200"/>',
    }))

    await page.goto(`${app}#/manga/read/mf%3Apage-order/second-a`)
    await expect(page.locator('#mreader')).toHaveAttribute('data-state', 'ready')
    await expect(page.locator('#mreader')).toHaveAttribute('data-mode', 'paged')
    const total = await page.evaluate(key => JSON.parse(localStorage.getItem('vellum:lib'))?.find(entry => entry.slug === key)?.total, key)
    expect(total).toBe(chapters.length)
    const { elapsedMs, sorts } = await page.evaluate(() => {
        const before = window.catalogSorts
        const start = performance.now()
        for (let i = 0; i < 12; i++) document.querySelector('#mr-next').click()
        return { elapsedMs: +(performance.now() - start).toFixed(1), sorts: window.catalogSorts - before }
    })
    console.log(`Manga 12 synchronous page turns: ${elapsedMs}ms, full catalog sorts: ${sorts}`)
    await expect(page.locator('#mr-pos')).toHaveText('Page 13 / 24')
    expect(sorts).toBe(0)

    // Identical chapter numbers form one logical chapter for navigation.
    const chapterSorts = await page.evaluate(() => window.catalogSorts)
    await page.keyboard.press('Shift+ArrowLeft')
    await expect(page.locator('#mr-title')).toContainText('Ch. 3')
    await expect(page.locator('#mreader')).toHaveAttribute('data-state', 'ready')
    await page.keyboard.press('Shift+ArrowRight')
    await expect(page.locator('#mr-title')).toContainText('Ch. 2')
    await expect(page.locator('#mreader')).toHaveAttribute('data-state', 'ready')
    await page.keyboard.press('Shift+ArrowRight')
    await expect(page.locator('#mr-title')).toContainText('Ch. 1')
    await expect(page.locator('#mreader')).toHaveAttribute('data-state', 'ready')
    expect(await page.evaluate(before => window.catalogSorts - before, chapterSorts)).toBe(0)
})
