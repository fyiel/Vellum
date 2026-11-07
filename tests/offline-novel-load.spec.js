import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

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
