import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

test('novel downloads overlap illustration requests while keeping source order and missing images', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { setTransport } = await import('/src/lib/http.js')
        const novel = await import('/src/lib/dl-novel.js')
        const storage = await import('/src/lib/downloads.js')
        const key = 'novel-illustration-overlap', count = 12
        let concurrent = 0, maxConcurrent = 0
        setTransport(async url => {
            const path = new URL(url, location.href)
            if (path.pathname.endsWith('/read/api/chapter')) {
                return Response.json({ html: '<p>Chapter text</p>' + Array.from({ length: count }, (_, i) =>
                    `<img src="https://images.example/pic-${i}.png">`).join('') })
            }
            const remote = path.pathname.endsWith('/read/api/image')
                ? new URL(path.searchParams.get('url')) : path
            const match = remote.pathname.match(/\/pic-(\d+)\.png$/)
            if (!match) throw new Error(`unexpected request ${path}`)
            const index = Number(match[1])
            concurrent++
            maxConcurrent = Math.max(maxConcurrent, concurrent)
            await new Promise(resolve => setTimeout(resolve, index % 3 === 0 ? 45 : 25))
            concurrent--
            if (index === 3) return new Response('Unavailable', { status: 503 })
            return new Response(`illustration ${index}`, { headers: { 'content-type': 'image/png' } })
        })

        const started = performance.now()
        await novel.downloadNovelChapter(key, 1, 'Fixture')
        const durationMs = performance.now() - started
        const entry = novel.novelDlEntry(key, 1)
        const chapter = JSON.parse(await (await storage.dlRead(storage.dlPath.novelChapter(key, 1))).text())
        const doc = new DOMParser().parseFromString(chapter.html, 'text/html')
        const sources = [...doc.querySelectorAll('img')].map(img => img.getAttribute('src'))
        const contents = await Promise.all(sources.map(async source => {
            const slot = /^dlimg:(\d+)$/.exec(source)
            return slot ? (await storage.dlRead(storage.dlPath.novelImage(key, 1, slot[1])))?.text() : source
        }))
        return { durationMs, maxConcurrent, entry, sources, contents, active: novel.novelDlActive(key, 1) }
    })
    console.log(`Novel 12 illustrations with 25–45ms request delays: ${result.durationMs.toFixed(1)}ms (${result.maxConcurrent} simultaneous requests)`)
    expect(result.maxConcurrent).toBeGreaterThan(1)
    expect(result.maxConcurrent).toBeLessThanOrEqual(4)
    expect(result.active).toBeNull()
    expect(result.entry?.kind).toBe('novel')
    expect(result.sources).toEqual(Array.from({ length: 12 }, (_, i) =>
        i === 3 ? 'https://images.example/pic-3.png' : `dlimg:${i < 3 ? i : i - 1}`))
    expect(result.contents).toEqual(Array.from({ length: 12 }, (_, i) =>
        i === 3 ? 'https://images.example/pic-3.png' : `illustration ${i}`))
})

test('startup novel repair avoids parsing text-only chapters and still upgrades legacy illustrations', async ({ page }) => {
    // Suppress the automatic launch scan until the fixture and instrumentation are ready.
    await page.addInitScript(() => {
        window.testOnline = false
        Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => window.testOnline })
    })
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const { upgradeNovelDownloads } = await import('/src/lib/dl-novel.js')
        const { setTransport } = await import('/src/lib/http.js')
        const key = 'startup-novel-scan'
        const plainCount = 250
        const plainHtml = `<p>${'Long chapter text. '.repeat(1000)}</p>`
        const entries = []
        for (let i = 1; i <= plainCount; i++) {
            await dl.dlWrite(dl.dlPath.novelChapter(key, i), JSON.stringify({ html: plainHtml }))
            entries.push({ kind: 'novel', key, id: String(i), title: 'Offline chapter' })
        }
        const legacy = plainCount + 1
        const originalImage = 'Previously saved illustration'
        const legacyHtml = `<p>Legacy chapter</p><img src="dlimg:0"><IMG SRC='https&#58;//images.example/legacy.png'>`
        // Older exports can encode '<' as a JSON escape, so test the parsed HTML.
        await dl.dlWrite(dl.dlPath.novelChapter(key, legacy), JSON.stringify({ html: legacyHtml }).replace(/</g, '\\u003c'))
        await dl.dlWrite(dl.dlPath.novelImage(key, legacy, 0), originalImage)
        entries.push({ kind: 'novel', key, id: String(legacy), title: 'Legacy chapter' })
        localStorage.setItem('vellum:dl', JSON.stringify(entries))
        const requests = []
        setTransport(async url => {
            requests.push(String(url))
            return new Response('Restored illustration', { headers: { 'content-type': 'image/png' } })
        })
        const parse = DOMParser.prototype.parseFromString
        let parses = 0
        DOMParser.prototype.parseFromString = function (...args) {
            parses++
            return parse.apply(this, args)
        }
        window.testOnline = true
        let elapsedMs
        try {
            const started = performance.now()
            await upgradeNovelDownloads()
            elapsedMs = performance.now() - started
        } finally { DOMParser.prototype.parseFromString = parse }
        const repaired = JSON.parse(await (await dl.dlRead(dl.dlPath.novelChapter(key, legacy))).text())
        const oldImage = await (await dl.dlRead(dl.dlPath.novelImage(key, legacy, 0))).text()
        const newImage = await (await dl.dlRead(dl.dlPath.novelImage(key, legacy, 1))).text()
        return { parses, elapsedMs, requests, repaired: repaired.html, oldImage, newImage }
    })
    console.log(`Startup scan of 250 19KB text chapters and one legacy illustrated chapter: ${result.elapsedMs.toFixed(1)}ms, ${result.parses} HTML parses`)
    expect(result.parses).toBeLessThanOrEqual(2)
    expect(result.requests).toEqual(['https://images.example/legacy.png'])
    expect(result.repaired).toContain('src="dlimg:0"')
    expect(result.repaired).toContain('src="dlimg:1"')
    expect(result.oldImage).toBe('Previously saved illustration')
    expect(result.newImage).toBe('Restored illustration')

    await page.reload()
    const second = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const { upgradeNovelDownloads } = await import('/src/lib/dl-novel.js')
        const { setTransport } = await import('/src/lib/http.js')
        const key = 'startup-novel-scan'
        // Replacing a checked chapter must invalidate its checkpoint so a
        // newly encountered legacy image is still repaired on the next launch.
        await dl.dlWrite(dl.dlPath.novelChapter(key, 1), JSON.stringify({
            html: '<p>Replaced chapter</p><img src="//images.example/replaced.png">',
        }))
        dl.dlRegister({ kind: 'novel', key, id: '1', title: 'Offline chapter' })
        const requests = []
        setTransport(async url => {
            requests.push(String(url))
            return new Response('Replaced illustration', { headers: { 'content-type': 'image/png' } })
        })
        const getFile = FileSystemFileHandle.prototype.getFile
        let reads = 0
        FileSystemFileHandle.prototype.getFile = function (...args) {
            reads++
            return getFile.apply(this, args)
        }
        window.testOnline = true
        let elapsedMs
        try {
            const started = performance.now()
            await upgradeNovelDownloads()
            elapsedMs = performance.now() - started
        } finally { FileSystemFileHandle.prototype.getFile = getFile }
        const chapter = JSON.parse(await (await dl.dlRead(dl.dlPath.novelChapter(key, 1))).text())
        return { elapsedMs, reads, requests, html: chapter.html }
    })
    console.log(`Reopen after 250 text chapters audited and one changed: ${second.elapsedMs.toFixed(1)}ms, ${second.reads} file reads`)
    expect(second.reads).toBeLessThanOrEqual(4)
    expect(second.requests).toEqual(['http://images.example/replaced.png'])
    expect(second.html).toContain('src="dlimg:0"')
})

test('failed legacy illustration repairs retry on the next launch', async ({ page }) => {
    await page.addInitScript(() => {
        window.testOnline = false
        Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => window.testOnline })
    })
    await page.goto(app)
    const original = '<p>Saved text</p><img src="https://images.example/temporarily-down.png">'
    const first = await page.evaluate(async html => {
        const dl = await import('/src/lib/downloads.js')
        const { upgradeNovelDownloads } = await import('/src/lib/dl-novel.js')
        const { setTransport } = await import('/src/lib/http.js')
        await dl.dlWrite(dl.dlPath.novelChapter('retry-images', 1), JSON.stringify({ html }))
        dl.dlRegister({ kind: 'novel', key: 'retry-images', id: '1', title: 'Saved text' })
        setTransport(async () => new Response('Image unavailable', { status: 503 }))
        window.testOnline = true
        await upgradeNovelDownloads()
        return JSON.parse(await (await dl.dlRead(dl.dlPath.novelChapter('retry-images', 1))).text()).html
    }, original)
    expect(first).toContain('https://images.example/temporarily-down.png')

    await page.reload()
    const second = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const { upgradeNovelDownloads } = await import('/src/lib/dl-novel.js')
        const { setTransport } = await import('/src/lib/http.js')
        let requests = 0
        setTransport(async () => {
            requests++
            return new Response('Recovered image', { headers: { 'content-type': 'image/png' } })
        })
        window.testOnline = true
        await upgradeNovelDownloads()
        const html = JSON.parse(await (await dl.dlRead(dl.dlPath.novelChapter('retry-images', 1))).text()).html
        const image = await (await dl.dlRead(dl.dlPath.novelImage('retry-images', 1, 0)))?.text()
        return { html, image, requests }
    })
    expect(second).toEqual({ html: '<p>Saved text</p><img src="dlimg:0">', image: 'Recovered image', requests: 1 })
})
