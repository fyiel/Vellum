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
