import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

test('mark all updates read persists the ledger once and acknowledges every series', async ({ page }) => {
    await page.goto(app)
    await page.evaluate(async () => {
        const { setTransport } = await import('/src/lib/http.js')
        const seen = Array.from({ length: 200 }, (_, i) => `seen-${i}`)
        const entries = Array.from({ length: 60 }, (_, i) => ({
            slug: `mf:bulk-${i}`, key: `mf:bulk-${i}`, kind: 'manga',
            title: `Bulk manga ${i}`, total: seen.length, chapterIds: seen,
            updatedAt: Date.now(),
        }))
        const ledger = Object.fromEntries(entries.map(entry => [entry.slug, {
            firstSeen: Date.now(), read: true, seenIds: seen, newChapters: [],
            latest: seen.length, latestIds: seen,
        }]))
        localStorage.setItem('vellum:lib', JSON.stringify(entries))
        localStorage.setItem('vellum:updates', JSON.stringify(ledger))
        const chapters = [
            { id: 'fresh', number: seen.length + 1 },
            ...seen.map((id, i) => ({ id, number: i + 1 })),
        ]
        setTransport(url => {
            const target = new URL(url, location.href)
            if (target.pathname !== '/read/api/manga/chapters') throw Error(`Unexpected request ${target}`)
            return Promise.resolve(Response.json({ key: target.searchParams.get('key'), chapters }))
        })
        location.hash = '#/updates'
    })
    await expect(page.locator('#ufeed .urow')).toHaveCount(60)
    await expect(page.locator('#count-updates')).toHaveText('60')

    const result = await page.evaluate(() => {
        const setItem = Storage.prototype.setItem
        let writes = 0
        Storage.prototype.setItem = function (key, value) {
            if (key === 'vellum:updates') writes++
            return setItem.call(this, key, value)
        }
        let elapsed
        try {
            const start = performance.now()
            document.querySelector('#umarkall').click()
            elapsed = performance.now() - start
        } finally { Storage.prototype.setItem = setItem }
        const saved = JSON.parse(localStorage.getItem('vellum:updates'))
        return {
            writes, elapsed, acknowledged: Object.values(saved).every(item => item.read
                && item.newChapters.length === 0 && item.seenIds.includes('fresh')),
            unreadRows: document.querySelectorAll('#ufeed .urow.unread').length,
            badge: document.querySelector('#count-updates').textContent,
        }
    })
    console.log(`Mark 60 series read (200 old chapters each): ${result.elapsed.toFixed(1)}ms, ${result.writes} ledger writes`)
    expect(result.writes).toBe(1)
    expect(result.acknowledged).toBe(true)
    expect(result.unreadRows).toBe(0)
    expect(result.badge).toBe('')
})
