import test from 'node:test'
import assert from 'node:assert/strict'
import { handleAnimeVideoRequest } from '../adapter/anime-adapter.mjs'
import { settleProviders } from '../adapter/provider-results.mjs'

const turn = () => new Promise(resolve => setImmediate(resolve))

test('video discovery returns the healthy catalogue while another provider is still loading', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
    const fetchImpl = async input => {
        if (String(input) === 'https://graphql.anilist.co') {
            return Response.json({ data: { Page: { pageInfo: { hasNextPage: false }, media: [
                { id: 21, title: { english: 'One Piece' }, coverImage: {}, studios: { nodes: [] } },
            ] } } })
        }
        return new Promise(() => {})
    }
    let done = false
    const pending = handleAnimeVideoRequest(new Request('https://vellum.test/read/api/video/discover?kind=anime'), {}, fetchImpl)
        .then(response => { done = true; return response })
    await turn()
    t.mock.timers.tick(501)
    await turn()
    assert.equal(done, true)
    const response = await pending
    const value = await response.json()
    assert.equal(response.status, 200)
    assert.equal(value.results[0].key, 'miruro:21')
    assert.equal(value.partial, true)
    assert.equal(value.errors[0].provider, 'cineby')
})

test('discovery includes both providers when the second finishes within the grace period', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
    let finish
    const pending = settleProviders([Promise.resolve(['first']), new Promise(resolve => { finish = resolve })], rows => rows.length > 0)
    await turn()
    t.mock.timers.tick(250)
    finish(['second'])
    const results = await pending
    assert.deepEqual(results.map(result => result.value), [['first'], ['second']])
})

test('an empty catalogue cannot cut off a slower provider that may have results', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
    let done = false
    const pending = settleProviders([Promise.resolve([]), new Promise(() => {})], rows => rows.length > 0)
        .then(result => { done = true; return result })
    await turn()
    t.mock.timers.tick(501)
    await turn()
    assert.equal(done, false)
    t.mock.timers.tick(7_499)
    const results = await pending
    assert.deepEqual(results[0].value, [])
    assert.equal(results[1].reason.code, 'provider_timeout')
})

test('a late provider failure is handled without mutating the response already returned', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
    let reject
    const pending = settleProviders([Promise.resolve(['first']), new Promise((_, fail) => { reject = fail })], rows => rows.length > 0)
    await turn()
    t.mock.timers.tick(501)
    const results = await pending
    const reason = results[1].reason
    reject(new Error('late upstream failure'))
    await turn()
    assert.equal(results[1].reason, reason)
    assert.equal(reason.code, 'provider_timeout')
})
