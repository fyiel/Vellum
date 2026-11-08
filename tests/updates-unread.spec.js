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

        await row.locator('.umark').click()
        await expect(row).toHaveClass(/unread/)
        await expect(page.locator('#count-updates')).toHaveText('1')
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
