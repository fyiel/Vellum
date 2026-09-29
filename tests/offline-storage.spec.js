import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`
const chapter = { n: 1, title: 'Saved chapter', html: '<p>This chapter stays available offline.</p>' }

test('requests persistent storage once and preserves downloads through time, cache cleanup and reload', async ({ page, context }) => {
    await page.addInitScript(() => {
        window.persistCalls = 0
        Object.defineProperty(navigator.storage, 'persisted', { value: async () => false })
        Object.defineProperty(navigator.storage, 'persist', { value: async () => { window.persistCalls++; return true } })
    })
    await page.goto(app)
    await page.evaluate(async content => {
        const dl = await import('/src/lib/downloads.js')
        await dl.dlWrite(dl.dlPath.novelChapter('kept', 1), JSON.stringify(content))
        dl.dlRegister({ kind: 'novel', key: 'kept', id: '1', title: 'Saved Book', at: 1 })
        await dl.dlWrite('test.txt', 'second write')
        const now = Date.now()
        Date.now = () => now + 10 * 365 * 86400_000
        await new Promise(resolve => { const r = indexedDB.deleteDatabase('vellum'); r.onsuccess = resolve; r.onblocked = resolve })
    }, chapter)
    await expect(page.locator('#dl-storage')).toContainText('Persistent storage enabled')
    expect(await page.evaluate(() => window.persistCalls)).toBe(1)
    await page.reload()
    await expect(page.locator('#dltable')).toContainText('Saved Book')
    const stored = await page.evaluate(async () => {
        const { dlRead, dlPath } = await import('/src/lib/downloads.js')
        return JSON.parse(await (await dlRead(dlPath.novelChapter('kept', 1))).text())
    })
    expect(stored).toEqual(chapter)
    // Warm the lazy reader module before disconnecting the development server.
    await page.evaluate(() => import('/src/screens/reader.js'))
    await context.setOffline(true)
    await page.evaluate(() => { location.hash = '#/read/kept/1' })
    await expect(page.locator('#reader-prose')).toContainText('This chapter stays available offline.')
})

test('a denied persistence grant does not block downloads or claim they are protected', async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(navigator.storage, 'persisted', { value: async () => false })
        Object.defineProperty(navigator.storage, 'persist', { value: async () => false })
    })
    await page.goto(app)
    await page.evaluate(async () => {
        const dl = await import('/src/lib/downloads.js')
        await dl.dlWrite('test-denied.txt', 'saved')
        dl.dlRegister({ kind: 'novel', key: 'denied', id: '1', title: 'Still saved' })
    })
    await expect(page.locator('#dltable')).toContainText('Still saved')
    await expect(page.locator('#dl-storage')).toContainText('Home Screen')
    await expect(page.locator('#dl-storage')).not.toContainText('Persistent storage enabled')
})

test('a failed background chapter repair retains the saved chapter and illustrations', async ({ page }) => {
    await page.route('**/read/api/chapter?**', route => route.fulfill({ status: 503, json: { error: 'source unavailable' } }))
    await page.goto(app)
    const kept = await page.evaluate(async content => {
        const dl = await import('/src/lib/downloads.js')
        const { downloadNovelChapter } = await import('/src/lib/dl-novel.js')
        await dl.dlWrite(dl.dlPath.novelChapter('repair', 1), JSON.stringify(content))
        await dl.dlWrite(dl.dlPath.novelImage('repair', 1, 0), 'saved illustration')
        dl.dlRegister({ kind: 'novel', key: 'repair', id: '1', title: 'Repair test' })
        try { await downloadNovelChapter('repair', 1, 'Repair test', { force: true }) } catch {}
        return {
            chapter: await (await dl.dlRead(dl.dlPath.novelChapter('repair', 1)))?.text(),
            image: await (await dl.dlRead(dl.dlPath.novelImage('repair', 1, 0)))?.text(),
        }
    }, chapter)
    expect(JSON.parse(kept.chapter)).toEqual(chapter)
    expect(kept.image).toBe('saved illustration')
})
