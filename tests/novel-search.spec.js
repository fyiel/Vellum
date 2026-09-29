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
