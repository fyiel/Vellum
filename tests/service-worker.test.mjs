import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../src/service-worker.js', import.meta.url), 'utf8')
    .replace('__STAMP__', '"test"').replace('__SHELL__', '["index.html", "assets/reader.js", "manifest.webmanifest"]')
function worker(fetchImpl = async () => new Response('network')) {
    const handlers = {}, deleted = [], writes = []
    const offline = new Response('offline shell')
    runInNewContext(source, {
        URL, fetch: fetchImpl,
        self: { registration: { scope: 'https://test/Vellum/' }, location: { origin: 'https://test' },
            addEventListener: (name, handler) => { handlers[name] = handler }, skipWaiting() {}, clients: { claim() {} } },
        caches: { open: async () => ({ addAll: async files => writes.push(...files) }),
            keys: async () => ['vellum-old', 'vellum-test', 'unrelated-cache'], delete: async key => deleted.push(key),
            match: async (key, options) => key === '/Vellum/' ? offline.clone()
                : key?.url?.endsWith('/assets/reader.js') && options?.ignoreVary ? new Response('cached reader') : undefined },
    })
    return { handlers, deleted, writes }
}

test('the offline shell never intercepts live search or media responses', () => {
    const { handlers } = worker()
    for (const url of ['https://test/read/api/search?progressive=1', 'https://test/Vellum/media.mp4', 'https://pumg.fyi/read/api/search']) {
        let intercepted = false
        handlers.fetch({ request: { url, method: 'GET' }, respondWith() { intercepted = true } })
        assert.equal(intercepted, false, url)
    }
})

test('a cached reader module remains usable offline when the server varies on Origin', async () => {
    const { handlers } = worker(async () => { throw Error('offline') })
    let response
    handlers.fetch({ request: new Request('https://test/Vellum/assets/reader.js', { headers: { Origin: 'https://test' } }), respondWith: p => { response = p } })
    assert.equal(await (await response).text(), 'cached reader')
})

test('offline or failed navigation uses the installed shell; an update only removes old shell caches', async () => {
    for (const fetchImpl of [async () => { throw Error('offline') }, async () => new Response('server error', { status: 503 })]) {
        const { handlers, deleted, writes } = worker(fetchImpl)
        let work
        handlers.install({ waitUntil: p => { work = p } }); await work
        assert(writes.includes('/Vellum/assets/reader.js'))
        assert(writes.includes('/Vellum/manifest.webmanifest'))
        handlers.activate({ waitUntil: p => { work = p } }); await work
        assert.deepEqual(deleted, ['vellum-old'])
        handlers.fetch({ request: { url: 'https://test/Vellum/', method: 'GET', mode: 'navigate' }, respondWith: p => { work = p } })
        assert.equal(await (await work).text(), 'offline shell')
    }
})
