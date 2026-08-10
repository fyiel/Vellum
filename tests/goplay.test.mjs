import test from 'node:test'
import assert from 'node:assert/strict'
import { handleAnimeRequest, handleAnimeVideoRequest } from '../adapter/anime-adapter.mjs'

const request = path => new Request(`https://vellum.test${path}`)
const deadFetch = () => { throw new Error('gp must never fetch') }
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

const expected = { error: { provider: 'gp', code: 'provider_unconfigured', message: 'goplay.su blocks automated access (Cloudflare Turnstile)', retryable: false } }

test('resolves every gp: route to 503 provider_unconfigured without fetching', async () => {
    const routes = [
        ['/read/api/anime/series/gp%3Ashow-1', handleAnimeRequest],
        ['/read/api/anime/episodes?key=gp%3Ashow-1&language=sub', handleAnimeRequest],
        ['/read/api/anime/watch?key=gp%3Ashow-1&language=sub&id=opaque', handleAnimeRequest],
        ['/read/api/video/series/gp%3Ashow-1', handleAnimeVideoRequest],
        ['/read/api/video/playback?key=gp%3Ashow-1&id=opaque', handleAnimeVideoRequest],
    ]
    for (const [path, handler] of routes) {
        const result = await handler(request(path), {}, deadFetch)
        assert.equal(result.status, 503)
        assert.deepEqual(await result.json(), expected)
    }
})

test('never lists GoPlay in discover results', async () => {
    const fetchImpl = async url => {
        const endpoint = String(url)
        if (endpoint === 'https://dramacooli.ws/wp-json/wp/v2/categories?orderby=count&per_page=100&page=1&hide_empty=true') {
            return response([{ id: 7, name: 'Korean Drama' }])
        }
        if (endpoint === 'https://graphql.anilist.co') {
            return response({ data: { Page: { pageInfo: { hasNextPage: false }, media: [] } } })
        }
        if (endpoint.startsWith('https://cineby.su/')) return new Response('{}', { headers: { 'content-type': 'text/html' } })
        throw new Error(`unexpected ${endpoint}`)
    }
    const drama = await handleAnimeVideoRequest(request('/read/api/video/discover?kind=drama'), {}, fetchImpl)
    assert.equal(drama.status, 200)
    const dramaBody = await drama.json()
    assert.deepEqual(dramaBody.results.map(row => row.key), ['dc:7'])
    assert.ok(dramaBody.results.every(row => !String(row.key).startsWith('gp:')))
    const all = await handleAnimeVideoRequest(request('/read/api/video/discover?kind=all'), {}, fetchImpl)
    assert.equal(all.status, 200)
    assert.ok((await all.json()).results.every(row => !String(row.key).startsWith('gp:')))
})
