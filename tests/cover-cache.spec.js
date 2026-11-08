import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

test('reuses an unchanged cover registry and observes updates from another tab', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { storeCover } = await import('/src/lib/cover-cache.js')
        const { setTransport } = await import('/src/lib/http.js')
        const first = 'https://covers.example/1.jpg'
        const second = 'https://covers.example/2.jpg'
        const entries = Object.fromEntries(Array.from({ length: 240 }, (_, i) =>
            [`https://covers.example/${i}.jpg`, `covers/${i}.jpg`]))
        const raw = JSON.stringify(entries)
        localStorage.setItem('vellum:covers', raw)
        let requests = 0
        setTransport(() => { requests++; return Promise.reject(new Error('fixture miss')) })

        const parse = JSON.parse
        let parses = 0
        JSON.parse = function (text, ...args) {
            if (text === raw || text === replacement) parses++
            return parse.call(this, text, ...args)
        }
        let replacement = ''
        try {
            const timesMs = []
            for (let run = 0; run < 3; run++) {
                const start = performance.now()
                for (let i = 0; i < 10_000; i++) storeCover(first, 'First')
                timesMs.push(performance.now() - start)
            }
            const parsesBefore = parses
            replacement = JSON.stringify({ [second]: 'covers/second.jpg' })
            localStorage.setItem('vellum:covers', replacement)
            storeCover(second, 'Second')
            const parsesAfter = parses
            storeCover(first, 'First')
            return { parsesBefore, parsesAfter, requests, timesMs }
        } finally { JSON.parse = parse }
    })
    console.log('Cover registry 240 entries, 3 × 10k cached lookups (ms):', result.timesMs.map(n => n.toFixed(1)))
    expect(result.parsesBefore).toBe(1)
    expect(result.parsesAfter).toBe(2)
    expect(result.requests).toBe(1)
})

for (const kind of ['missing', 'empty']) {
    test(`re-downloads a ${kind} offline cover after finding its stale registry entry`, async ({ page }) => {
        await page.goto(app)
        const initial = await page.evaluate(async kind => {
            const { storeCover, localCover } = await import('/src/lib/cover-cache.js')
            const { dlPath, dlRemove, dlWrite } = await import('/src/lib/downloads.js')
            const { setTransport } = await import('/src/lib/http.js')
            const url = `https://covers.example/${kind}.jpg`
            const path = dlPath.cover(`${kind}.png`)
            if (kind === 'empty') await dlWrite(path, new Blob([]))
            else await dlRemove(path)
            localStorage.setItem('vellum:covers', JSON.stringify({ [url]: path }))

            const copy = await localCover(url)
            const registered = JSON.parse(localStorage.getItem('vellum:covers'))[url] ?? null
            window.coverFetches = 0
            setTransport(async () => {
                window.coverFetches++
                return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="4"/>', {
                    headers: { 'content-type': 'image/svg+xml' },
                })
            })
            storeCover(url, 'Recovered cover')
            return { url, size: copy?.size ?? null, registered }
        }, kind)

        expect(initial).toMatchObject({ size: null, registered: null })
        await expect.poll(() => page.evaluate(async url => {
            const { localCover } = await import('/src/lib/cover-cache.js')
            return (await localCover(url))?.text() || null
        }, initial.url)).toContain('<svg')
        expect(await page.evaluate(() => window.coverFetches)).toBe(1)
    })
}

test('temporary offline cover read failures preserve its cached registry entry', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { localCover } = await import('/src/lib/cover-cache.js')
        const { dlPath, dlRead, dlWrite } = await import('/src/lib/downloads.js')
        const url = 'https://covers.example/temporarily-unreadable.jpg'
        const path = dlPath.cover('temporarily-unreadable.svg')
        await dlWrite(path, new Blob(['saved cover'], { type: 'image/svg+xml' }))
        localStorage.setItem('vellum:covers', JSON.stringify({ [url]: path }))

        const getFile = FileSystemFileHandle.prototype.getFile
        FileSystemFileHandle.prototype.getFile = async function (...args) {
            if (this.name === 'temporarily-unreadable.svg') throw new DOMException('In use', 'NotReadableError')
            return getFile.apply(this, args)
        }
        let offline
        try { offline = await localCover(url) }
        finally { FileSystemFileHandle.prototype.getFile = getFile }
        return {
            offline: offline === null,
            registered: JSON.parse(localStorage.getItem('vellum:covers'))[url] === path,
            recovered: await (await localCover(url))?.text(),
            bytes: await (await dlRead(path))?.text(),
        }
    })
    expect(result).toEqual({ offline: true, registered: true, recovered: 'saved cover', bytes: 'saved cover' })
})

test('cover filesystem lookup errors preserve its cached registry entry', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { localCover } = await import('/src/lib/cover-cache.js')
        const { dlPath, dlWrite } = await import('/src/lib/downloads.js')
        const url = 'https://covers.example/temporarily-inaccessible.jpg'
        const path = dlPath.cover('temporarily-inaccessible.svg')
        await dlWrite(path, new Blob(['saved inaccessible cover'], { type: 'image/svg+xml' }))
        localStorage.setItem('vellum:covers', JSON.stringify({ [url]: path }))

        const getFileHandle = FileSystemDirectoryHandle.prototype.getFileHandle
        FileSystemDirectoryHandle.prototype.getFileHandle = async function (name, options) {
            if (name === 'temporarily-inaccessible.svg') throw new DOMException('Unavailable', 'NotAllowedError')
            return getFileHandle.call(this, name, options)
        }
        let offline
        try { offline = await localCover(url) }
        finally { FileSystemDirectoryHandle.prototype.getFileHandle = getFileHandle }
        return {
            offline: offline === null,
            registered: JSON.parse(localStorage.getItem('vellum:covers'))[url] === path,
            recovered: await (await localCover(url))?.text(),
        }
    })
    expect(result).toEqual({ offline: true, registered: true, recovered: 'saved inaccessible cover' })
})

test('different cover URLs with the same legacy hash keep their own offline artwork', async ({ page }) => {
    await page.goto(app)
    const first = 'https://covers.example/Ab.jpg'
    const second = 'https://covers.example/BA.jpg'

    await page.evaluate(async first => {
        const { storeCover } = await import('/src/lib/cover-cache.js')
        const { setTransport } = await import('/src/lib/http.js')
        localStorage.setItem('vellum:covers', '{}')
        setTransport(async source => {
            const title = new URL(source, location.href).searchParams.get('t')
            return new Response(`<svg xmlns="http://www.w3.org/2000/svg"><title>${title}</title></svg>`, {
                headers: { 'content-type': 'image/svg+xml' },
            })
        })
        storeCover(first, 'First')
    }, first)

    const read = url => page.evaluate(async url => {
        const { localCover } = await import('/src/lib/cover-cache.js')
        return (await localCover(url))?.text() || null
    }, url)
    await expect.poll(() => read(first)).toContain('<title>First</title>')
    await page.evaluate(async second => {
        const { storeCover } = await import('/src/lib/cover-cache.js')
        storeCover(second, 'Second')
    }, second)
    await expect.poll(() => read(second)).toContain('<title>Second</title>')

    expect(await read(first)).toContain('<title>First</title>')
    const registry = await page.evaluate(() => JSON.parse(localStorage.getItem('vellum:covers')))
    expect(registry[first]).not.toBe(registry[second])
})

test('a new colliding cover cannot overwrite a previously saved legacy filename', async ({ page }) => {
    await page.goto(app)
    const result = await page.evaluate(async () => {
        const { storeCover, localCover } = await import('/src/lib/cover-cache.js')
        const { dlPath, dlWrite } = await import('/src/lib/downloads.js')
        const { setTransport } = await import('/src/lib/http.js')
        const oldUrl = 'https://covers.example/Ab.jpg'
        const newUrl = 'https://covers.example/BA.jpg'
        const oldPath = dlPath.cover('zvijml.svg') // the URL's original DJB2 filename
        await dlWrite(oldPath, new Blob(['<svg>Existing offline art</svg>'], { type: 'image/svg+xml' }))
        localStorage.setItem('vellum:covers', JSON.stringify({ [oldUrl]: oldPath }))
        setTransport(async () => new Response('<svg>New offline art</svg>', {
            headers: { 'content-type': 'image/svg+xml' },
        }))
        storeCover(newUrl, 'New')
        for (let i = 0; i < 100 && !JSON.parse(localStorage.getItem('vellum:covers'))[newUrl]; i++) {
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        return {
            oldArt: await (await localCover(oldUrl))?.text(),
            newArt: await (await localCover(newUrl))?.text(),
            paths: JSON.parse(localStorage.getItem('vellum:covers')),
            oldPath,
        }
    })
    expect(result.oldArt).toBe('<svg>Existing offline art</svg>')
    expect(result.newArt).toBe('<svg>New offline art</svg>')
    expect(result.paths['https://covers.example/Ab.jpg']).toBe(result.oldPath)
    expect(result.paths['https://covers.example/BA.jpg']).not.toBe(result.oldPath)
})
