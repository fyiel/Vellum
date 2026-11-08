import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

test('reopening a replaced saved novel chapter shows its latest text', async ({ page }) => {
    const slug = 'updated-saved-chapter'
    await page.route(`**/read/api/chapters?slug=${slug}`, route => route.fulfill({
        json: { chapters: [{ n: 1, t: 'One' }] },
    }))
    await page.route(`**/read/api/series/**`, route => route.fulfill({
        json: { key: `nf:${slug}`, nfSlug: slug, title: 'Saved novel' },
    }))
    await page.goto(app)
    await page.evaluate(async slug => {
        const dl = await import('/src/lib/downloads.js')
        await dl.dlWrite(dl.dlPath.novelChapter(slug, 1), JSON.stringify({ html: '<p>Original offline text</p>' }))
        dl.dlRegister({ kind: 'novel', key: slug, id: '1', title: 'Saved novel' })
        location.hash = `#/read/${slug}/1`
    }, slug)
    await expect(page.locator('#reader .ch-block')).toContainText('Original offline text')

    await page.evaluate(async slug => {
        location.hash = '#/'
        const dl = await import('/src/lib/downloads.js')
        await dl.dlWrite(dl.dlPath.novelChapter(slug, 1), JSON.stringify({ html: '<p>Revised offline text</p>' }))
    }, slug)
    await expect(page.locator('#reader')).not.toHaveClass(/active/)
    await page.evaluate(slug => { location.hash = `#/read/${slug}/1` }, slug)
    await expect(page.locator('#reader .ch-block')).toContainText('Revised offline text')
})
