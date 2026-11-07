import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`
const tauri = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url)))
const webmClip = [...readFileSync(new URL('./fixtures/offline-clip.webm', import.meta.url))]

test('cancelling a manga download interrupts pending metadata requests', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { setTransport } = await import('/src/lib/http.js')
        const dl = await import('/src/lib/dl-manga.js')
        const key = 'mf:cancel-metadata', id = 'c1'
        let requests = 0, aborted = 0
        setTransport((url, init) => new Promise((resolve, reject) => {
            requests++
            const timer = setTimeout(() => resolve(Response.json({})), 600)
            init.signal.addEventListener('abort', () => {
                clearTimeout(timer)
                aborted++
                reject(new DOMException('Cancelled', 'AbortError'))
            }, { once: true })
        }))
        const task = dl.downloadMangaChapter(key, id).then(() => 'saved', error => error.message)
        const until = performance.now() + 300
        while (requests < 2 && performance.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
        dl.cancelMangaDownload(key, id)
        const outcome = await Promise.race([task, new Promise(resolve => setTimeout(() => resolve('pending'), 150))])
        return { requests, aborted, outcome, active: !!dl.mangaDlActive(key, id), saved: !!dl.mangaDlEntry(key, id) }
    })
    expect(result.requests).toBe(2)
    expect(result.aborted).toBe(2)
    expect(result.outcome).not.toBe('pending')
    expect(result.active).toBe(false)
    expect(result.saved).toBe(false)
})

test('cancelling a manga download at the final page never registers an incomplete copy', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { setTransport } = await import('/src/lib/http.js')
        const dl = await import('/src/lib/dl-manga.js')
        const { dlRead, dlPath } = await import('/src/lib/downloads.js')
        const key = 'mf:cancel-final', id = 'c1'
        setTransport(async url => {
            const path = String(url)
            if (path.includes('/manga/series/')) return Response.json({ key, kind: 'manga', title: 'Fixture', format: 'manga' })
            if (path.includes('/manga/chapter?')) return Response.json({
                key, chapter: { id, number: 1, title: 'First' },
                pages: [{ url: `/read/api/manga/image?key=${encodeURIComponent(key)}&id=${id}&page=0` }],
            })
            if (path.includes('/manga/image?')) return {
                ok: true, status: 200,
                blob: async () => {
                    dl.cancelMangaDownload(key, id)
                    return new Blob(['incomplete image'])
                },
            }
            throw new Error(`unexpected request ${path}`)
        })
        const outcome = await dl.downloadMangaChapter(key, id).then(() => 'saved', error => error.message)
        return {
            outcome, active: !!dl.mangaDlActive(key, id),
            saved: !!dl.mangaDlEntry(key, id),
            bytes: !!await dlRead(dlPath.mangaPage(key, id, 0)),
        }
    })
    expect(result).toEqual({ outcome: 'download cancelled', active: false, saved: false, bytes: false })
})

test('a failed video writer releases its job and permits retry', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const storage = navigator.storage
        const getDirectory = storage.getDirectory.bind(storage)
        let failed = false
        Object.defineProperty(storage, 'getDirectory', { value: async () => {
            if (!failed) { failed = true; throw new DOMException('Disk full', 'QuotaExceededError') }
            return getDirectory()
        } })
        const { setTransport } = await import('/src/lib/http.js')
        const dl = await import('/src/lib/dl-video.js')
        setTransport(async url => String(url).includes('/playback?')
            ? Response.json({ key: 'mock:retry', episodeId: '1', providerLabel: 'Test', sources: [{ kind: 'direct', url: '/video.mp4', type: 'video/mp4' }] })
            : new Response(new Uint8Array([1, 2, 3])))
        let error
        try { await dl.downloadVideoEpisode('mock:retry', '1') } catch (e) { error = e.message }
        const activeAfterFailure = !!dl.videoDlActive('mock:retry', '1')
        await dl.downloadVideoEpisode('mock:retry', '1')
        return { error, activeAfterFailure, activeAfterRetry: !!dl.videoDlActive('mock:retry', '1'), saved: !!dl.videoDlEntry('mock:retry', '1') }
    })
    expect(result).toEqual({ error: 'Disk full', activeAfterFailure: false, activeAfterRetry: false, saved: true })
})

test('downloaded WebM episodes retain their format and play from offline storage', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async bytes => {
        const { setTransport } = await import('/src/lib/http.js')
        const { dlEntry } = await import('/src/lib/downloads.js')
        const { downloadVideoEpisode, loadDownloadedVideoUrl } = await import('/src/lib/dl-video.js')
        const key = 'mock:webm', id = 'first'
        setTransport(async url => {
            const path = String(url)
            if (path.includes('/playback?')) return Response.json({ key, episodeId: id, providerLabel: 'WebM', sources: [{ kind: 'direct', url: '/clip.webm', type: 'video/webm' }] })
            if (path.includes('/series/')) return Response.json({ key, kind: 'anime', title: 'WebM fixture', episodes: [{ id, number: 1, title: 'Clip' }] })
            return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'video/webm' } })
        })
        await downloadVideoEpisode(key, id, { title: 'WebM fixture' })
        const originalCreate = URL.createObjectURL.bind(URL)
        let objectMime
        URL.createObjectURL = blob => { objectMime = blob.type; return originalCreate(blob) }
        const url = await loadDownloadedVideoUrl(key, id)
        URL.createObjectURL = originalCreate
        const video = document.createElement('video')
        video.preload = 'auto'
        video.src = url
        document.body.append(video)
        const playback = await Promise.race([
            new Promise(resolve => {
                video.onloadedmetadata = () => resolve('loaded')
                video.onerror = () => resolve(`error ${video.error?.code}`)
            }),
            new Promise(resolve => setTimeout(() => resolve('timed out'), 5000)),
        ])
        video.remove()
        URL.revokeObjectURL(url)
        return { savedMime: dlEntry('video', key, id)?.mime, objectMime, playback }
    }, webmClip)
    expect(result).toEqual({ savedMime: 'video/webm', objectMime: 'video/webm', playback: 'loaded' })

    await page.evaluate(() => {
        const original = HTMLMediaElement.prototype.canPlayType
        HTMLMediaElement.prototype.canPlayType = function (type) {
            ;(window.__probedVideoTypes ||= []).push(type)
            return original.call(this, type)
        }
        location.hash = '#/watch/play/mock%3Awebm/first'
    })
    await expect(page.locator('#vplayer video.video-media')).toBeVisible()
    expect(await page.evaluate(() => window.__probedVideoTypes)).toContain('video/webm')
})

test('registry quota failures reject downloads and keep existing entries recoverable', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const { downloadNovelChapter, deleteNovelDownload } = await import('/src/lib/dl-novel.js')
        const { setTransport } = await import('/src/lib/http.js')
        setTransport(async () => Response.json({ n: 1, html: '<p>Offline copy</p>' }))
        await dl.dlWrite(dl.dlPath.novelChapter('existing', 1), JSON.stringify({ html: '<p>Existing copy</p>' }))
        dl.dlRegister({ kind: 'novel', key: 'existing', id: '1' })
        const setItem = Storage.prototype.setItem
        Storage.prototype.setItem = function (key, value) {
            if (key === 'vellum:dl') throw new DOMException('Registry full', 'QuotaExceededError')
            return setItem.call(this, key, value)
        }
        let downloadError, deleteError
        try { await downloadNovelChapter('new', 1, 'New') } catch (e) { downloadError = e.message }
        try { await deleteNovelDownload('existing', 1) } catch (e) { deleteError = e.message }
        return {
            downloadError, deleteError,
            newEntry: dl.dlEntry('novel', 'new', '1'), newBytes: !!await dl.dlRead(dl.dlPath.novelChapter('new', 1)),
            existingEntry: !!dl.dlEntry('novel', 'existing', '1'), existingBytes: !!await dl.dlRead(dl.dlPath.novelChapter('existing', 1)),
        }
    })
    expect(result.downloadError).toContain('download list')
    expect(result.deleteError).toContain('download list')
    expect(result).toMatchObject({ newEntry: null, newBytes: false, existingEntry: true, existingBytes: true })
})

test('native chapter text is sent to the filesystem as UTF-8 bytes', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        let written
        window.__TAURI_INTERNALS__ = { invoke: async (command, data) => {
            if (command === 'plugin:fs|write_file') {
                if (!(data instanceof Uint8Array)) throw new Error('writeFile requires Uint8Array')
                written = new TextDecoder().decode(data)
            }
        } }
        const dl = await import('/src/lib/downloads.js')
        await dl.dlWrite(dl.dlPath.novelChapter('unicode', 1), 'Chapter café 世界')
        return written
    })
    expect(result).toBe('Chapter café 世界')
})

test('failed OPFS writes abort the writer before propagating the error', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        let aborted = false
        const directory = {
            getDirectoryHandle: async () => directory,
            getFileHandle: async () => ({ createWritable: async () => ({
                write: async () => { throw new DOMException('Disk full', 'QuotaExceededError') },
                abort: async () => { aborted = true },
                close: async () => {},
            }) }),
        }
        Object.defineProperty(navigator.storage, 'getDirectory', { value: async () => directory })
        const dl = await import('/src/lib/downloads.js')
        let error
        try { await dl.dlWrite('quota.txt', 'text') } catch (e) { error = e.message }
        return { aborted, error }
    })
    expect(result).toEqual({ aborted: true, error: 'Disk full' })
})

for (const mode of ['steady', 'stalled', 'cancelled']) {
    test(`direct video download handles a ${mode} stream`, async ({ page }) => {
        await page.goto(app)
        const result = await page.evaluate(async mode => {
            // Keep the production timeout at 30 seconds but shorten its clock for this regression.
            const realTimeout = window.setTimeout.bind(window)
            window.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms === 30_000 ? 1000 : ms, ...args)
            AbortSignal.timeout = ms => {
                const ctrl = new AbortController()
                window.setTimeout(() => ctrl.abort(new DOMException('Timed out', 'TimeoutError')), ms)
                return ctrl.signal
            }
            const { setTransport } = await import('/src/lib/http.js')
            const dl = await import('/src/lib/dl-video.js')
            let produced = 0
            setTransport(async (url, init) => {
                if (String(url).includes('/playback?')) return Response.json({ key: `mock:${mode}`, episodeId: '1', providerLabel: 'Test', sources: [{ kind: 'direct', url: '/video.mp4', type: 'video/mp4' }] })
                let timer
                return new Response(new ReadableStream({
                    start(controller) {
                        timer = setInterval(() => {
                            controller.enqueue(new Uint8Array(8))
                            produced++
                            if (mode === 'stalled' || produced === 20) {
                                clearInterval(timer)
                                if (mode !== 'stalled') controller.close()
                            }
                        }, 100)
                        init.signal.addEventListener('abort', () => {
                            clearInterval(timer)
                            controller.error(init.signal.reason)
                        }, { once: true })
                    },
                    cancel() { clearInterval(timer) },
                }))
            })
            let error
            const task = dl.downloadVideoEpisode(`mock:${mode}`, '1').catch(e => { error = e.message })
            if (mode === 'cancelled') realTimeout(() => dl.cancelVideoDownload(`mock:${mode}`, '1'), 250)
            await task
            return { produced, error, saved: !!dl.videoDlEntry(`mock:${mode}`, '1'), active: !!dl.videoDlActive(`mock:${mode}`, '1') }
        }, mode)
        expect(result.active).toBe(false)
        if (mode === 'steady') expect(result).toMatchObject({ produced: 20, saved: true })
        else {
            expect(result.error).toBeTruthy()
            expect(result.saved).toBe(false)
        }
    })
}

for (const policy of ['csp', 'devCsp']) {
    test(`desktop ${policy} permits offline art, media, embeds and HLS workers`, async ({ page }) => {
        await page.route(app, async route => {
            const response = await route.fetch()
            await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': tauri.app.security[policy] } })
        })
        await page.route('https://media.example/**', route => route.fulfill({ contentType: 'video/mp4', body: '' }))
        await page.route('https://embed.example/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Provider fixture</p>' }))
        await page.goto(app)
        const result = await page.evaluate(async () => {
            const violations = []
            const onViolation = e => violations.push(e.effectiveDirective)
            document.addEventListener('securitypolicyviolation', onViolation)
            const image = new Image()
            image.src = URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'], { type: 'image/svg+xml' }))
            document.body.append(image)
            const video = document.createElement('video')
            video.src = 'https://media.example/video.mp4'
            document.body.append(video)
            video.load()
            const frame = document.createElement('iframe')
            frame.src = 'https://embed.example/player'
            document.body.append(frame)
            let workerReady = false
            try {
                const url = URL.createObjectURL(new Blob(['postMessage("ready")'], { type: 'text/javascript' }))
                const worker = new Worker(url)
                worker.onmessage = () => { workerReady = true; worker.terminate(); URL.revokeObjectURL(url) }
            } catch {}
            await new Promise(resolve => setTimeout(resolve, 500))
            document.removeEventListener('securitypolicyviolation', onViolation)
            return { violations, workerReady, imageReady: image.naturalWidth > 0 }
        })
        expect(result).toEqual({ violations: [], workerReady: true, imageReady: true })
    })
}


for (const imageAvailable of [false, true]) {
    test(`novel image repair preserves existing offline images when the source is ${imageAvailable ? 'available' : 'down'}`, async ({ page }) => {
        await page.goto(app)
        const result = await page.evaluate(async imageAvailable => {
            const dl = await import('/src/lib/downloads.js')
            const { downloadNovelChapter } = await import('/src/lib/dl-novel.js')
            const { setTransport } = await import('/src/lib/http.js')
            const key = 'repair-illustrations'
            const html = '<p>Original saved chapter</p><img src="dlimg:0"><img src="https://images.example/missing.png">'
            await dl.dlWrite(dl.dlPath.novelChapter(key, 1), JSON.stringify({ n: 1, html }))
            await dl.dlWrite(dl.dlPath.novelImage(key, 1, 0), 'Original illustration')
            dl.dlRegister({ kind: 'novel', key, id: '1', title: 'Saved chapter' })
            let chapterRequests = 0
            setTransport(async url => {
                if (String(url).includes('/chapter?')) {
                    chapterRequests++
                    return Response.json({ html: '<p>Changed source text</p><img src="https://images.example/old.png"><img src="https://images.example/missing.png">' })
                }
                return imageAvailable ? new Response('New illustration', { headers: { 'content-type': 'image/png' } })
                    : new Response('Unavailable', { status: 503 })
            })
            await downloadNovelChapter(key, 1, 'Saved chapter', { force: true })
            const chapter = JSON.parse(await (await dl.dlRead(dl.dlPath.novelChapter(key, 1))).text())
            return {
                html: chapter.html, chapterRequests,
                oldImage: await (await dl.dlRead(dl.dlPath.novelImage(key, 1, 0))).text(),
                newImage: await (await dl.dlRead(dl.dlPath.novelImage(key, 1, 1)))?.text(),
            }
        }, imageAvailable)
        expect(result.chapterRequests).toBe(0)
        expect(result.html).toContain('Original saved chapter')
        expect(result.html).toContain('src="dlimg:0"')
        expect(result.oldImage).toBe('Original illustration')
        if (imageAvailable) {
            expect(result.html).toContain('src="dlimg:1"')
            expect(result.newImage).toBe('New illustration')
        } else expect(result.html).toContain('https://images.example/missing.png')
    })
}
