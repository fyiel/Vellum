const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'
const MINUTE = 60_000
const HOUR = 60 * MINUTE

// cineby.su now 301s to flixer.su: the __NEXT_DATA__ pages this provider used to walk are gone,
// and every listing, detail and season payload comes from an open TMDB passthrough on a sibling
// host of the same family. The passthrough answers identically on each live member, so one is
// kept as a failover for when the primary rotates away.
const API_HOSTS = ['https://plsdontscrapemelove.flixer.su', 'https://plsdontscrapemelove.flixer.gd']
let apiHost = API_HOSTS[0]
const TMDB_IMAGE = 'https://image.tmdb.org/t/p'
const LISTING = 'trending/all/day'
const RETRY_DELAY = 400
const FETCH_BUDGET = 9_000
// the source endpoint makes the site's scraper fetch upstreams live, so it gets a longer budget
const SOURCE_BUDGET = 20_000
const SOURCE_FIELDS = ['url', 'file', 'src', 'hls', 'embed', 'iframe', 'link', 'm3u8']
// subtitle track sets are published separately, either one can be missing
const SUBTITLE_SOURCES = ['v1', 'v2']
const SUBTITLE_HOST = 'https://sub.vdrk.site'

const str = value => typeof value === 'string' ? value : null
const num = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
const tmdbId = key => String(key || '').match(/^cineby:(\d+)$/)?.[1] || null
const EPISODE = /^s(\d+)e(\d+)$/
const timeout = (parent, ms = 12_000) => {
    const ctrl = new AbortController()
    const abort = () => ctrl.abort()
    if (parent?.aborted) abort()
    else parent?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, ms)
    return { signal: ctrl.signal, close: () => { clearTimeout(timer); parent?.removeEventListener('abort', abort) } }
}

const clean = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || null
const httpsUrl = value => {
    if (typeof value !== 'string' || !value) return null
    try { return new URL(value).protocol === 'https:' ? value : null } catch { return null }
}
const yearOf = value => num(String(value || '').slice(0, 4))
const imageUrl = (path, size) => httpsUrl(path) || (typeof path === 'string' && path.startsWith('/') ? `${TMDB_IMAGE}/${size}${path}` : null)
const EMBED_HOSTS = ['embed.test', 'ok.test']
// the app origin comes from request headers (Origin on cross-origin fetches, Referer otherwise);
// embeds pointing back at the app would run same-origin with it once the sandbox is gone
const appHost = request => {
    const source = request.headers?.get?.('origin') || request.headers?.get?.('referer')
    if (!source) return null
    try { return new URL(source).hostname } catch { return null }
}
const embedUrl = (value, request) => {
    let target
    try { target = new URL(value) } catch { return null }
    if (target.protocol !== 'https:') return null
    const host = target.hostname
    const origin = appHost(request)
    if (host === new URL(request.url).hostname || (origin && host === origin)) return null
    return EMBED_HOSTS.some(base => host === base || host.endsWith(`.${base}`)) ? target.href : null
}

// the shared `cached` has no stale window and no negative caching, and this provider cannot let a
// failed scrape look like an empty catalogue: an expired entry keeps being served while the
// refresh runs behind the request, a failed refresh never drops the last good copy, and a failure
// is stored as an error (never as content) for a short while so one blip cannot hide a title
const CACHES = new WeakMap()
const cacheOf = fetchImpl => {
    let cache = CACHES.get(fetchImpl)
    if (!cache) { cache = new Map(); CACHES.set(fetchImpl, cache) }
    return cache
}
const cachedFor = (fetchImpl, key, ttl, load, options = {}) => {
    const { staleMs = 12 * HOUR, negTtl = 30_000, accept = value => value != null } = options
    const cache = cacheOf(fetchImpl)
    const now = Date.now()
    const entry = cache.get(key)
    if (entry?.pending) return entry.pending
    if (entry?.value !== undefined && entry.expires > now) return Promise.resolve(entry.value)
    if (entry?.error !== undefined && entry.errorUntil > now) return Promise.reject(entry.error)
    const stale = entry?.value !== undefined && entry.staleUntil > now ? entry.value : undefined
    const pending = load().then(
        value => {
            if (!accept(value)) throw Object.assign(new Error('Cineby returned an empty payload'), { code: 'provider_unavailable' })
            const seen = Date.now()
            cache.set(key, { value, expires: seen + ttl, staleUntil: seen + ttl + staleMs })
            return value
        },
        error => {
            if (stale === undefined) cache.set(key, { error, errorUntil: Date.now() + negTtl })
            else cache.set(key, { value: stale, expires: 0, staleUntil: Date.now() + staleMs })
            throw error
        },
    )
    if (stale !== undefined) {
        pending.catch(() => {})
        cache.set(key, { value: stale, expires: 0, staleUntil: entry.staleUntil, pending })
        return Promise.resolve(stale)
    }
    cache.set(key, { pending })
    if (cache.size > 64) cache.delete(cache.keys().next().value)
    return pending
}

const retryable = error => error?.status === 429 || (num(error?.status) ?? 0) >= 500 || error?.transport === true

// one host, one attempt: a request is only repeated (with backoff) for a failure that a retry can
// actually fix, and the last attempt moves to the sibling host instead of hammering a dead one
async function requestJson(ctx, url, budget) {
    const scoped = timeout(ctx.request?.signal, budget)
    try {
        const response = await ctx.fetchImpl(url, { signal: scoped.signal, headers: { accept: 'application/json, text/plain', 'user-agent': BROWSER_UA } })
        const type = response.headers?.get?.('content-type') || ''
        if (!response.ok) throw Object.assign(new Error(`http ${response.status}`), { status: response.status, code: response.status === 404 ? 'not_found' : 'provider_unavailable' })
        const body = await response.text()
        // a rotated or parked domain answers 200 with HTML or plain text here; that is never content
        if (!type.includes('json')) throw Object.assign(new Error(`Cineby answered ${type || 'no content type'} instead of JSON`), { code: 'provider_unavailable', transport: true })
        try { return JSON.parse(body) } catch { throw Object.assign(new Error('Cineby answered unparsable JSON'), { code: 'provider_unavailable', transport: true }) }
    } catch (error) {
        if (error?.name !== 'AbortError') {
            if (error?.status === undefined && error?.code === undefined) error.transport = true
            throw error
        }
        // our own budget elapsed: retryable, unlike a client that hung up on us
        if (ctx.request?.signal?.aborted) throw error
        throw Object.assign(new Error('Cineby timed out'), { code: 'provider_unavailable', transport: true })
    } finally { scoped.close() }
}

const apiUrl = path => new URL(`/api/tmdb/${path}`, apiHost).href

async function apiJson(ctx, path, budget = FETCH_BUDGET) {
    let failure = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt === 2) apiHost = API_HOSTS.find(host => host !== apiHost) || apiHost
        try {
            return await requestJson(ctx, apiUrl(path), budget)
        } catch (error) {
            failure = error
            if (!retryable(error) || ctx.request?.signal?.aborted) throw error
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (attempt + 1)))
        }
    }
    throw failure
}

// a key only carries the TMDB id, so the type is probed: cineby.su served every title from
// /movie/<id>, so movie wins when an id happens to exist in both TMDB namespaces
const mediaFor = (ctx, id) => cachedFor(ctx.fetchImpl, `cineby:media:${id}`, 2 * HOUR, async () => {
    const failures = []
    for (const type of ['movie', 'tv']) {
        try {
            const media = await apiJson(ctx, `${type}/${id}`)
            if (media && (str(media.title) || str(media.name))) return { type, media }
            failures.push(Object.assign(new Error('Cineby title not found'), { code: 'not_found' }))
        } catch (error) { failures.push(error) }
    }
    throw failures.find(error => error?.code !== 'not_found') || Object.assign(new Error('Cineby title not found'), { code: 'not_found' })
}, { negTtl: 60_000, accept: value => value?.media != null })

const seasonFor = (ctx, id, season) => cachedFor(ctx.fetchImpl, `cineby:season:${id}:${season}`, 2 * HOUR,
    () => apiJson(ctx, `tv/${id}/season/${season}`),
    { accept: value => Array.isArray(value?.episodes), negTtl: 60_000 })

const movieEpisode = media => [{
    id: 's1e1', number: 1, season: 1, title: clean(media.title) || 'Movie',
    description: clean(media.overview), image: imageUrl(media.backdrop_path || media.poster_path, 'w500'),
    airDate: str(media.release_date),
}]

const episode = (season, item) => {
    const number = num(item?.episode_number)
    if (number == null) return null
    return {
        id: `s${season}e${number}`, number, season,
        title: clean(item?.name) || `Episode ${number}`, description: clean(item?.overview),
        image: imageUrl(item?.still_path, 'w300'), airDate: str(item?.air_date),
    }
}

// the season summary on the show payload already lists how many episodes a season holds, so a
// season that fails to load still yields a usable list instead of emptying the series
const seasonFallback = (season, summary) => Array.from({ length: Math.min(num(summary?.episode_count) || 0, 500) }, (unused, index) => ({
    id: `s${season}e${index + 1}`, number: index + 1, season, title: `Episode ${index + 1}`,
    description: null, image: imageUrl(summary?.poster_path, 'w300'), airDate: null,
}))

const mapLimit = async (items, limit, load) => {
    const out = new Array(items.length)
    let next = 0
    const worker = async () => { while (next < items.length) { const index = next++; out[index] = await load(items[index], index) } }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    return out
}

const row = (item, id, title) => ({
    key: `cineby:${id}`, kind: 'anime', title,
    poster: imageUrl(item?.poster_path, 'w500'),
    year: yearOf(item?.release_date || item?.first_air_date),
})

const rows = data => {
    const seen = new Set()
    const list = []
    for (const item of Array.isArray(data?.results) ? data.results : []) {
        const id = num(item?.id)
        const title = clean(item?.title) || clean(item?.name)
        const media = item?.media_type === 'tv' ? 'tv' : item?.media_type === 'movie' ? 'movie' : null
        if (id == null || !title || !media || seen.has(id)) continue
        seen.add(id)
        list.push(row(item, id, title))
    }
    return list
}

export async function discover(ctx, options = {}) {
    const { page = 1, limit = 24, search = null } = options
    const query = str(search)?.trim()
    const path = query ? `search/multi?query=${encodeURIComponent(query)}&page=${page}` : `${LISTING}?page=${page}`
    try {
        const data = await cachedFor(ctx.fetchImpl, `cineby:listing:${path}`, query ? 30 * MINUTE : 6 * HOUR,
            () => apiJson(ctx, path), { accept: value => Array.isArray(value?.results) })
        const found = rows(data)
        if (!found.length && !query) throw Object.assign(new Error('Cineby listing contained no titles'), { code: 'provider_unavailable' })
        const total = num(data?.total_pages)
        return { rows: found.slice(0, limit), hasMore: total == null ? false : Number(page) < total, partial: false, error: null }
    } catch (error) {
        return { rows: [], hasMore: false, partial: true, error: { provider: 'cineby', code: 'provider_unavailable', message: 'Cineby listing is unavailable' } }
    }
}

export async function series(ctx, key) {
    const id = tmdbId(key)
    if (!id) throw Object.assign(new Error('Invalid Cineby key'), { code: 'invalid_request' })
    const { media } = await mediaFor(ctx, id)
    return {
        key, kind: 'anime',
        title: clean(media.title) || clean(media.name) || 'Untitled',
        poster: imageUrl(media.poster_path, 'w500'),
        synopsis: clean(media.overview),
        year: yearOf(media.release_date || media.first_air_date),
    }
}

export async function episodes(ctx, key) {
    const id = tmdbId(key)
    if (!id) throw Object.assign(new Error('Invalid Cineby key'), { code: 'invalid_request' })
    const { type, media } = await mediaFor(ctx, id)
    if (type === 'movie') return movieEpisode(media)
    const seasons = (Array.isArray(media.seasons) ? media.seasons : [])
        .filter(season => num(season?.season_number) != null && (num(season?.episode_count) == null || num(season.episode_count) > 0))
    const listed = await mapLimit(seasons, 4, async season => {
        const number = num(season.season_number)
        try {
            const data = await seasonFor(ctx, id, number)
            const items = data.episodes.map(item => episode(number, item)).filter(Boolean)
            if (items.length) return items
        } catch (error) { if (ctx.request?.signal?.aborted) throw error }
        return seasonFallback(number, season)
    })
    const found = listed.flat().sort((a, b) => a.season - b.season || a.number - b.number)
    if (found.length) return found
    return [{
        id: 's1e1', number: 1, season: 1, title: clean(media.name) || 'Episode 1',
        description: null, image: imageUrl(media.backdrop_path || media.poster_path, 'w500'), airDate: null,
    }]
}

const collectUrls = (node, out = [], depth = 0) => {
    if (node == null || depth > 6 || out.length >= 8) return out
    if (typeof node === 'string') {
        if (httpsUrl(node)) out.push(node)
        return out
    }
    if (Array.isArray(node)) {
        for (const item of node) collectUrls(item, out, depth + 1)
        return out
    }
    if (typeof node === 'object') {
        for (const field of SOURCE_FIELDS) if (typeof node[field] === 'string') collectUrls(node[field], out, depth + 1)
        for (const value of Object.values(node)) if (value && typeof value === 'object') collectUrls(value, out, depth + 1)
    }
    return out
}

const sourceOf = (url, request) => {
    if (/\.m3u8|\/manifest|mpegurl/i.test(url)) return { kind: 'direct', url: new URL(url).href, type: 'application/x-mpegURL' }
    if (/\.mp4(\?|$)|\/video\.mp4/i.test(url)) return { kind: 'direct', url: new URL(url).href, type: 'video/mp4' }
    const embed = embedUrl(url, request)
    return embed ? { kind: 'embed', url: embed } : null
}

// the source endpoint is the site's scraper front end. The browser build signs every call and
// decrypts the answer with a WASM key, so a signed or empty answer is an outage here, never
// content: only the plain shapes this backend also serves are read
const sourcePayload = (ctx, path) => cachedFor(ctx.fetchImpl, `cineby:sources:${path}`, 10 * MINUTE, async () => {
    const scoped = timeout(ctx.request?.signal, SOURCE_BUDGET)
    try {
        const response = await ctx.fetchImpl(apiUrl(path), {
            signal: scoped.signal,
            headers: { accept: 'application/json, text/plain', 'user-agent': BROWSER_UA, 'x-only-sources': '1' },
        })
        const body = await response.text()
        if (!response.ok) throw Object.assign(new Error(`http ${response.status}${body ? ` ${clean(body).slice(0, 120)}` : ''}`), { status: response.status, code: 'stream_unavailable' })
        let data
        try { data = JSON.parse(body) } catch {
            throw Object.assign(new Error('Cineby sources are signed by the site and cannot be read'), { code: 'stream_unavailable' })
        }
        const urls = collectUrls(data?.sources ?? data, [])
        // an answer we can read that holds no usable https source is the title having none (the
        // site's own backend answers 403 {"code":"500","error":"no sources found"} for those), so it
        // fails as an unplayable stream rather than as an outage of the provider
        if (!urls.length) throw Object.assign(new Error('Cineby returned no playable stream'), { code: 'stream_unavailable' })
        return urls
    } catch (error) {
        if (error?.name === 'AbortError' && !ctx.request?.signal?.aborted) throw Object.assign(new Error('Cineby timed out resolving sources'), { code: 'stream_unavailable' })
        if (error?.name === 'AbortError') throw error
        if (error?.code === undefined && error?.status === undefined) throw Object.assign(error, { code: 'stream_unavailable' })
        throw error
    } finally { scoped.close() }
}, { staleMs: 10 * MINUTE, negTtl: 60_000 })

const subtitleUrl = (version, type, id, episodeId) => {
    const match = EPISODE.exec(String(episodeId || ''))
    const path = type === 'movie' ? `movie/${id}` : `tv/${id}/${match[1]}/${match[2]}`
    return `${SUBTITLE_HOST}/${version}/${path}`
}

// track sets live on a second host and either version can be missing, so both are best effort
const subtitlesFor = async (ctx, type, id, episodeId) => {
    const sets = await Promise.all(SUBTITLE_SOURCES.map(async version => {
        try {
            return await cachedFor(ctx.fetchImpl, `cineby:subs:${version}:${type}:${id}:${episodeId}`, 12 * HOUR,
                () => requestJson(ctx, subtitleUrl(version, type, id, episodeId), FETCH_BUDGET),
                { accept: value => Array.isArray(value), negTtl: 10 * MINUTE })
        } catch { return [] }
    }))
    const seen = new Set()
    const tracks = []
    for (const set of sets) {
        for (const track of set) {
            const url = httpsUrl(track?.file) || httpsUrl(track?.url)
            const label = clean(track?.label)
            if (!url || !label || seen.has(url)) continue
            seen.add(url)
            tracks.push({ url, label, lang: clean(track?.language) || label })
        }
    }
    return tracks
}

export async function playback(ctx, key, language, episodeId) {
    const id = tmdbId(key)
    const match = EPISODE.exec(String(episodeId || ''))
    if (!id || !match) throw Object.assign(new Error('Invalid Cineby episode'), { code: 'invalid_request' })
    const { type, media } = await mediaFor(ctx, id)
    let path
    if (type === 'movie') {
        if (episodeId !== 's1e1') throw Object.assign(new Error('Cineby title has no such episode'), { code: 'not_found' })
        path = `movie/${id}/images`
    } else {
        const season = Number(match[1])
        const number = Number(match[2])
        const data = await seasonFor(ctx, id, season)
        if (!data.episodes.some(item => num(item?.episode_number) === number)) throw Object.assign(new Error('Cineby episode not found'), { code: 'not_found' })
        path = `tv/${id}/season/${season}/episode/${number}/images`
    }
    const urls = await sourcePayload(ctx, path)
    const seen = new Set()
    const sources = []
    for (const url of urls) {
        const source = sourceOf(url, ctx.request)
        if (!source || seen.has(source.url)) continue
        seen.add(source.url)
        sources.push(source)
    }
    // every validated source is handed back, not just the direct ones: the player uses the embeds
    // as further servers for the same episode
    if (!sources.length) throw Object.assign(new Error('Cineby returned no playable stream'), { code: 'stream_unavailable' })
    const subtitles = await subtitlesFor(ctx, type, id, episodeId)
    return { sources, subtitles, providerLabel: 'Cineby' }
}

export const cineby = {
    key: 'cineby', label: 'Cineby', kinds: ['anime'], source: 'Cineby',
    discover, series, episodes, playback,
}
