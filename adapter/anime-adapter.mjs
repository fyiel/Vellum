const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const ANILIST = 'https://graphql.anilist.co'
const ANIDB = 'https://anidb.app'
const FORMATS = new Set(['TV', 'MOVIE', 'OVA', 'ONA', 'SPECIAL', 'MUSIC'])
const VIDEO_KEY = /^miruro:(\d+)$/
const ANIDB_EPISODE = /^anidbapp:(\d+):(\d+)$/
const ANIDB_MEDIA = /^[A-Za-z0-9_-]{32}\/[A-Za-z0-9._~/-]{1,500}$/
const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
const str = value => typeof value === 'string' ? value : null
const num = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: JSON_HEADERS })
const failure = (status, code, message, retryable = false) => json({ error: { provider: 'miruro', code, message, retryable } }, status)
const providerCache = new WeakMap()

const timeout = (parent, ms = 12_000) => {
    const ctrl = new AbortController()
    const abort = () => ctrl.abort()
    if (parent?.aborted) abort()
    else parent?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, ms)
    return { signal: ctrl.signal, close: () => { clearTimeout(timer); parent?.removeEventListener('abort', abort) } }
}

async function fetchJson(fetchImpl, input, init, parent) {
    const scoped = timeout(parent)
    try {
        const response = await fetchImpl(input, { ...init, signal: scoped.signal, headers: { accept: 'application/json', ...init?.headers } })
        const body = await response.json().catch(() => null)
        if (!response.ok || body?.errors?.length) throw Object.assign(new Error(body?.errors?.[0]?.message || body?.message || `http ${response.status}`), { status: response.status })
        if (body == null) throw new Error('empty response')
        return body
    } finally { scoped.close() }
}

const MEDIA_FIELDS = `id title { romaji english native userPreferred } synonyms description status format season seasonYear episodes duration genres studios(isMain: true) { nodes { name } } coverImage { extraLarge large } bannerImage`
const PAGE_QUERY = `query($page:Int,$perPage:Int,$search:String,$format:MediaFormat){Page(page:$page,perPage:$perPage){pageInfo{hasNextPage} media(type:ANIME,search:$search,format:$format,sort:[TRENDING_DESC,POPULARITY_DESC]){${MEDIA_FIELDS}}}}`
const SERIES_QUERY = `query($id:Int){Media(id:$id,type:ANIME){${MEDIA_FIELDS}}}`

const cleanDescription = value => str(value)?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || null
const anime = value => {
    const id = value?.id == null ? null : String(value.id)
    const title = value?.title?.english || value?.title?.userPreferred || value?.title?.romaji || value?.title?.native
    if (!opaque(id) || !title) return null
    return {
        key: `miruro:${id}`, kind: 'anime', title,
        alternateTitles: [...new Set([value?.title?.romaji, value?.title?.english, value?.title?.native, ...(Array.isArray(value?.synonyms) ? value.synonyms : [])].filter(Boolean))],
        cover: str(value?.coverImage?.extraLarge) || str(value?.coverImage?.large), banner: str(value?.bannerImage),
        synopsis: cleanDescription(value?.description), status: str(value?.status)?.toLowerCase() || null,
        format: str(value?.format)?.toLowerCase() || null, season: str(value?.season)?.toLowerCase() || null,
        year: num(value?.seasonYear), totalEpisodes: num(value?.episodes), duration: num(value?.duration),
        genres: Array.isArray(value?.genres) ? value.genres.filter(v => typeof v === 'string') : [],
        studios: Array.isArray(value?.studios?.nodes) ? value.studios.nodes.map(v => v?.name).filter(Boolean) : [],
        source: 'Miruro', provider: 'vellum',
    }
}

const episode = value => {
    const id = value?.id == null ? null : String(value.id)
    const number = num(value?.number)
    if (!opaque(id) || number == null) return null
    return { id, number, title: str(value.title), description: str(value.description), image: str(value.image), airDate: str(value.airDate) }
}

const positive = (value, fallback, max) => {
    const parsed = Number.parseInt(value || '', 10)
    return Number.isInteger(parsed) && parsed > 0 ? Math.min(max, parsed) : fallback
}
const pageArgs = url => ({ page: positive(url.searchParams.get('page'), 1, 10_000), limit: positive(url.searchParams.get('limit'), 24, 50), format: url.searchParams.get('format')?.toUpperCase() || null })

const anilist = (fetchImpl, query, variables, signal) => fetchJson(fetchImpl, ANILIST, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }),
}, signal)

const cached = (fetchImpl, key, ttl, load) => {
    let cache = providerCache.get(fetchImpl)
    if (!cache) { cache = new Map(); providerCache.set(fetchImpl, cache) }
    const hit = cache.get(key)
    if (hit && hit.expires > Date.now()) return hit.value
    const value = load().catch(error => { cache.delete(key); throw error })
    if (cache.size >= 100) cache.delete(cache.keys().next().value)
    cache.set(key, { value, expires: Date.now() + ttl })
    return value
}

const slipgateBase = env => {
    const raw = env.VELLUM_SLIPGATE_URL
    if (!raw) throw Object.assign(new Error('Anime playback service is not configured'), { code: 'provider_unconfigured' })
    let base
    try { base = new URL(raw.endsWith('/') ? raw : `${raw}/`) } catch { throw Object.assign(new Error('Slipgate URL is invalid'), { code: 'provider_unconfigured' }) }
    if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) throw Object.assign(new Error('Slipgate URL must use HTTPS'), { code: 'provider_unconfigured' })
    return base
}

async function slipgateJson(env, fetchImpl, path, payload, request) {
    return fetchJson(fetchImpl, new URL(path, slipgateBase(env)), {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(env.VELLUM_SLIPGATE_KEY ? { 'x-slipgate-key': env.VELLUM_SLIPGATE_KEY } : {}),
        },
        body: JSON.stringify(payload),
    }, request.signal)
}

const normalizeTitle = value => String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '')
const htmlEntities = value => value.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
const htmlAttr = (tag, name) => htmlEntities(tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2] || '')
const base64url = value => btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromBase64url = value => {
    try { return atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')) } catch { return '' }
}

async function animeDbFetch(env, fetchImpl, target, request) {
    const data = await slipgateJson(env, fetchImpl, 'anidb/fetch', { url: target }, request)
    if (!data?.ok || data.status !== 200 || typeof data.body !== 'string') throw new Error(data?.error || 'AniDB transport failed')
    return data.body
}

async function animeDbSeries(env, fetchImpl, row, request) {
    return cached(fetchImpl, `anidb:series:${row.key}`, 30 * 60_000, async () => {
        const url = new URL('/browse', ANIDB)
        url.searchParams.set('q', row.title)
        const body = await animeDbFetch(env, fetchImpl, url.href, request)
        const names = new Set([row.title, ...row.alternateTitles].map(normalizeTitle).filter(Boolean))
        for (const match of body.matchAll(/<a\b[^>]*>/gi)) {
            const title = htmlAttr(match[0], 'title')
            const href = htmlAttr(match[0], 'href')
            if (!names.has(normalizeTitle(title))) continue
            let target
            try { target = new URL(href, ANIDB) } catch { continue }
            const id = target.origin === ANIDB ? target.pathname.match(/^\/anime\/[a-z0-9-]+-(\d+)$/i)?.[1] : null
            if (id) return { id, title }
        }
        throw Object.assign(new Error('AniDB could not map this Miruro title'), { code: 'not_found' })
    })
}

const animeDbEpisode = (seriesId, value) => {
    const upstreamId = String(value?.id || '')
    const number = num(value?.episode)
        ?? num(value?.number)
    if (!/^\d+$/.test(upstreamId) || number == null) return null
    return {
        id: base64url(`anidbapp:${seriesId}:${upstreamId}`), number,
        title: str(value?.title) || `Episode ${number}`,
        description: null, image: null, airDate: null,
        filler: Boolean(value?.filler),
    }
}

async function animeDbEpisodes(env, fetchImpl, row, request) {
    return cached(fetchImpl, `anidb:episodes:${row.key}`, 10 * 60_000, async () => {
        const series = await animeDbSeries(env, fetchImpl, row, request)
        const body = await animeDbFetch(env, fetchImpl, `${ANIDB}/api/frontend/anime/${series.id}/episodes`, request)
        const data = JSON.parse(body)
        const episodes = (Array.isArray(data?.episodes) ? data.episodes : []).map(value => animeDbEpisode(series.id, value)).filter(Boolean)
        if (!episodes.length) throw Object.assign(new Error('AniDB returned no episodes'), { code: 'not_found' })
        return { series, episodes }
    })
}

const animeDbEpisodeId = value => fromBase64url(value).match(ANIDB_EPISODE)

async function animeDbSources(env, fetchImpl, row, language, episodeId, request) {
    const match = animeDbEpisodeId(episodeId)
    if (!match) throw Object.assign(new Error('Invalid Miruro pewe episode'), { code: 'not_found' })
    const { series } = await animeDbEpisodes(env, fetchImpl, row, request)
    if (match[1] !== series.id) throw Object.assign(new Error('Episode does not belong to this series'), { code: 'not_found' })
    const data = await slipgateJson(env, fetchImpl, 'anidb/source', {
        series_id: Number(series.id), episode_id: Number(match[2]), language,
    }, request)
    if (!data?.ok || data.provider !== 'pewe' || data.category !== language || data.source_id !== episodeId) {
        throw new Error(data?.error || 'Miruro pewe source identity changed')
    }
    if (typeof data.media_path !== 'string' || !data.media_path.startsWith('/anidb/media/')) throw new Error('AniDB returned no proxied media')
    const media = data.media_path.slice('/anidb/media/'.length)
    if (!ANIDB_MEDIA.test(media)) throw new Error('AniDB returned an invalid media capability')
    return [{ kind: 'direct', url: `/read/api/video/media/${media}`, type: 'application/x-mpegURL' }]
}

async function animeDbMedia(env, fetchImpl, media, request) {
    if (!ANIDB_MEDIA.test(media)) return failure(400, 'invalid_request', 'Invalid anime media path')
    const scoped = timeout(request.signal, 35_000)
    try {
        const response = await fetchImpl(new URL(`anidb/media/${media}`, slipgateBase(env)), {
            method: request.method,
            headers: {
                ...(env.VELLUM_SLIPGATE_KEY ? { 'x-slipgate-key': env.VELLUM_SLIPGATE_KEY } : {}),
                ...(request.headers.get('range') ? { range: request.headers.get('range') } : {}),
            },
            signal: scoped.signal,
        })
        const headers = new Headers()
        for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
            const value = response.headers.get(name)
            if (value) headers.set(name, value)
        }
        headers.set('access-control-allow-origin', '*')
        headers.set('access-control-allow-methods', 'GET, HEAD, OPTIONS')
        headers.set('access-control-allow-headers', 'Range')
        headers.set('access-control-expose-headers', 'Content-Length, Content-Range, Accept-Ranges')
        return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers })
    } finally { scoped.close() }
}

async function playback(env, fetchImpl, path, request) {
    const raw = env.VELLUM_ANIME_PLAYBACK_URL
    if (!raw) throw Object.assign(new Error('Anime playback service is not configured'), { code: 'provider_unconfigured' })
    let base
    try { base = new URL(raw.endsWith('/') ? raw : `${raw}/`) } catch { throw Object.assign(new Error('Anime playback URL is invalid'), { code: 'provider_unconfigured' }) }
    if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) throw Object.assign(new Error('Anime playback URL must use HTTPS'), { code: 'provider_unconfigured' })
    return fetchJson(fetchImpl, new URL(path, base), {
        headers: env.VELLUM_ANIME_PLAYBACK_KEY ? { authorization: `Bearer ${env.VELLUM_ANIME_PLAYBACK_KEY}` } : {},
    }, request.signal)
}

const idFromKey = key => String(key || '').match(VIDEO_KEY)?.[1] || null
async function animeForKey(key, request, fetchImpl) {
    const id = idFromKey(key)
    if (!id) throw Object.assign(new Error('Invalid anime key'), { code: 'invalid_request' })
    const data = await anilist(fetchImpl, SERIES_QUERY, { id: Number(id) }, request.signal)
    const row = anime(data?.data?.Media)
    if (!row) throw Object.assign(new Error('Anime not found'), { code: 'not_found' })
    return row
}

async function providerEpisodes(env, fetchImpl, row, language, request) {
    if (env.VELLUM_ANIME_PLAYBACK_URL) {
        const data = await playback(env, fetchImpl, `episodes?anilistId=${encodeURIComponent(idFromKey(row.key))}&language=${language}`, request)
        return (Array.isArray(data) ? data : data?.episodes || []).map(episode).filter(Boolean)
    }
    return (await animeDbEpisodes(env, fetchImpl, row, request)).episodes
}

const ownedSources = data => (Array.isArray(data?.sources) ? data.sources : []).map(source => {
    const sourceUrl = str(source?.url)
    let target
    try { target = new URL(sourceUrl) } catch { return null }
    if (target.protocol !== 'https:') return null
    if (source?.type === 'embed') return { kind: 'embed', url: target.href }
    const type = source?.type === 'hls' || /\.m3u8(?:$|\?)/i.test(sourceUrl) ? 'application/x-mpegURL' : 'video/mp4'
    return { kind: 'direct', url: target.href, type }
}).filter(Boolean)

const ownedSubtitles = data => (Array.isArray(data?.subtitles) ? data.subtitles : []).map(track => ({
    url: str(track?.url), label: str(track?.label) || str(track?.lang), lang: str(track?.language) || str(track?.lang),
})).filter(track => {
    try { return new URL(track.url).protocol === 'https:' && Boolean(track.lang) } catch { return false }
})

async function providerPlayback(env, fetchImpl, row, language, episodeId, request) {
    if (env.VELLUM_ANIME_PLAYBACK_URL) {
        const provider = env.VELLUM_ANIME_PROVIDER || 'default'
        const data = await playback(env, fetchImpl, `sources?episodeId=${encodeURIComponent(episodeId)}&provider=${encodeURIComponent(provider)}&category=${language}`, request)
        return { sources: ownedSources(data), subtitles: ownedSubtitles(data), providerLabel: env.VELLUM_ANIME_PROVIDER_LABEL || 'Miruro' }
    }
    return {
        sources: await animeDbSources(env, fetchImpl, row, language, episodeId, request),
        subtitles: [],
        providerLabel: 'Miruro · pewe (AniDB App)',
    }
}

export async function handleAnimeRequest(request, env = {}, fetchImpl = fetch) {
    const url = new URL(request.url)
    const root = '/read/api/anime/'
    if (request.method !== 'GET' || !url.pathname.startsWith(root)) return failure(404, 'not_found', 'Anime route not found')
    const route = url.pathname.slice(root.length)
    try {
        if (route === 'discover' || route === 'search') {
            const { page, limit, format } = pageArgs(url)
            const search = route === 'search' ? url.searchParams.get('q')?.trim() : null
            if (route === 'search' && !search) return failure(400, 'invalid_request', 'Search query is required')
            if (format && !FORMATS.has(format)) return failure(400, 'invalid_request', 'Invalid anime format')
            const data = await anilist(fetchImpl, PAGE_QUERY, { page, perPage: limit, search, format }, request.signal)
            const results = (data?.data?.Page?.media || []).map(anime).filter(Boolean)
            return json({ page, results, hasMore: Boolean(data?.data?.Page?.pageInfo?.hasNextPage) })
        }

        if (route.startsWith('series/')) {
            const key = decodeURIComponent(route.slice(7))
            if (!idFromKey(key)) return failure(400, 'invalid_request', 'Invalid anime key')
            const row = await animeForKey(key, request, fetchImpl)
            return row ? json(row) : failure(404, 'not_found', 'Anime not found')
        }

        if (route === 'episodes') {
            const key = url.searchParams.get('key') || ''
            const language = url.searchParams.get('language') || 'sub'
            if (!idFromKey(key) || !['sub', 'dub'].includes(language)) return failure(400, 'invalid_request', 'Invalid episode request')
            if (!env.VELLUM_ANIME_PLAYBACK_URL && !env.VELLUM_SLIPGATE_URL) throw Object.assign(new Error('Anime playback service is not configured'), { code: 'provider_unconfigured' })
            const row = env.VELLUM_ANIME_PLAYBACK_URL ? { key } : await animeForKey(key, request, fetchImpl)
            const episodes = await providerEpisodes(env, fetchImpl, row, language, request)
            return json({ key, language, episodes })
        }

        if (route === 'watch') {
            const key = url.searchParams.get('key') || ''
            const language = url.searchParams.get('language') || 'sub'
            const id = url.searchParams.get('id') || ''
            if (!idFromKey(key) || !opaque(id) || !['sub', 'dub'].includes(language)) return failure(400, 'invalid_request', 'Invalid stream request')
            if (!env.VELLUM_ANIME_PLAYBACK_URL && !env.VELLUM_SLIPGATE_URL) throw Object.assign(new Error('Anime playback service is not configured'), { code: 'provider_unconfigured' })
            const row = env.VELLUM_ANIME_PLAYBACK_URL ? { key } : await animeForKey(key, request, fetchImpl)
            const playback = await providerPlayback(env, fetchImpl, row, language, id, request)
            const sources = playback.sources.map(source => source.kind === 'embed'
                ? { url: source.url, type: 'embed' }
                : { url: source.url, type: source.type.includes('mpegURL') ? 'hls' : 'mp4' })
            const subtitles = playback.subtitles.map(track => ({ url: track.url, label: track.label, language: track.lang }))
            if (!sources.length) return failure(502, 'stream_unavailable', 'Playback service returned no playable stream', true)
            return json({ key, language, episode: { id, number: 0, title: null, description: null, image: null, airDate: null }, sources, subtitles })
        }
        return failure(404, 'not_found', 'Anime route not found')
    } catch (error) {
        if (request.signal.aborted || error?.name === 'AbortError') return failure(499, 'request_cancelled', 'Anime request cancelled', true)
        if (error?.code === 'provider_unconfigured') return failure(503, error.code, error.message)
        return failure(502, 'provider_unavailable', route === 'episodes' || route === 'watch' ? 'Anime playback service is unavailable' : 'AniList is unavailable', true)
    }
}

export async function handleAnimeVideoRequest(request, env = {}, fetchImpl = fetch) {
    const url = new URL(request.url)
    const root = '/read/api/video/'
    if (!url.pathname.startsWith(root)) return failure(404, 'not_found', 'Video route not found')
    const route = url.pathname.slice(root.length)
    if (route.startsWith('media/')) {
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
            'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-allow-headers': 'Range',
        } })
        if (!['GET', 'HEAD'].includes(request.method)) return failure(405, 'invalid_request', 'Invalid anime media method')
        return animeDbMedia(env, fetchImpl, route.slice(6), request)
    }
    if (request.method !== 'GET') return failure(404, 'not_found', 'Video route not found')
    try {
        if (route === 'discover') {
            const kind = url.searchParams.get('kind') || 'all'
            if (!['all', 'anime', 'drama'].includes(kind)) return failure(400, 'invalid_request', 'Invalid video kind')
            if (kind === 'drama') return json({ page: 1, results: [], hasMore: false, partial: true, errors: [{ provider: 'miruro', code: 'kind_unavailable', message: 'Anime provider does not serve K-drama' }] })
            const { page, limit, format } = pageArgs(url)
            const search = url.searchParams.get('q')?.trim() || null
            if (format && !FORMATS.has(format)) return failure(400, 'invalid_request', 'Invalid anime format')
            const data = await anilist(fetchImpl, PAGE_QUERY, { page, perPage: limit, search, format }, request.signal)
            const results = (data?.data?.Page?.media || []).map(anime).filter(Boolean).map(item => ({
                ...item, poster: item.cover,
            }))
            return json({ page, results, hasMore: Boolean(data?.data?.Page?.pageInfo?.hasNextPage), partial: false, errors: [] })
        }

        if (route.startsWith('series/')) {
            const key = decodeURIComponent(route.slice(7))
            if (!idFromKey(key)) return failure(400, 'invalid_request', 'Invalid anime key')
            const row = await animeForKey(key, request, fetchImpl)
            const episodes = await providerEpisodes(env, fetchImpl, row, 'sub', request)
            if (!episodes.length) return failure(404, 'not_found', 'No subtitled episodes found')
            return json({ ...row, poster: row.cover, source: 'Miruro · pewe (AniDB App)', episodes, partial: false, errors: [] })
        }

        if (route === 'playback') {
            const key = url.searchParams.get('key') || ''
            const episodeId = url.searchParams.get('id') || ''
            if (!idFromKey(key) || !opaque(episodeId)) return failure(400, 'invalid_request', 'Invalid playback request')
            const row = await animeForKey(key, request, fetchImpl)
            const value = await providerPlayback(env, fetchImpl, row, 'sub', episodeId, request)
            if (!value.sources.length) return failure(502, 'stream_unavailable', 'Playback service returned no playable stream', true)
            return json({ key, episodeId, providerLabel: value.providerLabel, sources: value.sources, subtitles: value.subtitles })
        }
        return failure(404, 'not_found', 'Video route not found')
    } catch (error) {
        if (request.signal.aborted || error?.name === 'AbortError') return failure(499, 'request_cancelled', 'Video request cancelled', true)
        if (error?.code === 'provider_unconfigured') return failure(503, error.code, error.message)
        if (error?.code === 'invalid_request') return failure(400, error.code, error.message)
        if (error?.code === 'not_found') return failure(404, error.code, error.message)
        return failure(502, 'provider_unavailable', 'Anime provider is unavailable', true)
    }
}

export default { fetch: (request, env) => handleAnimeRequest(request, env) }
