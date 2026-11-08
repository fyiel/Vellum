import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

for (const section of ['manga', 'watch']) {
    test(`${section} keeps existing cards and focus while loading another page`, async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 600 })
        const manga = section === 'manga'
        const initialCount = manga ? 48 : 30
        const list = manga ? '#mlist' : '#vlist'
        const card = manga ? '.manga-card' : '.watch-card'
        const more = manga ? '#mmore' : '#vmore'
        const endpoint = manga ? '/read/api/manga/discover' : '/read/api/video/discover'
        let releasePage
        const pageGate = new Promise(resolve => { releasePage = resolve })
        let requestedNext = false

        await page.route(`**${endpoint}?**`, async route => {
            const url = new URL(route.request().url())
            const n = Number(url.searchParams.get('page'))
            if (n === 2) { requestedNext = true; await pageGate }
            const keys = n === 1 ? Array.from({ length: initialCount }, (_, i) => `paging-${i}`) : ['paging-new']
            const results = keys.map(key => manga
                ? { key: `mf:${key}`, kind: 'manga', format: 'manga', title: `Manga ${key}` }
                : { key: `dc:${key}`, kind: 'drama', title: `Drama ${key}` })
            await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ page: n, results, hasMore: n === 1 }) })
        })
        if (!manga) {
            await page.route('https://graphql.anilist.co', route => route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ data: { Page: { pageInfo: { hasNextPage: false }, media: [] } } }),
            }))
        }

        await page.goto(`${app}#/${section}`)
        await expect(page.locator(`${list} ${card}`)).toHaveCount(initialCount)
        expect(requestedNext).toBe(false)
        await page.evaluate(({ list, card }) => {
            const element = document.querySelector(list)
            const first = element.querySelector(card)
            first.focus()
            let removed = 0
            new MutationObserver(records => {
                for (const record of records) removed += [...record.removedNodes].filter(node => node.matches?.(card)).length
            }).observe(element, { childList: true })
            window.pagingRender = { first, removed: () => removed }
        }, { list, card })

        await page.locator(more).dispatchEvent('click')
        await expect.poll(() => requestedNext).toBe(true)
        await expect(page.locator(more)).toBeDisabled()
        const duringLoading = await page.evaluate(({ list, card }) => ({
            sameFirstCard: window.pagingRender.first === document.querySelector(`${list} ${card}`),
            retainedFocus: document.activeElement === window.pagingRender.first,
            removedCards: window.pagingRender.removed(),
        }), { list, card })
        releasePage()
        await expect(page.locator(`${list} ${card}`)).toHaveCount(initialCount + 1)
        expect(duringLoading).toEqual({ sameFirstCard: true, retainedFocus: true, removedCards: 0 })
    })
}
