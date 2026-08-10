import test from 'node:test'
import assert from 'node:assert/strict'
import { handleAnimeRequest } from '../adapter/anime-adapter.mjs'

const request = path => new Request(`https://vellum.test${path}`)
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

test('normalizes AniList metadata without requiring playback configuration', async () => {
    let body
    const fetchImpl = async (_url, init) => {
        body = JSON.parse(init.body)
        return response({ data: { Page: { pageInfo: { hasNextPage: true }, media: [{
            id: 21, title: { english: 'One Piece', romaji: 'One Piece' }, description: '<b>Pirates</b> at sea.',
            status: 'RELEASING', format: 'TV', season: 'FALL', seasonYear: 1999, episodes: null, duration: 24,
            genres: ['Action'], studios: { nodes: [{ name: 'Toei Animation' }] }, coverImage: { extraLarge: 'https://img.test/21.jpg' }, bannerImage: null,
        }] } } })
    }
    const result = await handleAnimeRequest(request('/read/api/anime/search?q=one%20piece&page=2&limit=12'), {}, fetchImpl)
    assert.equal(result.status, 200)
    assert.deepEqual(await result.json(), {
        page: 2,
        results: [{ key: 'miruro:21', kind: 'anime', title: 'One Piece', alternateTitles: ['One Piece'], cover: 'https://img.test/21.jpg', banner: null, synopsis: 'Pirates at sea.', status: 'releasing', format: 'tv', season: 'fall', year: 1999, totalEpisodes: null, duration: 24, genres: ['Action'], studios: ['Toei Animation'], source: 'Miruro', provider: 'vellum' }],
        hasMore: true,
    })
    assert.equal(body.variables.search, 'one piece')
    assert.equal(body.variables.page, 2)
})

test('keeps opaque episode ids exact across the owned playback seam', async () => {
    const opaqueId = 'gogo/anime?episode=01+sub'
    const calls = []
    const fetchImpl = async url => {
        calls.push(String(url))
        if (String(url).includes('episodes?')) return response([{ id: opaqueId, number: 1, title: 'Departure' }])
        return response({ sources: [{ url: 'https://media.test/stream.m3u8', quality: 'default' }], subtitles: [{ url: 'https://media.test/en.vtt', lang: 'English' }] })
    }
    const env = { VELLUM_ANIME_PLAYBACK_URL: 'https://playback.vellum.test/', VELLUM_ANIME_PROVIDER: 'owned' }
    const episodes = await handleAnimeRequest(request('/read/api/anime/episodes?key=miruro%3A21&language=sub'), env, fetchImpl)
    assert.deepEqual((await episodes.json()).episodes[0], { id: opaqueId, number: 1, title: 'Departure', description: null, image: null, airDate: null })
    const stream = await handleAnimeRequest(request(`/read/api/anime/watch?key=miruro%3A21&language=sub&id=${encodeURIComponent(opaqueId)}`), env, fetchImpl)
    const streamBody = await stream.json()
    assert.equal(streamBody.episode.id, opaqueId)
    assert.equal(streamBody.sources[0].type, 'hls')
    assert.match(calls[0], /anilistId=21&language=sub/)
    assert.match(calls[1], new RegExp(`episodeId=${encodeURIComponent(opaqueId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
})

test('returns an explicit unavailable state when playback is not configured', async () => {
    const result = await handleAnimeRequest(request('/read/api/anime/episodes?key=miruro%3A21&language=dub'), {}, () => { throw new Error('must not fetch') })
    assert.equal(result.status, 503)
    assert.deepEqual(await result.json(), { error: { provider: 'miruro', code: 'provider_unconfigured', message: 'Anime playback service is not configured', retryable: false } })
})

test('rejects non-HTTPS playback sources at the boundary', async () => {
    const env = { VELLUM_ANIME_PLAYBACK_URL: 'https://playback.vellum.test/' }
    const result = await handleAnimeRequest(request('/read/api/anime/watch?key=miruro%3A21&language=sub&id=opaque'), env, () => response({ sources: [{ url: 'http://media.test/video.mp4' }] }))
    assert.equal(result.status, 502)
    assert.equal((await result.json()).error.code, 'stream_unavailable')
})

test('live AniList contract returns normalized anime metadata', { skip: process.env.VELLUM_LIVE_CONTRACT !== '1' }, async () => {
    const result = await handleAnimeRequest(request('/read/api/anime/discover?page=1&limit=1'))
    assert.equal(result.status, 200)
    const body = await result.json()
    assert.equal(body.page, 1)
    assert.equal(body.results.length, 1)
    assert.match(body.results[0].key, /^miruro:\d+$/)
    assert.equal(body.results[0].kind, 'anime')
    assert.equal(body.results[0].source, 'Miruro')
})
