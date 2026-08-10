import test from 'node:test'
import assert from 'node:assert/strict'
import { discover, episodes, playback, series } from '../adapter/providers/cineby.mjs'
import { cached, handleAnimeVideoRequest } from '../adapter/anime-adapter.mjs'

const request = path => new Request(`https://vellum.test${path}`)
const ctx = fetchImpl => ({ env: {}, fetchImpl, request: request('/'), cached })
const html = data => `<html><head></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`
const htmlResponse = data => new Response(html(data), { headers: { 'content-type': 'text/html' } })

test('parses a Cineby __NEXT_DATA__ page into a cineby:<tmdbId> series', async () => {
    const media = { tmdb_id: 123, title: 'Solo Leveling', poster: 'https://img.test/sl.jpg', synopsis: '<p>Hunters</p>', year: 2024 }
    const fetchImpl = async (url, init) => {
        assert.equal(url, 'https://cineby.su/movie/123')
        assert.match(init.headers['user-agent'], /^Mozilla\/5\.0/)
        return htmlResponse({ props: { pageProps: { media } } })
    }
    const result = await series(ctx(fetchImpl), 'cineby:123')
    assert.equal(result.key, 'cineby:123')
    assert.equal(result.kind, 'anime')
    assert.equal(result.title, 'Solo Leveling')
    assert.equal(result.poster, 'https://img.test/sl.jpg')
    assert.equal(result.synopsis, 'Hunters')
    assert.equal(result.year, 2024)
})

test('flattens Cineby seasons into flat s{season}e{episode} ids', async () => {
    const media = {
        tmdb_id: 123, title: 'Solo Leveling',
        seasons: [
            { season_number: 2, episodes: [{ episode_number: 3 }, { episode_number: 4 }] },
            { season_number: 1, episodes: [{ episode_number: 1 }, { episode_number: 2 }] },
        ],
    }
    const fetchImpl = async () => htmlResponse({ props: { pageProps: { media } } })
    const result = await episodes(ctx(fetchImpl), 'cineby:123')
    assert.deepEqual(result.map(item => item.id), ['s1e1', 's1e2', 's2e3', 's2e4'])
    assert.deepEqual(result.map(item => item.number), [1, 2, 3, 4])
    assert.equal(result[2].season, 2)
})

test('treats a Cineby movie without seasons as a single s1e1 episode', async () => {
    const media = { tmdb_id: 999, title: 'Weathering With You' }
    const fetchImpl = async () => htmlResponse({ props: { pageProps: { media } } })
    const result = await episodes(ctx(fetchImpl), 'cineby:999')
    assert.deepEqual(result.map(item => item.id), ['s1e1'])
})

test('emits only validated https direct and embed Cineby sources', async () => {
    const fetchImpl = async () => htmlResponse({ props: { pageProps: { media: { tmdb_id: 123, title: 'Solo Leveling' }, player: { hls: 'https://media.test/master.m3u8', embed: 'https://embed.test/play', src: 'http://ignored.test/x.m3u8' } } } })
    const result = await playback(ctx(fetchImpl), 'cineby:123', 'sub', 's1e1')
    assert.deepEqual(result.sources, [
        { kind: 'direct', url: 'https://media.test/master.m3u8', type: 'application/x-mpegURL' },
        { kind: 'embed', url: 'https://embed.test/play' },
    ])
    assert.equal(result.providerLabel, 'Cineby')
})

test('fails closed with stream_unavailable when Cineby exposes only http sources', async () => {
    const fetchImpl = async url => {
        if (String(url).startsWith('https://cineby.su/')) {
            return htmlResponse({ props: { pageProps: { media: { tmdb_id: 123, title: 'Solo Leveling' }, player: { src: 'http://media.test/stream.m3u8' } } } })
        }
        throw new Error(`unexpected ${url}`)
    }
    await assert.rejects(playback(ctx(fetchImpl), 'cineby:123', 'sub', 's1e1'), error => error?.code === 'stream_unavailable')
    const result = await handleAnimeVideoRequest(request('/read/api/video/playback?key=cineby%3A123&id=s1e1'), {}, fetchImpl)
    assert.equal(result.status, 502)
    assert.deepEqual(await result.json(), { error: { provider: 'cineby', code: 'stream_unavailable', message: 'Cineby returned no playable stream', retryable: true } })
})

test('returns a partial discover outcome when the Cineby listing cannot be parsed', async () => {
    const fetchImpl = async url => {
        assert.equal(url, 'https://cineby.su/browse')
        throw new Error('challenge page')
    }
    const result = await discover(ctx(fetchImpl))
    assert.deepEqual(result.rows, [])
    assert.equal(result.hasMore, false)
    assert.equal(result.partial, true)
    assert.deepEqual(result.error, { provider: 'cineby', code: 'provider_unavailable', message: 'Cineby listing is unavailable' })
})
