import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

test('cover registry quota failure keeps previously downloaded covers intact', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { storeCover, localCover } = await import('/src/lib/cover-cache.js')
        const { dlWrite, dlPath } = await import('/src/lib/downloads.js')
        const { setTransport } = await import('/src/lib/http.js')
        const originalUrl = 'https://covers.example/first.jpg'
        const originalPath = dlPath.cover('first.png')
        await dlWrite(originalPath, new Blob(['existing cover'], { type: 'image/png' }))

        const registry = { [originalUrl]: originalPath }
        for (let i = 1; i < 240; i++) registry[`https://covers.example/other-${i}.jpg`] = `covers/missing-${i}.jpg`
        localStorage.setItem('vellum:covers', JSON.stringify(registry))

        const setItem = Storage.prototype.setItem
        let attempts = 0
        Storage.prototype.setItem = function (key, value) {
            if (key === 'vellum:covers') {
                attempts++
                throw new DOMException('storage quota exceeded', 'QuotaExceededError')
            }
            return setItem.call(this, key, value)
        }
        try {
            setTransport(async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
                headers: { 'content-type': 'image/svg+xml' },
            }))
            storeCover('https://covers.example/new.jpg', 'New book')
            for (let i = 0; i < 100 && !attempts; i++) await new Promise(resolve => setTimeout(resolve, 10))
            await new Promise(resolve => setTimeout(resolve, 50)) // let any asynchronous removal finish

            const original = await localCover(originalUrl)
            const root = await navigator.storage.getDirectory()
            const dir = await (await root.getDirectoryHandle('downloads')).getDirectoryHandle('covers')
            let files = 0
            for await (const _ of dir.values()) files++
            return {
                attempts,
                registered: JSON.parse(localStorage.getItem('vellum:covers'))[originalUrl] === originalPath,
                original: original ? await original.text() : null,
                files,
            }
        } finally { Storage.prototype.setItem = setItem }
    })

    expect(result).toEqual({ attempts: 1, registered: true, original: 'existing cover', files: 1 })
})
