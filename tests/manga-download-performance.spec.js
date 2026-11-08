import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

test('manga downloads overlap page requests while retaining page order and bounded concurrency', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { setTransport } = await import('/src/lib/http.js')
        const dl = await import('/src/lib/dl-manga.js')
        const storage = await import('/src/lib/downloads.js')
        const key = 'mf:overlapping-download', id = 'c1', count = 12
        let concurrent = 0, maxConcurrent = 0
        setTransport(async url => {
            const path = new URL(url, location.href)
            if (path.pathname.endsWith('/manga/series/' + encodeURIComponent(key))) {
                return Response.json({ key, kind: 'manga', title: 'Fixture', format: 'manga' })
            }
            if (path.pathname.endsWith('/manga/chapter')) {
                return Response.json({
                    key, chapter: { id, number: 1, title: 'Chapter 1' },
                    pages: Array.from({ length: count }, (_, i) => ({ url: `/read/api/manga/image?key=${encodeURIComponent(key)}&id=${id}&page=${i}` })),
                })
            }
            if (path.pathname.endsWith('/manga/image')) {
                const index = Number(path.searchParams.get('page'))
                concurrent++
                maxConcurrent = Math.max(maxConcurrent, concurrent)
                await new Promise(resolve => setTimeout(resolve, 25))
                concurrent--
                // Different completion order must not change the original page numbering.
                return new Response(`image ${index}`, { headers: { 'content-type': 'image/png' } })
            }
            throw new Error(`unexpected request ${path}`)
        })
        const started = performance.now()
        await dl.downloadMangaChapter(key, id)
        const durationMs = performance.now() - started
        const entry = dl.mangaDlEntry(key, id)
        const contents = await Promise.all(Array.from({ length: count }, async (_, i) =>
            (await storage.dlRead(storage.dlPath.mangaPage(key, id, i)))?.text()))
        return { maxConcurrent, durationMs, done: dl.mangaDlActive(key, id), entry, contents }
    })
    console.log(`Manga 12-page download with 25ms network delay: ${result.durationMs.toFixed(1)}ms (${result.maxConcurrent} simultaneous requests)`)
    expect(result.maxConcurrent).toBeGreaterThan(1)
    expect(result.maxConcurrent).toBeLessThanOrEqual(4)
    expect(result.done).toBeNull()
    expect(result.entry).toMatchObject({ pages: 12, size: 86 })
    expect(result.contents).toEqual(Array.from({ length: 12 }, (_, i) => `image ${i}`))
})

test('a concurrent page failure waits for pending writes before removing partial downloads', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { setTransport } = await import('/src/lib/http.js')
        const manga = await import('/src/lib/dl-manga.js')
        const storage = await import('/src/lib/downloads.js')
        const key = 'mf:concurrent-failure', id = 'c1'
        let enteredWrite, releaseWrite
        const entered = new Promise(resolve => { enteredWrite = resolve })
        const released = new Promise(resolve => { releaseWrite = resolve })
        const originalWrite = FileSystemWritableFileStream.prototype.write
        FileSystemWritableFileStream.prototype.write = async function (data) {
            if (data instanceof Blob && await data.text() === 'page 0') {
                enteredWrite()
                await released
            }
            return originalWrite.call(this, data)
        }
        setTransport(async url => {
            const path = new URL(url, location.href)
            if (path.pathname.endsWith('/manga/series/' + encodeURIComponent(key))) {
                return Response.json({ key, kind: 'manga', title: 'Fixture', format: 'manga' })
            }
            if (path.pathname.endsWith('/manga/chapter')) {
                return Response.json({
                    key, chapter: { id, number: 1 },
                    pages: Array.from({ length: 4 }, (_, i) => ({ url: `/read/api/manga/image?key=${encodeURIComponent(key)}&id=${id}&page=${i}` })),
                })
            }
            if (path.pathname.endsWith('/manga/image')) {
                const index = Number(path.searchParams.get('page'))
                if (index === 1) { await entered; return new Response('Unavailable', { status: 503 }) }
                return new Response(`page ${index}`)
            }
            throw new Error(`unexpected request ${path}`)
        })
        try {
            const task = manga.downloadMangaChapter(key, id).then(() => 'saved', error => error.message)
            await entered
            const early = await Promise.race([task.then(() => 'finished'), new Promise(resolve => setTimeout(() => resolve('pending'), 75))])
            releaseWrite()
            const error = await task
            const leftovers = await Promise.all(Array.from({ length: 4 }, async (_, i) =>
                !!await storage.dlRead(storage.dlPath.mangaPage(key, id, i))))
            return { early, error, leftovers, saved: !!manga.mangaDlEntry(key, id), active: !!manga.mangaDlActive(key, id) }
        } finally {
            releaseWrite()
            FileSystemWritableFileStream.prototype.write = originalWrite
        }
    })
    expect(result).toEqual({
        early: 'pending', error: 'page 2 failed (http 503)',
        leftovers: [false, false, false, false], saved: false, active: false,
    })
})
