import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

for (const kind of ['manga', 'anime', 'drama']) {
    test(`marking a ${kind} update unread survives a refresh`, async ({ page }) => {
        const key = kind === 'manga' ? 'mf:unread-update' : `mock:${kind}-unread-update`
        const entries = [
            { id: 'episode-2', number: 2, season: 1, title: 'New update' },
            { id: 'episode-1', number: 1, season: 1, title: 'Previously seen' },
        ]
        if (kind === 'manga') {
            await page.route('**/read/api/manga/chapters?**', route => route.fulfill({
                json: { key, chapters: entries },
            }))
        } else {
            await page.route('**/read/api/video/series/**', route => route.fulfill({
                json: { key, kind, title: 'Unread test', episodes: entries },
            }))
        }

        await page.goto(app)
        await page.evaluate(({ key, kind }) => {
            localStorage.setItem('vellum:lib', JSON.stringify([{
                slug: key, key, kind, title: 'Unread test', total: 1,
                ...(kind === 'manga' ? { chapterIds: ['episode-1'] } : { episodeIds: ['episode-1'] }),
            }]))
            localStorage.setItem('vellum:updates', JSON.stringify({
                [key]: { firstSeen: Date.now(), read: true, seenIds: ['episode-1'] },
            }))
            location.hash = '#/updates'
        }, { key, kind })

        const row = page.locator('#ufeed .urow')
        await expect(row).toHaveCount(1)
        await expect(row.locator('.uchip')).toHaveAttribute('data-id', 'episode-2')
        await expect(page.locator('#count-updates')).toHaveText('1')

        await row.locator('.umark').click()
        await expect(row).toHaveClass(/read/)
        await expect(page.locator('#count-updates')).toHaveText('')
        const acknowledged = await page.evaluate(key => JSON.parse(localStorage.getItem('vellum:updates'))[key], key)
        expect(acknowledged.seenIds).toEqual(['episode-2', 'episode-1'])
        expect(acknowledged[kind === 'manga' ? 'newChapters' : 'newEpisodes']).toEqual([])
        expect(acknowledged.latestIds).toBeUndefined()

        await row.locator('.umark').click()
        await expect(row).toHaveClass(/unread/)
        await expect(page.locator('#count-updates')).toHaveText('1')
        expect(await page.evaluate(key => JSON.parse(localStorage.getItem('vellum:updates'))[key].latestIds, key))
            .toEqual(['episode-2', 'episode-1'])
        await page.reload()
        await expect(page.locator('#ufeed .urow')).toHaveCount(1)
        await expect(page.locator('#ufeed .urow')).toHaveClass(/unread/)
        await expect(page.locator('#ufeed .uchip')).toHaveAttribute('data-id', 'episode-2')
        await expect(page.locator('#count-updates')).toHaveText('1')

        await page.locator('#ufeed .umark').click()
        await page.reload()
        await expect(page.locator('#ufeed .urow')).toHaveCount(0)
        await expect(page.locator('#count-updates')).toHaveText('')
    })
}

test('a reopened manga alert can be acknowledged while the provider is offline', async ({ page }) => {
    const key = 'mf:offline-ack'
    const pattern = '**/read/api/manga/chapters?**'
    const chapters = [{ id: 'new', number: 2 }, { id: 'old', number: 1 }]
    await page.route(pattern, route => route.fulfill({ json: { key, chapters } }))
    await page.goto(app)
    await page.evaluate(key => {
        localStorage.setItem('vellum:lib', JSON.stringify([{
            slug: key, key, kind: 'manga', title: 'Offline updates', total: 1, chapterIds: ['old'],
        }]))
        localStorage.setItem('vellum:updates', JSON.stringify({
            [key]: { firstSeen: Date.now(), read: true, seenIds: ['old'] },
        }))
        location.hash = '#/updates'
    }, key)
    await expect(page.locator('#ufeed .urow')).toHaveCount(1)
    await page.locator('#ufeed .umark').click() // acknowledge, removing the duplicate full-ID list
    await page.locator('#ufeed .umark').click() // reopen, restoring the offline snapshot

    await page.unroute(pattern)
    await page.route(pattern, route => route.abort('failed'))
    await page.reload()
    await expect(page.locator('#ufeed .urow.unread')).toHaveCount(1)
    await page.locator('#umarkall').click()
    const acknowledged = await page.evaluate(key => JSON.parse(localStorage.getItem('vellum:updates'))[key], key)
    expect(acknowledged).toMatchObject({ read: true, seenIds: ['new', 'old'], newChapters: [] })
    expect(acknowledged.latestIds).toBeUndefined()

    await page.unroute(pattern)
    await page.route(pattern, route => route.fulfill({ json: { key, chapters } }))
    await page.reload()
    await expect(page.locator('#ufeed .urow')).toHaveCount(0)
})

for (const kind of ['novel', 'manga', 'anime', 'drama']) {
    test(`a temporarily shortened ${kind} list keeps previously discovered updates visible`, async ({ page }) => {
        await page.goto(app)
        await page.evaluate(async kind => {
            const { setTransport } = await import('/src/lib/http.js')
            const key = kind === 'manga' ? 'mf:short-list'
                : kind === 'novel' ? 'nf:short-list' : `mock:${kind}-short-list`
            const old = kind === 'novel' ? { n: 1 } : { id: 'old', number: 1 }
            const recent = kind === 'novel' ? { n: 2 } : { id: 'new', number: 2 }
            window.shortenedUpdates = false
            setTransport(url => {
                const entries = window.shortenedUpdates ? [old] : [old, recent]
                return Promise.resolve(Response.json(kind === 'manga' ? { key, chapters: entries }
                    : kind === 'novel' ? { key, chapters: entries }
                        : { key, kind, title: 'Short list', episodes: entries }))
            })
            localStorage.setItem('vellum:lib', JSON.stringify([{
                slug: key, key, kind, title: 'Short list', total: 1,
                ...(kind === 'manga' ? { chapterIds: ['old'] }
                    : kind === 'novel' ? {} : { episodeIds: ['old'] }),
            }]))
            localStorage.setItem('vellum:updates', JSON.stringify({
                [key]: kind === 'novel'
                    ? { firstSeen: Date.now(), read: true, seenUpTo: 1 }
                    : { firstSeen: Date.now(), read: true, seenIds: ['old'] },
            }))
            location.hash = '#/updates'
        }, kind)

        await expect(page.locator('#ufeed .urow.unread')).toHaveCount(1)
        await expect(page.locator('#count-updates')).toHaveText('1')
        const first = await page.evaluate(() => JSON.parse(localStorage.getItem('vellum:updates')))

        const after = await page.evaluate(async () => {
            window.shortenedUpdates = true
            const { buildFeed } = await import('/src/lib/updates.js')
            return buildFeed({ fresh: true })
        })
        expect(after.feed).toHaveLength(1)
        expect(after.feed[0]).toMatchObject({ read: false, title: 'Short list', newCount: 1 })
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vellum:updates')))).toEqual(first)
    })
}
