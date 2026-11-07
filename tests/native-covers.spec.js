import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`
const art = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"><rect width="2" height="3" fill="red"/></svg>'

async function nativePage(page) {
    // Boot only the document so this fixture controls the native bridge before modules load.
    await page.route('**/src/main.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }))
    // CI points web API traffic at a closed local port. This native fixture must
    // use the production host named in the unchanged Tauri HTTP capability.
    await page.route('**/src/lib/http.js', async route => {
        const response = await route.fetch()
        const body = (await response.text()).replaceAll('import.meta.env.VITE_API_HOST', JSON.stringify('https://pumg.fyi'))
        await route.fulfill({ response, body })
    })
    await page.addInitScript(() => {
        const files = new Map()
        window.__TAURI_INTERNALS__ = { invoke: async (command, args, options) => {
            if (command === 'plugin:fs|mkdir') return
            if (command === 'plugin:fs|write_file') { files.set(decodeURIComponent(options.headers.path), Array.from(args)); return }
            if (command === 'plugin:fs|read_file') {
                if (!files.has(args.path)) throw new Error('File not found')
                return files.get(args.path)
            }
            if (command === 'plugin:fs|remove') { files.delete(args.path); return }
            throw new Error(`Unexpected native command: ${command}`)
        } }
    })
    await page.goto(app)
}

for (const exactAllowed of [true, false]) {
    test(`native cover cache stays within the existing HTTP scope with exact proxy ${exactAllowed ? 'available' : 'unavailable'}`, async ({ page }) => {
        await nativePage(page)
        const result = await page.evaluate(async ({ art, exactAllowed }) => {
            const { setTransport } = await import('/src/lib/http.js')
            const { storeCover, localCover } = await import('/src/lib/cover-cache.js')
            const requests = []
            setTransport(async value => {
                const url = new URL(value)
                requests.push(url.href)
                if (url.origin !== 'https://pumg.fyi') throw new Error('URL not allowed by permissions')
                if (url.pathname === '/read/api/image') return exactAllowed
                    ? new Response(art, { headers: { 'content-type': 'image/svg+xml' } })
                    : new Response('Host not allowed', { status: 400 })
                if (url.pathname === '/read/api/cover' && url.searchParams.get('proxy') === '1') return new Response(art, { headers: { 'content-type': 'image/svg+xml' } })
                throw new Error('Unexpected request')
            })
            const source = 'https://cdn.example/cover.jpg'
            storeCover(source, 'Fixture title')
            let blob
            for (let i = 0; i < 100 && !blob; i++) {
                await new Promise(resolve => setTimeout(resolve, 10))
                blob = await localCover(source)
            }
            return { requests, stored: blob ? await blob.text() : null }
        }, { art, exactAllowed })
        expect(result.stored).toBe(art)
        expect(result.requests).toHaveLength(exactAllowed ? 1 : 2)
        const first = new URL(result.requests[0])
        expect(first.origin).toBe('https://pumg.fyi')
        expect(first.pathname).toBe('/read/api/image')
        expect(first.searchParams.get('url')).toBe('https://cdn.example/cover.jpg')
        if (!exactAllowed) {
            const fallback = new URL(result.requests[1])
            expect(fallback.origin).toBe('https://pumg.fyi')
            expect(fallback.pathname).toBe('/read/api/cover')
            expect(fallback.searchParams.get('t')).toBe('Fixture title')
            expect(fallback.searchParams.get('proxy')).toBe('1')
        }
    })
}

for (const absolute of [false, true]) {
    test(`native ${absolute ? 'absolute' : 'relative'} cover resolver streams bytes instead of redirecting`, async ({ page }) => {
        await nativePage(page)
        const result = await page.evaluate(async ({ art, absolute }) => {
            const { setTransport } = await import('/src/lib/http.js')
            const { storeCover, localCover } = await import('/src/lib/cover-cache.js')
            const source = `${absolute ? 'https://pumg.fyi' : ''}/read/api/cover?t=Original%20title&v=nu1`
            const requests = []
            setTransport(async value => {
                requests.push(value)
                const url = new URL(value)
                if (url.origin !== 'https://pumg.fyi' || url.searchParams.get('proxy') !== '1') throw new Error('Unproxied or out-of-scope cover')
                return new Response(art, { headers: { 'content-type': 'image/svg+xml' } })
            })
            storeCover(source, '')
            let blob
            for (let i = 0; i < 100 && !blob; i++) {
                await new Promise(resolve => setTimeout(resolve, 10))
                blob = await localCover(source)
            }
            return { requests, stored: blob ? await blob.text() : null }
        }, { art, absolute })
        expect(result.stored).toBe(art)
        expect(result.requests).toHaveLength(1)
        const request = new URL(result.requests[0])
        expect(request.searchParams.get('t')).toBe('Original title')
        expect(request.searchParams.get('v')).toBe('nu1')
        expect(request.searchParams.get('proxy')).toBe('1')
    })
}
