import { test, expect } from '@playwright/test'

test('Cineby details accept season zero specials alongside regular episodes', async ({ page }) => {
    await page.route('**/read/api/video/series/cineby%3A1399', route => route.fulfill({ json: {
        key: 'cineby:1399', kind: 'anime', title: 'Series with specials',
        episodes: [
            { id: 's0e1', number: 1, season: 0, title: 'Behind the scenes' },
            { id: 's1e1', number: 1, season: 1, title: 'First episode' },
        ],
    } }))
    await page.goto(`http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/#/watch/series/cineby%3A1399`)
    await expect(page.locator('.video-episode-row')).toHaveCount(2)
    await expect(page.locator('.video-episode-row[data-id="s0e1"]')).toContainText('Behind the scenes')
    await expect(page.locator('.video-episode-row[data-id="s1e1"]')).toContainText('First episode')
})
