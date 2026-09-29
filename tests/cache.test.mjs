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
