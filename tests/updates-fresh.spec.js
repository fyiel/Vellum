import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

for (const kind of ['novel', 'manga', 'anime', 'drama']) {
    test(`opening Updates refreshes stale ${kind} lists for the reader`, async ({ page }) => {
        await page.goto(app)
        const info = await page.evaluate(async kind => {
            const { setTransport } = await import('/src/lib/http.js')
            const { getChapters } = await import('/src/lib/api.js')
            const { getMangaChapters } = await import('/src/lib/manga-api.js')
            const { getVideoSeries } = await import('/src/lib/video-api.js')
            const video = kind === 'anime' || kind === 'drama'
            const key = kind === 'manga' ? 'mf:updated-chapters' : video ? 'mock:updated-chapters' : 'nf:updated-chapters'
            const old = kind === 'novel' ? { n: 1 } : { id: 'chapter-1', number: 1 }
            const recent = kind === 'novel' ? { n: 2 } : { id: 'chapter-2', number: 2 }
            let changed = false
            let calls = 0
            setTransport(url => {
                const path = new URL(url, location.href).pathname
                if (!path.includes(video ? '/video/series/' : kind === 'manga' ? '/manga/chapters' : '/chapters')) throw Error(`Unexpected request ${url}`)
                calls++
                const entries = changed ? [old, recent] : [old]
                return Promise.resolve(Response.json(video ? { key, kind, title: 'Updated chapters', episodes: entries } : { key, chapters: entries }))
            })
            // A reader or series visit filled the 30-minute chapter-list cache.
            if (kind === 'manga') await getMangaChapters(key)
            else if (video) await getVideoSeries(key)
            else await getChapters(key)
            changed = true
            localStorage.setItem('vellum:lib', JSON.stringify([{
                slug: key, key, title: 'Updated chapters', kind, total: 1,
                ...(kind === 'manga' ? { chapterIds: ['chapter-1'] } : video ? { episodeIds: ['chapter-1'] } : {}),
            }]))
            localStorage.setItem('vellum:updates', JSON.stringify({
                [key]: kind !== 'novel'
                    ? { firstSeen: Date.now(), read: true, seenIds: ['chapter-1'] }
                    : { firstSeen: Date.now(), read: true, seenUpTo: 1 },
            }))
            window.updateRequestCount = () => calls
            location.hash = '#/updates'
            return { key }
        }, kind)

        await expect(page.locator('#ufeed .urow')).toHaveCount(1)
        await expect(page.locator('#ufeed .urow')).toContainText('Updated chapters')
        await expect(page.locator('#count-updates')).toHaveText('1')
        expect(await page.evaluate(() => window.updateRequestCount())).toBe(2)
        const stored = await page.evaluate(key => JSON.parse(localStorage.getItem('vellum:updates'))[key], info.key)
        const changes = kind === 'manga' ? stored.newChapters.map(c => c.id)
            : kind === 'novel' ? stored.newNums : stored.newEpisodes.map(e => e.id)
        expect(changes).toEqual([kind === 'novel' ? 2 : 'chapter-2'])
        // The newly advertised chapter or episode must also be available to its reader.
        const fromCache = await page.evaluate(async ({ key, kind }) => {
            const { getChapters } = await import('/src/lib/api.js')
            const { getMangaChapters } = await import('/src/lib/manga-api.js')
            const { getVideoSeries } = await import('/src/lib/video-api.js')
            return kind === 'novel' ? (await getChapters(key)).chapters
                : kind === 'manga' ? (await getMangaChapters(key)).chapters
                    : (await getVideoSeries(key)).episodes
        }, { key: info.key, kind })
        expect(fromCache).toHaveLength(2)
        expect(await page.evaluate(() => window.updateRequestCount())).toBe(2)
    })
}
