import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

test('saved manga pages load concurrently in order without unbounded file reads', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const { loadDownloadedMangaChapter } = await import('/src/lib/dl-manga.js')
        const key = 'mf:fast-offline', id = 'chapter-1', count = 18
        for (let i = 0; i < count; i++) await dl.dlWrite(dl.dlPath.mangaPage(key, id, i), `page ${i}`)
        dl.dlRegister({ kind: 'manga', key, id, pages: count, title: 'Fixture' })

        const original = FileSystemDirectoryHandle.prototype.getFileHandle
        const create = URL.createObjectURL
        const blobs = new Map()
        URL.createObjectURL = function (blob) { const url = create.call(URL, blob); blobs.set(url, blob); return url }
        let concurrent = 0, maxConcurrent = 0
        FileSystemDirectoryHandle.prototype.getFileHandle = async function (name, options) {
            if (/^\d+$/.test(name)) {
                concurrent++
                maxConcurrent = Math.max(maxConcurrent, concurrent)
                await new Promise(resolve => setTimeout(resolve, 20))
                concurrent--
            }
            return original.call(this, name, options)
        }
        try {
            const serialStart = performance.now()
            for (let i = 0; i < count; i++) await dl.dlRead(dl.dlPath.mangaPage(key, id, i))
            const serialDurationMs = performance.now() - serialStart
            const started = performance.now()
            const copy = await loadDownloadedMangaChapter(key, id)
            const durationMs = performance.now() - started
            const pages = await Promise.all(copy.content.pages.map(item => blobs.get(item.url).text()))
            for (const item of copy.content.pages) URL.revokeObjectURL(item.url)
            return { maxConcurrent, serialDurationMs, durationMs, pages }
        } finally {
            FileSystemDirectoryHandle.prototype.getFileHandle = original
            URL.createObjectURL = create
        }
    })
    expect(result.maxConcurrent).toBeGreaterThan(1)
    expect(result.maxConcurrent).toBeLessThanOrEqual(6)
    expect(result.durationMs).toBeLessThan(260)
    expect(result.durationMs).toBeLessThan(result.serialDurationMs / 2)
    expect(result.pages).toEqual(Array.from({ length: 18 }, (_, i) => `page ${i}`))
    console.log(`Saved manga 18 pages: serial=${result.serialDurationMs.toFixed(1)}ms, concurrent=${result.durationMs.toFixed(1)}ms`)
})

test('partial or cancelled manga reads release all allocated image URLs', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const { loadDownloadedMangaChapter } = await import('/src/lib/dl-manga.js')
        const key = 'mf:incomplete', id = 'c1'
        for (let i = 0; i < 3; i++) await dl.dlWrite(dl.dlPath.mangaPage(key, id, i), `page ${i}`)
        dl.dlRegister({ kind: 'manga', key, id, pages: 4, title: 'Fixture' })

        const create = URL.createObjectURL, revoke = URL.revokeObjectURL
        const created = [], revoked = []
        URL.createObjectURL = function (blob) { const url = create.call(URL, blob); created.push(url); return url }
        URL.revokeObjectURL = function (url) { revoked.push(url); return revoke.call(URL, url) }
        try {
            const getFileHandle = FileSystemDirectoryHandle.prototype.getFileHandle
            FileSystemDirectoryHandle.prototype.getFileHandle = async function (name, options) {
                if (name === '3') await new Promise(resolve => setTimeout(resolve, 50))
                return getFileHandle.call(this, name, options)
            }
            let incomplete
            try { incomplete = await loadDownloadedMangaChapter(key, id) }
            finally { FileSystemDirectoryHandle.prototype.getFileHandle = getFileHandle }
            const partialReleased = incomplete === null && created.length > 0 && created.every(url => revoked.includes(url))
            await dl.dlWrite(dl.dlPath.mangaPage(key, id, 3), 'page 3')
            const ctrl = new AbortController()
            const original = FileSystemDirectoryHandle.prototype.getFileHandle
            FileSystemDirectoryHandle.prototype.getFileHandle = async function (name, options) {
                if (/^\d+$/.test(name)) await new Promise(resolve => setTimeout(resolve, 25))
                return original.call(this, name, options)
            }
            try {
                ctrl.abort()
                const cancelled = await loadDownloadedMangaChapter(key, id, { signal: ctrl.signal })
                return { partialReleased, cancelled: cancelled === null, allReleased: created.every(url => revoked.includes(url)) }
            } finally { FileSystemDirectoryHandle.prototype.getFileHandle = original }
        } finally {
            URL.createObjectURL = create
            URL.revokeObjectURL = revoke
        }
    })
    expect(result).toEqual({ partialReleased: true, cancelled: true, allReleased: true })
})

test('zero-byte saved manga pages release the stale chapter registry after falling back', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const { loadDownloadedMangaChapter } = await import('/src/lib/dl-manga.js')
        const key = 'mf:zero-byte-page', id = 'c1'
        await dl.dlWrite(dl.dlPath.mangaPage(key, id, 0), 'page 0')
        await dl.dlWrite(dl.dlPath.mangaPage(key, id, 1), new Blob([]))
        dl.dlRegister({ kind: 'manga', key, id, pages: 2, title: 'Fixture' })
        const offline = await loadDownloadedMangaChapter(key, id)
        if (offline) for (const page of offline.content.pages) URL.revokeObjectURL(page.url)
        return { offline: offline === null, registered: !!dl.dlEntry('manga', key, id) }
    })
    expect(result).toEqual({ offline: true, registered: false })
})

test('missing or empty saved manga pages allow a fresh chapter download while retaining existing pages until retry', async ({ page }) => {
    await page.goto(app)
    const results = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const manga = await import('/src/lib/dl-manga.js')
        const { setTransport } = await import('/src/lib/http.js')
        const results = []
        for (const kind of ['missing', 'empty']) {
            const key = `mf:stale-${kind}`, id = 'c1'
            await dl.dlWrite(dl.dlPath.mangaPage(key, id, 0), 'existing first page')
            if (kind === 'empty') await dl.dlWrite(dl.dlPath.mangaPage(key, id, 1), new Blob([]))
            dl.dlRegister({ kind: 'manga', key, id, pages: 2, title: 'Fixture', size: 100 })
            const offline = await manga.loadDownloadedMangaChapter(key, id)
            const stale = !!manga.mangaDlEntry(key, id)
            const kept = await (await dl.dlRead(dl.dlPath.mangaPage(key, id, 0)))?.text()

            setTransport(async url => {
                const path = String(url)
                if (path.includes('/manga/series/')) return Response.json({ key, kind: 'manga', title: 'Fixture', format: 'manga' })
                if (path.includes('/manga/chapter?')) return Response.json({
                    key, chapter: { id, number: 1 },
                    pages: Array.from({ length: 2 }, (_, i) => ({ url: `/read/api/manga/image?key=${encodeURIComponent(key)}&id=${id}&page=${i}` })),
                })
                if (path.includes('/manga/image?')) return new Response(`fresh page ${new URL(path, location.href).searchParams.get('page')}`)
                throw new Error(`unexpected request ${path}`)
            })
            await manga.downloadMangaChapter(key, id)
            results.push({ kind, offline: offline === null, stale, kept,
                registered: !!manga.mangaDlEntry(key, id),
                pages: await Promise.all([0, 1].map(async i => (await dl.dlRead(dl.dlPath.mangaPage(key, id, i)))?.text())),
            })
        }
        return results
    })
    expect(results).toEqual(['missing', 'empty'].map(kind => ({
        kind, offline: true, stale: false, kept: 'existing first page', registered: true,
        pages: ['fresh page 0', 'fresh page 1'],
    })))
})

test('a failed retry preserves the surviving pages of an incomplete manga chapter', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const manga = await import('/src/lib/dl-manga.js')
        const { setTransport } = await import('/src/lib/http.js')
        const key = 'mf:retry-preserve-pages', id = 'c1'
        for (const i of [0, 2]) await dl.dlWrite(dl.dlPath.mangaPage(key, id, i), `original page ${i}`)
        dl.dlRegister({ kind: 'manga', key, id, pages: 3, title: 'Fixture' })
        await manga.loadDownloadedMangaChapter(key, id) // removes the incomplete registry row

        const transport = fail => async url => {
            const path = String(url)
            if (path.includes('/manga/series/')) return Response.json({ key, kind: 'manga', title: 'Fixture', format: 'manga' })
            if (path.includes('/manga/chapter?')) return Response.json({
                key, chapter: { id, number: 1 },
                pages: Array.from({ length: 3 }, (_, i) => ({ url: `/read/api/manga/image?key=${encodeURIComponent(key)}&id=${id}&page=${i}` })),
            })
            if (path.includes('/manga/image?')) {
                const index = Number(new URL(path, location.href).searchParams.get('page'))
                if (fail && index === 1) {
                    await new Promise(resolve => setTimeout(resolve, 100))
                    return new Response('outage', { status: 503 })
                }
                return new Response(`new page ${index}`)
            }
            throw new Error(`unexpected request ${path}`)
        }
        setTransport(transport(true))
        const error = await manga.downloadMangaChapter(key, id).then(() => null, err => err.message)
        const preserved = await Promise.all([0, 2].map(async i =>
            (await dl.dlRead(dl.dlPath.mangaPage(key, id, i)))?.text()))
        const registeredAfterFailure = !!manga.mangaDlEntry(key, id)

        setTransport(transport(false))
        await manga.downloadMangaChapter(key, id)
        const pages = await Promise.all([0, 1, 2].map(async i =>
            (await dl.dlRead(dl.dlPath.mangaPage(key, id, i)))?.text()))
        const root = await navigator.storage.getDirectory()
        const mangaRoot = await (await (await root.getDirectoryHandle('downloads'))
            .getDirectoryHandle('manga')).getDirectoryHandle(encodeURIComponent(key))
        const backups = []
        for await (const name of mangaRoot.keys()) if (name.includes('.rollback-')) backups.push(name)
        return { error, preserved, registeredAfterFailure, pages,
            registered: !!manga.mangaDlEntry(key, id), backups }
    })
    expect(result).toEqual({
        error: 'page 2 failed (http 503)',
        preserved: ['original page 0', 'original page 2'],
        registeredAfterFailure: false,
        pages: ['new page 0', 'new page 1', 'new page 2'],
        registered: true,
        backups: [],
    })
})

test('a temporary manga page read failure preserves the saved chapter and its bytes', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const manga = await import('/src/lib/dl-manga.js')
        const key = 'mf:unreadable-page', id = 'c1'
        for (let i = 0; i < 2; i++) await dl.dlWrite(dl.dlPath.mangaPage(key, id, i), `page ${i}`)
        dl.dlRegister({ kind: 'manga', key, id, pages: 2, title: 'Fixture' })
        const original = FileSystemFileHandle.prototype.getFile
        FileSystemFileHandle.prototype.getFile = async function (...args) {
            if (this.name === '1') throw new Error('temporary read failure')
            return original.apply(this, args)
        }
        let offline
        try { offline = await manga.loadDownloadedMangaChapter(key, id) }
        finally { FileSystemFileHandle.prototype.getFile = original }
        return { offline: offline === null, registered: !!manga.mangaDlEntry(key, id),
            page: await (await dl.dlRead(dl.dlPath.mangaPage(key, id, 1)))?.text() }
    })
    expect(result).toEqual({ offline: true, registered: true, page: 'page 1' })
})

test('manga reader fetches metadata while opening its saved image files', async ({ page }) => {
    await page.goto(app)
    const key = 'mf:overlap', id = 'c1'
    await page.evaluate(async ({ key, id }) => {
        const dl = await import('/src/lib/downloads.js')
        for (let i = 0; i < 4; i++) await dl.dlWrite(dl.dlPath.mangaPage(key, id, i), `page ${i}`)
        dl.dlRegister({ kind: 'manga', key, id, pages: 4, title: 'Offline fixture' })

        let reading = 0, metadataOverlapped = false
        const original = FileSystemDirectoryHandle.prototype.getFileHandle
        FileSystemDirectoryHandle.prototype.getFileHandle = async function (name, options) {
            if (/^\d+$/.test(name)) {
                reading++
                await new Promise(resolve => setTimeout(resolve, 100))
                reading--
            }
            return original.call(this, name, options)
        }
        const { setTransport } = await import('/src/lib/http.js')
        setTransport(async url => {
            if (reading > 0) metadataOverlapped = true
            if (String(url).includes('/manga/series/')) return Response.json({ key, kind: 'manga', title: 'Offline fixture', format: 'manga' })
            if (String(url).includes('/manga/chapters?')) return Response.json({ key, chapters: [{ id, number: 1, title: 'First' }] })
            throw new Error(`unexpected request ${url}`)
        })
        window.metadataOverlapped = () => metadataOverlapped
        location.hash = `#/manga/read/${encodeURIComponent(key)}/${id}`
    }, { key, id })
    await expect(page.locator('#mreader')).toHaveAttribute('data-state', 'ready')
    expect(await page.evaluate(() => window.metadataOverlapped())).toBe(true)
})

test('offline manga progress preserves known chapter counts when provider metadata fails', async ({ page }) => {
    await page.goto(app)
    const key = 'mf:offline-total', id = 'chapter-1'
    await page.evaluate(async ({ key, id }) => {
        const dl = await import('/src/lib/downloads.js')
        const { touchLibrary } = await import('/src/lib/store.js')
        const chapters = Array.from({ length: 600 }, (_, i) => `chapter-${i + 1}`)
        touchLibrary({ slug: key, key, kind: 'manga', title: 'Saved Manga', total: 600, chapterIds: chapters })
        const image = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200"/>'], { type: 'image/svg+xml' })
        for (let i = 0; i < 3; i++) await dl.dlWrite(dl.dlPath.mangaPage(key, id, i), image)
        dl.dlRegister({ kind: 'manga', key, id, pages: 3, number: 1, title: 'Saved Manga', format: 'manga' })
        const { setTransport } = await import('/src/lib/http.js')
        setTransport(async () => { throw new Error('provider metadata unavailable') })
        location.hash = `#/manga/read/${encodeURIComponent(key)}/${id}`
    }, { key, id })

    await expect(page.locator('#mreader')).toHaveAttribute('data-state', 'ready')
    await page.locator('#mr-next').click()
    const stored = await page.evaluate(k => {
        const entry = JSON.parse(localStorage.getItem('vellum:lib')).find(item => item.slug === k)
        const tracked = JSON.parse(localStorage.getItem('vellum:updates'))[k]
        return {
            total: entry.total, chapterIds: entry.chapterIds.length, lastPage: entry.lastPage,
            pageCount: entry.pageCount, tracked: tracked.seenIds.length,
            readCount: entry.readCount, readIds: JSON.parse(localStorage.getItem(`vellum:read:${k}`) || '[]'),
        }
    }, key)
    expect(stored).toEqual({
        total: 600, chapterIds: 600, lastPage: 2, pageCount: 3,
        tracked: 600, readCount: 1, readIds: [id],
    })
})

async function savedMangaPair(page, key, format, metadataAvailable = false) {
    await page.goto(app)
    await page.evaluate(async ({ key, format, metadataAvailable }) => {
        const dl = await import('/src/lib/downloads.js')
        const { touchLibrary } = await import('/src/lib/store.js')
        touchLibrary({
            slug: key, key, kind: 'manga', title: 'Saved Pair', format,
            total: 600, chapterIds: Array.from({ length: 600 }, (_, i) => `chapter-${i + 1}`),
        })
        const image = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200"/>'], { type: 'image/svg+xml' })
        for (let n = 1; n <= 2; n++) {
            for (let i = 0; i < 2; i++) await dl.dlWrite(dl.dlPath.mangaPage(key, `chapter-${n}`, i), image)
            dl.dlRegister({ kind: 'manga', key, id: `chapter-${n}`, number: n, pages: 2, title: 'Saved Pair', format })
        }
        const created = [], revoked = [], requests = []
        const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
        URL.createObjectURL = blob => { const url = create(blob); created.push(url); return url }
        URL.revokeObjectURL = url => { revoked.push(url); revoke(url) }
        window.offlinePair = { created, revoked, requests }
        const { setTransport } = await import('/src/lib/http.js')
        setTransport(async url => {
            requests.push(String(url))
            if (metadataAvailable) {
                if (String(url).includes('/manga/series/')) return Response.json({ key, kind: 'manga', title: 'Saved Pair', format })
                if (String(url).includes('/manga/chapters?')) return Response.json({
                    key,
                    chapters: [1, 2].map(n => ({ id: `chapter-${n}`, number: n, title: `Chapter ${n}` })),
                })
            }
            throw new Error('provider unavailable')
        })
        location.hash = `#/manga/read/${encodeURIComponent(key)}/chapter-1`
    }, { key, format, metadataAvailable })
    await expect(page.locator('#mreader')).toHaveAttribute('data-state', 'ready')
}

test('paged manga navigates downloaded chapters without metadata and keeps the catalog total', async ({ page }) => {
    const key = 'mf:offline-paged-neighbors'
    await savedMangaPair(page, key, 'manga')
    await page.locator('#mr-next').click()
    await expect(page.locator('#mr-pos')).toHaveText('Page 2 / 2')
    await expect(page.locator('#mr-next')).toBeEnabled()
    await page.locator('#mr-next').click()
    await expect(page.locator('#mr-title')).toContainText('Ch. 2')
    const progress = await page.evaluate(key => {
        const entry = JSON.parse(localStorage.getItem('vellum:lib')).find(row => row.slug === key)
        return { total: entry.total, chapterIds: entry.chapterIds.length, lastId: entry.lastId, read: JSON.parse(localStorage.getItem(`vellum:read:${key}`)) }
    }, key)
    expect(progress).toEqual({ total: 600, chapterIds: 600, lastId: 'chapter-2', read: ['chapter-1', 'chapter-2'] })
})

test('scrolling saved manga streams the next chapter and releases downloaded image URLs', async ({ page }) => {
    const key = 'mf:offline-scroll-neighbors'
    await savedMangaPair(page, key, 'manhwa')
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight)
        window.dispatchEvent(new Event('scroll'))
    })
    await expect(page.locator('#mr-title')).toContainText('Ch. 2')
    await expect(page).toHaveURL(/chapter-2$/)
    await expect(page.locator('#mr-pages .manga-page')).toHaveCount(4)
    await page.evaluate(() => { location.hash = '#/' })
    await expect(page.locator('#mreader')).not.toHaveClass(/active/)
    const result = await page.evaluate(() => ({
        created: window.offlinePair.created.length,
        allReleased: window.offlinePair.created.every(url => window.offlinePair.revoked.includes(url)),
        extraRequests: window.offlinePair.requests.filter(url => url.includes('/manga/chapter?')).length,
    }))
    expect(result).toEqual({ created: 4, allReleased: true, extraRequests: 0 })
})

test('online manga metadata streams a downloaded next chapter without fetching it again', async ({ page }) => {
    const key = 'mf:online-saved-scroll-neighbors'
    await savedMangaPair(page, key, 'manhwa', true)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight)
        window.dispatchEvent(new Event('scroll'))
    })
    await expect(page.locator('#mr-title')).toContainText('Ch. 2')
    await expect(page.locator('#mr-pages .manga-page')).toHaveCount(4)
    await page.evaluate(() => { location.hash = '#/' })
    await expect(page.locator('#mreader')).not.toHaveClass(/active/)
    const result = await page.evaluate(() => ({
        created: window.offlinePair.created.length,
        allReleased: window.offlinePair.created.every(url => window.offlinePair.revoked.includes(url)),
        chapterRequests: window.offlinePair.requests.filter(url => url.includes('/manga/chapter?')),
    }))
    expect(result).toEqual({ created: 4, allReleased: true, chapterRequests: [] })
})

test('changing reading mode releases images from discarded streamed chapters', async ({ page }) => {
    const key = 'mf:offline-discard-streamed'
    await savedMangaPair(page, key, 'manhwa')
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight)
        window.dispatchEvent(new Event('scroll'))
    })
    await expect(page.locator('#mr-title')).toContainText('Ch. 2')
    await page.locator('#mr-mode').selectOption('paged')
    const during = await page.evaluate(() => {
        const { created, revoked } = window.offlinePair
        return {
            created: created.length,
            previousReleased: created.slice(0, 2).every(url => revoked.includes(url)),
            currentRetained: created.slice(2).every(url => !revoked.includes(url)),
        }
    })
    expect(during).toEqual({ created: 4, previousReleased: true, currentRetained: true })
    await page.evaluate(() => { location.hash = '#/' })
    await expect(page.locator('#mreader')).not.toHaveClass(/active/)
    expect(await page.evaluate(() => window.offlinePair.created.every(url => window.offlinePair.revoked.includes(url)))).toBe(true)
})

test('leaving a saved manga chapter during a disk read releases its image URLs', async ({ page }) => {
    await page.goto(app)
    const key = 'mf:close-offline', id = 'c1'
    await page.evaluate(async ({ key, id }) => {
        const dl = await import('/src/lib/downloads.js')
        for (let i = 0; i < 6; i++) await dl.dlWrite(dl.dlPath.mangaPage(key, id, i), `page ${i}`)
        dl.dlRegister({ kind: 'manga', key, id, pages: 6, title: 'Offline fixture' })
        const created = [], revoked = []
        window.offlineProbe = { created, revoked, diskFinished: false }
        const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
        URL.createObjectURL = blob => { const url = create(blob); created.push(url); return url }
        URL.revokeObjectURL = url => { revoked.push(url); revoke(url) }
        const original = FileSystemDirectoryHandle.prototype.getFileHandle
        FileSystemDirectoryHandle.prototype.getFileHandle = async function (name, options) {
            if (name === '5') {
                await new Promise(resolve => setTimeout(resolve, 250))
                window.offlineProbe.diskFinished = true
            }
            return original.call(this, name, options)
        }
        const { setTransport } = await import('/src/lib/http.js')
        setTransport(async url => {
            if (String(url).includes('/manga/series/')) return Response.json({ key, title: 'Offline fixture', format: 'manga' })
            if (String(url).includes('/manga/chapters?')) return Response.json({ key, chapters: [{ id, number: 1 }] })
            throw new Error(`unexpected request ${url}`)
        })
        location.hash = `#/manga/read/${encodeURIComponent(key)}/${id}`
    }, { key, id })

    await page.waitForFunction(() => window.offlineProbe.created.length > 1)
    await page.evaluate(() => { location.hash = '#/' })
    await expect(page.locator('#mreader')).not.toHaveClass(/active/)
    await page.waitForFunction(() => {
        const probe = window.offlineProbe
        return probe.diskFinished && probe.created.length > 1 && probe.created.every(url => probe.revoked.includes(url))
    })
})
