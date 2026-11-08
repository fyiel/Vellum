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

test('extending a novel reader chapter drawer retains links and the current scroll position', async ({ page }) => {
    const slug = 'drawer-reveal-perf'
    const count = 2200
    const chapters = Array.from({ length: count }, (_, i) => ({ n: i + 1, t: `Chapter ${i + 1}` }))
    await page.route('**/read/api/series/**', route => reply(route, {
        key: `nf:${slug}`, nfSlug: slug, title: 'Large novel',
    }))
    await page.route(`**/read/api/chapters?slug=${slug}`, route => reply(route, { chapters }))
    await page.route(`**/read/api/chapter?slug=${slug}&n=*`, route => {
        const n = Number(new URL(route.request().url()).searchParams.get('n'))
        return reply(route, { n, title: `Chapter ${n}`, html: `<p>Chapter ${n} text</p>` })
    })
    await page.goto(`${app}#/read/${slug}/1000`)
    await expect(page.locator('#r-title')).toContainText('Chapter 1000')
    await page.locator('#r-list').click()
    await expect(page.locator('#drawer-list .chap')).toHaveCount(100)

    const result = await page.evaluate(() => {
        const list = document.querySelector('#drawer-list')
        const first = list.querySelector('.chap')
        let added = 0, removed = 0
        const count = records => {
            for (const record of records) {
                for (const node of record.addedNodes) if (node.matches?.('.chap')) added++
                for (const node of record.removedNodes) if (node.matches?.('.chap')) removed++
            }
        }
        const observer = new MutationObserver(count)
        observer.observe(list, { childList: true })
        const start = performance.now()
        const later = list.querySelector('#dw-later')
        later.focus({ preventScroll: true })
        later.click()
        list.querySelector('#dw-later').click()
        const focusLater = document.activeElement === later
        const beforeAnchor = first.getBoundingClientRect().top
        const earlier = list.querySelector('#dw-earlier')
        earlier.focus({ preventScroll: true })
        earlier.click()
        const anchorShift = Math.abs(first.getBoundingClientRect().top - beforeAnchor)
        const focusEarlier = document.activeElement === earlier
        const elapsedMs = performance.now() - start
        count(observer.takeRecords())
        observer.disconnect()
        return {
            added, removed, elapsedMs,
            after: list.querySelectorAll('.chap').length,
            firstPreserved: first.isConnected && list.querySelectorAll('.chap')[150] === first,
            anchorShift, focusLater, focusEarlier,
            earlier: list.querySelector('#dw-earlier')?.textContent,
            later: list.querySelector('#dw-later')?.textContent,
        }
    })
    console.log(`Novel reader drawer reveal to ${result.after} links: ${result.elapsedMs.toFixed(1)}ms, ${result.added} links added, ${result.removed} removed, anchor shift ${result.anchorShift.toFixed(1)}px`)
    expect(result).toMatchObject({
        after: 550, added: 450, removed: 0, firstPreserved: true,
        focusLater: true, focusEarlier: true, earlier: '824 earlier…', later: '826 later…',
    })
    expect(result.anchorShift).toBeLessThan(2)

    await page.locator('#dw-q').fill('2166')
    await expect(page.locator('#drawer-list .chap')).toHaveCount(1)
    await expect(page.locator('#drawer-list .chap')).toContainText('Chapter 2166')
    await page.locator('#dw-q').fill('')
    await expect(page.locator('#drawer-list .chap')).toHaveCount(550)
    await page.locator('#dw-q').fill('2166')
    await page.locator('#drawer-list .chap').click()
    await expect(page.locator('#r-title')).toContainText('Chapter 2166')
})

test('novel reader chapter drawer keeps keyboard focus when its last batch is revealed', async ({ page }) => {
    const slug = 'drawer-boundaries'
    const chapters = Array.from({ length: 200 }, (_, i) => ({ n: i + 1, t: `Chapter ${i + 1}` }))
    await page.route('**/read/api/series/**', route => reply(route, { key: `nf:${slug}`, nfSlug: slug, title: 'Novel' }))
    await page.route(`**/read/api/chapters?slug=${slug}`, route => reply(route, { chapters }))
    await page.route(`**/read/api/chapter?slug=${slug}&n=*`, route => {
        const n = Number(new URL(route.request().url()).searchParams.get('n'))
        return reply(route, { n, title: `Chapter ${n}`, html: `<p>Chapter ${n} text</p>` })
    })

    await page.goto(`${app}#/read/${slug}/180`)
    await expect(page.locator('#r-title')).toContainText('Chapter 180')
    await page.locator('#r-list').click()
    const earlier = await page.evaluate(() => {
        const list = document.querySelector('#drawer-list')
        const button = list.querySelector('#dw-earlier')
        button.focus({ preventScroll: true })
        button.click()
        button.click()
        return {
            focused: document.activeElement?.matches('.chap') ? document.activeElement.querySelector('.n')?.textContent : null,
            count: list.querySelectorAll('.chap').length,
            buttonGone: !list.querySelector('#dw-earlier'),
        }
    })
    expect(earlier).toEqual({ focused: '#1', count: 200, buttonGone: true })

    await page.keyboard.press('Escape')
    await page.evaluate(slug => { location.hash = `#/read/${slug}/1` }, slug)
    await expect(page.locator('#r-title')).toContainText('Chapter 1')
    await page.locator('#r-list').click()
    const later = await page.evaluate(() => {
        const list = document.querySelector('#drawer-list')
        const button = list.querySelector('#dw-later')
        button.focus({ preventScroll: true })
        button.click()
        return {
            focused: document.activeElement?.matches('.chap') ? document.activeElement.querySelector('.n')?.textContent : null,
            count: list.querySelectorAll('.chap').length,
            buttonGone: !list.querySelector('#dw-later'),
        }
    })
    expect(later).toEqual({ focused: '#76', count: 200, buttonGone: true })
})

test('novel download updates only inspect the affected button in a large catalog', async ({ page }) => {
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
        let labelChecks = 0
        const observer = new MutationObserver(records => { mutations += records.length })
        observer.observe(list, { attributes: true, characterData: true, childList: true, subtree: true })
        const getAttribute = Element.prototype.getAttribute
        Element.prototype.getAttribute = function (name) {
            if (name === 'aria-label' && this.classList.contains('chdl')) labelChecks++
            return getAttribute.call(this, name)
        }
        const { downloadNovelChapter } = await import('/src/lib/dl-novel.js')
        try { await downloadNovelChapter(slug, 1, 'Large novel') }
        finally { Element.prototype.getAttribute = getAttribute }
        mutations += observer.takeRecords().length
        observer.disconnect()
        return {
            mutations,
            labelChecks,
            unchangedLabel: untouched.textContent,
            changedLabel: buttons.at(-1).textContent,
        }
    }, slug)
    console.log(`Novel ${count} rows, one download: ${result.labelChecks} button checks, ${result.mutations} DOM mutations`)
    expect(result).toMatchObject({ unchangedLabel: '↓', changedLabel: '✓' })
    expect(result.mutations).toBeLessThan(20)
    expect(result.labelChecks).toBeLessThan(20)
})

test('manga download progress only inspects its chapter button in a large catalog', async ({ page }) => {
    const key = 'mf:download-buttons-perf'
    const id = 'chapter-1'
    const chapters = Array.from({ length: 1200 }, (_, i) => ({ id: `chapter-${i + 1}`, number: i + 1 }))
    await page.route('**/read/api/manga/series/**', route => reply(route, { key, kind: 'manga', format: 'manga', title: 'Large manga' }))
    await page.route('**/read/api/manga/chapters?**', route => reply(route, { key, chapters }))
    await page.route('**/read/api/manga/chapter?**', route => {
        const chapterId = new URL(route.request().url()).searchParams.get('id')
        return reply(route, {
            key, chapter: chapters.find(chapter => chapter.id === chapterId),
            pages: [{ url: `/read/api/manga/image?key=${encodeURIComponent(key)}&id=${chapterId}&page=0` }],
        })
    })
    await page.route('**/read/api/manga/image?**', route => route.fulfill({ contentType: 'image/png', body: 'page bytes' }))
    await page.goto(`${app}#/manga/series/${encodeURIComponent(key)}`)
    await expect(page.locator('#mchapter-list .chdl')).toHaveCount(250)
    await page.locator('#mchapter-more').click()
    await page.locator('#mchapter-more').click()
    await expect(page.locator('#mchapter-list .chdl')).toHaveCount(750)

    const result = await page.evaluate(async ({ key, id }) => {
        const list = document.querySelector('#mchapter-list')
        let labelChecks = 0
        let mutations = 0
        let firstChecks = 0
        const observer = new MutationObserver(records => { mutations += records.length })
        observer.observe(list, { attributes: true, characterData: true, childList: true, subtree: true })
        const original = Element.prototype.getAttribute
        Element.prototype.getAttribute = function (name) {
            if (name === 'aria-label' && this.classList.contains('chdl')) labelChecks++
            return original.call(this, name)
        }
        try {
            const { downloadMangaChapter } = await import('/src/lib/dl-manga.js')
            await downloadMangaChapter(key, id)
            await new Promise(resolve => setTimeout(resolve, 350)) // let the progress paint flush
            firstChecks = labelChecks
            await Promise.all(['chapter-2', 'chapter-3'].map(chapterId => downloadMangaChapter(key, chapterId)))
            await new Promise(resolve => setTimeout(resolve, 350))
        } finally {
            Element.prototype.getAttribute = original
        }
        mutations += observer.takeRecords().length
        observer.disconnect()
        const changed = list.querySelector(`[data-dl="${id}"]`)
        const parallelLabels = ['chapter-2', 'chapter-3'].map(chapterId => list.querySelector(`[data-dl="${chapterId}"]`)?.textContent)
        const untouched = list.querySelector('[data-dl="chapter-4"]')
        return { firstChecks, labelChecks, mutations, changedLabel: changed?.textContent, parallelLabels, untouchedLabel: untouched?.textContent }
    }, { key, id })
    console.log(`Manga 750 rows, one download: ${result.firstChecks} button checks; three total: ${result.labelChecks} checks, ${result.mutations} DOM mutations`)
    expect(result).toMatchObject({ changedLabel: '✓', parallelLabels: ['✓', '✓'], untouchedLabel: '↓' })
    expect(result.firstChecks).toBeLessThan(20)
    expect(result.labelChecks).toBeLessThan(20)
    expect(result.mutations).toBeLessThan(30)
})

test('revealing more manga chapters retains existing rows and only appends new ones', async ({ page }) => {
    const key = 'mf:reveal-perf'
    const chapters = Array.from({ length: 2000 }, (_, i) => ({ id: `chapter-${i + 1}`, number: i + 1 }))
    await page.route('**/read/api/manga/series/**', route => reply(route, { key, kind: 'manga', format: 'manga', title: 'Large manga' }))
    await page.route('**/read/api/manga/chapters?**', route => reply(route, { key, chapters }))
    await page.goto(`${app}#/manga/series/${encodeURIComponent(key)}`)
    await expect(page.locator('#mchapter-list .mchrow')).toHaveCount(250)

    const result = await page.evaluate(() => {
        const list = document.querySelector('#mchapter-list')
        const first = list.querySelector('.chline')
        let added = 0, removed = 0
        const observer = new MutationObserver(records => {
            for (const record of records) {
                for (const node of record.addedNodes) if (node.matches?.('.chline')) added++
                for (const node of record.removedNodes) if (node.matches?.('.chline')) removed++
            }
        })
        observer.observe(list, { childList: true })
        const start = performance.now()
        list.querySelector('#mchapter-more').click()
        list.querySelector('#mchapter-more').click()
        const elapsedMs = performance.now() - start
        observer.takeRecords().forEach(record => {
            for (const node of record.addedNodes) if (node.matches?.('.chline')) added++
            for (const node of record.removedNodes) if (node.matches?.('.chline')) removed++
        })
        observer.disconnect()
        return {
            added, removed, elapsedMs, before: 250,
            after: list.querySelectorAll('.mchrow').length,
            firstPreserved: list.querySelector('.chline') === first,
            focusedId: document.activeElement?.dataset.id,
            more: list.querySelector('#mchapter-more')?.textContent,
        }
    })
    console.log(`Manga reveal to ${result.after} rows: ${result.elapsedMs.toFixed(1)}ms, ${result.added} rows added, ${result.removed} removed`)
    expect(result).toMatchObject({ after: 750, added: 500, removed: 0, firstPreserved: true, focusedId: 'chapter-501' })
    expect(result.more).toContain('750 of 2000')
    await page.locator('#mchsearch').fill('Ch. 777')
    await expect(page.locator('#mchapter-list .mchrow')).toHaveCount(1)
    await expect(page.locator('#mchapter-list .mchrow')).toHaveAttribute('data-id', 'chapter-777')
    await page.locator('#mchsearch').fill('')
    await expect(page.locator('#mchapter-list .mchrow')).toHaveCount(250)
})

test('revealing more manga reader chapters retains existing links and preserves search and focus', async ({ page }) => {
    const key = 'mf:reader-drawer-perf'
    const chapters = Array.from({ length: 2000 }, (_, i) => ({ id: `chapter-${i + 1}`, number: i + 1, title: `Entry ${i + 1}` }))
    await page.route('**/read/api/manga/series/**', route => reply(route, {
        key, kind: 'manga', format: 'manga', title: 'Large reader',
    }))
    await page.route('**/read/api/manga/chapters?**', route => reply(route, { key, chapters }))
    await page.route('**/read/api/manga/chapter?**', route => {
        const id = new URL(route.request().url()).searchParams.get('id')
        return reply(route, {
            key, chapter: chapters.find(chapter => chapter.id === id),
            pages: [{ url: `/read/api/manga/image?key=${encodeURIComponent(key)}&id=${id}&page=0` }],
        })
    })
    await page.route('**/read/api/manga/image?**', route => route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200"/>',
    }))

    await page.goto(`${app}#/manga/read/${encodeURIComponent(key)}/chapter-1`)
    await expect(page.locator('#mreader')).toHaveAttribute('data-state', 'ready')
    await page.locator('#mr-list').click()
    await expect(page.locator('#mdrawer-list .chap')).toHaveCount(400)

    const result = await page.evaluate(() => {
        const list = document.querySelector('#mdrawer-list')
        const first = list.querySelector('.chap')
        let added = 0, removed = 0
        const count = records => {
            for (const record of records) {
                for (const node of record.addedNodes) if (node.matches?.('.chap')) added++
                for (const node of record.removedNodes) if (node.matches?.('.chap')) removed++
            }
        }
        const observer = new MutationObserver(count)
        observer.observe(list, { childList: true })
        const start = performance.now()
        list.querySelector('#mdrawer-more').click()
        list.querySelector('#mdrawer-more').click()
        const elapsedMs = performance.now() - start
        count(observer.takeRecords())
        observer.disconnect()
        return {
            added, removed, elapsedMs,
            after: list.querySelectorAll('.chap').length,
            firstPreserved: list.querySelector('.chap') === first,
            focused: document.activeElement?.querySelector('.n')?.textContent,
            more: list.querySelector('#mdrawer-more')?.textContent,
        }
    })
    console.log(`Manga reader drawer reveal to ${result.after} links: ${result.elapsedMs.toFixed(1)}ms, ${result.added} links added, ${result.removed} removed`)
    expect(result).toMatchObject({
        after: 1200, added: 800, removed: 0, firstPreserved: true, focused: 'Ch. 801', more: 'Show 400 more',
    })

    await page.locator('#mdw-q').fill('Ch. 1777')
    await expect(page.locator('#mdrawer-list .chap')).toHaveCount(1)
    await expect(page.locator('#mdrawer-list .chap .n')).toHaveText('Ch. 1777')
    await page.locator('#mdw-q').fill('not a chapter')
    await expect(page.locator('#mdrawer-list .empty')).toHaveText('No matching chapters')
    await page.locator('#mdw-q').fill('')
    await expect(page.locator('#mdrawer-list .chap')).toHaveCount(400)
    await expect(page.locator('#mdrawer-list .chap.current')).toHaveAttribute('aria-current', 'page')
    await page.locator('#mdw-q').fill('Ch. 1777')
    await page.locator('#mdrawer-list .chap').click()
    await expect(page.locator('#mr-title')).toContainText('Ch. 1777')
})

test('revealing more video episodes retains existing rows and only appends new ones', async ({ page }) => {
    const key = 'mock:reveal-perf'
    const episodes = Array.from({ length: 2000 }, (_, i) => ({
        id: `episode-${i + 1}`, season: 1, number: i + 1, title: `Signal ${i + 1}`,
    }))
    await page.route('**/read/api/video/series/**', route => reply(route, {
        key, kind: 'anime', title: 'Large video series', episodes,
    }))
    await page.goto(`${app}#/watch/series/${encodeURIComponent(key)}`)
    await expect(page.locator('#video-episode-list .video-episode-row')).toHaveCount(200)

    const result = await page.evaluate(() => {
        const list = document.querySelector('#video-episode-list')
        const first = list.querySelector('.chline')
        let added = 0, removed = 0
        const count = records => {
            for (const record of records) {
                for (const node of record.addedNodes) if (node.matches?.('.chline')) added++
                for (const node of record.removedNodes) if (node.matches?.('.chline')) removed++
            }
        }
        const observer = new MutationObserver(count)
        observer.observe(list, { childList: true })
        const start = performance.now()
        list.querySelector('#video-episode-more').click()
        list.querySelector('#video-episode-more').click()
        const elapsedMs = performance.now() - start
        count(observer.takeRecords())
        observer.disconnect()
        return {
            added, removed, elapsedMs,
            after: list.querySelectorAll('.video-episode-row').length,
            firstPreserved: list.querySelector('.chline') === first,
            focusedId: document.activeElement?.dataset.id,
            more: list.querySelector('#video-episode-more')?.textContent,
        }
    })
    console.log(`Video reveal to ${result.after} rows: ${result.elapsedMs.toFixed(1)}ms, ${result.added} rows added, ${result.removed} removed`)
    expect(result).toMatchObject({ after: 600, added: 400, removed: 0, firstPreserved: true, focusedId: 'episode-401' })
    expect(result.more).toContain('600 of 2000')
    await page.locator('#video-episode-search').fill('Signal 1777')
    await expect(page.locator('#video-episode-list .video-episode-row')).toHaveCount(1)
    await expect(page.locator('#video-episode-list .video-episode-row')).toHaveAttribute('data-id', 'episode-1777')
    await page.locator('#video-episode-search').fill('not an episode')
    await expect(page.locator('#video-episode-list .video-episode-empty')).toHaveText('No matching episodes')
    await page.locator('#video-episode-search').fill('')
    await expect(page.locator('#video-episode-list .video-episode-row')).toHaveCount(200)
})

test('video download progress only inspects the affected button in a large episode list', async ({ page }) => {
    const key = 'mock:download-progress-perf'
    const episodes = Array.from({ length: 1200 }, (_, i) => ({
        id: `episode-${i + 1}`, season: 1, number: i + 1,
    }))
    await page.route('**/read/api/video/series/**', route => reply(route, {
        key, kind: 'anime', title: 'Large video series', episodes,
    }))
    await page.route('**/read/api/video/playback?**', route => {
        const id = new URL(route.request().url()).searchParams.get('id')
        return reply(route, {
            key, episodeId: id, providerLabel: 'Test provider',
            sources: [{ kind: 'direct', url: '/read/api/video/media/test.mp4', type: 'video/mp4' }],
        })
    })
    await page.route('**/read/api/video/media/**', route => route.fulfill({ contentType: 'video/mp4', body: 'offline video bytes' }))
    await page.goto(`${app}#/watch/series/${encodeURIComponent(key)}`)
    await expect(page.locator('#video-episode-list .chdl')).toHaveCount(200)
    await page.locator('#video-episode-more').click()
    await page.locator('#video-episode-more').click()
    await expect(page.locator('#video-episode-list .chdl')).toHaveCount(600)

    const result = await page.evaluate(async key => {
        const list = document.querySelector('#video-episode-list')
        const untouched = list.querySelector('[data-dl="episode-600"]')
        let checks = 0, mutations = 0, firstChecks = 0
        const original = Element.prototype.getAttribute
        const observer = new MutationObserver(records => { mutations += records.length })
        observer.observe(list, { attributes: true, characterData: true, childList: true, subtree: true })
        Element.prototype.getAttribute = function (name) {
            if (name === 'aria-label' && this.classList.contains('chdl')) checks++
            return original.call(this, name)
        }
        try {
            const { downloadVideoEpisode } = await import('/src/lib/dl-video.js')
            await downloadVideoEpisode(key, 'episode-1')
            await new Promise(resolve => setTimeout(resolve, 350))
            firstChecks = checks
            await Promise.all(['episode-2', 'episode-3'].map(id => downloadVideoEpisode(key, id)))
            await new Promise(resolve => setTimeout(resolve, 350))
        } finally {
            Element.prototype.getAttribute = original
        }
        mutations += observer.takeRecords().length
        observer.disconnect()
        return {
            firstChecks, checks, mutations,
            changedLabel: list.querySelector('[data-dl="episode-1"]')?.textContent,
            parallelLabels: ['episode-2', 'episode-3'].map(id => list.querySelector(`[data-dl="${id}"]`)?.textContent),
            untouchedLabel: untouched.textContent,
        }
    }, key)
    console.log(`Video 600 rows, one download: ${result.firstChecks} button checks; three total: ${result.checks} checks, ${result.mutations} DOM mutations`)
    expect(result).toMatchObject({ changedLabel: '✓', parallelLabels: ['✓', '✓'], untouchedLabel: '↓' })
    expect(result.firstChecks).toBeLessThan(20)
    expect(result.checks).toBeLessThan(20)
    expect(result.mutations).toBeLessThan(30)
})

test('refining a novel chapter search avoids repeated DOM ancestor lookups', async ({ page }) => {
    const slug = 'chapter-filter-perf'
    const count = 3000
    await page.route('**/read/api/series/**', route => reply(route, { title: 'Large novel', nfSlug: slug }))
    await page.route('**/read/api/chapters?slug=chapter-filter-perf', route => reply(route, {
        chapters: Array.from({ length: count }, (_, i) => ({ n: i + 1, t: `Chapter ${i + 1}` })),
    }))
    await page.goto(`${app}#/series/nf%3Achapter-filter-perf`)
    await expect(page.locator('#chlist .chline')).toHaveCount(count)

    await page.locator('#chsearch').fill('299')
    await expect(page.locator('#chlist .chline:visible')).toHaveCount(13)
    await page.evaluate(() => {
        window.chapterFilterMutations = 0
        window.chapterFilterObserver = new MutationObserver(records => { window.chapterFilterMutations += records.length })
        window.chapterFilterObserver.observe(document.querySelector('#chlist'), {
            attributes: true, attributeFilter: ['style'], subtree: true,
        })
        window.chapterFilterClosestCalls = 0
        window.chapterFilterOriginalClosest = Element.prototype.closest
        Element.prototype.closest = function (selector) {
            if (selector === '.chline') window.chapterFilterClosestCalls++
            return window.chapterFilterOriginalClosest.call(this, selector)
        }
    })
    await page.locator('#chsearch').fill('2999')
    await expect(page.locator('#chlist .chline:visible')).toHaveCount(1)
    const result = await page.evaluate(() => {
        const mutations = window.chapterFilterMutations + window.chapterFilterObserver.takeRecords().length
        const closestCalls = window.chapterFilterClosestCalls
        Element.prototype.closest = window.chapterFilterOriginalClosest
        window.chapterFilterObserver.disconnect()
        delete window.chapterFilterOriginalClosest
        delete window.chapterFilterClosestCalls
        delete window.chapterFilterObserver
        delete window.chapterFilterMutations
        return { mutations, closestCalls }
    })
    console.log(`Novel 3000 rows, narrow chapter search: ${result.closestCalls} ancestor lookups, ${result.mutations} style mutations`)
    expect(result.closestCalls).toBeLessThan(30)
    expect(result.mutations).toBeLessThan(30)

    await page.locator('#chsearch').fill('')
    await expect(page.locator('#chlist .chline:visible')).toHaveCount(count)
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
