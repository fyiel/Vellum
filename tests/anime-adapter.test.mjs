import test from 'node:test'
import assert from 'node:assert/strict'
import { handleAnimeRequest, handleAnimeVideoRequest } from '../adapter/anime-adapter.mjs'

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

test('maps Miruro pewe ids through AniDB into proxied HLS Watch playback', async () => {
    const episodeOne = 'YW5pZGJhcHA6Mzg4MDozNTEy'
    const episodeTwo = 'YW5pZGJhcHA6Mzg4MDozNTEz'
    const targets = []
    const media = {
        id: 21, title: { english: 'One Piece', romaji: 'One Piece' }, description: 'Pirates at sea.',
        status: 'RELEASING', format: 'TV', season: 'FALL', seasonYear: 1999, episodes: null, duration: 24,
        genres: ['Action'], studios: { nodes: [{ name: 'Toei Animation' }] }, coverImage: { extraLarge: 'https://img.test/21.jpg' }, bannerImage: null,
    }
    const fetchImpl = async (input, init) => {
        if (String(input) === 'https://graphql.anilist.co') {
            const query = JSON.parse(init.body).query
            return response(query.includes('Page(')
                ? { data: { Page: { pageInfo: { hasNextPage: false }, media: [media] } } }
                : { data: { Media: media } })
        }
        const endpoint = String(input)
        assert.equal(init.headers['x-slipgate-key'], 'local-test')
        const payload = JSON.parse(init.body)
        targets.push({ endpoint, payload })
        if (endpoint.endsWith('/anidb/source')) {
            return response({
                ok: true, status: 200, provider: 'pewe', category: 'sub', source_id: episodeOne,
                media_path: '/anidb/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/master.m3u8',
            })
        }
        assert.equal(endpoint, 'http://127.0.0.1:8189/anidb/fetch')
        const target = new URL(payload.url)
        if (target.pathname === '/browse') return response({ ok: true, status: 200, body: '<a href="https://anidb.app/anime/one-piece-3880" title="One Piece">One Piece</a>' })
        if (target.pathname.endsWith('/episodes')) return response({ ok: true, status: 200, body: JSON.stringify({ episodes: [
            { id: 3512, number: 1, filler: false }, { id: 3513, number: 2, filler: false },
        ] }) })
        throw new Error(`unexpected target ${payload.url}`)
    }
    const env = { VELLUM_SLIPGATE_URL: 'http://127.0.0.1:8189/', VELLUM_SLIPGATE_KEY: 'local-test' }

    const catalog = await handleAnimeVideoRequest(request('/read/api/video/discover?kind=anime&q=one%20piece'), env, fetchImpl)
    assert.equal(catalog.status, 200)
    const catalogItem = (await catalog.json()).results[0]
    assert.equal(catalogItem.key, 'miruro:21')
    assert.equal(catalogItem.kind, 'anime')
    assert.equal(catalogItem.poster, 'https://img.test/21.jpg')

    const detail = await handleAnimeVideoRequest(request('/read/api/video/series/miruro%3A21'), env, fetchImpl)
    assert.equal(detail.status, 200)
    assert.deepEqual(await detail.json(), {
        key: 'miruro:21', kind: 'anime', title: 'One Piece', alternateTitles: ['One Piece'], cover: 'https://img.test/21.jpg', banner: null,
        synopsis: 'Pirates at sea.', status: 'releasing', format: 'tv', season: 'fall', year: 1999, totalEpisodes: null, duration: 24,
        genres: ['Action'], studios: ['Toei Animation'], source: 'Miruro · pewe (AniDB App)', provider: 'vellum', poster: 'https://img.test/21.jpg',
        episodes: [
            { id: episodeOne, number: 1, title: 'Episode 1', description: null, image: null, airDate: null, filler: false },
            { id: episodeTwo, number: 2, title: 'Episode 2', description: null, image: null, airDate: null, filler: false },
        ],
        partial: false, errors: [],
    })

    const playback = await handleAnimeVideoRequest(request(`/read/api/video/playback?key=miruro%3A21&id=${episodeOne}`), env, fetchImpl)
    assert.equal(playback.status, 200)
    assert.deepEqual(await playback.json(), {
        key: 'miruro:21', episodeId: episodeOne, providerLabel: 'Miruro · pewe (AniDB App)',
        sources: [{ kind: 'direct', url: '/read/api/video/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/master.m3u8', type: 'application/x-mpegURL' }], subtitles: [],
    })
    assert.ok(targets.filter(item => item.payload.url).every(item => new URL(item.payload.url).hostname === 'anidb.app'))
    assert.deepEqual(targets.at(-1).payload, { series_id: 3880, episode_id: 3512, language: 'sub' })
})

test('rejects a changed Miruro pewe identity at the Watch boundary', async () => {
    const episodeId = 'YW5pZGJhcHA6Mzg4MDozNTEy'
    const fetchImpl = async (input, init) => {
        if (String(input) === 'https://graphql.anilist.co') return response({ data: { Media: {
            id: 21, title: { english: 'One Piece' }, seasonYear: 1999, studios: { nodes: [] }, coverImage: {},
        } } })
        const payload = JSON.parse(init.body)
        if (String(input).endsWith('/anidb/source')) return response({ ok: true, status: 200, provider: 'ally', category: 'sub', source_id: episodeId, media_path: '/anidb/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/master.m3u8' })
        const target = new URL(payload.url)
        if (target.pathname === '/browse') return response({ ok: true, status: 200, body: '<a href="/anime/one-piece-3880" title="One Piece">One Piece</a>' })
        return response({ ok: true, status: 200, body: JSON.stringify({ episodes: [{ id: 3512, number: 1 }] }) })
    }
    const result = await handleAnimeVideoRequest(request(`/read/api/video/playback?key=miruro%3A21&id=${episodeId}`), { VELLUM_SLIPGATE_URL: 'http://localhost:8189' }, fetchImpl)
    assert.equal(result.status, 502)
    assert.equal((await result.json()).error.code, 'provider_unavailable')
})

test('proxies bounded AniDB media responses with Range and CORS', async () => {
    let seen
    const fetchImpl = async (input, init) => {
        seen = { input: String(input), init }
        return new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: {
            'content-type': 'video/mp2t', 'content-range': 'bytes 0-2/99', 'content-length': '3',
        } })
    }
    const media = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/file-1-f1-v1-a1.xls'
    const result = await handleAnimeVideoRequest(new Request(`https://vellum.test/read/api/video/media/${media}`, {
        headers: { range: 'bytes=0-2' },
    }), { VELLUM_SLIPGATE_URL: 'http://localhost:8189', VELLUM_SLIPGATE_KEY: 'local-test' }, fetchImpl)
    assert.equal(result.status, 206)
    assert.equal(result.headers.get('access-control-allow-origin'), '*')
    assert.equal(result.headers.get('content-range'), 'bytes 0-2/99')
    assert.equal(seen.input, `http://localhost:8189/anidb/media/${media}`)
    assert.equal(seen.init.headers.range, 'bytes=0-2')
    assert.equal(seen.init.headers['x-slipgate-key'], 'local-test')
    assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [1, 2, 3])
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
