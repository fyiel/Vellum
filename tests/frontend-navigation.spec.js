import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="120"><rect width="80" height="120"/></svg>'
const cover = `data:image/svg+xml,${encodeURIComponent(svg)}`
const deferred = () => {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve }
}
const navigate = (page, hash) => page.evaluate(value => { location.hash = value }, hash)
const manga = key => ({ key, kind: 'manga', format: 'manga', title: key, cover })
const chapters = [1, 2, 3].map(number => ({ id: String(number), number, title: `Chapter ${number}` }))

async function fixtures(page, { image, media, chapter } = {}) {
    await page.route('**/read/api/**', async route => {
        const url = new URL(route.request().url())
        const key = url.searchParams.get('key')
        const id = url.searchParams.get('id')
        if (url.pathname.includes('/manga/series/')) return reply(route, manga(decodeURIComponent(url.pathname.split('/').at(-1))))
        if (url.pathname.endsWith('/manga/chapters')) return reply(route, { key, chapters })
        if (url.pathname.endsWith('/manga/chapter')) return reply(route, {
            key, chapter: chapters.find(item => item.id === id) || { id, number: 1 },
            pages: [{ url: `/read/api/manga/image?key=${encodeURIComponent(key)}&id=${id}&page=0` }],
        })
        if (url.pathname.endsWith('/manga/image')) {
            if (image) await image(url)
            return route.fulfill({ contentType: 'image/svg+xml', body: svg })
        }
        if (url.pathname.includes('/video/series/')) return reply(route, {
            key: decodeURIComponent(url.pathname.split('/').at(-1)), kind: 'drama', title: decodeURIComponent(url.pathname.split('/').at(-1)), poster: cover,
            episodes: chapters,
        })
        if (url.pathname.endsWith('/video/playback')) return reply(route, {
            key, episodeId: id, providerLabel: 'Fixture',
            sources: [{ kind: 'direct', url: `/read/api/video/media/test.mp4?key=${encodeURIComponent(key)}&id=${id}`, type: 'video/mp4' }],
        })
        if (url.pathname.endsWith('/video/media/test.mp4')) {
            if (media) await media(url)
            return route.fulfill({ contentType: 'video/mp4', body: 'test video bytes' })
        }
        if (url.pathname.includes('/series/')) return reply(route, { title: 'Novel fixture', nfSlug: 'fixture', cover })
        if (url.pathname.endsWith('/chapters')) return reply(route, { chapters: chapters.map(item => ({ n: item.number, t: item.title })) })
        if (url.pathname.endsWith('/chapter')) {
            if (chapter) await chapter(url)
            return reply(route, { title: 'Fixture chapter', html: '<p>Fixture text.</p>' })
        }
        return reply(route, { results: [], hasMore: false })
    })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(app)
    return errors
}

async function holdFirstFetch(page, prefix) {
    await page.evaluate(prefix => {
        const originalFetch = window.fetch
        const target = new URL(prefix, location.href)
        window.heldDetailFetch = false
        window.abortedDetailFetch = false
        window.fetch = (url, options) => {
            const requested = new URL(url, location.href)
            if (!window.heldDetailFetch && requested.origin === target.origin && requested.pathname.startsWith(target.pathname)) {
                window.heldDetailFetch = true
                return new Promise((_, reject) => {
                    options.signal.addEventListener('abort', () => {
                        window.abortedDetailFetch = true
                        reject(new DOMException('Cancelled', 'AbortError'))
                    }, { once: true })
                })
            }
            return originalFetch(url, options)
        }
    }, prefix)
}

for (const { name, route, path, title, selector } of [
    { name: 'novel', route: '#/series/nf%3Afixture', path: '/read/api/series/', title: 'Novel fixture', selector: '#sinfo .dtitle' },
    { name: 'manga', route: '#/manga/series/mf%3Afirst', path: '/read/api/manga/series/', title: 'mf:first', selector: '#sinfo .dtitle' },
    { name: 'video', route: '#/watch/series/mock%3Afirst', path: '/read/api/video/series/', title: 'mock:first', selector: '#vinfo .video-title' },
]) {
    test(`cancels an abandoned ${name} detail request and reloads on return`, async ({ page }) => {
        const errors = await fixtures(page)
        await holdFirstFetch(page, path)
        await navigate(page, route)
        await expect.poll(() => page.evaluate(() => window.heldDetailFetch)).toBe(true)
        await navigate(page, '#/')
        await expect.poll(() => page.evaluate(() => window.abortedDetailFetch)).toBe(true)
        await navigate(page, route)
        await expect(page.locator(selector)).toHaveText(title)
        expect(errors).toEqual([])
    })
}

for (const { name, first, second, path, title, selector } of [
    { name: 'novel', first: '#/series/nf%3Afixture', second: '#/series/nf%3Aother', path: '/read/api/series/', title: 'Novel fixture', selector: '#sinfo .dtitle' },
    { name: 'manga', first: '#/manga/series/mf%3Afirst', second: '#/manga/series/mf%3Asecond', path: '/read/api/manga/series/', title: 'mf:second', selector: '#sinfo .dtitle' },
    { name: 'video', first: '#/watch/series/mock%3Afirst', second: '#/watch/series/mock%3Asecond', path: '/read/api/video/series/', title: 'mock:second', selector: '#vinfo .video-title' },
]) {
    test(`cancels stale ${name} detail requests when switching titles`, async ({ page }) => {
        const errors = await fixtures(page)
        await holdFirstFetch(page, path)
        await navigate(page, first)
        await expect.poll(() => page.evaluate(() => window.heldDetailFetch)).toBe(true)
        await navigate(page, second)
        await expect.poll(() => page.evaluate(() => window.abortedDetailFetch)).toBe(true)
        await expect(page.locator(selector)).toHaveText(title)
        expect(errors).toEqual([])
    })
}

for (const { name, route, path, selector } of [
    { name: 'novel', route: '#/series/nf%3Afixture', path: '/read/api/chapters', selector: '#chlist .chrow' },
    { name: 'manga', route: '#/manga/series/mf%3Afirst', path: '/read/api/manga/chapters', selector: '#mchapter-list .mchrow' },
]) {
    test(`cancels an abandoned ${name} chapter list request and retries on return`, async ({ page }) => {
        const errors = await fixtures(page)
        await holdFirstFetch(page, path)
        await navigate(page, route)
        await expect.poll(() => page.evaluate(() => window.heldDetailFetch)).toBe(true)
        await navigate(page, '#/')
        await expect.poll(() => page.evaluate(() => window.abortedDetailFetch)).toBe(true)
        await navigate(page, route)
        await expect(page.locator(selector)).toHaveCount(3)
        expect(errors).toEqual([])
    })
}

test('cancels an abandoned AniList detail lookup while video episodes reload', async ({ page }) => {
    const errors = await fixtures(page)
    await page.route('https://graphql.anilist.co', route => reply(route, { data: { Media: { id: 123, title: { english: 'Anime fixture' } } } }))
    await holdFirstFetch(page, 'https://graphql.anilist.co/')
    await navigate(page, '#/watch/series/miruro%3A123')
    await expect.poll(() => page.evaluate(() => window.heldDetailFetch)).toBe(true)
    await navigate(page, '#/')
    await expect.poll(() => page.evaluate(() => window.abortedDetailFetch)).toBe(true)
    await navigate(page, '#/watch/series/miruro%3A123')
    await expect(page.locator('#video-episode-list .video-episode-row')).toHaveCount(3)
    expect(errors).toEqual([])
})

test('a failed manga detail load clears the chapter spinner and retries cleanly', async ({ page }) => {
    const errors = await fixtures(page)
    let tries = 0
    await page.route('**/read/api/manga/series/**', route => {
        if (tries++ === 0) return route.fulfill({
            status: 404, contentType: 'application/json',
            body: JSON.stringify({ error: { message: 'Manga unavailable', retryable: false } }),
        })
        return reply(route, manga('mf:first'))
    })
    await navigate(page, '#/manga/series/mf%3Afirst')
    await expect(page.locator('#mseries-retry')).toBeVisible()
    await expect(page.locator('#schapters')).not.toContainText('Finding chapters…')
    await expect(page.locator('#schapters')).toHaveAttribute('aria-busy', 'false')
    await page.locator('#mseries-retry').click()
    await expect(page.locator('#mchapter-list .mchrow')).toHaveCount(3)
    expect(errors).toEqual([])
})

test('a failed novel detail load can be retried without leaving the title', async ({ page }) => {
    const errors = await fixtures(page)
    let tries = 0
    await page.route('**/read/api/series/**', route => {
        if (tries++ === 0) return route.fulfill({
            status: 503, contentType: 'application/json',
            body: JSON.stringify({ error: { message: 'Source temporarily unavailable', retryable: false } }),
        })
        return reply(route, { title: 'Novel fixture', nfSlug: 'fixture', cover })
    })
    await navigate(page, '#/series/nf%3Afixture')
    await expect(page.locator('#sinfo')).toContainText('Source temporarily unavailable')
    await expect(page.locator('#series-retry')).toBeVisible()
    await page.locator('#series-retry').click()
    await expect(page.locator('#sinfo .dtitle')).toHaveText('Novel fixture')
    await expect(page.locator('#chlist .chrow')).toHaveCount(3)
    expect(errors).toEqual([])
})

for (const kind of ['novel', 'manga']) {
    test(`a pending ${kind} chapter filter cannot hide the next title's chapters`, async ({ page }) => {
        const errors = await fixtures(page)
        if (kind === 'novel') await page.route('**/read/api/series/**', route => {
            const other = route.request().url().includes('other')
            return reply(route, { title: other ? 'Second novel' : 'First novel', nfSlug: other ? 'other' : 'fixture', cover })
        })
        const mangaView = kind === 'manga'
        const prefix = mangaView ? '#/manga/series/mf%3A' : '#/series/nf%3A'
        const input = mangaView ? '#mchsearch' : '#chsearch'
        const rows = mangaView ? '#mchapter-list .mchrow' : '#chlist .chrow'
        await navigate(page, `${prefix}${mangaView ? 'first' : 'fixture'}`)
        await expect(page.locator(rows)).toHaveCount(3)
        await page.clock.install()
        await page.locator(input).fill('no-such-chapter')
        await navigate(page, `${prefix}${mangaView ? 'second' : 'other'}`)
        await expect(page.locator('#sinfo .dtitle')).toHaveText(mangaView ? 'mf:second' : 'Second novel')
        await expect(page.locator(rows)).toHaveCount(3)
        await page.clock.runFor(200)
        await expect(page.locator(`${rows}:visible`)).toHaveCount(3)
        await expect(page.locator(input)).toHaveValue('')
        expect(errors).toEqual([])
    })
}

for (const kind of ['novel', 'manga']) {
    test(`returning to a ${kind} detail never shows the other format's stale content`, async ({ page }) => {
        const errors = await fixtures(page)
        const mangaView = kind === 'manga'
        const key = mangaView ? 'mf:first' : 'nf:fixture'
        const first = mangaView ? '#/manga/series/mf%3Afirst' : '#/series/nf%3Afixture'
        const other = mangaView ? '#/series/nf%3Afixture' : '#/manga/series/mf%3Afirst'
        const title = mangaView ? 'mf:first' : 'Novel fixture'
        const otherTitle = mangaView ? 'Novel fixture' : 'mf:first'
        await navigate(page, first)
        await expect(page.locator('#sinfo .dtitle')).toHaveText(title)
        await navigate(page, other)
        await expect(page.locator('#sinfo .dtitle')).toHaveText(otherTitle)

        // Force a cache miss while retaining the previous screen state, so the loading
        // view remains inspectable until the next response is released.
        await page.evaluate(async ({ kind, key }) => {
            const api = kind === 'manga' ? await import('/src/lib/manga-api.js') : await import('/src/lib/api.js')
            const cached = await (kind === 'manga' ? api.getMangaSeries(key) : api.getSeries(key))
            cached.title = ''
            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open('vellum', 2)
                request.onsuccess = () => resolve(request.result)
                request.onerror = () => reject(request.error)
            })
            await new Promise((resolve, reject) => {
                const tx = db.transaction('cache', 'readwrite')
                tx.objectStore('cache').clear()
                tx.oncomplete = resolve
                tx.onerror = () => reject(tx.error)
            })
        }, { kind, key })

        const started = deferred()
        const release = deferred()
        await page.route(mangaView ? '**/read/api/manga/series/**' : '**/read/api/series/**', async route => {
            started.resolve()
            await release.promise
            return reply(route, mangaView ? manga('mf:first') : { title: 'Novel fixture', nfSlug: 'fixture', cover })
        })
        await navigate(page, first)
        await started.promise
        try {
            await expect(page.locator('#sinfo')).not.toContainText(otherTitle)
            await expect(page.locator('#sinfo')).toContainText(mangaView ? 'Loading manga' : 'loading')
        } finally { release.resolve() }
        await expect(page.locator('#sinfo .dtitle')).toHaveText(title)
        expect(errors).toEqual([])
    })
}

for (const kind of ['novel', 'manga']) {
    test(`downloads only the active ${kind} after visiting both shared detail screens`, async ({ page }) => {
        const errors = await fixtures(page)
        const order = kind === 'novel' ? ['#/manga/series/mf%3Afirst', '#/series/nf%3Afixture'] : ['#/series/nf%3Afixture', '#/manga/series/mf%3Afirst']
        for (const hash of order) {
            await navigate(page, hash)
            await expect(page.locator(hash.includes('/manga/') ? '#mchapter-list .mchrow' : '#chlist .chrow')).toHaveCount(3)
        }
        await page.locator('#schapters .chdl').first().click()
        await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('vellum:dl') || '[]').length)).toBeGreaterThan(0)
        await expect(page.locator('#schapters .chdl').first()).toHaveClass(/done/)
        await expect.poll(() => page.evaluate(async () => {
            const novel = await import('/src/lib/dl-novel.js')
            const manga = await import('/src/lib/dl-manga.js')
            return [1, 2, 3].some(id => novel.novelDlActive('fixture', id) || manga.mangaDlActive('mf:first', String(id)))
        })).toBe(false)
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vellum:dl') || '[]').map(item => item.kind))).toEqual([kind])
        expect(errors).toEqual([])
    })
}

for (const kind of ['manga', 'video']) {
    test(`keeps a ${kind} download batch attached to its original series after navigation`, async ({ page }) => {
        const started = deferred()
        const release = deferred()
        const hold = async url => {
            if (url.searchParams.get('id') !== '1') return
            started.resolve()
            await release.promise
        }
        const errors = await fixtures(page, { [kind === 'manga' ? 'image' : 'media']: hold })
        const prefix = kind === 'manga' ? 'mf' : 'mock'
        const section = kind === 'manga' ? 'manga' : 'watch'
        const rows = kind === 'manga' ? '#mchapter-list .mchrow' : '#video-episode-list .video-episode-row'
        await navigate(page, `#/${section}/series/${prefix}%3Afirst`)
        await expect(page.locator(rows)).toHaveCount(3)
        await page.locator(kind === 'manga' ? '#mdl-next' : '#vdl-next').click()
        await started.promise
        await navigate(page, `#/${section}/series/${prefix}%3Asecond`)
        await expect(page.locator(kind === 'manga' ? '#sinfo .dtitle' : '#vinfo .video-title')).toHaveText(`${prefix}:second`)
        await expect(page.locator(rows)).toHaveCount(3)
        release.resolve()
        await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('vellum:dl') || '[]').length)).toBe(3)
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vellum:dl')).map(item => item.key))).toEqual(Array(3).fill(`${prefix}:first`))
        expect(errors).toEqual([])
    })
}

test('chapter filtering hides the download action with its novel row', async ({ page }) => {
    await fixtures(page)
    await navigate(page, '#/series/nf%3Afixture')
    await expect(page.locator('#chlist .chrow')).toHaveCount(3)
    await page.locator('#chsearch').fill('Chapter 2')
    await expect(page.locator('#chlist .chrow:visible')).toHaveCount(1)
    await expect(page.locator('#chlist .chdl:visible')).toHaveCount(1)
    await expect(page.locator('#chlist .chdl:visible')).toHaveAttribute('data-dl', '2')
})

test('manga progress stays reset after filtering and a new download', async ({ page }) => {
    const errors = await fixtures(page)
    await page.evaluate(() => {
        localStorage.setItem('vellum:pos:mf:first', JSON.stringify({ id: '2', page: 0 }))
        localStorage.setItem('vellum:read:mf:first', JSON.stringify(['1', '2']))
    })
    await navigate(page, '#/manga/series/mf%3Afirst')
    await expect(page.locator('#mchapter-list .mchrow.current')).toHaveAttribute('data-id', '2')
    page.once('dialog', dialog => dialog.accept())
    await page.locator('#manga-reset').click()
    await page.locator('#mchsearch').fill('Chapter 2')
    await expect(page.locator('#mchapter-list .mchrow')).toHaveCount(1)
    await expect(page.locator('#mchapter-list .mchrow.current')).toHaveCount(0)
    await expect(page.locator('#mchapter-list [aria-current]')).toHaveCount(0)
    await page.locator('#mchsearch').fill('')
    await expect(page.locator('#mchapter-list .mchrow')).toHaveCount(3)
    await page.locator('#mdl-next').click()
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('vellum:dl') || '[]').length)).toBe(3)
    expect(errors).toEqual([])
})

for (const failed of ['reader', 'manga-reader', 'video-player']) {
    test(`cleans a failed ${failed} overlay when switching directly to another immersive mode`, async ({ page }) => {
        const errors = await fixtures(page)
        await page.route(`**/src/screens/${failed}.js`, route => route.abort('failed'))
        const from = failed === 'reader' ? '#/read/fixture/1' : failed === 'manga-reader' ? '#/manga/read/mf%3Afirst/1' : '#/watch/play/mock%3Afirst/1'
        const overlay = failed === 'reader' ? '#reader' : failed === 'manga-reader' ? '#mreader' : '#vplayer'
        await navigate(page, from)
        await expect(page.locator(overlay)).toContainText(failed === 'video-player' ? 'Player unavailable' : 'Reader unavailable')
        await navigate(page, failed === 'reader' ? '#/manga/read/mf%3Afirst/1' : '#/read/fixture/1')
        await expect(page.locator(failed === 'reader' ? '#mreader' : '#reader')).toHaveClass(/active/)
        await expect(page.locator(overlay)).not.toHaveClass(/active/)
        expect(errors).toEqual([])
    })
}

test('Watch preserves alternate title search matches from AniList', async ({ page }) => {
    await fixtures(page)
    await page.route('https://graphql.anilist.co', route => reply(route, {
        data: { Page: { pageInfo: { hasNextPage: false }, media: [{
            id: 16498, title: { english: 'Attack on Titan', romaji: 'Shingeki no Kyojin' }, coverImage: { large: cover },
        }] } },
    }))
    await navigate(page, '#/watch')
    await page.locator('#vsearch').fill('Shingeki no Kyojin')
    await expect(page.locator('#vlab')).toContainText('Shingeki no Kyojin')
    await expect(page.locator('#vlist a.watch-card')).toContainText('Attack on Titan')
})

test('Watch can continue past a duplicate pagination page', async ({ page }) => {
    await fixtures(page)
    await page.route('https://graphql.anilist.co', route => reply(route, { data: { Page: { pageInfo: { hasNextPage: false }, media: [] } } }))
    await page.route('**/read/api/video/discover?**', route => {
        const n = Number(new URL(route.request().url()).searchParams.get('page'))
        const results = n === 1 ? Array.from({ length: 30 }, (_, i) => ({ key: `mock:show-${i}`, kind: 'drama', title: `Show ${i}`, poster: cover }))
            : n === 2 ? [{ key: 'mock:show-0', kind: 'drama', title: 'Show 0', poster: cover }]
                : [{ key: 'mock:final', kind: 'drama', title: 'Final show', poster: cover }]
        return reply(route, { results, hasMore: n < 3 })
    })
    await navigate(page, '#/watch')
    await expect(page.locator('#vlist .watch-card')).toHaveCount(30)
    await page.locator('#vmore').dispatchEvent('click')
    await expect(page.locator('#vmore')).toBeEnabled()
    await expect(page.locator('#vmore')).not.toHaveAttribute('hidden')
    await page.locator('#vmore').dispatchEvent('click')
    await expect(page.locator('#vlist .watch-card')).toHaveCount(31)
})

test('opening and closing an unloaded video preserves its saved timestamp', async ({ page }) => {
    const errors = await fixtures(page)
    await page.evaluate(() => localStorage.setItem('vellum:pos:mock:first', JSON.stringify({ id: '1', position: 42, duration: 100 })))
    await navigate(page, '#/watch/play/mock%3Afirst/1')
    await expect(page.locator('#vplayer')).toHaveAttribute('data-state', 'ready')
    await page.locator('#vp-back').click()
    await expect(page.locator('#video-start')).toBeVisible()
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vellum:pos:mock:first')))).toMatchObject({ id: '1', position: 42, duration: 100 })
    expect(errors).toEqual([])
})

test('offline video metadata does not rewrite a drama library as a one episode anime', async ({ page }) => {
    const errors = await fixtures(page)
    await page.route('**/read/api/video/series/**', route => reply(route, { error: { message: 'Offline fixture', retryable: false } }))
    await page.evaluate(async () => {
        const { dlWrite, dlPath, dlRegister } = await import('/src/lib/downloads.js')
        await dlWrite(dlPath.video('mock:first', '1'), new Blob(['fixture video'], { type: 'video/mp4' }))
        dlRegister({ kind: 'video', key: 'mock:first', id: '1', title: 'Drama fixture', label: 'Episode 1', size: 13, mediaKind: 'drama' })
        localStorage.setItem('vellum:lib', JSON.stringify([{ slug: 'mock:first', key: 'mock:first', kind: 'drama', title: 'Drama fixture', format: 'K-Drama', cover: 'existing-cover', total: 12, episodeIds: ['1', '2', '3'], source: 'Fixture source' }]))
    })
    await navigate(page, '#/watch/play/mock%3Afirst/1')
    await expect(page.locator('.video-provider-label')).toHaveText('Provided by Downloaded copy')
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vellum:lib'))[0])).toMatchObject({ kind: 'drama', format: 'K-Drama', cover: 'existing-cover', total: 12, episodeIds: ['1', '2', '3'], source: 'Fixture source' })
    expect(errors).toEqual([])
})

test('a removed video cannot put the next episode into an error state', async ({ page }) => {
    const errors = await fixtures(page)
    await navigate(page, '#/watch/play/mock%3Afirst/1')
    await expect(page.locator('#vplayer')).toHaveAttribute('data-state', 'ready')
    await page.evaluate(() => { window.previousVideo = document.querySelector('#vplayer video') })
    await navigate(page, '#/watch/play/mock%3Afirst/2')
    await expect(page.locator('#vp-episode')).toContainText('Episode 2')
    await expect(page.locator('#vplayer')).toHaveAttribute('data-state', 'ready')
    await page.evaluate(() => window.previousVideo.dispatchEvent(new Event('error')))
    await expect(page.locator('#vplayer')).toHaveAttribute('data-state', 'ready')
    await expect(page.locator('.video-playback-error')).toHaveCount(0)
    expect(errors).toEqual([])
})

for (const section of ['manga', 'watch', 'discover']) {
    test(`preserves a pending ${section} search across a quick round trip`, async ({ page }) => {
        await fixtures(page)
        await page.route('https://graphql.anilist.co', route => reply(route, { data: { Page: { pageInfo: { hasNextPage: false }, media: [] } } }))
        const input = section === 'manga' ? '#msearch' : section === 'watch' ? '#vsearch' : '#dsearch'
        const label = section === 'manga' ? '#mlab' : section === 'watch' ? '#vlab' : '#dlab'
        await navigate(page, `#/${section}`)
        await expect(page.locator(input)).toBeVisible()
        await page.evaluate(async ({ input, section }) => {
            const field = document.querySelector(input)
            field.value = 'pending query'
            field.dispatchEvent(new Event('input', { bubbles: true }))
            const left = new Promise(resolve => window.addEventListener('hashchange', resolve, { once: true }))
            location.hash = '#/'
            await left
            location.hash = `#/${section}`
        }, { input, section })
        await expect(page.locator(label)).toContainText('pending query')
        await expect(page.locator(input)).toHaveValue('pending query')
    })
}

for (const section of ['manga', 'watch']) {
    test(`cancels an abandoned ${section} search and reloads it on return`, async ({ page }) => {
        const errors = await fixtures(page)
        if (section === 'manga') {
            await page.route('**/read/api/manga/search?**', route => reply(route, {
                page: 1, results: [manga('mf:resumed')], hasMore: false,
            }))
        } else {
            await page.route('**/read/api/video/discover?**', route => reply(route, {
                page: 1, results: [{ key: 'dc:resumed', kind: 'drama', title: 'Resumed title', poster: cover }],
                hasMore: false, partial: false, errors: [],
            }))
        }

        await navigate(page, `#/${section}`)
        if (section === 'watch') await page.locator('#vkind [data-kind="drama"]').click()
        const input = section === 'manga' ? '#msearch' : '#vsearch'
        const path = section === 'manga' ? '/read/api/manga/search' : '/read/api/video/discover'
        // Keep the first request pending until its signal is aborted; the next one uses the fixture.
        await page.evaluate(path => {
            const originalFetch = window.fetch
            window.heldBrowseRequest = false
            window.abandonedBrowseRequest = false
            window.fetch = (url, options) => {
                const target = new URL(url, location.href)
                if (!window.heldBrowseRequest && target.pathname === path && target.searchParams.get('q') === 'resumed') {
                    window.heldBrowseRequest = true
                    return new Promise((_, reject) => {
                        options.signal.addEventListener('abort', () => {
                            window.abandonedBrowseRequest = true
                            reject(new DOMException('Cancelled', 'AbortError'))
                        }, { once: true })
                    })
                }
                return originalFetch(url, options)
            }
        }, path)

        await page.locator(input).fill('resumed')
        await expect.poll(() => page.evaluate(() => window.heldBrowseRequest)).toBe(true)
        await navigate(page, '#/')
        await expect.poll(() => page.evaluate(() => window.abandonedBrowseRequest)).toBe(true)
        await navigate(page, `#/${section}`)
        await expect(page.locator(section === 'manga' ? '#mlist' : '#vlist')).toContainText(section === 'manga' ? 'mf:resumed' : 'Resumed title')
        expect(errors).toEqual([])
    })
}

for (const section of ['manga', 'watch']) {
    test(`keeps ${section} pagination usable after leaving during load more`, async ({ page }) => {
        const errors = await fixtures(page)
        const path = section === 'manga' ? '/read/api/manga/discover' : '/read/api/video/discover'
        const cards = section === 'manga' ? '#mlist .manga-card' : '#vlist .watch-card'
        const more = section === 'manga' ? '#mmore' : '#vmore'
        await page.route(`**${path}?**`, route => {
            const n = Number(new URL(route.request().url()).searchParams.get('page'))
            const results = n === 1
                ? Array.from({ length: 30 }, (_, i) => section === 'manga'
                    ? manga(`mf:browse-${i}`)
                    : { key: `dc:browse-${i}`, kind: 'drama', title: `Browse ${i}`, poster: cover })
                : [section === 'manga' ? manga('mf:final') : { key: 'dc:final', kind: 'drama', title: 'Final title', poster: cover }]
            return reply(route, { page: n, results, hasMore: n === 1, partial: false, errors: [] })
        })
        await page.route('https://graphql.anilist.co', route => reply(route, { data: { Page: { pageInfo: { hasNextPage: false }, media: [] } } }))
        await navigate(page, `#/${section}`)
        if (section === 'watch') await page.locator('#vkind [data-kind="drama"]').click()
        await expect(page.locator(cards)).toHaveCount(30)

        await page.evaluate(path => {
            const originalFetch = window.fetch
            window.heldBrowsePage = false
            window.abandonedBrowsePage = false
            window.fetch = (url, options) => {
                const target = new URL(url, location.href)
                if (!window.heldBrowsePage && target.pathname === path && target.searchParams.get('page') === '2') {
                    window.heldBrowsePage = true
                    return new Promise((_, reject) => {
                        options.signal.addEventListener('abort', () => {
                            window.abandonedBrowsePage = true
                            reject(new DOMException('Cancelled', 'AbortError'))
                        }, { once: true })
                    })
                }
                return originalFetch(url, options)
            }
        }, path)
        await page.locator(more).dispatchEvent('click')
        await expect.poll(() => page.evaluate(() => window.heldBrowsePage)).toBe(true)
        await navigate(page, '#/')
        await expect.poll(() => page.evaluate(() => window.abandonedBrowsePage)).toBe(true)
        await navigate(page, `#/${section}`)
        await expect(page.locator(cards)).toHaveCount(30)
        await expect(page.locator(more)).toBeEnabled()
        await page.locator(more).dispatchEvent('click')
        await expect(page.locator(cards)).toHaveCount(31)
        expect(errors).toEqual([])
    })
}

for (const mode of ['trending', 'search']) {
    test(`cancels an abandoned Discover ${mode} request and reloads on return`, async ({ page }) => {
        const errors = await fixtures(page)
        const path = mode === 'search' ? '/read/api/search' : '/read/api/discover'
        await page.route(`**${path}?**`, route => reply(route, {
            results: [{ key: 'nf:discovered', title: 'Discovered title', cover }], hasMore: false,
        }))
        await page.evaluate(({ path, mode }) => {
            const originalFetch = window.fetch
            window.heldDiscoverRequest = false
            window.abandonedDiscoverRequest = false
            window.fetch = (url, options) => {
                const target = new URL(url, location.href)
                if (!window.heldDiscoverRequest && target.pathname === path
                    && (mode !== 'search' || target.searchParams.get('q') === 'discovered')) {
                    window.heldDiscoverRequest = true
                    return new Promise((_, reject) => {
                        options.signal.addEventListener('abort', () => {
                            window.abandonedDiscoverRequest = true
                            reject(new DOMException('Cancelled', 'AbortError'))
                        }, { once: true })
                    })
                }
                return originalFetch(url, options)
            }
        }, { path, mode })

        await navigate(page, '#/discover')
        if (mode === 'search') await page.locator('#dsearch').fill('discovered')
        await expect.poll(() => page.evaluate(() => window.heldDiscoverRequest)).toBe(true)
        await navigate(page, '#/')
        await expect.poll(() => page.evaluate(() => window.abandonedDiscoverRequest)).toBe(true)
        await navigate(page, '#/discover')
        await expect(page.locator('#dlist .dcard')).toContainText('Discovered title')
        expect(errors).toEqual([])
    })
}

test('Discover preserves its feed and retries a page interrupted by navigation', async ({ page }) => {
    const errors = await fixtures(page)
    const path = '/read/api/discover'
    await page.route(`**${path}?**`, route => {
        const n = Number(new URL(route.request().url()).searchParams.get('page'))
        const results = n === 1
            ? Array.from({ length: 30 }, (_, i) => ({ key: `nf:discovery-${i}`, title: `Discovery ${i}`, cover }))
            : [{ key: 'nf:final', title: 'Final discovery', cover }]
        return reply(route, { page: n, results, hasMore: n === 1 })
    })
    await navigate(page, '#/discover')
    await expect(page.locator('#dlist .dcard')).toHaveCount(30)
    await page.evaluate(path => {
        const originalFetch = window.fetch
        window.heldDiscoverPage = false
        window.abandonedDiscoverPage = false
        window.fetch = (url, options) => {
            const target = new URL(url, location.href)
            if (!window.heldDiscoverPage && target.pathname === path && target.searchParams.get('page') === '2') {
                window.heldDiscoverPage = true
                return new Promise((_, reject) => {
                    options.signal.addEventListener('abort', () => {
                        window.abandonedDiscoverPage = true
                        reject(new DOMException('Cancelled', 'AbortError'))
                    }, { once: true })
                })
            }
            return originalFetch(url, options)
        }
    }, path)
    const scrollToEnd = () => page.locator('#view-discover .scroll').evaluate(element => {
        element.scrollTop = element.scrollHeight
        element.dispatchEvent(new Event('scroll'))
    })
    await scrollToEnd()
    await expect.poll(() => page.evaluate(() => window.heldDiscoverPage)).toBe(true)
    await navigate(page, '#/')
    await expect.poll(() => page.evaluate(() => window.abandonedDiscoverPage)).toBe(true)
    await expect(page.locator('#dlist .dcard')).toHaveCount(30)
    await navigate(page, '#/discover')
    await scrollToEnd()
    await expect(page.locator('#dlist .dcard')).toHaveCount(31)
    expect(errors).toEqual([])
})

test('novel image object URLs are released and refreshed when reopening a chapter', async ({ page }) => {
    const errors = await fixtures(page)
    await page.evaluate(async () => {
        window.revokedUrls = []
        const revoke = URL.revokeObjectURL.bind(URL)
        URL.revokeObjectURL = value => { window.revokedUrls.push(value); revoke(value) }
        const { dlWrite, dlPath, dlRegister } = await import('/src/lib/downloads.js')
        const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8t8AAAAASUVORK5CYII='), c => c.charCodeAt(0))
        await dlWrite(dlPath.novelImage('fixture', 1, 0), new Blob([png], { type: 'image/png' }))
        await dlWrite(dlPath.novelChapter('fixture', 1), JSON.stringify({ title: 'Offline chapter', html: '<p>Saved text</p><img src="dlimg:0">' }))
        dlRegister({ kind: 'novel', key: 'fixture', id: '1', title: 'Fixture', label: 'Chapter 1', size: 100 })
    })
    await navigate(page, '#/read/fixture/1')
    const image = page.locator('#reader-prose .ch-block img').first()
    await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBe(1)
    const first = await image.getAttribute('src')
    await navigate(page, '#/')
    await expect(page.locator('#reader')).not.toHaveClass(/active/)
    expect(await page.evaluate(() => window.revokedUrls)).toContain(first)
    await navigate(page, '#/read/fixture/1')
    await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBe(1)
    expect(await image.getAttribute('src')).not.toBe(first)
    expect(errors).toEqual([])
})

test('novel reader dialogs trap focus and Escape returns to their trigger', async ({ page }) => {
    const errors = await fixtures(page)
    await navigate(page, '#/read/fixture/1')
    await expect(page.locator('#reader-prose .ch-block').first()).toBeVisible()
    await page.locator('#r-list').click()
    await expect(page.locator('#drawer')).toHaveAttribute('aria-modal', 'true')
    await expect(page.locator('#dw-q')).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(page.locator('#drawer-list a').last()).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.locator('#dw-q')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.locator('#drawer')).toHaveAttribute('aria-hidden', 'true')
    await expect(page.locator('#r-list')).toBeFocused()
    await page.locator('#r-settings').click()
    await expect(page.locator('#sheet')).toHaveAttribute('aria-hidden', 'false')
    await expect(page.locator('#sheet button.on').first()).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.locator('#r-settings')).toBeFocused()
    await expect(page.locator('#sheet')).toHaveAttribute('aria-hidden', 'true')
    expect(errors).toEqual([])
})

for (const section of ['library', 'novel', 'manga', 'video']) {
    test(`reports a ${section} download deletion failure without dropping the saved item`, async ({ page }) => {
        const errors = await fixtures(page)
        const kind = section === 'library' ? 'novel' : section
        const key = kind === 'novel' ? 'fixture' : kind === 'manga' ? 'mf:first' : 'mock:first'
        const id = kind === 'novel' ? '3' : '1'
        await page.evaluate(async ({ kind, key, id }) => {
            const { dlRegister } = await import('/src/lib/downloads.js')
            dlRegister({ kind, key, id, title: 'Fixture', size: 100 })
            window.confirm = () => true
            window.downloadAlerts = []
            window.alert = message => window.downloadAlerts.push(message)
        }, { kind, key, id })
        await navigate(page, section === 'library' ? '#/updates' : section === 'novel' ? '#/series/nf%3Afixture' : section === 'manga' ? '#/manga/series/mf%3Afirst' : '#/watch/series/mock%3Afirst')
        if (section === 'library') await navigate(page, '#/')
        const button = page.locator(section === 'library' ? '#dltable .dldel' : section === 'video' ? '#video-episode-list .chdl' : '#schapters .chdl').first()
        await expect(button).toBeVisible()
        await page.evaluate(() => {
            const set = Storage.prototype.setItem
            Storage.prototype.setItem = function (key, value) {
                if (key === 'vellum:dl') throw new DOMException('Full', 'QuotaExceededError')
                return set.call(this, key, value)
            }
        })
        await button.click()
        await expect.poll(() => page.evaluate(() => window.downloadAlerts.length)).toBe(1)
        expect(await page.evaluate(() => window.downloadAlerts[0])).toContain('Could not save the download list')
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vellum:dl')).length)).toBe(1)
        expect(errors).toEqual([])
    })
}

test('applied novel filters reach progressive search and have separate cache identities', async ({ page }) => {
    await fixtures(page)
    const requests = []
    await page.route('**/read/api/search?**', route => {
        requests.push(Object.fromEntries(new URL(route.request().url()).searchParams))
        return reply(route, { results: [{ key: 'nf:fixture', title: 'Fixture' }], pending: false })
    })
    await page.evaluate(async () => {
        const { searchNovels } = await import('/src/lib/api.js')
        await searchNovels('fixture')
        await searchNovels('fixture', { sources: ['nf'], genres: ['Fantasy'], tags: ['Magic'], status: 'complete', minRating: 4.5, length: 'long', sort: 'rating', order: 'desc' })
    })
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({ q: 'fixture', progressive: '1', sources: 'nf', genres: 'Fantasy', tags: 'Magic', status: 'complete', minRating: '4.5', length: 'long', sort: 'rating', order: 'desc' })
})

for (const lazy of ['reader', 'manga-reader', 'video-player']) {
    test(`leaves a pending ${lazy} import without blocking navigation`, async ({ page }) => {
        const errors = await fixtures(page)
        const started = deferred()
        const release = deferred()
        await page.route(`**/src/screens/${lazy}.js`, async route => {
            started.resolve()
            await release.promise
            await route.continue()
        })
        await navigate(page, lazy === 'reader' ? '#/read/fixture/1' : lazy === 'manga-reader' ? '#/manga/read/mf%3Afirst/1' : '#/watch/play/mock%3Afirst/1')
        await started.promise
        await navigate(page, '#/discover')
        await expect(page.locator('#view-discover')).toBeVisible()
        release.resolve()
        await page.evaluate(path => import(path), `/src/screens/${lazy}.js`)
        await expect(page.locator('#reader.active, #mreader.active, #vplayer.active')).toHaveCount(0)
        expect(errors).toEqual([])
    })
}

for (const width of [320, 768]) {
    test(`fits detail actions and reader controls at ${width}px`, async ({ page }) => {
        const errors = await fixtures(page)
        await page.setViewportSize({ width, height: 844 })
        for (const [section, hash, ready, actions] of [
            ['novel', '#/series/nf%3Afixture', '#chlist .chrow', '#sinfo .dactions'],
            ['manga', '#/manga/series/mf%3Afirst', '#mchapter-list .mchrow', '#sinfo .dactions'],
            ['video', '#/watch/series/mock%3Afirst', '#video-episode-list .video-episode-row', '#vinfo .video-actions'],
        ]) {
            await navigate(page, hash)
            await expect(page.locator(ready)).toHaveCount(3)
            const box = await page.locator(actions).boundingBox()
            expect(box.x).toBeGreaterThanOrEqual(0)
            expect(box.x + box.width).toBeLessThanOrEqual(width + 1)
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
            if (section !== 'video') {
                const search = await page.locator('#schapters input').boundingBox()
                expect(search.width).toBeGreaterThan(180)
            }
            if (process.env.VELLUM_SCREENSHOTS) await page.screenshot({ path: `/tmp/vellum-${section}-${width}.png` })
        }
        expect(errors).toEqual([])
    })
}

test('Discover explains unsupported filters instead of pretending the provider matched', async ({ page }) => {
    await fixtures(page)
    await page.route('**/read/api/discover?**', route => {
        const params = new URL(route.request().url()).searchParams
        if (params.get('status') === 'hiatus') return route.fulfill({ status: 422, json: { error: { code: 'unsupported_filter', message: 'NovelFire does not support the hiatus filter.', retryable: false } } })
        return reply(route, { results: [] })
    })
    await navigate(page, '#/discover')
    await page.locator('#ftoggle').click()
    await page.locator('[data-filter="status"] [data-v="hiatus"]').click()
    await page.locator('#fapply').click()
    await expect(page.locator('#dlist')).toContainText('NovelFire does not support the hiatus filter.')
    await expect(page.locator('#dlist')).not.toContainText('could not reach')
})

test('Discover names skipped sources while showing supported mixed source results', async ({ page }) => {
    await fixtures(page)
    const requests = []
    await page.route('**/read/api/discover?**', route => {
        const params = Object.fromEntries(new URL(route.request().url()).searchParams)
        requests.push(params)
        return reply(route, { results: [{ key: 'az:fixture', title: 'Supported title', source: 'az', cover }], unsupportedSources: params.status === 'hiatus' ? ['nf'] : [] })
    })
    await navigate(page, '#/discover')
    await page.locator('#ftoggle').click()
    await page.locator('[data-src="novelfire"]').click()
    await page.locator('[data-src="az"]').click()
    await page.locator('[data-filter="status"] [data-v="hiatus"]').click()
    await page.locator('#fapply').click()
    await expect(page.locator('#dnotice')).toContainText('Novelfire does not support these filters and was skipped')
    await expect(page.locator('#dlist .dcard')).toContainText('Supported title')
    expect(requests.some(params => params.sources === 'az,novelfire' && params.status === 'hiatus')).toBe(true)
})

test('Discover tells search-only providers to enter a title instead of reporting an outage', async ({ page }) => {
    await fixtures(page)
    await page.route('**/read/api/discover?**', route => {
        const params = new URL(route.request().url()).searchParams
        if (params.get('sources') === 'rb') return route.fulfill({ status: 422, json: { error: { code: 'source_requires_query', message: 'Enter a title to search Ranobes.', retryable: false } } })
        return reply(route, { results: [] })
    })
    await navigate(page, '#/discover')
    await page.locator('#ftoggle').click()
    await page.locator('[data-src="rb"]').click()
    await page.locator('#fapply').click()
    await expect(page.locator('#dlist')).toContainText('Enter a title to search Ranobes.')
    await expect(page.locator('#dlist')).not.toContainText('could not reach')
})

test('progressive novel refreshes keep all applied filters while new choices are staged', async ({ page }) => {
    await fixtures(page)
    await page.route('**/read/api/discover/taxonomy', route => reply(route, { genres: ['Fantasy'], tags: ['Magic'] }))
    const requests = []
    await page.route('**/read/api/search?**', route => {
        requests.push(Object.fromEntries(new URL(route.request().url()).searchParams))
        return reply(route, { results: [], pending: requests.length === 1, retryAfterMs: 1000 })
    })
    await navigate(page, '#/discover')
    await page.locator('#ftoggle').click()
    for (const token of ['Fantasy', 'Magic']) {
        await page.locator('#toksearch').fill(token)
        await page.locator('#tokdrop .topt').first().click()
    }
    await page.locator('[data-src="novelfire"]').click()
    await page.locator('[data-filter="status"] [data-v="complete"]').click()
    await page.locator('[data-filter="minrating"] [data-v="4.5"]').click()
    await page.locator('[data-filter="length"] [data-v="long"]').click()
    await page.locator('#fapply').click()
    await page.locator('#dsearch').fill('filtered refresh')
    await expect.poll(() => requests.length).toBe(1)
    await page.locator('[data-filter="status"] [data-v="ongoing"]').click()
    await page.locator('[data-filter="length"] [data-v="short"]').click()
    await expect.poll(() => requests.length).toBe(2)
    for (const request of requests) expect(request).toMatchObject({
        q: 'filtered refresh', progressive: '1', sources: 'novelfire',
        genres: 'Fantasy', tags: 'Magic', status: 'complete', minRating: '4.5', length: 'long',
    })
})
