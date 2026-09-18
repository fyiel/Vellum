import test from 'node:test'
import assert from 'node:assert/strict'
import { handleAnimeRequest, handleAnimeVideoRequest } from '../adapter/anime-adapter.mjs'

const request = path => new Request(`https://vellum.test${path}`)
const deadFetch = () => { throw new Error('gp must never fetch') }
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

// the DramaCooli provider resolves the live DramaCool host before its first query and probes the
// entry with a manual-redirect request; dramacoolt.top answers 200 with the theme's own markup, so
// the aggregation fixture answers that one lookup the same way and passes everything else through
const DC_ORIGIN = 'https://dramacoolt.top'
const DC_CATALOGUE = '<!doctype html><html><head><title>DramaCool</title></head><body><div class="bsx"><a href="https://dramacoolt.top/">Latest</a></div></body></html>'
const dcLive = handler => async (url, init) => {
    if (init?.redirect !== 'manual') return handler(url, init)
    assert.equal(url, DC_ORIGIN)
    return new Response(DC_CATALOGUE, { headers: { 'content-type': 'text/html' } })
}

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
    const fetchImpl = dcLive(async url => {
        const endpoint = String(url)
        // the K-drama leg of the aggregation is the live WP REST catalogue: slug-keyed rows carrying
        // exactly the fields the provider asks for
        if (endpoint === 'https://dramacoolt.top/wp-json/wp/v2/categories?orderby=count&order=desc&hide_empty=true&per_page=24&page=1&_fields=id,slug,name,description,count') {
            return response([{ id: 7, count: 53, description: '', name: 'Korean Drama', slug: 'korean-drama' }])
        }
        if (endpoint === 'https://graphql.anilist.co') {
            return response({ data: { Page: { pageInfo: { hasNextPage: false }, media: [] } } })
        }
        if (endpoint.startsWith('https://plsdontscrapemelove.flixer.su/')) return new Response('{}', { headers: { 'content-type': 'text/html' } })
        throw new Error(`unexpected ${endpoint}`)
    })
    const drama = await handleAnimeVideoRequest(request('/read/api/video/discover?kind=drama'), {}, fetchImpl)
    assert.equal(drama.status, 200)
    const dramaBody = await drama.json()
    assert.deepEqual(dramaBody.results.map(row => row.key), ['dc:korean-drama'])
    assert.ok(dramaBody.results.every(row => !String(row.key).startsWith('gp:')))
    const all = await handleAnimeVideoRequest(request('/read/api/video/discover?kind=all'), {}, fetchImpl)
    assert.equal(all.status, 200)
    assert.ok((await all.json()).results.every(row => !String(row.key).startsWith('gp:')))
})
