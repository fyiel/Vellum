import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

test('acknowledged manga and video IDs are not stored twice', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { touchLibrary, loadUpdLedger, saveUpdLedger } = await import('/src/lib/store.js')
        const { setRead, markAll } = await import('/src/lib/updates.js')
        const ids = Array.from({ length: 500 }, (_, i) => `chapter-${i}`)
        const manga = 'mf:followed-manga', video = 'mock:followed-drama'
        touchLibrary({ slug: manga, key: manga, kind: 'manga', title: 'Manga', chapterIds: ids })
        touchLibrary({ slug: video, key: video, kind: 'drama', title: 'Drama', episodeIds: ids })
        const initial = loadUpdLedger()
        const initialBytes = localStorage.getItem('vellum:updates').length
        const initialIds = [initial[manga].latestIds, initial[video].latestIds].map(value => value?.length)

        const next = [...ids, 'new-chapter']
        initial[manga] = { ...initial[manga], read: false, latestIds: next,
            newChapters: [{ id: 'new-chapter', label: 'Ch. 501' }] }
        initial[video] = { ...initial[video], read: false, latestIds: next,
            newEpisodes: [{ id: 'new-chapter', label: 'Episode 501' }] }
        saveUpdLedger(initial)
        setRead(manga, true, next.length, next)
        markAll([{ slug: video, kind: 'drama', latestIds: next }])
        const saved = loadUpdLedger()
        return {
            initialBytes,
            initial: initialIds,
            acknowledged: [saved[manga], saved[video]].map(entry => ({
                read: entry.read, seen: entry.seenIds.length, last: entry.seenIds.at(-1),
                latestIds: entry.latestIds,
            })),
            acknowledgedBytes: localStorage.getItem('vellum:updates').length,
        }
    })
    expect(result.initial).toEqual([undefined, undefined])
    expect(result.acknowledged).toEqual(Array(2).fill({
        read: true, seen: 501, last: 'new-chapter', latestIds: undefined,
    }))
    expect(result.acknowledgedBytes).toBeLessThan(result.initialBytes + 150)
})

test('legacy duplicate update snapshots yield quota headroom for reading progress', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { posSet } = await import('/src/lib/store.js')
        const ids = Array.from({ length: 400 }, (_, i) => `chapter-${i}`)
        const ledger = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [
            `mf:legacy-${i}`, { firstSeen: 10, read: true, seenIds: ids, latestIds: ids, newChapters: [] },
        ]))
        ledger['mf:unread'] = {
            firstSeen: 20, read: false, seenIds: ['old'], latestIds: ['new', 'old'],
            newChapters: [{ id: 'new', label: 'Ch. 2' }],
        }
        localStorage.setItem('vellum:updates', JSON.stringify(ledger))
        localStorage.setItem('vellum:dl', JSON.stringify([{ kind: 'manga', key: 'kept', id: '1' }]))
        const usage = () => Object.keys(localStorage).reduce((n, key) => n + key.length + localStorage.getItem(key).length, 0)
        const before = usage()
        const cap = before + 2
        const original = Storage.prototype.setItem
        let rejected = 0
        Storage.prototype.setItem = function (key, value) {
            const previous = this.getItem(key)
            const next = usage() - (previous === null ? 0 : key.length + previous.length) + key.length + String(value).length
            if (next > cap) {
                rejected++
                throw new DOMException('quota exceeded', 'QuotaExceededError')
            }
            return original.call(this, key, value)
        }
        const position = { id: 'chapter-17', page: 7, at: Date.now() }
        try { posSet('mf:progress', position) }
        finally { Storage.prototype.setItem = original }
        const saved = JSON.parse(localStorage.getItem('vellum:updates'))
        return {
            rejected, before, after: usage(),
            position: JSON.parse(localStorage.getItem('vellum:pos:mf:progress') || 'null'),
            oldIds: saved['mf:legacy-0'].seenIds.length,
            oldLatestIds: saved['mf:legacy-0'].latestIds,
            unread: saved['mf:unread'],
            downloads: JSON.parse(localStorage.getItem('vellum:dl')),
        }
    })
    expect(result.rejected).toBeGreaterThan(0)
    expect(result.position).toMatchObject({ id: 'chapter-17', page: 7 })
    expect(result.oldIds).toBe(400)
    expect(result.oldLatestIds).toBeUndefined()
    expect(result.unread.newChapters).toEqual([{ id: 'new', label: 'Ch. 2' }])
    expect(result.unread.latestIds).toEqual(['new', 'old'])
    expect(result.downloads).toEqual([{ kind: 'manga', key: 'kept', id: '1' }])
    expect(result.after).toBeLessThan(result.before)
    console.log(`Storage pressure: ${result.before} -> ${result.after} characters, ${result.rejected} quota rejections`)
})
