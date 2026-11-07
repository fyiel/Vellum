import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version

test('an aborted IndexedDB cache read does not deliver a stale response', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async version => {
        const { cached } = await import('/src/lib/cache.js')
        const key = 'cancelled-disk-read'
        const request = indexedDB.open('vellum', 2)
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains('cache')) {
                request.result.createObjectStore('cache').createIndex('at', 'at')
            }
        }
        const db = await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        await new Promise((resolve, reject) => {
            const tx = db.transaction('cache', 'readwrite')
            tx.objectStore('cache').put({ v: 'old result', exp: Date.now() + 60_000, at: Date.now() }, `${version}|${key}`)
            tx.oncomplete = resolve
            tx.onerror = () => reject(tx.error)
        })
        db.close()

        const ctrl = new AbortController()
        let loads = 0
        const pending = cached(key, 60_000, async () => { loads++; return 'new result' }, { signal: ctrl.signal })
        ctrl.abort() // while cached() is waiting on IndexedDB
        const outcome = await pending.then(value => ({ value }), error => ({ name: error.name }))
        return { ...outcome, loads }
    }, version)

    expect(result).toEqual({ name: 'AbortError', loads: 0 })
})

test('aborting before a cache miss is checked avoids a needless provider request', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { cached } = await import('/src/lib/cache.js')
        const ctrl = new AbortController()
        let loads = 0
        const pending = cached(`aborted-miss-${crypto.randomUUID()}`, 60_000, async () => {
            loads++
            return 'too late'
        }, { signal: ctrl.signal })
        ctrl.abort()
        const outcome = await pending.then(value => ({ value }), error => ({ name: error.name }))
        await new Promise(resolve => setTimeout(resolve, 0))
        return { ...outcome, loads }
    })

    expect(result).toEqual({ name: 'AbortError', loads: 0 })
})
