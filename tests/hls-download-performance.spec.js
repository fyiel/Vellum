import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

test('HLS downloads overlap segment requests while writing fragments in media order', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { setTransport } = await import('/src/lib/http.js')
        const { downloadVideoEpisode, videoDlEntry } = await import('/src/lib/dl-video.js')
        const { dlRead, dlPath } = await import('/src/lib/downloads.js')
        const key = 'mock:overlap-hls', id = 'first', count = 12
        const playlist = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n' +
            Array.from({ length: count }, (_, i) => `#EXTINF:4,\npart-${i}.m4s\n`).join('') + '#EXT-X-ENDLIST\n'
        let concurrent = 0, peak = 0
        setTransport(async url => {
            const path = String(url)
            if (path.includes('/playback?')) return Response.json({
                key, episodeId: id, providerLabel: 'Fixture',
                sources: [{ kind: 'direct', url: '/playlist.m3u8', type: 'application/x-mpegURL' }],
            })
            if (path.endsWith('/playlist.m3u8')) return new Response(playlist)
            if (path.endsWith('/init.mp4')) return new Response('INIT|')
            const match = /\/part-(\d+)\.m4s$/.exec(path)
            if (match) {
                concurrent++
                peak = Math.max(peak, concurrent)
                await new Promise(resolve => setTimeout(resolve, 25 + (Number(match[1]) % 3) * 5))
                concurrent--
                return new Response(`part${match[1]}|`)
            }
            throw new Error(`unexpected request ${path}`)
        })
        const started = performance.now()
        await downloadVideoEpisode(key, id)
        const durationMs = performance.now() - started
        const blob = await dlRead(dlPath.video(key, id))
        return { durationMs, peak, stored: await blob.text(), entry: videoDlEntry(key, id) }
    })
    console.log(`HLS 12-fragment download with 25–35ms network delay: ${result.durationMs.toFixed(1)}ms (${result.peak} simultaneous requests)`)
    expect(result.peak).toBeGreaterThan(1)
    expect(result.peak).toBeLessThanOrEqual(4)
    const expected = 'INIT|' + Array.from({ length: 12 }, (_, i) => `part${i}|`).join('')
    expect(result.stored).toBe(expected)
    expect(result.entry?.size).toBe(expected.length)
})

test('a failed prefetched HLS segment aborts unused requests and discards the video', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { setTransport } = await import('/src/lib/http.js')
        const { downloadVideoEpisode, videoDlActive, videoDlEntry } = await import('/src/lib/dl-video.js')
        const { dlRead, dlPath } = await import('/src/lib/downloads.js')
        const key = 'mock:failed-prefetch', id = 'first'
        let started = 0, aborted = 0
        setTransport((url, { signal } = {}) => {
            const path = String(url)
            if (path.includes('/playback?')) return Promise.resolve(Response.json({
                key, episodeId: id, providerLabel: 'Fixture',
                sources: [{ kind: 'direct', url: '/playlist.m3u8', type: 'application/x-mpegURL' }],
            }))
            if (path.endsWith('/playlist.m3u8')) return Promise.resolve(new Response(
                '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n' +
                Array.from({ length: 8 }, (_, i) => `#EXTINF:4,\npart-${i}.m4s\n`).join('') + '#EXT-X-ENDLIST\n'))
            if (path.endsWith('/init.mp4')) return Promise.resolve(new Response('INIT|'))
            const match = /\/part-(\d+)\.m4s$/.exec(path)
            if (!match) throw new Error(`unexpected request ${path}`)
            started++
            if (Number(match[1]) === 1) return Promise.resolve(new Response('Unavailable', { status: 503 }))
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => resolve(new Response('fragment')), 75)
                signal.addEventListener('abort', () => {
                    clearTimeout(timer)
                    aborted++
                    reject(new DOMException('Aborted', 'AbortError'))
                }, { once: true })
            })
        })
        const error = await downloadVideoEpisode(key, id).then(() => 'saved', cause => cause.message)
        return {
            error, started, aborted,
            active: !!videoDlActive(key, id), saved: !!videoDlEntry(key, id),
            leftover: !!await dlRead(dlPath.video(key, id)),
        }
    })
    expect(result.error).toBe('http 503')
    expect(result.started).toBeGreaterThan(2)
    expect(result.aborted).toBeGreaterThan(0)
    expect(result).toMatchObject({ active: false, saved: false, leftover: false })
})
