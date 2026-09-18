import test from 'node:test'
import assert from 'node:assert/strict'
import { discover, episodes, playback, series } from '../adapter/providers/cineby.mjs'
import { cached, handleAnimeVideoRequest } from '../adapter/anime-adapter.mjs'

const request = path => new Request(`https://vellum.test${path}`)
const ctx = fetchImpl => ({ env: {}, fetchImpl, request: request('/'), cached })

// cineby.su 301s to flixer.su, whose only remaining HTML is an SEO shell without __NEXT_DATA__;
// every listing, detail, season and source payload now comes from the open TMDB passthrough on
// plsdontscrapemelove.<flixer domain>. Payloads below are that endpoint's live shapes.
const API = 'https://plsdontscrapemelove.flixer.su/api/tmdb'
const SUBTITLE_HOST = 'https://sub.vdrk.site'
const TMDB_IMAGE = 'https://image.tmdb.org/t/p'
const jsonResponse = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
// an id that is not in the requested namespace relays TMDB's own error envelope
const notFound = () => new Response(JSON.stringify({ status_code: 34, status_message: 'The resource you requested could not be found.', success: false }), { status: 404, headers: { 'content-type': 'application/json' } })

// GET /api/tmdb/tv/127532 — the show payload lists its seasons; the upstream order is [0, 1] and is
// presented reversed here so the flattened list has to come out ordered
const SHOW = {
    id: 127532, name: 'Solo Leveling', title: null, release_date: null,
    overview: 'They say whatever doesn’t kill you makes you stronger, but that’s not the case for the world’s weakest hunter Sung Jinwoo.',
    poster_path: '/geCRueV3ElhRTr0xtJuEWJt6dJ1.jpg', first_air_date: '2024-01-07',
    seasons: [
        { season_number: 1, episode_count: 25, name: 'Solo Leveling', air_date: '2024-01-05' },
        { season_number: 0, episode_count: 1, name: 'Specials', air_date: '2024-02-25' },
    ],
}

// GET /api/tmdb/tv/127532/season/<n>
const SEASON_ONE = {
    _id: '60c79d6d99259c004115f112', id: 199167, name: 'Solo Leveling', season_number: 1,
    air_date: '2024-01-05', poster_path: '/geCRueV3ElhRTr0xtJuEWJt6dJ1.jpg', vote_average: 8.3,
    episodes: [
        { air_date: '2024-01-07', episode_number: 1, name: "I'm Used to It", still_path: '/rm8q4ZHkVwbwUjjdbOIV9v5RW99.jpg', overview: 'Around ten years ago, gates that connected our world to another dimension began to appear.' },
        { air_date: '2024-01-14', episode_number: 2, name: 'If I Had One More Chance', still_path: '/ch5o2NnATbswomEiCugOgjX8IwY.jpg', overview: 'Jinwoo and his party appear to have cleared a low-level dungeon.' },
    ],
}
const SEASON_ZERO = {
    _id: '65d1df89aa659e018643991b', id: 379694, name: 'Specials', season_number: 0,
    air_date: '2024-02-25', poster_path: '/hUQRnwRuVtz0CRZhUiOA26gXRoU.jpg', vote_average: 0,
    episodes: [
        { air_date: '2024-02-25', episode_number: 1, name: 'How to Get Stronger', still_path: '/7OEMEVIQQevzH8HzrDHpxfvpmvY.jpg', overview: 'Jinwoo recaps the events of the story so far.' },
    ],
}

// GET /api/tmdb/movie/299939 — a movie payload carries no seasons at all
const MOVIE = {
    id: 299939, title: 'Debug', name: null, first_air_date: null, seasons: null, release_date: '2014-11-03',
    overview: 'Six young computer hackers sent to work on a derelict space freighter, are forced to match wits with a vengeful artificial intelligence that would kill to be human.',
    poster_path: '/lnsqg7ukZe9S0uoPQ7633sWtMno.jpg', backdrop_path: '/5vWjogEzawuF4e07Y28xsuWBBty.jpg',
}

// GET /api/tmdb/movie/299939/images: the site's own client reads either a server list or a single
// file object out of the source payload
const SOURCE_SERVERS = {
    sources: [
        { server: 'alpha', url: 'https://media.test/master.m3u8' },
        { server: 'bravo', url: 'https://media.test/master.m3u8' },
        { server: 'charlie', url: 'https://embed.test/play' },
        { server: 'delta', url: 'http://ignored.test/x.m3u8' },
    ],
}
const SOURCE_FILE = { sources: { file: 'http://media.test/stream.m3u8' } }

// GET https://sub.vdrk.site/<v1|v2>/movie/299939 — both versions are published separately and
// v2 may serve files hosted on a later cache generation
const SUBTITLES_V1 = [{ label: 'Bulgarian', file: 'https://cache.vdrk.site/v1/vtt/movie/299939/Bulgarian.vtt' }]
const SUBTITLES_V2 = [
    { label: 'English', file: 'https://cache.vdrk.site/v2/movie/299939/English.vtt' },
    { label: 'English 1', file: 'https://cache.vdrk.site/v3/movie/299939/English 1.vtt' },
    { label: 'Spanish 1', file: 'https://cache.vdrk.site/v3/movie/299939/Spanish 1.vtt' },
]

// a stub only ever answers the upstream shapes above; anything else fails immediately instead of
// burning the provider's retry budget
const serve = routes => async (url, init) => {
    const handler = routes[String(url)]
    if (!handler) throw Object.assign(new Error(`unexpected ${url}`), { status: 400 })
    return handler(init)
}

test('parses a Cineby tmdb passthrough payload into a cineby:<tmdbId> series', async () => {
    const fetchImpl = serve({
        // 127532 only exists in TMDB's tv namespace, so the movie probe misses first
        [`${API}/movie/127532`]: () => notFound(),
        [`${API}/tv/127532`]: init => {
            assert.match(init.headers['user-agent'], /^Mozilla\/5\.0/)
            return jsonResponse(SHOW)
        },
    })
    const result = await series(ctx(fetchImpl), 'cineby:127532')
    assert.equal(result.key, 'cineby:127532')
    assert.equal(result.kind, 'anime')
    assert.equal(result.title, 'Solo Leveling')
    assert.equal(result.poster, `${TMDB_IMAGE}/w500/geCRueV3ElhRTr0xtJuEWJt6dJ1.jpg`)
    assert.equal(result.synopsis, SHOW.overview)
    assert.equal(result.year, 2024)
})

test('flattens Cineby seasons into flat s{season}e{episode} ids', async () => {
    const fetchImpl = serve({
        [`${API}/movie/127532`]: () => notFound(),
        [`${API}/tv/127532`]: () => jsonResponse(SHOW),
        [`${API}/tv/127532/season/1`]: () => jsonResponse(SEASON_ONE),
        [`${API}/tv/127532/season/0`]: () => jsonResponse(SEASON_ZERO),
    })
    const result = await episodes(ctx(fetchImpl), 'cineby:127532')
    assert.deepEqual(result.map(item => item.id), ['s0e1', 's1e1', 's1e2'])
    assert.deepEqual(result.map(item => item.number), [1, 1, 2])
    assert.deepEqual(result.map(item => item.season), [0, 1, 1])
    assert.equal(result[1].title, "I'm Used to It")
    assert.equal(result[1].image, `${TMDB_IMAGE}/w300/rm8q4ZHkVwbwUjjdbOIV9v5RW99.jpg`)
})

test('treats a Cineby movie without seasons as a single s1e1 episode', async () => {
    const fetchImpl = serve({ [`${API}/movie/299939`]: () => jsonResponse(MOVIE) })
    const result = await episodes(ctx(fetchImpl), 'cineby:299939')
    assert.deepEqual(result.map(item => item.id), ['s1e1'])
    assert.deepEqual(result.map(item => item.season), [1])
    assert.equal(result[0].title, 'Debug')
})

test('emits only validated https direct and embed Cineby sources', async () => {
    const fetchImpl = serve({
        [`${API}/movie/299939`]: () => jsonResponse(MOVIE),
        [`${API}/movie/299939/images`]: init => {
            assert.equal(init.headers['x-only-sources'], '1')
            return jsonResponse(SOURCE_SERVERS)
        },
        [`${SUBTITLE_HOST}/v1/movie/299939`]: () => jsonResponse(SUBTITLES_V1),
        [`${SUBTITLE_HOST}/v2/movie/299939`]: () => jsonResponse(SUBTITLES_V2),
    })
    const result = await playback(ctx(fetchImpl), 'cineby:299939', 'sub', 's1e1')
    assert.deepEqual(result.sources, [
        { kind: 'direct', url: 'https://media.test/master.m3u8', type: 'application/x-mpegURL' },
        { kind: 'embed', url: 'https://embed.test/play' },
    ])
    assert.equal(result.providerLabel, 'Cineby')
    assert.deepEqual(result.subtitles, [
        { url: 'https://cache.vdrk.site/v1/vtt/movie/299939/Bulgarian.vtt', label: 'Bulgarian', lang: 'Bulgarian' },
        { url: 'https://cache.vdrk.site/v2/movie/299939/English.vtt', label: 'English', lang: 'English' },
        { url: 'https://cache.vdrk.site/v3/movie/299939/English 1.vtt', label: 'English 1', lang: 'English 1' },
        { url: 'https://cache.vdrk.site/v3/movie/299939/Spanish 1.vtt', label: 'Spanish 1', lang: 'Spanish 1' },
    ])
})

test('fails closed with stream_unavailable when Cineby exposes only http sources', async () => {
    const fetchImpl = serve({
        [`${API}/movie/299939`]: () => jsonResponse(MOVIE),
        [`${API}/movie/299939/images`]: () => jsonResponse(SOURCE_FILE),
    })
    await assert.rejects(playback(ctx(fetchImpl), 'cineby:299939', 'sub', 's1e1'), error => error?.code === 'stream_unavailable')
    const result = await handleAnimeVideoRequest(request('/read/api/video/playback?key=cineby%3A299939&id=s1e1'), {}, fetchImpl)
    assert.equal(result.status, 502)
    assert.deepEqual(await result.json(), { error: { provider: 'cineby', code: 'stream_unavailable', message: 'Cineby returned no playable stream', retryable: true } })
})

test('returns a partial discover outcome when the Cineby listing cannot be parsed', async () => {
    let calls = 0
    const fetchImpl = async url => {
        calls += 1
        assert.equal(String(url), `${API}/trending/all/day?page=1`)
        // a rotated or parked domain answers the listing with a challenge page instead of JSON
        return new Response('<html><head><title>Just a moment...</title></head><body>challenge</body></html>',
            { status: 403, headers: { 'content-type': 'text/html' } })
    }
    const result = await discover(ctx(fetchImpl))
    assert.deepEqual(result.rows, [])
    assert.equal(result.hasMore, false)
    assert.equal(result.partial, true)
    assert.deepEqual(result.error, { provider: 'cineby', code: 'provider_unavailable', message: 'Cineby listing is unavailable' })
    assert.equal(calls, 1)
})
