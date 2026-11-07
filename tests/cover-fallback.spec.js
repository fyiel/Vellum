import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

test('a corrupt offline cover releases its object URL when decoding fails', async ({ page }) => {
    await page.goto(app)
    await page.evaluate(async () => {
        const { dlWrite, dlPath } = await import('/src/lib/downloads.js')
        const source = 'https://covers.example.invalid/broken.png'
        const path = dlPath.cover('broken.png')
        await dlWrite(path, new Blob(['this is not a picture'], { type: 'image/png' }))
        localStorage.setItem('vellum:covers', JSON.stringify({ [source]: path }))
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })

        const created = [], revoked = []
        window.coverProbe = { created, revoked, errors: 0 }
        const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
        URL.createObjectURL = blob => { const url = create(blob); created.push(url); return url }
        URL.revokeObjectURL = url => { revoked.push(url); revoke(url) }
        const img = document.createElement('img')
        img.dataset.cover = source
        img.dataset.hideError = ''
        img.addEventListener('error', () => { window.coverProbe.errors++ })
        img.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
        document.body.append(img)
        window.dispatchEvent(new Event('offline'))
    })
    await page.waitForFunction(() => window.coverProbe.created.length === 1 && window.coverProbe.errors > 0)
    const probe = await page.evaluate(() => window.coverProbe)
    expect(probe.revoked).toContain(probe.created[0])
})

test('removing an offline cover before it finishes loading releases its object URL', async ({ page }) => {
    await page.goto(app)
    await page.evaluate(async () => {
        const { dlWrite, dlPath } = await import('/src/lib/downloads.js')
        const source = 'https://covers.example.invalid/removed.png'
        const path = dlPath.cover('removed.png')
        const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8t8AAAAASUVORK5CYII='), c => c.charCodeAt(0))
        await dlWrite(path, new Blob([png], { type: 'image/png' }))
        localStorage.setItem('vellum:covers', JSON.stringify({ [source]: path }))
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })

        const created = [], revoked = []
        const img = document.createElement('img')
        window.removedCoverProbe = { created, revoked, img }
        const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
        URL.createObjectURL = blob => {
            const url = create(blob)
            created.push(url)
            queueMicrotask(() => img.remove())
            return url
        }
        URL.revokeObjectURL = url => { revoked.push(url); revoke(url) }
        img.dataset.cover = source
        img.dataset.hideError = ''
        img.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
        document.body.append(img)
        window.dispatchEvent(new Event('offline'))
    })
    await page.waitForFunction(() => window.removedCoverProbe.created.length === 1 && !window.removedCoverProbe.img.isConnected)
    const probe = await page.evaluate(() => ({ created: window.removedCoverProbe.created, revoked: window.removedCoverProbe.revoked }))
    expect(probe.revoked).toContain(probe.created[0])
})
