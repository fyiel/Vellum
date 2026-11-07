import test from 'node:test'
import assert from 'node:assert/strict'
import { discover, playback, series } from '../adapter/providers/cineby.mjs'
import { handleAnimeRequest } from '../adapter/anime-adapter.mjs'

const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const req = (path = '/', signal) => new Request(`https://vellum.test${path}`, { signal })
const ctx = (fetchImpl, signal) => ({ fetchImpl, request: req('/', signal) })
const turn = () => new Promise(resolve => setImmediate(resolve))

test('Cineby respects Retry-After across titles without sibling-host retries', async t => {
    let now = 1_000_000
    t.mock.method(Date, 'now', () => now)
    const calls = []
    const fetchImpl = async url => {
        calls.push(String(url))
        if (calls.length === 1) return new Response('', { status: 429, headers: { 'retry-after': '120' } })
        return json({ id: 2, title: 'Recovered' })
    }
    await assert.rejects(series(ctx(fetchImpl), 'cineby:1'))
    await assert.rejects(series(ctx(fetchImpl), 'cineby:2'))
    assert.equal(calls.length, 1)
    now += 120_001
    assert.equal((await series(ctx(fetchImpl), 'cineby:2')).title, 'Recovered')
    assert.equal(calls.length, 2)
    assert.equal(new URL(calls[0]).host, new URL(calls[1]).host)
})

test('Cineby respects Retry-After HTTP dates', async t => {
    let now = 1_000_000
    t.mock.method(Date, 'now', () => now)
    let calls = 0
    const fetchImpl = async () => {
        calls++
        return new Response('', { status: 429, headers: { 'retry-after': new Date(now + 120_000).toUTCString() } })
    }
    await discover(ctx(fetchImpl))
    now += 61_000
    await discover(ctx(fetchImpl), { page: 2 })
    assert.equal(calls, 1)
})

test('cancelling one Cineby waiter does not cancel or poison a shared title load', async () => {
    const firstCtrl = new AbortController()
    let finish, calls = 0
    const fetchImpl = (url, { signal }) => {
        calls++
        return new Promise((resolve, reject) => {
            finish = () => resolve(json({ id: 1, title: 'Healthy' }))
            signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true })
        })
    }
    const first = series(ctx(fetchImpl, firstCtrl.signal), 'cineby:1')
    const rejection = assert.rejects(first, { name: 'AbortError' })
    await turn()
    const second = series(ctx(fetchImpl), 'cineby:1')
    firstCtrl.abort()
    await rejection
    finish()
    assert.equal((await second).title, 'Healthy')
    assert.equal((await series(ctx(fetchImpl), 'cineby:1')).title, 'Healthy')
    assert.equal(calls, 1)
})

test('Cineby has one nine-second retry budget even if transport ignores abort', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
    let calls = 0, done = false
    const fetchImpl = async () => { calls++; return new Promise(() => {}) }
    const result = discover(ctx(fetchImpl)).then(value => { done = true; return value })
    await turn()
    t.mock.timers.tick(9_001)
    await turn()
    assert.equal(done, true)
    assert.equal((await result).partial, true)
    assert.equal(calls, 1)
})

test('all anime backends in cooldown fail fast until expiry', async t => {
    let now = 1_000_000
    t.mock.method(Date, 'now', () => now)
    let upstreamCalls = 0
    const fetchImpl = async (url, init) => {
        if (String(url) === 'https://graphql.anilist.co') {
            const id = JSON.parse(init.body).variables.id
            return json({ data: { Media: { id, title: { english: `Title ${id}` } } } })
        }
        if (String(url).startsWith('https://hianime.at/')) {
            upstreamCalls++
            return new Response('', { status: 503 })
        }
        throw new Error(`Unexpected URL: ${url}`)
    }
    for (const id of [21, 22, 23]) {
        const response = await handleAnimeRequest(req(`/read/api/anime/episodes?key=miruro:${id}`), {}, fetchImpl)
        assert.equal(response.status, 502)
    }
    assert.equal(upstreamCalls, 1)
    now += 20 * 60_000 + 1
    assert.equal((await handleAnimeRequest(req('/read/api/anime/episodes?key=miruro:24'), {}, fetchImpl)).status, 502)
    assert.equal(upstreamCalls, 2)
})

test('Cineby retry backoff draws from the same deadline', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
    let calls = 0, done = false
    const fetchImpl = async () => {
        calls++
        if (calls === 1) return new Response('', { status: 503 })
        return new Promise(() => {})
    }
    const result = discover(ctx(fetchImpl)).then(value => { done = true; return value })
    await turn()
    t.mock.timers.tick(400)
    await turn()
    assert.equal(calls, 2)
    t.mock.timers.tick(8_601)
    await turn()
    assert.equal(done, true)
    assert.equal((await result).partial, true)
    assert.equal(calls, 2)
})

test('Cineby body reads cannot exceed the total budget', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
    let done = false
    const fetchImpl = async () => ({ ok: true, headers: new Headers({ 'content-type': 'application/json' }), text: () => new Promise(() => {}) })
    const result = discover(ctx(fetchImpl)).then(value => { done = true; return value })
    await turn()
    t.mock.timers.tick(9_001)
    await turn()
    assert.equal(done, true)
    assert.equal((await result).partial, true)
})

test('an already cancelled Cineby caller makes no request and leaves no negative cache', async () => {
    let calls = 0
    const fetchImpl = async () => { calls++; return json({ id: 1, title: 'Healthy' }) }
    const ctrl = new AbortController()
    ctrl.abort()
    await assert.rejects(series(ctx(fetchImpl, ctrl.signal), 'cineby:1'), { name: 'AbortError' })
    assert.equal(calls, 0)
    assert.equal((await series(ctx(fetchImpl), 'cineby:1')).title, 'Healthy')
    assert.equal(calls, 1)
})

test('Cineby keeps stale data but does not renew it or ignore a rate limit', async t => {
    let now = 1_000_000
    t.mock.method(Date, 'now', () => now)
    let calls = 0
    const fetchImpl = async () => {
        calls++
        if (calls === 1) return json({ results: [{ id: 1, title: 'Cached', media_type: 'movie' }], total_pages: 1 })
        return new Response('', { status: 429, headers: { 'retry-after': '120' } })
    }
    assert.equal((await discover(ctx(fetchImpl))).rows[0].title, 'Cached')
    now += 6 * 60 * 60_000 + 1
    assert.equal((await discover(ctx(fetchImpl))).rows[0].title, 'Cached')
    await turn()
    now += 61_000
    assert.equal((await discover(ctx(fetchImpl))).rows[0].title, 'Cached')
    assert.equal((await discover(ctx(fetchImpl), { page: 2 })).partial, true)
    assert.equal(calls, 2)
    now += 12 * 60 * 60_000
    assert.equal((await discover(ctx(fetchImpl))).partial, true)
    assert.equal(calls, 3)
})


test('a Cineby source rate limit cools metadata too without waiting for its body', async () => {
    let calls = 0, bodyReads = 0
    const fetchImpl = async url => {
        calls++
        if (!String(url).endsWith('/images')) return json({ id: 1, title: 'A movie' })
        return {
            ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }),
            text: () => { bodyReads++; return new Promise(() => {}) },
        }
    }
    await assert.rejects(playback(ctx(fetchImpl), 'cineby:1', 'sub', 's1e1'), { status: 429, retryAfterMs: 120_000 })
    await assert.rejects(series(ctx(fetchImpl), 'cineby:2'), { status: 429 })
    assert.equal(calls, 2)
    assert.equal(bodyReads, 0)
})


test('overflowing Retry-After values cannot create a permanent Cineby cooldown', async t => {
    let now = 1_000_000
    t.mock.method(Date, 'now', () => now)
    for (const header of ['1e308', '9'.repeat(300), '9007199254740991', 'Infinity', '-1', '0.5']) {
        let calls = 0
        const fetchImpl = async () => {
            calls++
            if (calls === 1) return new Response('', { status: 429, headers: { 'retry-after': header } })
            return json({ id: 2, title: 'Recovered' })
        }
        await assert.rejects(series(ctx(fetchImpl), 'cineby:1'), error => Number.isFinite(error.retryAfterMs))
        now += 60_001
        assert.equal((await series(ctx(fetchImpl), 'cineby:2')).title, 'Recovered')
        assert.equal(calls, 2)
    }
})

test('Cineby cancels unread error bodies without waiting for stream teardown', async () => {
    for (const source of [false, true]) {
        for (const status of [403, 429]) {
            let cancelled = 0
            const fetchImpl = async url => {
                if (source && !String(url).endsWith('/images')) return json({ id: 1, title: 'A movie' })
                return new Response(new ReadableStream({
                    cancel() { cancelled++; return new Promise(() => {}) },
                }), { status, headers: { 'retry-after': '120' } })
            }
            const pending = source
                ? playback(ctx(fetchImpl), 'cineby:1', 'sub', 's1e1')
                : series(ctx(fetchImpl), 'cineby:1')
            await assert.rejects(pending, { status })
            assert.equal(cancelled, 1, `${source ? 'source' : 'metadata'} ${status} response body`)
        }
    }
})
