import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { cached } from '../src/lib/cache.js'

test('repeated partial searches release abort listeners after each response', async () => {
    const controller = new AbortController()
    for (let i = 0; i < 25; i++) {
        const response = await cached('pending-search', 60_000, async () => ({ pending: true, results: [i] }), {
            signal: controller.signal, accept: data => !data.pending,
        })
        assert.deepEqual(response.results, [i])
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    }
    await assert.rejects(cached('failed-search', 0, async () => { throw Error('upstream failed') }, { signal: controller.signal }))
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('cancelled cache calls reject even if the loader ignores the abort signal', async () => {
    const ctrl = new AbortController()
    let started
    const loading = new Promise(resolve => { started = resolve })
    let finish
    const result = new Promise(resolve => { finish = resolve })
    const pending = cached('non-cancellable-provider', 60_000, async () => {
        started()
        return result
    }, { signal: ctrl.signal })

    await loading
    ctrl.abort()
    finish('late response')
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0)
})

test('aborting a cache call settles immediately even when the provider is still pending', async () => {
    const ctrl = new AbortController()
    let started
    const loading = new Promise(resolve => { started = resolve })
    let finish
    const response = new Promise(resolve => { finish = resolve })
    const pending = cached('non-responding-provider', 60_000, () => {
        started()
        return response
    }, { signal: ctrl.signal })

    await loading
    ctrl.abort()
    const outcome = await Promise.race([
        pending.then(() => 'resolved', error => error.name),
        new Promise(resolve => setTimeout(() => resolve('still pending'), 30)),
    ])
    finish('eventually delivered')
    assert.equal(outcome, 'AbortError')
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0)
})

test('a forced refresh supersedes an older loader and deduplicates matching refreshes', async () => {
    const key = `force-race-${Date.now()}`
    let startOld, releaseOld
    const oldStarted = new Promise(resolve => { startOld = resolve })
    const oldGate = new Promise(resolve => { releaseOld = resolve })
    const old = cached(key, 60_000, async () => {
        startOld()
        await oldGate
        return 'old result'
    })
    await oldStarted

    const ctrl = new AbortController()
    let loads = 0
    const fresh = cached(key, 60_000, async () => { loads++; return 'new result' }, { fresh: true, signal: ctrl.signal })
    const joined = cached(key, 60_000, async () => { loads++; return 'unexpected duplicate' }, { fresh: true, signal: ctrl.signal })
    assert.equal(await fresh, 'new result')
    assert.equal(await joined, 'new result')
    assert.equal(loads, 1)
    releaseOld()
    assert.equal(await old, 'old result')
    assert.equal(await cached(key, 60_000, async () => 'unexpected reload'), 'new result')
})

test('a failed or cancelled forced refresh keeps the previously cached value', async () => {
    const key = `force-failure-${Date.now()}`
    await cached(key, 60_000, async () => 'known good')
    await assert.rejects(cached(key, 60_000, async () => { throw Error('offline') }, { fresh: true }), /offline/)
    assert.equal(await cached(key, 60_000, async () => 'unexpected reload'), 'known good')

    const ctrl = new AbortController()
    let start, release
    const started = new Promise(resolve => { start = resolve })
    const delayed = new Promise(resolve => { release = resolve })
    const pending = cached(key, 60_000, async () => { start(); await delayed; return 'late update' }, {
        fresh: true, signal: ctrl.signal,
    })
    await started
    ctrl.abort()
    await assert.rejects(pending, { name: 'AbortError' })
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(await cached(key, 60_000, async () => 'unexpected reload'), 'known good')
    assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0)
})
