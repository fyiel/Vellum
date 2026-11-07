import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`
const cover = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="60" height="90"/%3E'
const row = (key, title, source = 'ndx') => ({ key, title, source, cover, chapters: 100, sources: [{ key, source }] })
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })

test.beforeEach(async ({ page }) => {
    await page.route('**/read/api/discover**', route => reply(route, { results: [], genres: [], tags: [] }))
    await page.goto(app)
    await page.locator('[data-nav="discover"]').click()
})

test('shows early matches, then replaces them with NU groups and maker sources', async ({ page }) => {
    let finish
    const finished = new Promise(resolve => { finish = resolve })
    let requests = 0
    await page.route('**/read/api/search?**', async route => {
        expect(new URL(route.request().url()).searchParams.get('progressive')).toBe('1')
        if (++requests === 1) return reply(route, { results: [row('ndx:multi', 'Multidimensional'), row('nf:multi', 'Tower of Avatars', 'nf')], pending: true, retryAfterMs: 250 })
        await finished
        return reply(route, { results: [{ ...row('nu:multi', 'Climbing the Tower with Multidimensional Avatars', 'az'), metadataSource: 'novelupdates', sources: [{ source: 'az' }, { source: 'nf' }, { source: 'ndx' }] }], pending: false })
    })
    await page.locator('#dsearch').fill('Multidimensional')
    await expect(page.locator('#dlist .dcard')).toHaveCount(2)
    await expect(page.locator('#rescount')).toContainText('updating')
    finish()
    await expect(page.locator('#dlist .dcard')).toHaveCount(1)
    await expect(page.locator('#dlist .dcard')).toHaveAttribute('data-key', 'nu:multi')
    await expect(page.locator('#dlist')).toContainText('3 sources')
    await expect(page.locator('#rescount')).not.toContainText('updating')
})

test('an empty pending response keeps searching; old responses cannot overwrite a new query', async ({ page }) => {
    let releaseOld
    const old = new Promise(resolve => { releaseOld = resolve })
    let oldRequests = 0
    await page.route('**/read/api/search?**', async route => {
        const q = new URL(route.request().url()).searchParams.get('q')
        if (q === 'old') {
            if (++oldRequests === 1) return reply(route, { results: [], pending: true, retryAfterMs: 250 })
            await old
            return reply(route, { results: [row('ndx:old', 'Old answer')], pending: false }).catch(() => {})
        }
        return reply(route, { results: [row('az:new', 'New answer', 'az')], pending: false })
    })
    await page.locator('#dsearch').fill('old')
    await expect(page.locator('#dlist')).toContainText('searching')
    await expect(page.locator('#dlist')).not.toContainText('no results')
    await expect.poll(() => oldRequests).toBe(2)
    await page.locator('#dsearch').fill('new')
    await expect(page.locator('#dlist')).toContainText('New answer')
    releaseOld()
    await expect(page.locator('#dlist .dcard')).toHaveCount(1)
    await expect(page.locator('#dlist')).not.toContainText('Old answer')
    await expect(page.locator('#dlist')).toContainText('Azure Chronicles')
})

test('resumes background search after returning to discover', async ({ page }) => {
    let complete = false
    await page.route('**/read/api/search?**', route => reply(route, { results: [row(complete ? 'nu:multi' : 'ndx:multi', complete ? 'Finished title' : 'Early title')], pending: !complete, retryAfterMs: 250 }))
    await page.locator('#dsearch').fill('multi')
    await expect(page.locator('#dlist')).toContainText('Early title')
    await page.locator('[data-nav="library"]').click()
    complete = true
    await page.locator('[data-nav="discover"]').click()
    await expect(page.locator('#dlist')).toContainText('Finished title')
    await expect(page.locator('#rescount')).not.toContainText('updating')
})

test('applies source selection to search requests and keeps each selection in its own cache', async ({ page }) => {
    const requests = []
    await page.route('**/read/api/search?**', route => {
        const sources = new URL(route.request().url()).searchParams.get('sources')
        requests.push(sources)
        const results = sources === 'noveldex' ? [row('ndx:chosen', 'NovelDex match')]
            : sources === 'az,noveldex' ? [row('ndx:chosen', 'NovelDex match'), row('az:chosen', 'Azure match', 'az')]
            : [row('nf:all', 'All sources match', 'nf')]
        return reply(route, { results, pending: false })
    })
    await page.locator('#dsearch').fill('source cache')
    await expect(page.locator('#dlist')).toContainText('All sources match')
    await page.locator('#ftoggle').click()
    await page.locator('#dsource [data-src="noveldex"]').click()
    await expect(page.locator('#dlist')).toContainText('All sources match')
    expect(requests).toEqual([null])
    await page.locator('#fapply').click()
    await expect(page.locator('#dlist')).toContainText('NovelDex match')
    await page.locator('#dsource [data-src="az"]').click()
    await page.locator('#fapply').click()
    await expect(page.locator('#dlist .dcard')).toHaveCount(2)
    expect(requests).toEqual([null, 'noveldex', 'az,noveldex'])
    await page.locator('#freset').click()
    await expect(page.locator('#dlist')).toContainText('All sources match')
    await expect(page.locator('#dsource [data-all]')).toHaveClass(/on/)
    // Reset reuses only the unfiltered cache, never the last selected source's cache.
    expect(requests).toEqual([null, 'noveldex', 'az,noveldex'])
})

test('no-query discovery sends applied sources, paginates them and resets to trending', async ({ page }) => {
    await expect(page.locator('#dlist')).toContainText('nothing trending right now')
    const requests = []
    await page.route('**/read/api/discover?**', route => {
        const params = new URL(route.request().url()).searchParams
        const sources = params.get('sources')
        requests.push({ sources, page: params.get('page'), sort: params.get('sort') })
        return reply(route, { results: params.get('page') !== '1' ? [] : sources
            ? [row('ndx:browse', 'NovelDex discovery'), row('az:browse', 'Azure discovery', 'az'), row('nf:wrong', 'Wrong source', 'nf')]
            : [row('nf:trending', 'Trending again', 'nf')] })
    })
    await page.locator('#ftoggle').click()
    await page.locator('#dsource [data-src="noveldex"]').click()
    await page.locator('#dsource [data-src="az"]').click()
    expect(requests).toEqual([])
    await page.locator('#fapply').click()
    await expect(page.locator('#dlist .dcard')).toHaveCount(2)
    await expect(page.locator('#dlist')).not.toContainText('Wrong source')
    await expect.poll(() => requests.some(r => r.page === '2')).toBe(true)
    expect(requests.every(r => r.sources === 'az,noveldex')).toBe(true)
    await page.locator('#freset').click()
    await expect(page.locator('#dlist')).toContainText('Trending again')
    expect(requests.some(r => r.sources === null && r.sort === 'trending')).toBe(true)
})

test('pending search refreshes retain applied sources and discard responses from an older selection', async ({ page }) => {
    let releaseOld
    const old = new Promise(resolve => { releaseOld = resolve })
    const requests = []
    await page.route('**/read/api/search?**', async route => {
        const sources = new URL(route.request().url()).searchParams.get('sources')
        requests.push(sources)
        if (sources === 'noveldex') {
            if (requests.filter(s => s === sources).length === 1) {
                return reply(route, { results: [row('ndx:early', 'Early selected result')], pending: true, retryAfterMs: 500 })
            }
            await old
            return reply(route, { results: [row('ndx:old', 'Old selected result')], pending: false }).catch(() => {})
        }
        return reply(route, { results: [row('az:current', 'Current selected result', 'az')], pending: false })
    })
    await page.locator('#ftoggle').click()
    await page.locator('#dsource [data-src="noveldex"]').click()
    await page.locator('#fapply').click()
    await page.locator('#dsearch').fill('pending sources')
    await expect(page.locator('#dlist')).toContainText('Early selected result')
    // A staged chip change must not alter progressive refreshes.
    await page.locator('#dsource [data-src="noveldex"]').click()
    await page.locator('#dsource [data-src="az"]').click()
    await expect.poll(() => requests.length).toBe(2)
    expect(requests).toEqual(['noveldex', 'noveldex'])
    await page.locator('#fapply').click()
    await expect(page.locator('#dlist')).toContainText('Current selected result')
    releaseOld()
    await expect(page.locator('#rescount')).not.toContainText('updating')
    await expect(page.locator('#dlist')).not.toContainText('Old selected result')
    expect(requests).toEqual(['noveldex', 'noveldex', 'az'])
})

test('discovery continues past empty filtered pages with hasMore and stops at the explicit end', async ({ page }) => {
    await expect(page.locator('#dlist')).toContainText('nothing trending right now')
    const pages = []
    await page.route('**/read/api/discover?**', route => {
        const p = Number(new URL(route.request().url()).searchParams.get('page'))
        pages.push(p)
        return reply(route, { results: p === 1 ? [] : [row('ndx:later', 'Later matching result')], hasMore: p === 1 })
    })
    await page.locator('#ftoggle').click()
    await page.locator('#dsource [data-src="noveldex"]').click()
    await page.locator('#fapply').click()
    await expect(page.locator('#dlist')).toContainText('Later matching result')
    await expect(page.locator('#rescount')).toHaveText('1 result')
    expect(pages).toEqual([1, 2])
})

test('discovery stops repeated nonempty pages even if the provider claims more', async ({ page }) => {
    await expect(page.locator('#dlist')).toContainText('nothing trending right now')
    const pages = []
    await page.route('**/read/api/discover?**', route => {
        pages.push(Number(new URL(route.request().url()).searchParams.get('page')))
        return reply(route, { results: [row('ndx:repeat', 'Repeated result')], hasMore: true })
    })
    await page.locator('#ftoggle').click()
    await page.locator('#dsource [data-src="noveldex"]').click()
    await page.locator('#fapply').click()
    await expect(page.locator('#rescount')).toHaveText('1 result')
    expect(pages).toEqual([1, 2])
})

test('discovery renders actionable source errors as text without retrying them', async ({ page }) => {
    await expect(page.locator('#dlist')).toContainText('nothing trending right now')
    let requests = 0
    const message = 'Enter a title to search NovelLive <img src=x onerror=alert(1)>'
    await page.route('**/read/api/discover?**', route => {
        requests++
        return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({
            error: { code: 'source_requires_query', message, retryable: false },
        }) })
    })
    await page.locator('#ftoggle').click()
    await page.locator('#dsource [data-src="nl"]').click()
    await page.locator('#fapply').click()
    await expect(page.locator('#dlist')).toHaveText(message)
    await expect(page.locator('#dlist img')).toHaveCount(0)
    expect(requests).toBe(1)
})

test('partial discovery results are not cached as a complete source selection', async ({ page }) => {
    await expect(page.locator('#dlist')).toContainText('nothing trending right now')
    let requests = 0
    await page.route('**/read/api/discover?**', route => {
        requests++
        return reply(route, { results: [row('ndx:partial', 'Partial result')], partial: true, failedSources: ['az'] })
    })
    const results = await page.evaluate(async () => {
        const { discover } = await import('/src/lib/api.js')
        const params = { sources: ['az', 'noveldex'], page: 1 }
        return [await discover(params), await discover(params)]
    })
    expect(results.every(result => result.partial)).toBe(true)
    expect(requests).toBe(2)
})
