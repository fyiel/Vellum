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
        }
    }, key)
    expect(stored).toEqual({ total: 600, chapterIds: 600, lastPage: 2, pageCount: 3, tracked: 600 })
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
