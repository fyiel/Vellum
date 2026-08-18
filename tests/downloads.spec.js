import { test, expect } from '@playwright/test'

// live-backend end-to-end downloads: each test downloads one item, reads it online from the
// local copy, then reads it fully offline. The lazy reader/player chunks are warmed online
// first because the dev server serves modules over http (in the packaged app they are local).

test('manga chapter downloads and reads offline', async ({ page, context }) => {
    test.setTimeout(240_000)
    await page.goto('http://127.0.0.1:5173/#/manga/series/mf%3Alrmyz')
    await page.waitForSelector('.mchrow', { timeout: 60_000 })
    const firstRow = page.locator('.mchrow').first()
    const chapterId = await firstRow.getAttribute('data-id')
    await page.locator('.chdl').first().click()
    await expect(page.locator('.chdl').first()).toHaveClass(/done/, { timeout: 180_000 })
    const entry = await page.evaluate(() => JSON.parse(localStorage.getItem('vellum:dl'))[0])
    expect(entry).toMatchObject({ kind: 'manga', id: chapterId })
    expect(entry.size).toBeGreaterThan(10_000)

    await firstRow.click()
    await expect(page.locator('.manga-page.loaded').first()).toBeVisible({ timeout: 30_000 })
    await page.goto('http://127.0.0.1:5173/#/manga/series/mf%3Alrmyz')
    await context.setOffline(true)
    await page.evaluate(({ key, id }) => { location.hash = `#/manga/read/${encodeURIComponent(key)}/${encodeURIComponent(id)}` }, { key: 'mf:lrmyz', id: chapterId })
    await expect(page.locator('.manga-page.loaded').first()).toBeVisible({ timeout: 30_000 })
})

test('novel chapter downloads and reads offline', async ({ page, context }) => {
    test.setTimeout(120_000)
    await page.goto('http://127.0.0.1:5173/#/series/nf%3Alord-of-the-mysteries')
    await expect(page.locator('#chlist .chrow').first()).toBeVisible({ timeout: 60_000 })
    const n = await page.locator('#chlist .chrow').first().getAttribute('data-n')
    await page.locator(`#chlist .chline:has(.chrow[data-n="${n}"]) .chdl`).click()
    await expect(page.locator(`#chlist .chline:has(.chrow[data-n="${n}"]) .chdl`)).toHaveClass(/done/, { timeout: 30_000 })
    await page.locator('#chlist .chrow').first().click()
    await expect(page.locator('#reader .ch-block').first()).toBeVisible({ timeout: 30_000 })
    await page.goto('http://127.0.0.1:5173/#/')
    await context.setOffline(true)
    await page.evaluate(n => { location.hash = `#/read/lord-of-the-mysteries/${n}` }, n)
    await expect(page.locator('#reader .ch-block').first()).toBeVisible({ timeout: 30_000 })
})

test('video episode downloads (hls remux) and plays offline', async ({ page, context }) => {
    test.setTimeout(600_000)
    await page.goto('http://127.0.0.1:5173/#/watch/series/miruro%3A21')
    await page.waitForSelector('.video-episode-row', { timeout: 60_000 })
    await page.locator('.chdl').first().click()
    await expect(page.locator('.chdl').first()).toHaveClass(/active/, { timeout: 30_000 })
    await expect(page.locator('.chdl').first()).toHaveClass(/done/, { timeout: 480_000 })
    const entry = await page.evaluate(() => JSON.parse(localStorage.getItem('vellum:dl'))[0])
    expect(entry.kind).toBe('video')
    expect(entry.size).toBeGreaterThan(1_000_000)

    await page.locator('.video-episode-row').first().click()
    await expect(page.locator('video.video-media')).toBeVisible({ timeout: 60_000 })
    expect(await page.locator('video.video-media').getAttribute('src')).toMatch(/^blob:/)

    await page.goto('http://127.0.0.1:5173/#/watch/series/miruro%3A21')
    await context.setOffline(true)
    await page.locator('.video-episode-row').first().click()
    await expect(page.locator('video.video-media')).toBeVisible({ timeout: 60_000 })
    expect(await page.locator('video.video-media').getAttribute('src')).toMatch(/^blob:/)
    await page.evaluate(() => { const v = document.querySelector('video.video-media'); v.preload = 'auto'; v.load() })
    await page.waitForFunction(() => document.querySelector('video.video-media').readyState >= 1, null, { timeout: 30_000 })
    expect(await page.evaluate(() => document.querySelector('video.video-media').duration)).toBeGreaterThan(60)
})
