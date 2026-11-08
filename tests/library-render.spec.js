import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

for (const hasUpdate of [false, true]) {
    test(`Library ${hasUpdate ? 'updates one alert' : 'checks unchanged alerts'} without replacing focused rows`, async ({ page }) => {
        await page.goto(app)
        await page.evaluate(async hasUpdate => {
            const { setTransport } = await import('/src/lib/http.js')
            const { showLibrary } = await import('/src/screens/library.js')
            const entries = Array.from({ length: 60 }, (_, i) => ({
                slug: `nf:library-render-${i}`, key: `nf:library-render-${i}`,
                kind: 'novel', title: `Library title ${i}`, total: 1,
                updatedAt: Date.now() - i * 1000,
            }))
            localStorage.setItem('vellum:lib', JSON.stringify(entries))

            let release
            const gate = new Promise(resolve => { release = resolve })
            let requests = 0
            setTransport(async url => {
                const target = new URL(url, location.href)
                if (target.pathname !== '/read/api/chapters') throw Error(`Unexpected request ${target}`)
                requests++
                await gate
                const first = target.searchParams.get('slug') === entries[0].slug
                return Response.json({ chapters: first && hasUpdate ? [{ n: 1 }, { n: 2 }] : [{ n: 1 }] })
            })

            const badge = document.querySelector('#count-updates')
            const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')
            let badgeWrites = 0
            Object.defineProperty(badge, 'textContent', {
                configurable: true,
                get() { return descriptor.get.call(this) },
                set(value) { descriptor.set.call(this, value); badgeWrites++ },
            })

            showLibrary()
            const firstRow = document.querySelector('#libtable .trow')
            firstRow.focus()
            let removedRows = 0
            new MutationObserver(records => {
                for (const record of records) {
                    removedRows += [...record.removedNodes].filter(node => node.matches?.('.trow')).length
                }
            }).observe(document.querySelector('#libtable'), { childList: true })
            window.libraryCheck = {
                release, firstRow,
                requests: () => requests,
                badgeWrites: () => badgeWrites,
                removedRows: () => removedRows,
            }
        }, hasUpdate)

        await expect(page.locator('#libtable .trow')).toHaveCount(60)
        await expect(page.locator('#libtable .trow').first()).toBeFocused()
        await expect.poll(() => page.evaluate(() => window.libraryCheck.requests())).toBeGreaterThan(0)
        await page.evaluate(() => window.libraryCheck.release())
        await expect.poll(() => page.evaluate(() => window.libraryCheck.badgeWrites())).toBe(1)

        const result = await page.evaluate(() => ({
            preservedRow: window.libraryCheck.firstRow === document.querySelector('#libtable .trow'),
            preservedFocus: document.activeElement === window.libraryCheck.firstRow,
            removedRows: window.libraryCheck.removedRows(),
        }))
        expect(result).toEqual({ preservedRow: true, preservedFocus: true, removedRows: 0 })
        await expect(page.locator('#count-updates')).toHaveText(hasUpdate ? '1' : '')
        if (hasUpdate) await expect(page.locator('#libtable .trow').first().locator('.upd')).toContainText('+1')
        else await expect(page.locator('#libtable .trow').first().locator('.upd')).not.toContainText('+1')
        expect(await page.evaluate(() => window.libraryCheck.requests())).toBe(60)
    })
}
