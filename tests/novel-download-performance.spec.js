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
