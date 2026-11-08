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

test('deleting a manga download waits for an in-flight page write and its cleanup', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { setTransport } = await import('/src/lib/http.js')
        const manga = await import('/src/lib/dl-manga.js')
        const { dlRead, dlPath } = await import('/src/lib/downloads.js')
        const key = 'mf:delete-during-write', id = 'c1'
        setTransport(async url => {
            const path = String(url)
            if (path.includes('/manga/series/')) return Response.json({ key, kind: 'manga', title: 'Fixture', format: 'manga' })
            if (path.includes('/manga/chapter?')) return Response.json({ key, chapter: { id, number: 1 }, pages: [{ url: `/read/api/manga/image?key=${encodeURIComponent(key)}&id=${id}&page=0` }] })
            if (path.includes('/manga/image?')) return new Response('Pending page', { headers: { 'content-type': 'image/png' } })
            throw new Error(`unexpected request ${path}`)
        })
        const original = FileSystemWritableFileStream.prototype.write
        let enterWrite, releaseWrite
        const entered = new Promise(resolve => { enterWrite = resolve })
        const released = new Promise(resolve => { releaseWrite = resolve })
        FileSystemWritableFileStream.prototype.write = async function (data) {
            if (data instanceof Blob && await data.text() === 'Pending page') {
                enterWrite()
                await released
            }
            return original.call(this, data)
        }
        try {
            const task = manga.downloadMangaChapter(key, id).then(() => 'saved', error => error.message)
            await entered
            const deletion = manga.deleteMangaDownload(key, id)
            const early = await Promise.race([deletion.then(() => 'resolved'), new Promise(resolve => setTimeout(() => resolve('pending'), 50))])
            releaseWrite()
            const [outcome] = await Promise.all([task, deletion])
            return { early, outcome, active: !!manga.mangaDlActive(key, id), saved: !!manga.mangaDlEntry(key, id), bytes: !!await dlRead(dlPath.mangaPage(key, id, 0)) }
        } finally { releaseWrite(); FileSystemWritableFileStream.prototype.write = original }
    })
    expect(result).toEqual({ early: 'pending', outcome: 'download cancelled', active: false, saved: false, bytes: false })
})

test('deleting a video download waits for an in-flight file write and its cleanup', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { setTransport } = await import('/src/lib/http.js')
        const video = await import('/src/lib/dl-video.js')
        const { dlRead, dlPath } = await import('/src/lib/downloads.js')
        const key = 'mock:delete-during-write', id = '1'
        setTransport(async url => String(url).includes('/playback?')
            ? Response.json({ key, episodeId: id, providerLabel: 'Test', sources: [{ kind: 'direct', url: '/test.mp4', type: 'video/mp4' }] })
            : new Response(new Uint8Array([1, 2, 3, 4])))
        const original = FileSystemWritableFileStream.prototype.write
        let enterWrite, releaseWrite
        const entered = new Promise(resolve => { enterWrite = resolve })
        const released = new Promise(resolve => { releaseWrite = resolve })
        FileSystemWritableFileStream.prototype.write = async function (data) {
            if (data?.type === 'write' && data.data?.byteLength === 4) {
                enterWrite()
                await released
            }
            return original.call(this, data)
        }
        try {
            const task = video.downloadVideoEpisode(key, id).then(() => 'saved', error => error.message)
            await entered
            const deletion = video.deleteVideoDownload(key, id)
            const early = await Promise.race([deletion.then(() => 'resolved'), new Promise(resolve => setTimeout(() => resolve('pending'), 50))])
            releaseWrite()
            const [outcome] = await Promise.all([task, deletion])
            return { early, outcome, active: !!video.videoDlActive(key, id), saved: !!video.videoDlEntry(key, id), bytes: !!await dlRead(dlPath.video(key, id)) }
        } finally { releaseWrite(); FileSystemWritableFileStream.prototype.write = original }
    })
    expect(result).toEqual({ early: 'pending', outcome: 'download cancelled', active: false, saved: false, bytes: false })
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

for (const playlist of ['master', 'variant']) {
    test(`video downloads report an HTTP failure from the ${playlist} HLS playlist`, async ({ page }) => {
        await page.goto(app)
        const result = await page.evaluate(async playlist => {
            const { setTransport } = await import('/src/lib/http.js')
            const dl = await import('/src/lib/dl-video.js')
            const { dlRead, dlPath } = await import('/src/lib/downloads.js')
            const key = `mock:hls-${playlist}`, id = '1'
            setTransport(async url => {
                const path = String(url)
                if (path.includes('/playback?')) return Response.json({
                    key, episodeId: id, providerLabel: 'Test',
                    sources: [{ kind: 'direct', url: '/master.m3u8', type: 'application/x-mpegURL' }],
                })
                if (path.endsWith('/master.m3u8')) {
                    return playlist === 'master' ? new Response('Forbidden', { status: 403 })
                        : new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant.m3u8\n')
                }
                if (path.endsWith('/variant.m3u8')) return new Response('Not found', { status: 404 })
                throw new Error(`unexpected request ${path}`)
            })
            let error
            try { await dl.downloadVideoEpisode(key, id) } catch (e) { error = e.message }
            return { error, saved: !!dl.videoDlEntry(key, id), bytes: !!await dlRead(dlPath.video(key, id)), active: !!dl.videoDlActive(key, id) }
        }, playlist)
        expect(result).toEqual({ error: playlist === 'master' ? 'http 403' : 'http 404', saved: false, bytes: false, active: false })
    })
}

test('HLS downloads reject encryption methods introduced after the first segment', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { setTransport } = await import('/src/lib/http.js')
        const video = await import('/src/lib/dl-video.js')
        const { dlRead, dlPath } = await import('/src/lib/downloads.js')
        const key = 'mock:rotated-method', id = '1'
        const bytes = new Uint8Array(16).fill(7)
        const iv = new Uint8Array(16)
        iv[15] = 1
        const cryptoKey = await crypto.subtle.importKey('raw', bytes, 'AES-CBC', false, ['encrypt'])
        // Deliberately valid AES-CBC ciphertext: treating SAMPLE-AES as AES-128
        // would decrypt it and incorrectly report an offline download as usable.
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, new TextEncoder().encode('encrypted fragment'))
        const playlist = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nclear.m4s\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin",IV=0x1\n#EXTINF:4,\nencrypted.m4s\n#EXT-X-ENDLIST\n'
        const requests = []
        setTransport(async url => {
            const path = String(url)
            requests.push(path)
            if (path.includes('/playback?')) return Response.json({
                key, episodeId: id, providerLabel: 'Test',
                sources: [{ kind: 'direct', url: '/rotated.m3u8', type: 'application/x-mpegURL' }],
            })
            if (path.endsWith('/rotated.m3u8')) return new Response(playlist)
            if (path.endsWith('/init.mp4')) return new Response(new Uint8Array([1, 2]))
            if (path.endsWith('/clear.m4s')) return new Response(new Uint8Array([3, 4]))
            if (path.endsWith('/key.bin')) return new Response(bytes)
            if (path.endsWith('/encrypted.m4s')) return new Response(encrypted)
            throw new Error(`unexpected request ${path}`)
        })
        let error = null
        try { await video.downloadVideoEpisode(key, id) } catch (cause) { error = cause.message }
        return {
            error, saved: !!video.videoDlEntry(key, id),
            bytes: !!await dlRead(dlPath.video(key, id)),
            fetchedEncryptedBytes: requests.some(path => path.endsWith('/encrypted.m4s')),
        }
    })
    expect(result).toEqual({
        error: "SAMPLE-AES encrypted streams can't be downloaded",
        saved: false, bytes: false, fetchedEncryptedBytes: false,
    })
})

for (const encryptedSegment of [true, false]) {
    test(`AES-128 HLS initialization data is decrypted when segments are ${encryptedSegment ? 'encrypted' : 'clear'}`, async ({ page }) => {
        await page.goto(app)
        const result = await page.evaluate(async encryptedSegment => {
            const { setTransport } = await import('/src/lib/http.js')
            const { downloadVideoEpisode } = await import('/src/lib/dl-video.js')
            const { dlRead, dlPath } = await import('/src/lib/downloads.js')
            const key = `mock:encrypted-init-${encryptedSegment}`, id = '1'
            const keyBytes = new Uint8Array(16).map((_, i) => i + 1)
            const iv = new Uint8Array(16)
            iv[15] = 7
            const aes = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt'])
            const init = new TextEncoder().encode('Initialization data')
            const segment = new TextEncoder().encode('Media segment payload')
            const encryptedInit = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, aes, init))
            const encryptedMedia = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, aes, segment))
            const playlist = `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x7\n#EXT-X-MAP:URI="init.mp4"\n${encryptedSegment ? '' : '#EXT-X-KEY:METHOD=NONE\n'}#EXTINF:4,\npart.m4s\n#EXT-X-ENDLIST\n`
            setTransport(async url => {
                const path = String(url)
                if (path.includes('/playback?')) return Response.json({
                    key, episodeId: id, providerLabel: 'Test',
                    sources: [{ kind: 'direct', url: '/encrypted.m3u8', type: 'application/x-mpegURL' }],
                })
                if (path.endsWith('/encrypted.m3u8')) return new Response(playlist)
                if (path.endsWith('/key.bin')) return new Response(keyBytes)
                if (path.endsWith('/init.mp4')) return new Response(encryptedInit)
                if (path.endsWith('/part.m4s')) return new Response(encryptedSegment ? encryptedMedia : segment)
                throw new Error(`unexpected request ${path}`)
            })
            await downloadVideoEpisode(key, id)
            const stored = await dlRead(dlPath.video(key, id))
            return { stored: [...new Uint8Array(await stored.arrayBuffer())], expected: [...init, ...segment] }
        }, encryptedSegment)
        expect(result.stored).toEqual(result.expected)
    })
}

test('HLS downloads write replacement initialization maps in media order', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { setTransport } = await import('/src/lib/http.js')
        const { downloadVideoEpisode } = await import('/src/lib/dl-video.js')
        const { dlRead, dlPath } = await import('/src/lib/downloads.js')
        const key = 'mock:multi-init', id = '1'
        const cipherKey = new Uint8Array(16).fill(11)
        const iv = new Uint8Array(16)
        iv[15] = 2
        const aes = await crypto.subtle.importKey('raw', cipherKey, 'AES-CBC', false, ['encrypt'])
        const encoder = new TextEncoder()
        const firstInit = encoder.encode('first initialization')
        const firstMedia = encoder.encode('first fragment')
        const secondInit = encoder.encode('second initialization')
        const secondMedia = encoder.encode('second fragment')
        const encryptedInit = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, aes, secondInit))
        const playlist = `#EXTM3U\n#EXT-X-MAP:URI="first.mp4"\n#EXTINF:4,\nfirst.m4s\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x2\n#EXT-X-MAP:URI="second.mp4"\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\nsecond.m4s\n#EXT-X-ENDLIST\n`
        setTransport(async url => {
            const path = String(url)
            if (path.includes('/playback?')) return Response.json({
                key, episodeId: id, providerLabel: 'Test',
                sources: [{ kind: 'direct', url: '/multi-init.m3u8', type: 'application/x-mpegURL' }],
            })
            if (path.endsWith('/multi-init.m3u8')) return new Response(playlist)
            if (path.endsWith('/key.bin')) return new Response(cipherKey)
            if (path.endsWith('/first.mp4')) return new Response(firstInit)
            if (path.endsWith('/second.mp4')) return new Response(encryptedInit)
            if (path.endsWith('/first.m4s')) return new Response(firstMedia)
            if (path.endsWith('/second.m4s')) return new Response(secondMedia)
            throw new Error(`unexpected request ${path}`)
        })
        await downloadVideoEpisode(key, id)
        const blob = await dlRead(dlPath.video(key, id))
        return { actual: [...new Uint8Array(await blob.arrayBuffer())], expected: [...firstInit, ...firstMedia, ...secondInit, ...secondMedia] }
    })
    expect(result.actual).toEqual(result.expected)
})

test('HLS downloads fetch only the declared byte ranges of a shared media resource', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { setTransport } = await import('/src/lib/http.js')
        const { downloadVideoEpisode } = await import('/src/lib/dl-video.js')
        const { dlRead, dlPath } = await import('/src/lib/downloads.js')
        const key = 'mock:byte-ranges', id = '1'
        const original = new TextEncoder().encode('INITpart1part2')
        const playlist = '#EXTM3U\n#EXT-X-MAP:URI="shared.m4s",BYTERANGE="4@0"\n#EXTINF:4,\n#EXT-X-BYTERANGE:5@4\nshared.m4s\n#EXTINF:4,\n#EXT-X-BYTERANGE:5\nshared.m4s\n#EXT-X-ENDLIST\n'
        const requestedRanges = []
        setTransport(async (url, init) => {
            const path = String(url)
            if (path.includes('/playback?')) return Response.json({
                key, episodeId: id, providerLabel: 'Test',
                sources: [{ kind: 'direct', url: '/range.m3u8', type: 'application/x-mpegURL' }],
            })
            if (path.endsWith('/range.m3u8')) return new Response(playlist)
            if (path.endsWith('/shared.m4s')) {
                const header = new Headers(init?.headers).get('range')
                requestedRanges.push(header)
                if (!header) return new Response(original)
                const match = /^bytes=(\d+)-(\d+)$/.exec(header)
                if (!match) throw Error(`bad range ${header}`)
                const start = Number(match[1]), end = Number(match[2])
                return new Response(original.slice(start, end + 1), {
                    status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${original.length}` },
                })
            }
            throw new Error(`unexpected request ${path}`)
        })
        await downloadVideoEpisode(key, id)
        const bytes = await dlRead(dlPath.video(key, id))
        return { requestedRanges, actual: [...new Uint8Array(await bytes.arrayBuffer())], expected: [...original] }
    })
    expect(result.requestedRanges).toEqual(['bytes=0-3', 'bytes=4-8', 'bytes=9-13'])
    expect(result.actual).toEqual(result.expected)
})

test('HLS byte-range downloads reject servers that return whole resources', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { setTransport } = await import('/src/lib/http.js')
        const video = await import('/src/lib/dl-video.js')
        const { dlRead, dlPath } = await import('/src/lib/downloads.js')
        const key = 'mock:range-ignored', id = '1'
        setTransport(async url => {
            const path = String(url)
            if (path.includes('/playback?')) return Response.json({
                key, episodeId: id, providerLabel: 'Test',
                sources: [{ kind: 'direct', url: '/range.m3u8', type: 'application/x-mpegURL' }],
            })
            if (path.endsWith('/range.m3u8')) return new Response('#EXTM3U\n#EXT-X-MAP:URI="shared.m4s",BYTERANGE="4@0"\n#EXTINF:4,\n#EXT-X-BYTERANGE:5@4\nshared.m4s\n#EXT-X-ENDLIST\n')
            if (path.endsWith('/shared.m4s')) return new Response('INITpart1') // ignores Range: 200 OK
            throw new Error(`unexpected request ${path}`)
        })
        let error = null
        try { await video.downloadVideoEpisode(key, id) } catch (cause) { error = cause.message }
        return { error, saved: !!video.videoDlEntry(key, id), bytes: !!await dlRead(dlPath.video(key, id)) }
    })
    expect(result.error).toMatch(/byte range/i)
    expect(result.saved).toBe(false)
    expect(result.bytes).toBe(false)
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

test('failed repair registry writes keep the original chapter and remove new illustrations', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const novel = await import('/src/lib/dl-novel.js')
        const { setTransport } = await import('/src/lib/http.js')
        const key = 'repair-registry-quota'
        const original = JSON.stringify({ html: '<p>Saved text</p><img src="dlimg:0"><img src="https://images.example/new.png">' })
        await dl.dlWrite(dl.dlPath.novelChapter(key, 1), original)
        await dl.dlWrite(dl.dlPath.novelImage(key, 1, 0), 'Saved picture')
        dl.dlRegister({ kind: 'novel', key, id: '1', title: 'Saved', size: 20 })
        setTransport(async () => new Response('New picture', { headers: { 'content-type': 'image/png' } }))
        const setItem = Storage.prototype.setItem
        Storage.prototype.setItem = function (name, value) {
            if (name === 'vellum:dl') throw new DOMException('Registry full', 'QuotaExceededError')
            return setItem.call(this, name, value)
        }
        let error
        try { await novel.downloadNovelChapter(key, 1, 'Saved', { force: true }) } catch (e) { error = e.message }
        Storage.prototype.setItem = setItem
        return {
            error,
            chapter: await (await dl.dlRead(dl.dlPath.novelChapter(key, 1)))?.text(),
            oldImage: await (await dl.dlRead(dl.dlPath.novelImage(key, 1, 0)))?.text(),
            newImage: !!await dl.dlRead(dl.dlPath.novelImage(key, 1, 1)),
            size: dl.dlEntry('novel', key, '1')?.size,
            original,
        }
    })
    expect(result.error).toContain('download list')
    expect(result).toMatchObject({ chapter: result.original, oldImage: 'Saved picture', newImage: false, size: 20 })
})

test('cancelling a novel download during its final file write never registers it', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const novel = await import('/src/lib/dl-novel.js')
        const { setTransport } = await import('/src/lib/http.js')
        const key = 'cancel-final-novel'
        setTransport(async () => Response.json({ html: '<p>Chapter in progress</p>' }))
        const write = FileSystemWritableFileStream.prototype.write
        let interrupted = false
        FileSystemWritableFileStream.prototype.write = async function (data) {
            await write.call(this, data)
            if (typeof data === 'string' && data.includes('Chapter in progress')) {
                interrupted = true
                novel.cancelNovelDownload(key, 1)
            }
        }
        let outcome
        try { await novel.downloadNovelChapter(key, 1, 'New') ; outcome = 'saved' }
        catch (e) { outcome = e.message }
        FileSystemWritableFileStream.prototype.write = write
        return {
            interrupted, outcome,
            saved: !!dl.dlEntry('novel', key, '1'),
            bytes: !!await dl.dlRead(dl.dlPath.novelChapter(key, 1)),
        }
    })
    expect(result).toEqual({ interrupted: true, outcome: 'download cancelled', saved: false, bytes: false })
})

test('deleting a chapter during background repair leaves no restored orphan files', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        const novel = await import('/src/lib/dl-novel.js')
        const { setTransport } = await import('/src/lib/http.js')
        const key = 'delete-during-repair'
        await dl.dlWrite(dl.dlPath.novelChapter(key, 1), JSON.stringify({ html: '<p>Keep offline</p><img src="https://images.example/new.png">' }))
        dl.dlRegister({ kind: 'novel', key, id: '1', title: 'Saved' })
        setTransport(async () => new Response('New image', { headers: { 'content-type': 'image/png' } }))
        const write = FileSystemWritableFileStream.prototype.write
        let enterWrite, releaseWrite
        const entered = new Promise(resolve => { enterWrite = resolve })
        const released = new Promise(resolve => { releaseWrite = resolve })
        FileSystemWritableFileStream.prototype.write = async function (data) {
            await write.call(this, data)
            if (typeof data === 'string' && data.includes('dlimg:0')) {
                enterWrite()
                await released
            }
        }
        const repair = novel.downloadNovelChapter(key, 1, 'Saved', { force: true }).catch(e => e.message)
        await entered
        const deletion = novel.deleteNovelDownload(key, 1)
        // Give the removal a chance to run while the repair's final write is held.
        await Promise.race([deletion, new Promise(resolve => setTimeout(resolve, 50))])
        releaseWrite()
        await Promise.all([repair, deletion])
        FileSystemWritableFileStream.prototype.write = write
        return {
            registered: !!dl.dlEntry('novel', key, '1'),
            chapter: !!await dl.dlRead(dl.dlPath.novelChapter(key, 1)),
            illustration: !!await dl.dlRead(dl.dlPath.novelImage(key, 1, 0)),
        }
    })
    expect(result).toEqual({ registered: false, chapter: false, illustration: false })
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

for (const stalled of ['request', 'stream']) {
    for (const reason of ['timeout', 'cancel']) {
        test(`non-cooperative direct video ${stalled} settles on ${reason}`, async ({ page }) => {
        await page.goto(app)
        const result = await page.evaluate(async ({ stalled, reason }) => {
            const realTimeout = window.setTimeout.bind(window)
            window.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms === 30_000 ? 80 : ms, ...args)
            const { setTransport } = await import('/src/lib/http.js')
            const video = await import('/src/lib/dl-video.js')
            const key = `mock:unresponsive-direct-${stalled}-${reason}`, id = '1'
            setTransport(url => {
                if (String(url).includes('/playback?')) return Response.json({
                    key, episodeId: id, providerLabel: 'Fixture', sources: [{ kind: 'direct', url: '/stalled.mp4', type: 'video/mp4' }],
                })
                if (stalled === 'request') return new Promise(() => {})
                return new Response(new ReadableStream({
                    start() {},
                    cancel() { return new Promise(() => {}) },
                }))
            })
            const task = video.downloadVideoEpisode(key, id).then(() => 'saved', error => error.message)
            if (reason === 'cancel') realTimeout(() => video.cancelVideoDownload(key, id), 25)
            const outcome = await Promise.race([task, new Promise(resolve => realTimeout(() => resolve('pending'), 600))])
            return { outcome, saved: !!video.videoDlEntry(key, id), active: !!video.videoDlActive(key, id) }
        }, { stalled, reason })
        expect(result).toEqual({ outcome: reason === 'cancel' ? 'download cancelled' : 'download timed out', saved: false, active: false })
        })
    }
}

for (const stalled of ['playlist request', 'playlist body', 'segment request', 'segment body']) {
    test(`non-cooperative HLS ${stalled} times out and releases the download`, async ({ page }) => {
        await page.goto(app)
        const result = await page.evaluate(async stalled => {
            const realTimeout = window.setTimeout.bind(window)
            AbortSignal.timeout = ms => {
                const ctrl = new AbortController()
                realTimeout(() => ctrl.abort(new DOMException('Timed out', 'TimeoutError')), ms === 30_000 ? 80 : ms)
                return ctrl.signal
            }
            const { setTransport } = await import('/src/lib/http.js')
            const video = await import('/src/lib/dl-video.js')
            const key = `mock:unresponsive-hls-${stalled.replace(' ', '-')}`, id = '1'
            setTransport(url => {
                const path = String(url)
                if (path.includes('/playback?')) return Response.json({
                    key, episodeId: id, providerLabel: 'Fixture', sources: [{ kind: 'direct', url: '/stalled.m3u8', type: 'application/x-mpegURL' }],
                })
                if (path.endsWith('/stalled.m3u8')) {
                    if (stalled === 'playlist request') return new Promise(() => {})
                    if (stalled === 'playlist body') return { ok: true, text: () => new Promise(() => {}) }
                    return new Response('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\npart.m4s\n#EXT-X-ENDLIST\n')
                }
                if (path.endsWith('/init.mp4')) return new Response(new Uint8Array([1, 2]))
                if (path.endsWith('/part.m4s')) {
                    if (stalled === 'segment request') return new Promise(() => {})
                    if (stalled === 'segment body') return { ok: true, status: 200, arrayBuffer: () => new Promise(() => {}) }
                }
                throw new Error(`unexpected request ${path}`)
            })
            const task = video.downloadVideoEpisode(key, id).then(() => 'saved', error => error.message)
            const outcome = await Promise.race([task, new Promise(resolve => realTimeout(() => resolve('pending'), 600))])
            return { outcome, saved: !!video.videoDlEntry(key, id), active: !!video.videoDlActive(key, id) }
        }, stalled)
        expect(result).toEqual({ outcome: 'download timed out', saved: false, active: false })
    })
}

for (const stalled of ['request', 'body']) {
    test(`cancelling a non-cooperative manga page ${stalled} releases its download`, async ({ page }) => {
        await page.goto(app)
        const result = await page.evaluate(async stalled => {
            const realTimeout = window.setTimeout.bind(window)
            const { setTransport } = await import('/src/lib/http.js')
            const manga = await import('/src/lib/dl-manga.js')
            const { dlRead, dlPath } = await import('/src/lib/downloads.js')
            const key = `mf:unresponsive-${stalled}`, id = 'c1'
            let pageRequested
            const requested = new Promise(resolve => { pageRequested = resolve })
            setTransport(url => {
                const path = String(url)
                if (path.includes('/manga/series/')) return Response.json({ key, kind: 'manga', title: 'Fixture', format: 'manga' })
                if (path.includes('/manga/chapter?')) return Response.json({
                    key, chapter: { id, number: 1 },
                    pages: [{ url: `/read/api/manga/image?key=${encodeURIComponent(key)}&id=${id}&page=0` }],
                })
                if (path.includes('/manga/image?')) {
                    pageRequested()
                    return stalled === 'request' ? new Promise(() => {}) : { ok: true, blob: () => new Promise(() => {}) }
                }
                throw new Error(`unexpected request ${path}`)
            })
            const task = manga.downloadMangaChapter(key, id).then(() => 'saved', error => error.message)
            const started = await Promise.race([requested.then(() => true), new Promise(resolve => realTimeout(() => resolve(false), 400))])
            manga.cancelMangaDownload(key, id)
            const outcome = await Promise.race([task, new Promise(resolve => realTimeout(() => resolve('pending'), 600))])
            return { started, outcome, saved: !!manga.mangaDlEntry(key, id), active: !!manga.mangaDlActive(key, id), bytes: !!await dlRead(dlPath.mangaPage(key, id, 0)) }
        }, stalled)
        expect(result).toEqual({ started: true, outcome: 'download cancelled', saved: false, active: false, bytes: false })
    })
}

test('a non-cooperative manga page request times out and releases its download', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const realTimeout = window.setTimeout.bind(window)
        AbortSignal.timeout = ms => {
            const ctrl = new AbortController()
            realTimeout(() => ctrl.abort(new DOMException('Timed out', 'TimeoutError')), ms === 60_000 ? 80 : ms)
            return ctrl.signal
        }
        const { setTransport } = await import('/src/lib/http.js')
        const manga = await import('/src/lib/dl-manga.js')
        const key = 'mf:unresponsive-timeout', id = 'c1'
        setTransport(url => {
            const path = String(url)
            if (path.includes('/manga/series/')) return Response.json({ key, kind: 'manga', title: 'Fixture', format: 'manga' })
            if (path.includes('/manga/chapter?')) return Response.json({
                key, chapter: { id, number: 1 },
                pages: [{ url: `/read/api/manga/image?key=${encodeURIComponent(key)}&id=${id}&page=0` }],
            })
            return new Promise(() => {})
        })
        const task = manga.downloadMangaChapter(key, id).then(() => 'saved', error => error.message)
        const outcome = await Promise.race([task, new Promise(resolve => realTimeout(() => resolve('pending'), 600))])
        return { outcome, saved: !!manga.mangaDlEntry(key, id), active: !!manga.mangaDlActive(key, id) }
    })
    expect(result).toEqual({ outcome: 'download timed out', saved: false, active: false })
})

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

for (const stalled of ['request', 'body']) {
    test(`non-cooperative novel illustration ${stalled} falls back to its proxy after timeout`, async ({ page }) => {
        await page.goto(app)
        const result = await page.evaluate(async stalled => {
            const realTimeout = window.setTimeout.bind(window)
            AbortSignal.timeout = ms => {
                const ctrl = new AbortController()
                realTimeout(() => ctrl.abort(new DOMException('Timed out', 'TimeoutError')), ms === 15_000 ? 70 : ms)
                return ctrl.signal
            }
            const dl = await import('/src/lib/downloads.js')
            const novel = await import('/src/lib/dl-novel.js')
            const { setTransport } = await import('/src/lib/http.js')
            const key = `novel-fallback-${stalled}`
            await dl.dlWrite(dl.dlPath.novelChapter(key, 1), JSON.stringify({
                html: '<p>Saved chapter</p><img src="dlimg:0"><img src="https://images.example/missing.png">',
            }))
            await dl.dlWrite(dl.dlPath.novelImage(key, 1, 0), 'Existing illustration')
            dl.dlRegister({ kind: 'novel', key, id: '1', title: 'Saved' })
            let direct = 0, proxy = 0
            setTransport(async url => {
                if (String(url).includes('/read/api/image?')) {
                    proxy++
                    return new Response('Proxied illustration', { headers: { 'content-type': 'image/png' } })
                }
                direct++
                return stalled === 'request' ? new Promise(() => {}) : { ok: true, blob: () => new Promise(() => {}) }
            })
            const task = novel.downloadNovelChapter(key, 1, 'Saved', { force: true }).then(() => 'saved', e => e.message)
            const outcome = await Promise.race([task, new Promise(resolve => realTimeout(() => resolve('pending'), 600))])
            const chapter = JSON.parse(await (await dl.dlRead(dl.dlPath.novelChapter(key, 1))).text())
            return {
                outcome, direct, proxy, active: !!novel.novelDlActive(key, 1),
                html: chapter.html,
                oldImage: await (await dl.dlRead(dl.dlPath.novelImage(key, 1, 0)))?.text(),
                newImage: await (await dl.dlRead(dl.dlPath.novelImage(key, 1, 1)))?.text(),
            }
        }, stalled)
        expect(result).toMatchObject({ outcome: 'saved', direct: 1, proxy: 1, active: false, oldImage: 'Existing illustration', newImage: 'Proxied illustration' })
        expect(result.html).toContain('Saved chapter')
        expect(result.html).toContain('src="dlimg:0"')
        expect(result.html).toContain('src="dlimg:1"')
    })

    test(`non-cooperative novel proxy ${stalled} times out while preserving the saved chapter`, async ({ page }) => {
        await page.goto(app)
        const result = await page.evaluate(async stalled => {
            const realTimeout = window.setTimeout.bind(window)
            AbortSignal.timeout = ms => {
                const ctrl = new AbortController()
                realTimeout(() => ctrl.abort(new DOMException('Timed out', 'TimeoutError')), ms === 15_000 ? 70 : ms)
                return ctrl.signal
            }
            const dl = await import('/src/lib/downloads.js')
            const novel = await import('/src/lib/dl-novel.js')
            const { setTransport } = await import('/src/lib/http.js')
            const key = `novel-proxy-${stalled}`
            const html = '<p>Saved chapter</p><img src="dlimg:0"><img src="https://images.example/missing.png">'
            await dl.dlWrite(dl.dlPath.novelChapter(key, 1), JSON.stringify({ html }))
            await dl.dlWrite(dl.dlPath.novelImage(key, 1, 0), 'Existing illustration')
            dl.dlRegister({ kind: 'novel', key, id: '1', title: 'Saved' })
            let proxy = 0
            setTransport(async url => {
                if (!String(url).includes('/read/api/image?')) return new Response('unavailable', { status: 503 })
                proxy++
                return stalled === 'request' ? new Promise(() => {}) : { ok: true, blob: () => new Promise(() => {}) }
            })
            const task = novel.downloadNovelChapter(key, 1, 'Saved', { force: true }).then(() => 'saved', e => e.message)
            const outcome = await Promise.race([task, new Promise(resolve => realTimeout(() => resolve('pending'), 600))])
            const chapter = JSON.parse(await (await dl.dlRead(dl.dlPath.novelChapter(key, 1))).text())
            return {
                outcome, proxy, active: !!novel.novelDlActive(key, 1),
                html: chapter.html, saved: !!novel.novelDlEntry(key, 1),
                oldImage: await (await dl.dlRead(dl.dlPath.novelImage(key, 1, 0)))?.text(),
                newImage: !!await dl.dlRead(dl.dlPath.novelImage(key, 1, 1)),
            }
        }, stalled)
        expect(result).toMatchObject({ outcome: 'saved', proxy: 1, active: false, saved: true, oldImage: 'Existing illustration', newImage: false })
        expect(result.html).toContain('src="dlimg:0"')
        expect(result.html).toContain('https://images.example/missing.png')
    })

    test(`cancelling a non-cooperative novel illustration ${stalled} releases the job`, async ({ page }) => {
        await page.goto(app)
        const result = await page.evaluate(async stalled => {
            const realTimeout = window.setTimeout.bind(window)
            const dl = await import('/src/lib/downloads.js')
            const novel = await import('/src/lib/dl-novel.js')
            const { setTransport } = await import('/src/lib/http.js')
            const key = `novel-cancel-${stalled}`
            let entered
            const fetching = new Promise(resolve => { entered = resolve })
            setTransport(async url => {
                if (String(url).includes('/chapter?')) return Response.json({ html: '<p>New chapter</p><img src="https://images.example/new.png">' })
                entered()
                return stalled === 'request' ? new Promise(() => {}) : { ok: true, blob: () => new Promise(() => {}) }
            })
            const task = novel.downloadNovelChapter(key, 1, 'New').then(() => 'saved', e => e.message)
            const started = await Promise.race([fetching.then(() => true), new Promise(resolve => realTimeout(() => resolve(false), 500))])
            novel.cancelNovelDownload(key, 1)
            const outcome = await Promise.race([task, new Promise(resolve => realTimeout(() => resolve('pending'), 600))])
            return {
                started, outcome, active: !!novel.novelDlActive(key, 1), saved: !!novel.novelDlEntry(key, 1),
                chapter: !!await dl.dlRead(dl.dlPath.novelChapter(key, 1)),
                image: !!await dl.dlRead(dl.dlPath.novelImage(key, 1, 0)),
            }
        }, stalled)
        expect(result).toEqual({ started: true, outcome: 'download cancelled', active: false, saved: false, chapter: false, image: false })
    })

    test(`deleting a saved novel during non-cooperative image ${stalled} finishes cleanup`, async ({ page }) => {
        await page.goto(app)
        const result = await page.evaluate(async stalled => {
            const realTimeout = window.setTimeout.bind(window)
            const dl = await import('/src/lib/downloads.js')
            const novel = await import('/src/lib/dl-novel.js')
            const { setTransport } = await import('/src/lib/http.js')
            const key = `novel-delete-${stalled}`
            await dl.dlWrite(dl.dlPath.novelChapter(key, 1), JSON.stringify({
                html: '<p>Saved chapter</p><img src="dlimg:0"><img src="https://images.example/new.png">',
            }))
            await dl.dlWrite(dl.dlPath.novelImage(key, 1, 0), 'Existing illustration')
            dl.dlRegister({ kind: 'novel', key, id: '1', title: 'Saved' })
            let entered
            const fetching = new Promise(resolve => { entered = resolve })
            setTransport(async () => {
                entered()
                return stalled === 'request' ? new Promise(() => {}) : { ok: true, blob: () => new Promise(() => {}) }
            })
            const repair = novel.downloadNovelChapter(key, 1, 'Saved', { force: true }).then(() => 'saved', e => e.message)
            const started = await Promise.race([fetching.then(() => true), new Promise(resolve => realTimeout(() => resolve(false), 500))])
            const deletion = novel.deleteNovelDownload(key, 1).then(() => 'deleted', e => e.message)
            const outcome = await Promise.race([Promise.all([repair, deletion]), new Promise(resolve => realTimeout(() => resolve(['pending', 'pending']), 600))])
            return {
                started, outcome, active: !!novel.novelDlActive(key, 1), saved: !!novel.novelDlEntry(key, 1),
                chapter: !!await dl.dlRead(dl.dlPath.novelChapter(key, 1)),
                image: !!await dl.dlRead(dl.dlPath.novelImage(key, 1, 0)),
            }
        }, stalled)
        expect(result).toEqual({ started: true, outcome: ['download cancelled', 'deleted'], active: false, saved: false, chapter: false, image: false })
    })
}
