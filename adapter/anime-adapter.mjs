const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const ANILIST = 'https://graphql.anilist.co'
const FORMATS = new Set(['TV', 'MOVIE', 'OVA', 'ONA', 'SPECIAL', 'MUSIC'])
const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
const str = value => typeof value === 'string' ? value : null
const num = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: JSON_HEADERS })
const failure = (status, code, message, retryable = false) => json({ error: { provider: 'miruro', code, message, retryable } }, status)

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
            if (!key.startsWith('miruro:') || !/^\d+$/.test(key.slice(7))) return failure(400, 'invalid_request', 'Invalid anime key')
            const data = await anilist(fetchImpl, SERIES_QUERY, { id: Number(key.slice(7)) }, request.signal)
            const row = anime(data?.data?.Media)
            return row ? json(row) : failure(404, 'not_found', 'Anime not found')
        }

        if (route === 'episodes') {
            const key = url.searchParams.get('key') || ''
            const language = url.searchParams.get('language') || 'sub'
            if (!key.startsWith('miruro:') || !/^\d+$/.test(key.slice(7)) || !['sub', 'dub'].includes(language)) return failure(400, 'invalid_request', 'Invalid episode request')
            const data = await playback(env, fetchImpl, `episodes?anilistId=${encodeURIComponent(key.slice(7))}&language=${language}`, request)
            const episodes = (Array.isArray(data) ? data : data?.episodes || []).map(episode).filter(Boolean)
            return json({ key, language, episodes })
        }

        if (route === 'watch') {
            const key = url.searchParams.get('key') || ''
            const language = url.searchParams.get('language') || 'sub'
            const id = url.searchParams.get('id') || ''
            if (!key.startsWith('miruro:') || !/^\d+$/.test(key.slice(7)) || !opaque(id) || !['sub', 'dub'].includes(language)) return failure(400, 'invalid_request', 'Invalid stream request')
            const provider = env.VELLUM_ANIME_PROVIDER || 'default'
            const data = await playback(env, fetchImpl, `sources?episodeId=${encodeURIComponent(id)}&provider=${encodeURIComponent(provider)}&category=${language}`, request)
            const sources = (Array.isArray(data?.sources) ? data.sources : []).map(source => {
                const sourceUrl = str(source?.url)
                try { if (new URL(sourceUrl).protocol !== 'https:') return null } catch { return null }
                return { url: sourceUrl, quality: str(source.quality), type: source?.type === 'hls' || /\.m3u8(?:$|\?)/i.test(sourceUrl) ? 'hls' : 'mp4' }
            }).filter(Boolean)
            const subtitles = (Array.isArray(data?.subtitles) ? data.subtitles : []).map(track => ({ url: str(track?.url), label: str(track?.label) || str(track?.lang), language: str(track?.language) })).filter(track => {
                try { return new URL(track.url).protocol === 'https:' } catch { return false }
            })
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

export default { fetch: (request, env) => handleAnimeRequest(request, env) }
