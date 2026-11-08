import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

test('saved novel chapter keeps the known series total when the catalog fails', async ({ page }) => {
    await page.goto(app)
    const key = 'offline-novel-total'
    await page.evaluate(async key => {
        const dl = await import('/src/lib/downloads.js')
        const { touchLibrary } = await import('/src/lib/store.js')
        touchLibrary({ slug: key, kind: 'novel', title: 'Saved Book', total: 600 })
        await dl.dlWrite(dl.dlPath.novelChapter(key, 1), JSON.stringify({ html: '<p>saved offline novel</p>' }))
        dl.dlRegister({ kind: 'novel', key, id: '1', title: 'Saved Book', label: 'Chapter 1' })
        const { setTransport } = await import('/src/lib/http.js')
        setTransport(async () => { throw new Error('catalog unavailable') })
        location.hash = `#/read/${key}/1`
    }, key)

    await expect(page.locator('#reader-prose')).toContainText('saved offline novel')
    await expect.poll(() => page.evaluate(key => {
        const entry = JSON.parse(localStorage.getItem('vellum:lib')).find(item => item.slug === key)
        return { total: entry?.total, lastN: entry?.lastN, readCount: entry?.readCount }
    }, key)).toEqual({ total: 600, lastN: 1, readCount: 1 })
})

test('recovers the full novel chapter list when the catalog becomes available again', async ({ page }) => {
    const slug = 'novel-catalog-recovery'
    let catalogRequests = 0
    await page.route(`**/read/api/chapters?slug=${slug}`, route => {
        // The HTTP client retries transient errors once before using saved chapters.
        if (++catalogRequests <= 2) return route.fulfill({ status: 503, json: { error: 'offline' } })
        return route.fulfill({ json: { chapters: [1, 2, 3].map(n => ({ n, t: `Chapter ${n}` })) } })
    })
    await page.route(`**/read/api/chapter?slug=${slug}&n=*`, route => {
        const n = Number(new URL(route.request().url()).searchParams.get('n'))
        return route.fulfill({ json: { html: `<p>Online chapter ${n}</p>` } })
    })
    await page.route('**/read/api/series/**', route => route.fulfill({
        json: { title: 'Recovery novel', nfSlug: slug, key: `nf:${slug}` },
    }))

    await page.goto(app)
    await page.evaluate(async slug => {
        const dl = await import('/src/lib/downloads.js')
        await dl.dlWrite(dl.dlPath.novelChapter(slug, 1), JSON.stringify({ html: '<p>Saved chapter one</p>' }))
        dl.dlRegister({ kind: 'novel', key: slug, id: '1', title: 'Recovery novel' })
        location.hash = `#/read/${slug}/1`
    }, slug)
    await expect(page.locator('#reader-prose')).toContainText('Saved chapter one')
    expect(catalogRequests).toBe(2)

    await page.evaluate(slug => { location.hash = `#/read/${slug}/2` }, slug)
    await expect(page.locator('#reader-prose')).toContainText('Online chapter 2')
    await expect(page.locator('#r-pos')).toContainText('2 / 3')
    expect(catalogRequests).toBe(3)

    await page.evaluate(slug => { location.hash = `#/read/${slug}/1` }, slug)
    await expect(page.locator('#reader-prose')).toContainText('Saved chapter one')
    expect(catalogRequests).toBe(3)
})

test('missing, empty, or invalid saved novel chapters allow a fresh download', async ({ page }) => {
    await page.goto(app)
    const results = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const novel = await import('/src/lib/dl-novel.js')
        const { setTransport } = await import('/src/lib/http.js')
        setTransport(async () => Response.json({ html: '<p>Fresh chapter</p>' }))
        const results = []
        for (const [kind, oldText] of [
            ['missing', null], ['empty', ''], ['bad-json', '{"html":'],
            ['bad-html', JSON.stringify({ html: ' ' })],
        ]) {
            const key = `novel-stale-${kind}`, n = 1
            if (oldText !== null) await dl.dlWrite(dl.dlPath.novelChapter(key, n), oldText)
            dl.dlRegister({ kind: 'novel', key, id: String(n), title: 'Fixture' })
            const offline = await novel.loadDownloadedNovelChapter(key, n)
            const stale = !!novel.novelDlEntry(key, n)
            const retained = await (await dl.dlRead(dl.dlPath.novelChapter(key, n)))?.text() ?? null
            await novel.downloadNovelChapter(key, n, 'Fixture')
            const copy = await novel.loadDownloadedNovelChapter(key, n)
            results.push({ kind, offline: offline === null, stale, retained,
                saved: !!novel.novelDlEntry(key, n), html: copy?.html })
        }
        return results
    })
    expect(results).toEqual([
        ['missing', null], ['empty', ''], ['bad-json', '{"html":'],
        ['bad-html', JSON.stringify({ html: ' ' })],
    ].map(([kind, retained]) => ({ kind, offline: true, stale: false, retained,
        saved: true, html: '<p>Fresh chapter</p>' })))
})

test('failed retry of a corrupt novel chapter leaves its original bytes and images intact', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const novel = await import('/src/lib/dl-novel.js')
        const { setTransport } = await import('/src/lib/http.js')
        const key = 'novel-stale-failed-retry', n = 1, original = '{"html":"recoverable data"'
        await dl.dlWrite(dl.dlPath.novelChapter(key, n), original)
        await dl.dlWrite(dl.dlPath.novelImage(key, n, 0), 'old illustration')
        dl.dlRegister({ kind: 'novel', key, id: String(n), title: 'Fixture' })
        await novel.loadDownloadedNovelChapter(key, n)
        setTransport(async () => { throw new Error('temporarily offline') })
        let failure
        try { await novel.downloadNovelChapter(key, n, 'Fixture') } catch (e) { failure = e.message }
        return { failure, registered: !!novel.novelDlEntry(key, n),
            chapter: await (await dl.dlRead(dl.dlPath.novelChapter(key, n)))?.text() ?? null,
            illustration: await (await dl.dlRead(dl.dlPath.novelImage(key, n, 0)))?.text() ?? null,
            original }
    })
    expect(result.failure).toContain('temporarily offline')
    expect(result).toMatchObject({ registered: false, illustration: 'old illustration', chapter: result.original })
})

test('replacing a corrupt novel chapter preserves orphan illustrations through failed writes and retry', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const novel = await import('/src/lib/dl-novel.js')
        const { setTransport } = await import('/src/lib/http.js')
        const key = 'novel-stale-image-collision', n = 1, original = '{"html":"partially saved"'
        await dl.dlWrite(dl.dlPath.novelChapter(key, n), original)
        await dl.dlWrite(dl.dlPath.novelImage(key, n, 0), 'old illustration')
        dl.dlRegister({ kind: 'novel', key, id: String(n), title: 'Fixture' })
        await novel.loadDownloadedNovelChapter(key, n)
        setTransport(async url => String(url).includes('/chapter?')
            ? Response.json({ html: '<p>Fresh</p><img src="https://images.example/new.png">' })
            : new Response('new illustration'))
        const setItem = Storage.prototype.setItem
        Storage.prototype.setItem = function (name, value) {
            if (name === 'vellum:dl') throw new DOMException('Full', 'QuotaExceededError')
            return setItem.call(this, name, value)
        }
        let error
        try { await novel.downloadNovelChapter(key, n, 'Fixture') } catch (e) { error = e.message }
        finally { Storage.prototype.setItem = setItem }
        const afterFailure = {
            chapter: await (await dl.dlRead(dl.dlPath.novelChapter(key, n)))?.text(),
            originalImage: await (await dl.dlRead(dl.dlPath.novelImage(key, n, 0)))?.text(),
            newImage: !!await dl.dlRead(dl.dlPath.novelImage(key, n, 1)),
        }
        await novel.downloadNovelChapter(key, n, 'Fixture')
        return { error, afterFailure, saved: !!novel.novelDlEntry(key, n),
            chapter: (await novel.loadDownloadedNovelChapter(key, n))?.html,
            originalImage: await (await dl.dlRead(dl.dlPath.novelImage(key, n, 0)))?.text(),
            newImage: await (await dl.dlRead(dl.dlPath.novelImage(key, n, 1)))?.text(),
            original }
    })
    expect(result.error).toContain('download list')
    expect(result.afterFailure).toEqual({ chapter: result.original, originalImage: 'old illustration', newImage: false })
    expect(result.saved).toBe(true)
    expect(result.chapter).toContain('src="blob:')
    expect(result.originalImage).toBe('old illustration')
    expect(result.newImage).toBe('new illustration')
})

test('temporary novel file read failures preserve the downloaded entry', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const novel = await import('/src/lib/dl-novel.js')
        const key = 'novel-unreadable', n = 1
        await dl.dlWrite(dl.dlPath.novelChapter(key, n), JSON.stringify({ html: '<p>Saved chapter</p>' }))
        dl.dlRegister({ kind: 'novel', key, id: String(n), title: 'Fixture' })
        const getFile = FileSystemFileHandle.prototype.getFile
        FileSystemFileHandle.prototype.getFile = async function (...args) {
            if (this.name === '1.json') throw new DOMException('In use', 'NotReadableError')
            return getFile.apply(this, args)
        }
        let offline
        try { offline = await novel.loadDownloadedNovelChapter(key, n) }
        finally { FileSystemFileHandle.prototype.getFile = getFile }
        return { offline: offline === null, registered: !!novel.novelDlEntry(key, n),
            original: (await novel.loadDownloadedNovelChapter(key, n))?.html }
    })
    expect(result).toEqual({ offline: true, registered: true, original: '<p>Saved chapter</p>' })
})

test('saved novel illustrations open concurrently in order and reuse duplicate slots', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const { loadDownloadedNovelChapter } = await import('/src/lib/dl-novel.js')
        const key = 'offline-illustrations', n = 1, count = 12
        for (let i = 0; i < count; i++) await dl.dlWrite(dl.dlPath.novelImage(key, n, i), `image ${i}`)
        const html = Array.from({ length: count }, (_, i) => `<img src="dlimg:${i}">`).join('') + '<img src="dlimg:0">'
        await dl.dlWrite(dl.dlPath.novelChapter(key, n), JSON.stringify({ html }))
        dl.dlRegister({ kind: 'novel', key, id: String(n), title: 'Fixture' })

        const original = FileSystemDirectoryHandle.prototype.getFileHandle
        let concurrent = 0, maxConcurrent = 0, reads = 0
        FileSystemDirectoryHandle.prototype.getFileHandle = async function (name, options) {
            if (/^\d+$/.test(name)) {
                reads++
                concurrent++
                maxConcurrent = Math.max(maxConcurrent, concurrent)
                await new Promise(resolve => setTimeout(resolve, 20))
                concurrent--
            }
            return original.call(this, name, options)
        }
        const nativeCreate = URL.createObjectURL
        const blobs = new Map()
        URL.createObjectURL = function (blob) { const url = nativeCreate.call(URL, blob); blobs.set(url, blob); return url }
        try {
            const startSerial = performance.now()
            for (let i = 0; i < count; i++) await dl.dlRead(dl.dlPath.novelImage(key, n, i))
            const serialMs = performance.now() - startSerial
            reads = 0
            maxConcurrent = 0
            const startParallel = performance.now()
            const copy = await loadDownloadedNovelChapter(key, n)
            const parallelMs = performance.now() - startParallel
            const urls = [...copy.html.matchAll(/src="(blob:[^"]+)"/g)].map(match => match[1])
            const contents = await Promise.all(urls.map(url => blobs.get(url).text()))
            for (const url of new Set(urls)) URL.revokeObjectURL(url)
            return { serialMs, parallelMs, maxConcurrent, reads, contents, duplicateUrl: urls.at(-1) === urls[0] }
        } finally {
            FileSystemDirectoryHandle.prototype.getFileHandle = original
            URL.createObjectURL = nativeCreate
        }
    })
    expect(result.maxConcurrent).toBeGreaterThan(1)
    expect(result.maxConcurrent).toBeLessThanOrEqual(4)
    expect(result.reads).toBe(12)
    expect(result.parallelMs).toBeLessThan(result.serialMs / 2)
    expect(result.duplicateUrl).toBe(true)
    expect(result.contents).toEqual([...Array.from({ length: 12 }, (_, i) => `image ${i}`), 'image 0'])
    console.log(`Saved novel 12 illustrations: serial=${result.serialMs.toFixed(1)}ms, concurrent=${result.parallelMs.toFixed(1)}ms`)
})

test('saved novel illustrations resolve single-quoted and unquoted local image slots', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const { loadDownloadedNovelChapter } = await import('/src/lib/dl-novel.js')
        const key = 'offline-quoted-images', n = 1
        await dl.dlWrite(dl.dlPath.novelImage(key, n, 0), 'Existing illustration')
        await dl.dlWrite(dl.dlPath.novelChapter(key, n), JSON.stringify({
            html: `<p>Offline chapter</p><IMG SRC='dlimg:0'><img src=dlimg:0>`,
        }))
        dl.dlRegister({ kind: 'novel', key, id: String(n), title: 'Saved chapter' })
        const create = URL.createObjectURL
        const blobs = new Map()
        URL.createObjectURL = function (blob) {
            const url = create.call(URL, blob)
            blobs.set(url, blob)
            return url
        }
        try {
            const saved = await loadDownloadedNovelChapter(key, n)
            const sources = [...new DOMParser().parseFromString(saved.html, 'text/html').querySelectorAll('img')]
                .map(img => img.getAttribute('src'))
            const bytes = await blobs.get(sources[0])?.text()
            for (const url of new Set(sources)) if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
            return { sources, bytes }
        } finally { URL.createObjectURL = create }
    })
    expect(result.sources).toHaveLength(2)
    expect(result.sources[0]).toMatch(/^blob:/)
    expect(result.sources[1]).toBe(result.sources[0])
    expect(result.bytes).toBe('Existing illustration')
})

test('cancelled saved-novel loads stop before materializing illustration URLs', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const { loadDownloadedNovelChapter } = await import('/src/lib/dl-novel.js')
        const key = 'offline-novel-cancel', n = 1
        for (let i = 0; i < 10; i++) await dl.dlWrite(dl.dlPath.novelImage(key, n, i), `image ${i}`)
        await dl.dlWrite(dl.dlPath.novelChapter(key, n), JSON.stringify({ html: Array.from({ length: 10 }, (_, i) => `<img src="dlimg:${i}">`).join('') }))
        dl.dlRegister({ kind: 'novel', key, id: String(n), title: 'Fixture' })

        const ctrl = new AbortController()
        const original = FileSystemDirectoryHandle.prototype.getFileHandle
        const create = URL.createObjectURL, revoke = URL.revokeObjectURL
        let reads = 0
        const created = [], revoked = []
        URL.createObjectURL = function (blob) { const url = create.call(URL, blob); created.push(url); return url }
        URL.revokeObjectURL = function (url) { revoked.push(url); revoke.call(URL, url) }
        FileSystemDirectoryHandle.prototype.getFileHandle = async function (name, options) {
            if (/^\d+$/.test(name)) {
                reads++
                await new Promise(resolve => setTimeout(resolve, 15))
                ctrl.abort()
            }
            return original.call(this, name, options)
        }
        try {
            const copy = await loadDownloadedNovelChapter(key, n, { signal: ctrl.signal })
            return { cancelled: copy === null, reads, allReleased: created.every(url => revoked.includes(url)) }
        } finally {
            FileSystemDirectoryHandle.prototype.getFileHandle = original
            URL.createObjectURL = create
            URL.revokeObjectURL = revoke
        }
    })
    expect(result.cancelled).toBe(true)
    expect(result.reads).toBeLessThanOrEqual(4)
    expect(result.allReleased).toBe(true)
})

test('an illustration URL failure cleans up URLs created earlier in the chapter', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const { loadDownloadedNovelChapter } = await import('/src/lib/dl-novel.js')
        const key = 'novel-url-failure', n = 1
        for (let i = 0; i < 3; i++) await dl.dlWrite(dl.dlPath.novelImage(key, n, i), `image ${i}`)
        await dl.dlWrite(dl.dlPath.novelChapter(key, n), JSON.stringify({ html: '<img src="dlimg:0"><img src="dlimg:1"><img src="dlimg:2">' }))
        dl.dlRegister({ kind: 'novel', key, id: '1', title: 'Fixture' })
        const create = URL.createObjectURL, revoke = URL.revokeObjectURL
        const created = [], revoked = []
        URL.createObjectURL = function (blob) {
            if (created.length === 1) throw new Error('could not create image URL')
            const url = create.call(URL, blob)
            created.push(url)
            return url
        }
        URL.revokeObjectURL = function (url) { revoked.push(url); revoke.call(URL, url) }
        try {
            const copy = await loadDownloadedNovelChapter(key, n)
            return { failed: copy === null, created: created.length, allReleased: created.every(url => revoked.includes(url)) }
        } finally {
            URL.createObjectURL = create
            URL.revokeObjectURL = revoke
        }
    })
    expect(result).toEqual({ failed: true, created: 1, allReleased: true })
})

test('closing an offline novel stops queued illustration disk reads', async ({ page }) => {
    await page.goto(app)
    await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const key = 'offline-novel-close', n = 1
        for (let i = 0; i < 12; i++) await dl.dlWrite(dl.dlPath.novelImage(key, n, i), `image ${i}`)
        await dl.dlWrite(dl.dlPath.novelChapter(key, n), JSON.stringify({ html: Array.from({ length: 12 }, (_, i) => `<img src="dlimg:${i}">`).join('') }))
        dl.dlRegister({ kind: 'novel', key, id: String(n), title: 'Fixture' })
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })

        window.novelReadProbe = { reads: 0 }
        const gate = new Promise(resolve => { window.releaseNovelReads = resolve })
        const original = FileSystemDirectoryHandle.prototype.getFileHandle
        FileSystemDirectoryHandle.prototype.getFileHandle = async function (name, options) {
            if (/^\d+$/.test(name)) {
                window.novelReadProbe.reads++
                await gate
            }
            return original.call(this, name, options)
        }
        location.hash = '#/read/offline-novel-close/1'
    })
    await page.waitForFunction(() => window.novelReadProbe.reads > 0)
    await page.evaluate(() => { location.hash = '#/'; window.releaseNovelReads() })
    await expect(page.locator('#reader')).not.toHaveClass(/active/)
    await page.waitForTimeout(150)
    expect(await page.evaluate(() => window.novelReadProbe.reads)).toBeLessThanOrEqual(4)
})
