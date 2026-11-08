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

        if (hasUpdate) {
            const refreshed = await page.evaluate(async () => {
                const { showLibrary } = await import('/src/screens/library.js')
                const oldRow = document.querySelector('#libtable .trow')
                showLibrary()
                return {
                    reused: document.querySelector('#libtable .trow') === oldRow,
                    alert: oldRow.querySelector('.upd').textContent,
                }
            })
            expect(refreshed).toEqual({ reused: true, alert: '+1' })
        }
    })
}

test('following a 61st title does not silently discard an older library entry', async ({ page }) => {
    await page.route('**/read/api/chapters**', route => route.fulfill({ json: { chapters: [{ n: 1 }] } }))
    await page.goto(app)
    await page.evaluate(async () => {
        const { touchLibrary } = await import('/src/lib/store.js')
        for (let i = 0; i < 61; i++) {
            touchLibrary({ slug: `nf:shelf-${i}`, kind: 'novel', title: `Shelf title ${i}`, total: 1 })
        }
        // Updating an existing title should not evict another followed series, either.
        touchLibrary({ slug: 'nf:shelf-40', lastN: 1, readCount: 1 })
    })
    await page.reload()
    await expect(page.locator('#libtable .trow')).toHaveCount(61)
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('vellum:lib')))
    expect(saved).toHaveLength(61)
    expect(saved.find(entry => entry.slug === 'nf:shelf-0')).toMatchObject({ title: 'Shelf title 0', total: 1 })
    expect(saved.find(entry => entry.slug === 'nf:shelf-40')).toMatchObject({ lastN: 1, readCount: 1 })
})

test('reopening a large Library retains unchanged rows and refreshes modified titles', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { showLibrary } = await import('/src/screens/library.js')
        const { setTransport } = await import('/src/lib/http.js')
        setTransport(() => Promise.resolve(Response.json({ chapters: [{ n: 1 }] })))
        const entries = Array.from({ length: 750 }, (_, i) => ({
            slug: `nf:large-shelf-${i}`, key: `nf:large-shelf-${i}`,
            kind: 'novel', title: `Large shelf title ${i}`, total: 1,
            author: `Author ${i}`, updatedAt: 1000000 - i,
        }))
        localStorage.setItem('vellum:lib', JSON.stringify(entries))
        showLibrary()

        const table = document.querySelector('#libtable')
        const firstRow = table.querySelector('.trow')
        const secondRow = table.querySelectorAll('.trow')[1]
        firstRow.focus()
        const before = performance.now()
        showLibrary()
        const elapsedMs = performance.now() - before
        const unchanged = firstRow === table.querySelector('.trow')
        const focused = document.activeElement === firstRow

        entries[1] = { ...entries[1], author: 'Revised author', readCount: 1, lastN: 1 }
        secondRow.focus()
        localStorage.setItem('vellum:lib', JSON.stringify(entries))
        showLibrary()
        return {
            unchanged, focused, elapsedMs,
            otherRowUpdated: table.querySelectorAll('.trow')[1].textContent.includes('Revised author'),
            otherRowReplaced: secondRow !== table.querySelectorAll('.trow')[1],
            changedRowFocusPreserved: document.activeElement === table.querySelectorAll('.trow')[1],
            firstStillPreserved: firstRow === table.querySelector('.trow'),
            count: table.querySelectorAll('.trow').length,
        }
    })
    console.log('Library 750 unchanged row refresh (ms):', result.elapsedMs.toFixed(1))
    expect(result).toMatchObject({
        unchanged: true, focused: true, otherRowUpdated: true,
        otherRowReplaced: true, changedRowFocusPreserved: true, firstStillPreserved: true, count: 750,
    })
})

test('resorting the Library preserves focus on an unchanged title', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { showLibrary } = await import('/src/screens/library.js')
        const { setTransport } = await import('/src/lib/http.js')
        setTransport(() => Promise.resolve(Response.json({ chapters: [{ n: 1 }] })))
        const entries = ['Alpha', 'Beta', 'Gamma'].map((title, i) => ({
            slug: `nf:${title.toLowerCase()}`, kind: 'novel', title, total: 1,
            updatedAt: Date.now() - i * 1000,
        }))
        localStorage.setItem('vellum:lib', JSON.stringify(entries))
        showLibrary()
        const table = document.querySelector('#libtable')
        const beta = table.querySelectorAll('.trow')[1]
        beta.focus()

        // Alpha becomes older; Beta's own contents are unchanged.
        entries[0].updatedAt = entries[2].updatedAt - 1000
        localStorage.setItem('vellum:lib', JSON.stringify(entries))
        showLibrary()
        return {
            firstSlug: table.querySelector('.trow')?.dataset.slug,
            betaReused: table.querySelector('.trow') === beta,
            focused: document.activeElement === beta,
            order: [...table.children].map(row => row.dataset.slug),
        }
    })
    expect(result).toEqual({
        firstSlug: 'nf:beta', betaReused: true, focused: true,
        order: ['nf:beta', 'nf:gamma', 'nf:alpha'],
    })
})

test('revisiting the Library retains unchanged Continue tiles and their focus', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { showLibrary } = await import('/src/screens/library.js')
        const { setTransport } = await import('/src/lib/http.js')
        setTransport(() => Promise.resolve(Response.json({ chapters: [{ n: 1 }] })))
        const entries = Array.from({ length: 4 }, (_, i) => ({
            slug: `nf:continue-${i}`, kind: 'novel', title: `Continue title ${i}`,
            readCount: 1, lastN: 2, total: 10, updatedAt: 1000 - i,
        }))
        localStorage.setItem('vellum:lib', JSON.stringify(entries))
        showLibrary()
        const cont = document.querySelector('#continue')
        const tile = cont.querySelector('.ctile')
        tile.focus()
        let removed = 0
        const observer = new MutationObserver(records => {
            for (const record of records) removed += [...record.removedNodes].filter(node => node.matches?.('.ctile')).length
        })
        observer.observe(cont, { childList: true })
        showLibrary()
        await Promise.resolve()
        observer.disconnect()
        const unchanged = {
            sameTile: tile === cont.querySelector('.ctile'),
            focused: document.activeElement === tile,
            removed,
            count: cont.querySelectorAll('.ctile').length,
        }
        entries[0].lastN = 4
        localStorage.setItem('vellum:lib', JSON.stringify(entries))
        showLibrary()
        return {
            ...unchanged,
            updated: cont.querySelector('.ctile').textContent.includes('Ch. 4'),
            changedTileFocused: document.activeElement === cont.querySelector('.ctile'),
        }
    })
    expect(result).toEqual({
        sameTile: true, focused: true, removed: 0, count: 4,
        updated: true, changedTileFocused: true,
    })
})

test('following and removing titles in another tab updates an open Library', async ({ page }) => {
    await page.goto(app)
    await page.evaluate(async () => {
        const { touchLibrary } = await import('/src/lib/store.js')
        const { showLibrary } = await import('/src/screens/library.js')
        touchLibrary({ slug: 'nf:tab-first', kind: 'novel', title: 'First title', total: 10 })
        showLibrary()
    })
    await expect(page.locator('#libtable .trow')).toHaveCount(1)

    const otherTab = await page.context().newPage()
    try {
        await otherTab.goto(app)
        await page.bringToFront()
        await page.evaluate(() => {
            window.originalLibraryRow = document.querySelector('#libtable .trow')
            window.originalLibraryRow.focus()
        })

        await otherTab.evaluate(async () => {
            const { touchLibrary } = await import('/src/lib/store.js')
            touchLibrary({ slug: 'nf:tab-second', kind: 'novel', title: 'Second title', total: 10 })
        })
        await expect(page.locator('#libtable .trow')).toHaveCount(2)
        expect(await page.evaluate(() => ({
            retained: [...document.querySelectorAll('#libtable .trow')].includes(window.originalLibraryRow),
            focused: document.activeElement === window.originalLibraryRow,
        }))).toEqual({ retained: true, focused: true })

        await otherTab.evaluate(async () => {
            const { dropLibrary } = await import('/src/lib/store.js')
            dropLibrary('nf:tab-second')
        })
        await expect(page.locator('#libtable .trow')).toHaveCount(1)
        await otherTab.evaluate(() => localStorage.clear())
        await expect(page.locator('#libtable .library-empty')).toBeVisible()
    } finally {
        await otherTab.close()
    }
})

test('saved downloads stay synchronized across tabs while preserving focused rows', async ({ page }) => {
    await page.goto(app)
    await page.evaluate(async () => {
        const { dlRegister } = await import('/src/lib/downloads.js')
        const { showLibrary } = await import('/src/screens/library.js')
        dlRegister({ kind: 'novel', key: 'tab-a', id: '1', title: 'Already saved', size: 1000 })
        showLibrary()
    })
    await expect(page.locator('#dltable .dlrow')).toHaveCount(1)

    const otherTab = await page.context().newPage()
    try {
        await otherTab.goto(app)
        await page.bringToFront()
        await page.evaluate(() => {
            window.originalSavedRow = document.querySelector('#dltable .dlrow')
            window.originalSavedButton = window.originalSavedRow.querySelector('.dldel')
            window.originalSavedButton.focus()
        })

        await otherTab.evaluate(async () => {
            const { dlRegister } = await import('/src/lib/downloads.js')
            dlRegister({ kind: 'novel', key: 'tab-b', id: '2', title: 'Saved elsewhere', size: 2000 })
        })
        await expect(page.locator('#dltable .dlrow')).toHaveCount(2)
        expect(await page.evaluate(() => ({
            preserved: document.querySelector('[data-key="tab-a"]') === window.originalSavedRow,
            focused: document.activeElement === window.originalSavedButton,
            newRow: document.querySelector('#dltable .dlrow')?.dataset.key,
        }))).toEqual({ preserved: true, focused: true, newRow: 'tab-b' })

        await otherTab.evaluate(async () => {
            const { dlUnregister } = await import('/src/lib/downloads.js')
            await dlUnregister('novel', 'tab-b', '2')
        })
        await expect(page.locator('#dltable .dlrow')).toHaveCount(1)
        await expect(page.locator('#dltable .dlrow')).toHaveAttribute('data-key', 'tab-a')

        await otherTab.evaluate(() => localStorage.clear())
        await expect(page.locator('#dltable .dlrow')).toHaveCount(0)
        await expect(page.locator('#dl-lab')).toBeHidden()
    } finally {
        await otherTab.close()
    }
})
