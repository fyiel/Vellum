import { dramacooli } from './providers/dramacooli.mjs'
import { cineby } from './providers/cineby.mjs'
import { goplay } from './providers/goplay.mjs'
import { kisskh } from './providers/kisskh.mjs'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }
const ANILIST = 'https://graphql.anilist.co'
const ANIDB = 'https://anidb.app'
const ANIDB_LABEL = 'Miruro · pewe (AniDB App)'
const HIANIME_LABEL = 'HiAnime'
const FORMATS = new Set(['TV', 'MOVIE', 'OVA', 'ONA', 'SPECIAL', 'MUSIC'])
const PROVIDER_KEY = /^(miruro|dc|gp|cineby|kiss):(.+)$/
const PROVIDER_IDS = { miruro: /^\d+$/, dc: /^[a-z0-9._-]{1,100}$/, gp: /^[a-z0-9._-]{1,100}$/, cineby: /^\d+$/, kiss: /^\d+$/ }
const ANIDB_EPISODE = /^anidbapp:(\d+):(\d+)$/
const ANIDB_MEDIA = /^[A-Za-z0-9_-]{32}\/[A-Za-z0-9._~/-]{1,500}$/
const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
const str = value => typeof value === 'string' ? value : null
const num = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: JSON_HEADERS })
const failure = (status, code, message, retryable = false, provider = 'miruro') => json({ error: { provider, code, message, retryable } }, status)
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
// search is unfiltered (miruro parity — unreleased titles show when looked up); the no-query
// feed excludes NOT_YET_RELEASED so browsing surfaces watchable titles. format is a declared but
// omittable variable: omitting it keeps the unfiltered query, while a value filters and paginates
// server side. filtering the returned page in the app instead threw away most of every page and
// reported hasMore for titles the reader could never reach, so the filter only ever looked empty.
// a format-less search does not even declare the variable — AniList answers an explicit null
// format with an empty page and the plain search has to stay unfiltered — so the declaring
// query is only used once the reader actually names a format.
const PAGE_QUERY = `query($page:Int,$perPage:Int,$search:String){Page(page:$page,perPage:$perPage){pageInfo{hasNextPage} media(type:ANIME,search:$search,sort:[TRENDING_DESC,POPULARITY_DESC]){${MEDIA_FIELDS}}}}`
const PAGE_FORMAT_QUERY = `query($page:Int,$perPage:Int,$search:String,$format:MediaFormat){Page(page:$page,perPage:$perPage){pageInfo{hasNextPage} media(type:ANIME,search:$search,format:$format,sort:[TRENDING_DESC,POPULARITY_DESC]){${MEDIA_FIELDS}}}}`
const FEED_QUERY = `query($page:Int,$perPage:Int,$format:MediaFormat){Page(page:$page,perPage:$perPage){pageInfo{hasNextPage} media(type:ANIME,format:$format,status_not:NOT_YET_RELEASED,sort:[TRENDING_DESC,POPULARITY_DESC]){${MEDIA_FIELDS}}}}`
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

const anilist = async (fetchImpl, query, variables) => {
    try {
        return await fetchJson(fetchImpl, ANILIST, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }),
        }, budgetSignal(null, ANILIST_BUDGET))
    } catch (error) { throw upstreamError(error) }
}

// entries live per fetchImpl and carry two clocks: expires bounds freshness, keep bounds the
// stale window that still answers from the last good copy while the refresh runs behind the
// request. a refresh that fails never drops that copy, it only widens the retry gap, and a load
// that fails is remembered for negTtl (0 keeps the old forget-on-error behaviour) so one blip
// cannot turn into a request storm against the source.
const CACHE_MAX = 100
const CACHE_RETRY_MS = 60_000

const cachePut = (entries, key, entry) => {
    entries.delete(key)
    if (entries.size >= CACHE_MAX) {
        const now = Date.now()
        for (const [entryKey, stored] of entries) if (stored.keep <= now) entries.delete(entryKey)
        while (entries.size >= CACHE_MAX) entries.delete(entries.keys().next().value)
    }
    entries.set(key, entry)
}

const cacheAccept = (accept, value) => {
    try { return Boolean(accept(value)) } catch { return false }
}

export const cached = (fetchImpl, key, ttl, load, negTtl = 0, accept = value => value !== null && value !== undefined, staleMs = 0) => {
    let state = providerCache.get(fetchImpl)
    if (!state) { state = { entries: new Map(), refreshing: new Set() }; providerCache.set(fetchImpl, state) }
    const { entries, refreshing } = state
    const now = Date.now()
    const hit = entries.get(key)

    if (hit) {
        // fresh, pending or negatively cached: the stored promise is the single answer everyone
        // waiting on this key shares
        if (hit.expires > now) {
            entries.delete(key)
            entries.set(key, hit)
            return hit.value
        }
        if (hit.ok && hit.keep > now) {
            entries.delete(key)
            entries.set(key, hit)
            if (!refreshing.has(key)) {
                refreshing.add(key)
                load().then(value => {
                    if (cacheAccept(accept, value)) {
                        cachePut(entries, key, { value: Promise.resolve(value), expires: Date.now() + ttl, keep: Date.now() + ttl + staleMs, ok: true })
                    } else {
                        hit.expires = Date.now() + (negTtl || CACHE_RETRY_MS)
                    }
                }).catch(() => { hit.expires = Date.now() + (negTtl || CACHE_RETRY_MS) }).finally(() => refreshing.delete(key))
            }
            return hit.value
        }
    }

    const entry = { value: null, expires: now + ttl, keep: now + ttl + staleMs, ok: false }
    const promise = Promise.resolve().then(load)
    entry.value = promise
    cachePut(entries, key, entry)
    promise.then(value => {
        const ok = cacheAccept(accept, value)
        entry.ok = ok
        const at = Date.now()
        const lifetime = ok ? ttl : negTtl
        entry.expires = at + lifetime
        entry.keep = at + lifetime + (ok ? staleMs : 0)
        if (lifetime > 0) { entries.delete(key); entries.set(key, entry) } else entries.delete(key)
    }, () => {
        if (negTtl > 0) {
            entry.expires = Date.now() + negTtl
            entry.keep = entry.expires
            entries.delete(key)
            entries.set(key, entry)
        } else entries.delete(key)
    })
    // a rejected load may sit in the map until negTtl passes, and nothing may be awaiting it
    promise.catch(() => {})
    return promise
}

// per source budgets sit below the shared 12s fetch cap: a slow source loses its turn instead of
// holding the reader. the abort is translated, because a source timeout is an upstream failure
// and not a request the reader cancelled
const ANILIST_BUDGET = 9_000
const HIANIME_BUDGET = 9_000
// a healthy slipgate anidb call answers in 0.3-0.6s, but a challenged or maintenance-served one
// rides the shared 12s cap and parks the reader in front of the fallback for that whole time
const SLIPGATE_BUDGET = 8_000

const budgetSignal = (parent, ms) => parent ? AbortSignal.any([parent, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)

const upstreamError = (error, parent) => {
    if (parent?.aborted) return error
    if (error?.name !== 'AbortError' && error?.name !== 'TimeoutError') return error
    return Object.assign(new Error('Anime source timed out'), { code: 'provider_unavailable', cause: error })
}

// AniList rate limits by IP and the same page is asked for by the anime routes, the video
// discover route and the miruro provider, so every page query goes through one cache entry per
// page instead of one AniList round trip per reader. a search page is worth caching even when it
// is empty (that is a real answer), the trending feed is not.
const ANILIST_SEARCH_TTL = 6 * 60 * 60_000
const ANILIST_FEED_TTL = 6 * 60 * 60_000
const ANILIST_STALE_MS = 12 * 60 * 60_000
const ANILIST_NEG_MS = 60_000

// pageArgs hands back null for "no format", and AniList answers an explicit null format with an
// empty page, so the variable has to be absent rather than null when the reader did not ask for
// one.
const anilistPage = (fetchImpl, { page, limit, search, format }) => {
    const wanted = format || undefined
    // the format-declaring search query only when a format is asked for, so a plain search is
    // never sent a format variable at all
    const query = search ? (wanted ? PAGE_FORMAT_QUERY : PAGE_QUERY) : FEED_QUERY
    const variables = search ? { page, perPage: limit, search, format: wanted } : { page, perPage: limit, format: wanted }
    return cached(fetchImpl,
        `anilist:page:${search ? `s:${search.toLowerCase()}` : 'feed'}:${wanted ?? ''}:${page}:${limit}`,
        search ? ANILIST_SEARCH_TTL : ANILIST_FEED_TTL,
        () => anilist(fetchImpl, query, variables),
        ANILIST_NEG_MS,
        data => Array.isArray(data?.data?.Page?.media) && (search || wanted ? true : data.data.Page.media.length > 0),
        ANILIST_STALE_MS)
}

const pageResults = data => (data?.data?.Page?.media || []).map(anime).filter(Boolean)

const pageMore = data => Boolean(data?.data?.Page?.pageInfo?.hasNextPage)

const slipgateBase = env => {
    const raw = env.VELLUM_SLIPGATE_URL
    if (!raw) throw Object.assign(new Error('Anime playback service is not configured'), { code: 'provider_unconfigured' })
    let base
    try { base = new URL(raw.endsWith('/') ? raw : `${raw}/`) } catch { throw Object.assign(new Error('Slipgate URL is invalid'), { code: 'provider_unconfigured' }) }
    if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) throw Object.assign(new Error('Slipgate URL must use HTTPS'), { code: 'provider_unconfigured' })
    return base
}

async function slipgateJson(env, fetchImpl, path, payload) {
    try {
        return await fetchJson(fetchImpl, new URL(path, slipgateBase(env)), {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(env.VELLUM_SLIPGATE_KEY ? { 'x-slipgate-key': env.VELLUM_SLIPGATE_KEY } : {}),
            },
            body: JSON.stringify(payload),
        }, budgetSignal(null, SLIPGATE_BUDGET))
    } catch (error) { throw upstreamError(error) }
}

const normalizeTitle = value => String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '')
const htmlEntities = value => value.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
const htmlAttr = (tag, name) => htmlEntities(tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2] || '')
const base64url = value => btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromBase64url = value => {
    try { return atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')) } catch { return '' }
}

async function animeDbFetch(env, fetchImpl, target) {
    const data = await slipgateJson(env, fetchImpl, 'anidb/fetch', { url: target })
    if (!data?.ok || data.status !== 200 || typeof data.body !== 'string') throw new Error(data?.error || 'AniDB transport failed')
    // AniDB App serves a static maintenance page with a 200 through Cloudflare, treat it as an
    // outage so the backend chain cools AniDB down and the fallback answers instead
    if (data.body.includes('Under Maintenance')) throw new Error('AniDB App is under maintenance')
    return data.body
}

// exact normalized match wins, otherwise the closest prefix match (one title is the other plus
// a suffix, e.g. year or season markers). Plain containment is too loose, it maps "THE ONE
// PIECE" (the 2026 remake) onto "One Piece".
const titleMatch = (candidates, titles) => {
    const names = [...new Set(titles.map(normalizeTitle).filter(Boolean))]
    let best = null
    for (const candidate of candidates) {
        const norm = normalizeTitle(candidate.title)
        if (!norm) continue
        if (names.includes(norm)) return candidate
        for (const name of names) {
            const min = Math.min(norm.length, name.length)
            if (min < 8) continue // too short to prefix match safely
            if (norm.slice(0, min) !== name.slice(0, min)) continue
            const gap = Math.abs(norm.length - name.length)
            if (!best || gap < best.gap) best = { ...candidate, gap }
        }
    }
    return best
}

// slipgate answers a maintenance window or a Cloudflare miss with a fast error, and the app used
// to re-probe it on every request until the ten minute backend cooldown expired. a failure is
// remembered briefly, a positive mapping for six hours with a day of stale service behind it.
const ANIDB_STALE_MS = 24 * 60 * 60_000
const ANIDB_NEG_MS = 5 * 60_000
// slipgate mints the pewe media capability with a twenty minute life, so a resolved source may
// only be reused inside a fraction of that
const SOURCES_TTL = 5 * 60_000

async function animeDbSeries(env, fetchImpl, row) {
    return cached(fetchImpl, `anidb:series:${row.key}`, 6 * 60 * 60_000, async () => {
        const url = new URL('/browse', ANIDB)
        url.searchParams.set('q', row.title)
        const body = await animeDbFetch(env, fetchImpl, url.href)
        const candidates = []
        for (const match of body.matchAll(/<a\b[^>]*>/gi)) {
            const title = htmlAttr(match[0], 'title')
            if (title) candidates.push({ title, href: htmlAttr(match[0], 'href') })
        }
        const best = titleMatch(candidates, [row.title, ...row.alternateTitles])
        if (!best) throw Object.assign(new Error('AniDB could not map this Miruro title'), { code: 'not_found' })
        let target
        try { target = new URL(best.href, ANIDB) } catch { throw Object.assign(new Error('AniDB could not map this Miruro title'), { code: 'not_found' }) }
        const id = target.origin === ANIDB ? target.pathname.match(/^\/anime\/[a-z0-9-]+-(\d+)$/i)?.[1] : null
        if (!id) throw Object.assign(new Error('AniDB could not map this Miruro title'), { code: 'not_found' })
        return { id, title: best.title }
    }, ANIDB_NEG_MS, series => Boolean(series?.id), ANIDB_STALE_MS)
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

async function animeDbEpisodes(env, fetchImpl, row) {
    return cached(fetchImpl, `anidb:episodes:${row.key}`, 2 * 60 * 60_000, async () => {
        const series = await animeDbSeries(env, fetchImpl, row)
        const body = await animeDbFetch(env, fetchImpl, `${ANIDB}/api/frontend/anime/${series.id}/episodes`)
        const data = JSON.parse(body)
        const episodes = (Array.isArray(data?.episodes) ? data.episodes : []).map(value => animeDbEpisode(series.id, value)).filter(Boolean)
        if (!episodes.length) throw Object.assign(new Error('AniDB returned no episodes'), { code: 'not_found' })
        return { series, episodes }
    }, ANIDB_NEG_MS, value => Boolean(value?.episodes?.length), ANIDB_STALE_MS)
}

const animeDbEpisodeId = value => fromBase64url(value).match(ANIDB_EPISODE)

async function animeDbSources(env, fetchImpl, row, language, episodeId) {
    const match = animeDbEpisodeId(episodeId)
    if (!match) throw Object.assign(new Error('Invalid Miruro pewe episode'), { code: 'not_found' })
    const { series } = await animeDbEpisodes(env, fetchImpl, row)
    if (match[1] !== series.id) throw Object.assign(new Error('Episode does not belong to this series'), { code: 'not_found' })
    // the episode id already names its series and episode, and the minted media path lives twenty
    // minutes, so one entry per episode and language serves the immediate replay
    return cached(fetchImpl, `anidb:sources:${episodeId}:${language}`, SOURCES_TTL, async () => {
        const data = await slipgateJson(env, fetchImpl, 'anidb/source', {
            series_id: Number(series.id), episode_id: Number(match[2]), language,
        })
        if (!data?.ok || data.provider !== 'pewe' || data.category !== language || data.source_id !== episodeId) {
            throw new Error(data?.error || 'Miruro pewe source identity changed')
        }
        if (typeof data.media_path !== 'string' || !data.media_path.startsWith('/anidb/media/')) throw new Error('AniDB returned no proxied media')
        const media = data.media_path.slice('/anidb/media/'.length)
        if (!ANIDB_MEDIA.test(media)) throw new Error('AniDB returned an invalid media capability')
        return [{ kind: 'direct', url: `/read/api/video/media/${media}`, type: 'application/x-mpegURL' }]
    }, 60_000, sources => Array.isArray(sources) && sources.length > 0)
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
        // Chromium's ORB blocks cross-origin no-cors media it does not trust; slipgate's own
        // content-type is not a recognized media type, so force the known anidb HLS chain types
        if (/\.m3u8(?:$|\?)/i.test(media)) headers.set('content-type', 'application/vnd.apple.mpegurl')
        else if (/\.xls(?:$|\?)/i.test(media)) headers.set('content-type', 'video/mp2t')
        headers.set('access-control-allow-origin', '*')
        headers.set('access-control-allow-methods', 'GET, HEAD, OPTIONS')
        headers.set('access-control-allow-headers', 'Range')
        headers.set('access-control-expose-headers', 'Content-Length, Content-Range, Accept-Ranges')
        return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers })
    } finally { scoped.close() }
}

// HiAnime backend, the fallback for when the AniDB App path is unavailable. Search, episode
// lists and serve links are plain pages a datacenter IP can still reach, and playback stays an
// embed so the provider player runs inside the reader browser instead of through this proxy

const HIANIME = 'https://hianime.at'
const HIANIME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
const HIANIME_TOKEN = /^hianime-(\d+)-(\d+)$/
// server order matters, the client plays the first embed source. ZokoAnime is preferred, it is
// the one confirmed to stream a live HLS chain (master playlist plus 720p and 1080p segments)
// end to end in the reader. The megaplay mirrors answer but their playability is unverified, so
// they stay as fallbacks for episodes ZokoAnime does not mirror.
const HIANIME_SERVERS = ['ZokoAnime', 'HD-1', 'Vidstream-2']
const HIANIME_EMBEDS = ['megaplay.buzz', 'zokoanime.video']

const hianimePage = async (fetchImpl, path, accept = 'text/html') => {
    const scoped = timeout(null, HIANIME_BUDGET)
    try {
        const response = await fetchImpl(`${HIANIME}${path}`, {
            headers: { 'user-agent': HIANIME_UA, accept, referer: `${HIANIME}/`, 'x-requested-with': 'XMLHttpRequest' },
            signal: scoped.signal,
        })
        if (!response.ok) throw new Error(`HiAnime http ${response.status}`)
        return await response.text()
    } catch (error) { throw upstreamError(error) } finally { scoped.close() }
}

const hianimeJson = async (fetchImpl, path) => {
    const body = await hianimePage(fetchImpl, path, 'application/json')
    try { return JSON.parse(body) } catch { throw new Error('HiAnime returned an unexpected payload') }
}

// the site mapping for a title and its episode list are the expensive part of the fallback, and
// both were re-scraped on every reader for a source that is itself only the second choice: two
// hours of freshness with a day of stale service behind it, and a missed scrape is remembered
// briefly so a flaky fallback cannot be hammered.
const HIANIME_STALE_MS = 24 * 60 * 60_000
const HIANIME_NEG_MS = 60_000

async function hianimeSeries(fetchImpl, row) {
    return cached(fetchImpl, `hianime:series:${row.key}`, 6 * 60 * 60_000, async () => {
        const body = await hianimePage(fetchImpl, `/search?keyword=${encodeURIComponent(row.title)}`)
        const candidates = []
        for (const block of body.matchAll(/<h3\b[^>]*class="[^"]*film-name[^"]*"[^>]*>[\s\S]*?<\/h3>/gi)) {
            const href = htmlAttr(block[0], 'href')
            const id = href.match(/-(\d+)\/?$/)?.[1]
            const title = htmlAttr(block[0], 'title') || htmlEntities(block[0].replace(/<[^>]*>/g, ' ')).trim()
            if (id && title) candidates.push({ id, title, href })
        }
        const best = titleMatch(candidates, [row.title, ...row.alternateTitles])
        if (!best) throw Object.assign(new Error('HiAnime could not map this Miruro title'), { code: 'not_found' })
        return { id: best.id, title: best.title }
    }, HIANIME_NEG_MS, series => Boolean(series?.id), HIANIME_STALE_MS)
}

async function hianimeEpisodes(fetchImpl, row) {
    return cached(fetchImpl, `hianime:episodes:${row.key}`, 2 * 60 * 60_000, async () => {
        const series = await hianimeSeries(fetchImpl, row)
        const data = await hianimeJson(fetchImpl, `/api/theme/episode/list/${series.id}`)
        const html = typeof data?.html === 'string' ? data.html : ''
        const episodes = []
        for (const match of html.matchAll(/<a\b[^>]*class="[^"]*ep-item[^"]*"[^>]*>/gi)) {
            const upstream = htmlAttr(match[0], 'data-id')
            const number = num(htmlAttr(match[0], 'data-number'))
            if (!/^\d+$/.test(upstream) || number == null) continue
            episodes.push({
                id: `hianime-${series.id}-${upstream}`, number,
                title: htmlAttr(match[0], 'title') || `Episode ${number}`,
                description: null, image: null, airDate: null,
            })
        }
        if (!episodes.length) throw Object.assign(new Error('HiAnime returned no episodes'), { code: 'not_found' })
        return episodes
    }, HIANIME_NEG_MS, episodes => episodes.length > 0, HIANIME_STALE_MS)
}

const hianimeEmbed = hash => {
    let value
    try { value = atob(hash) } catch { return null }
    try {
        const url = new URL(value)
        if (url.protocol !== 'https:') return null
        if (!HIANIME_EMBEDS.some(base => url.hostname === base || url.hostname.endsWith(`.${base}`))) return null
        return url.href
    } catch { return null }
}

async function hianimeSources(fetchImpl, seriesId, episodeId, language) {
    const match = String(episodeId || '').match(HIANIME_TOKEN)
    if (!match) throw Object.assign(new Error('Invalid HiAnime episode'), { code: 'not_found' })
    if (String(seriesId) !== match[1]) throw Object.assign(new Error('Episode does not belong to this series'), { code: 'not_found' })
    // the embed link is derived from the episode's server hash and is stable for as long as the
    // mirror exists, so a short entry absorbs the replay and the reader's retries
    return cached(fetchImpl, `hianime:sources:${episodeId}:${language}`, 10 * 60_000, async () => {
        const data = await hianimeJson(fetchImpl, `/api/theme/episode/servers?episodeId=${match[2]}`)
        const html = typeof data?.html === 'string' ? data.html : ''
        const servers = []
        for (const tag of html.matchAll(/<div\b[^>]*class="[^"]*server-item[^"]*"[^>]*>/gi)) {
            const type = htmlAttr(tag[0], 'data-type')
            if (type !== 'sub' && type !== 'dub') continue
            servers.push({ name: htmlAttr(tag[0], 'data-server-name'), type, hash: htmlAttr(tag[0], 'data-hash') })
        }
        const inLanguage = servers.filter(server => server.type === language)
        const pool = inLanguage.length ? inLanguage : servers
        // one episode is mirrored on several hosts, the first allowlisted host with a usable link wins
        for (const name of HIANIME_SERVERS) {
            const embed = hianimeEmbed(pool.find(server => server.name === name)?.hash || '')
            if (embed) return [{ kind: 'embed', url: embed }]
        }
        throw Object.assign(new Error('HiAnime returned no playable stream'), { code: 'stream_unavailable' })
    }, 60_000, sources => Array.isArray(sources) && sources.length > 0, HIANIME_STALE_MS)
}

// backends answer in order, a transport failure cools one down so later requests go straight to
// the next, a semantic miss (no such title) only loses that one request. the cooldown is what
// stops a challenged upstream from costing every reader the probe budget, so it outlasts a
// maintenance window rather than the ten minutes it took to notice
const BACKEND_COOLDOWN = 20 * 60_000
const backendDown = new WeakMap()

const backendOutage = error => !error?.code || error.code === 'provider_unavailable'

const backendDownNow = (fetchImpl, key) => {
    let map = backendDown.get(fetchImpl)
    if (!map) { map = new Map(); backendDown.set(fetchImpl, map) }
    map.set(key, Date.now() + BACKEND_COOLDOWN)
}

async function firstBackend(fetchImpl, backends) {
    const failures = []
    for (const backend of backends) {
        if ((backendDown.get(fetchImpl)?.get(backend.key) ?? 0) > Date.now()) continue
        try {
            const value = await backend.load()
            backendDown.get(fetchImpl)?.delete(backend.key)
            return { key: backend.key, value }
        } catch (error) {
            if (backendOutage(error)) backendDownNow(fetchImpl, backend.key)
            failures.push(error)
        }
    }
    // a config error explains the most, a transport error outranks a miss, only a clean sweep of
    // misses reads as a missing title
    const failure = failures.find(error => error?.code === 'provider_unconfigured')
        ?? failures.find(backendOutage)
    if (failure) throw failure
    if (failures.length) throw Object.assign(new Error('No anime backend has this title'), { code: 'not_found' })
    return { key: backends[0].key, value: await backends[0].load() }
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

const decodeKey = value => {
    try { return decodeURIComponent(value) } catch { throw Object.assign(new Error('Invalid anime key'), { code: 'invalid_request' }) }
}

const keyInfo = value => {
    const match = String(value || '').match(PROVIDER_KEY)
    if (!match) return { unknown: true, provider: String(value || '').split(':')[0], id: null }
    const provider = match[1]
    const id = match[2]
    if (!PROVIDER_IDS[provider].test(id)) return { unknown: false, provider, id: null }
    return { unknown: false, provider, id }
}
const idFromKey = key => {
    const info = keyInfo(key)
    return info.provider === 'miruro' ? info.id : null
}
const appHost = request => {
    const source = request.headers?.get?.('origin') || request.headers?.get?.('referer')
    if (!source) return null
    try { return new URL(source).hostname } catch { return null }
}

async function animeForKey(key, fetchImpl) {
    const id = idFromKey(key)
    if (!id) throw Object.assign(new Error('Invalid anime key'), { code: 'invalid_request' })
    // the series route asks for the row twice per request (metadata plus the backend chain) and
    // AniList rate limits by IP, so one lookup per key per two hours, with a day of stale service
    // behind it and a short memory of a key AniList does not know
    return cached(fetchImpl, `anilist:series:${id}`, 2 * 60 * 60_000, async () => {
        const data = await anilist(fetchImpl, SERIES_QUERY, { id: Number(id) })
        const row = anime(data?.data?.Media)
        if (!row) throw Object.assign(new Error('Anime not found'), { code: 'not_found' })
        return row
    }, ANILIST_NEG_MS, row => Boolean(row?.key), ANILIST_STALE_MS)
}

// embeds from the owned playback service are allowlisted and must not point back at the app
// origin (appHost above); empty today — the service emits direct HLS only. ponytail: add hosts
// here if a provider ever emits legit embeds.
const OWNED_EMBED_HOSTS = new Set([])
const ownedSources = (data, request) => (Array.isArray(data?.sources) ? data.sources : []).map(source => {
    const sourceUrl = str(source?.url)
    let target
    try { target = new URL(sourceUrl) } catch { return null }
    if (target.protocol !== 'https:') return null
    if (source?.type === 'embed') {
        const origin = appHost(request)
        if (target.hostname === new URL(request.url).hostname || (origin && target.hostname === origin)) return null
        if (![...OWNED_EMBED_HOSTS].some(base => target.hostname === base || target.hostname.endsWith(`.${base}`))) return null
        return { kind: 'embed', url: target.href }
    }
    const type = source?.type === 'hls' || /\.m3u8(?:$|\?)/i.test(sourceUrl) ? 'application/x-mpegURL' : 'video/mp4'
    return { kind: 'direct', url: target.href, type }
}).filter(Boolean)

const ownedSubtitles = data => (Array.isArray(data?.subtitles) ? data.subtitles : []).map(track => ({
    url: str(track?.url), label: str(track?.label) || str(track?.lang), lang: str(track?.language) || str(track?.lang),
})).filter(track => {
    try { return new URL(track.url).protocol === 'https:' && Boolean(track.lang) } catch { return false }
})

const ctxFor = (env, fetchImpl, request) => ({ env, fetchImpl, request, cached })

// a provider hands back a bare episode array, unless it also reports which backend the list came from
const episodeList = value => Array.isArray(value) ? { episodes: value } : value

const miruro = {
    key: 'miruro',
    label: 'Miruro',
    kinds: ['anime'],
    source: 'Miruro · pewe (AniDB App)',
    async discover(ctx, { page, limit, format, search }) {
        const data = await anilistPage(ctx.fetchImpl, { page, limit, search, format })
        const results = pageResults(data).map(item => ({ ...item, poster: item.cover }))
        return { rows: results, hasMore: pageMore(data), partial: false, error: null }
    },
    async series(ctx, key) {
        return animeForKey(key, ctx.fetchImpl)
    },
    async episodes(ctx, key, language) {
        const { env, fetchImpl, request } = ctx
        if (env.VELLUM_ANIME_PLAYBACK_URL) {
            const data = await playback(env, fetchImpl, `episodes?anilistId=${encodeURIComponent(idFromKey(key))}&language=${language}`, request)
            return (Array.isArray(data) ? data : data?.episodes || []).map(episode).filter(Boolean)
        }
        const row = await animeForKey(key, fetchImpl)
        const backends = []
        if (env.VELLUM_SLIPGATE_URL) backends.push({ key: 'anidb', load: async () => (await animeDbEpisodes(env, fetchImpl, row)).episodes })
        backends.push({ key: 'hianime', load: () => hianimeEpisodes(fetchImpl, row) })
        const result = await firstBackend(fetchImpl, backends)
        return { episodes: result.value, source: result.key === 'hianime' ? HIANIME_LABEL : ANIDB_LABEL }
    },
    async playback(ctx, key, language, episodeId) {
        const { env, fetchImpl, request } = ctx
        if (env.VELLUM_ANIME_PLAYBACK_URL) {
            const provider = env.VELLUM_ANIME_PROVIDER || 'default'
            const data = await playback(env, fetchImpl, `sources?episodeId=${encodeURIComponent(episodeId)}&provider=${encodeURIComponent(provider)}&category=${language}`, request)
            return { sources: ownedSources(data, request), subtitles: ownedSubtitles(data), providerLabel: env.VELLUM_ANIME_PROVIDER_LABEL || 'Miruro' }
        }
        // a HiAnime episode id names its own backend and series, both are checked before it plays
        if (HIANIME_TOKEN.test(episodeId)) {
            const row = await animeForKey(key, fetchImpl)
            const series = await hianimeSeries(fetchImpl, row)
            return { sources: await hianimeSources(fetchImpl, series.id, episodeId, language), subtitles: [], providerLabel: HIANIME_LABEL }
        }
        const row = await animeForKey(key, fetchImpl)
        return {
            sources: await animeDbSources(env, fetchImpl, row, language, episodeId),
            subtitles: [],
            providerLabel: ANIDB_LABEL,
        }
    },
}

const REGISTRY = new Map([
    ['miruro', miruro],
    ['dc', dramacooli],
    ['gp', goplay],
    ['cineby', cineby],
    ['kiss', kisskh],
])

const routeEntry = (info, invalid) => {
    if (info.unknown) return failure(400, 'invalid_request', 'Unknown video provider', false, info.provider)
    if (info.id == null) return failure(400, 'invalid_request', invalid)
    return REGISTRY.get(info.provider)
}
const unconfigured = entry => failure(503, 'provider_unconfigured', entry.unavailable || 'Provider is not configured', false, entry.key)

export async function handleAnimeRequest(request, env = {}, fetchImpl = fetch) {
    const url = new URL(request.url)
    const root = '/read/api/anime/'
    if (request.method !== 'GET' || !url.pathname.startsWith(root)) return failure(404, 'not_found', 'Anime route not found')
    const route = url.pathname.slice(root.length)
    let activeProvider = 'miruro'
    try {
        if (route === 'discover' || route === 'search') {
            const { page, limit, format } = pageArgs(url)
            const search = route === 'search' ? url.searchParams.get('q')?.trim() : null
            if (route === 'search' && !search) return failure(400, 'invalid_request', 'Search query is required')
            if (format && !FORMATS.has(format)) return failure(400, 'invalid_request', 'Invalid anime format')
            const data = await anilistPage(fetchImpl, { page, limit, search, format })
            return json({ page, results: pageResults(data), hasMore: pageMore(data) })
        }

        if (route.startsWith('series/')) {
            const key = decodeKey(route.slice(7))
            const entry = routeEntry(keyInfo(key), 'Invalid anime key')
            if (entry instanceof Response) return entry
            activeProvider = entry.key
            if (entry.unavailable || !entry.series) return unconfigured(entry)
            const row = await entry.series(ctxFor(env, fetchImpl, request), key)
            return row ? json(row) : failure(404, 'not_found', 'Anime not found')
        }

        if (route === 'episodes') {
            const key = url.searchParams.get('key') || ''
            const language = url.searchParams.get('language') || 'sub'
            const entry = routeEntry(keyInfo(key), 'Invalid episode request')
            if (entry instanceof Response) return entry
            if (!['sub', 'dub'].includes(language)) return failure(400, 'invalid_request', 'Invalid episode request')
            activeProvider = entry.key
            if (entry.unavailable || !entry.episodes) return unconfigured(entry)
            const episodes = episodeList(await entry.episodes(ctxFor(env, fetchImpl, request), key, language)).episodes
            return json({ key, language, episodes })
        }

        if (route === 'watch') {
            const key = url.searchParams.get('key') || ''
            const language = url.searchParams.get('language') || 'sub'
            const id = url.searchParams.get('id') || ''
            const entry = routeEntry(keyInfo(key), 'Invalid stream request')
            if (entry instanceof Response) return entry
            if (!opaque(id) || !['sub', 'dub'].includes(language)) return failure(400, 'invalid_request', 'Invalid stream request')
            activeProvider = entry.key
            if (entry.unavailable || !entry.playback) return unconfigured(entry)
            const value = await entry.playback(ctxFor(env, fetchImpl, request), key, language, id)
            const sources = value.sources.map(source => source.kind === 'embed'
                ? { url: source.url, type: 'embed' }
                : { url: source.url, type: source.type.includes('mpegURL') ? 'hls' : 'mp4' })
            const subtitles = value.subtitles.map(track => ({ url: track.url, label: track.label, language: track.lang }))
            if (!sources.length) return failure(502, 'stream_unavailable', 'Playback service returned no playable stream', true, entry.key)
            return json({ key, language, episode: { id, number: 0, title: null, description: null, image: null, airDate: null }, sources, subtitles })
        }
        return failure(404, 'not_found', 'Anime route not found')
    } catch (error) {
        if (request.signal.aborted || error?.name === 'AbortError') return failure(499, 'request_cancelled', 'Anime request cancelled', true, activeProvider)
        if (error?.code === 'provider_unconfigured') return failure(503, error.code, error.message, false, activeProvider)
        if (error?.code === 'invalid_request') return failure(400, error.code, error.message, false, activeProvider)
        if (error?.code === 'not_found') return failure(404, error.code, error.message, false, activeProvider)
        if (error?.code === 'stream_unavailable') return failure(502, error.code, error.message, true, activeProvider)
        return failure(502, 'provider_unavailable', route === 'episodes' || route === 'watch' ? 'Anime playback service is unavailable' : 'AniList is unavailable', true, activeProvider)
    }
}

export async function handleAnimeVideoRequest(request, env = {}, fetchImpl = fetch) {
    const url = new URL(request.url)
    const root = '/read/api/video/'
    if (!url.pathname.startsWith(root)) return failure(404, 'not_found', 'Video route not found')
    const route = url.pathname.slice(root.length)
    const media = route.startsWith('media/')
    if (media) {
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
            'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-allow-headers': 'Range',
        } })
        if (!['GET', 'HEAD'].includes(request.method)) return failure(405, 'invalid_request', 'Invalid anime media method')
    } else if (request.method !== 'GET') return failure(404, 'not_found', 'Video route not found')
    let activeProvider = 'miruro'
    try {
        // the media route runs through the same error mapping as the rest: a slipgate that is
        // unconfigured or unreachable is a 503 or a 502, never an unhandled 500
        if (media) return await animeDbMedia(env, fetchImpl, route.slice(6), request)
        if (route === 'discover') {
            const kind = url.searchParams.get('kind') || 'all'
            if (!['all', 'anime', 'drama'].includes(kind)) return failure(400, 'invalid_request', 'Invalid video kind')
            const { page, limit, format } = pageArgs(url)
            const search = url.searchParams.get('q')?.trim() || null
            if (format && !FORMATS.has(format)) return failure(400, 'invalid_request', 'Invalid anime format')
            const ctx = ctxFor(env, fetchImpl, request)
            const providers = [...REGISTRY.values()].filter(entry => !entry.unavailable && typeof entry.discover === 'function' && (kind === 'all' || entry.kinds.includes(kind)))
            const outcomes = await Promise.all(providers.map(entry => entry.discover(ctx, { page, limit, format, search })
                .then(result => ({ entry, ...result }))
                .catch(error => ({ entry, rows: [], hasMore: false, partial: true, error: { provider: entry.key, code: 'provider_unavailable', message: error?.message || 'Provider is unavailable' } }))))
            return json({
                page,
                results: outcomes.flatMap(outcome => outcome.rows),
                hasMore: outcomes.some(outcome => outcome.hasMore),
                partial: outcomes.some(outcome => outcome.partial),
                errors: outcomes.flatMap(outcome => outcome.error ? [outcome.error] : []),
            })
        }

        if (route.startsWith('series/')) {
            const key = decodeKey(route.slice(7))
            const entry = routeEntry(keyInfo(key), 'Invalid anime key')
            if (entry instanceof Response) return entry
            activeProvider = entry.key
            if (entry.unavailable || !entry.series || !entry.episodes) return unconfigured(entry)
            const ctx = ctxFor(env, fetchImpl, request)
            const row = await entry.series(ctx, key)
            const listed = episodeList(await entry.episodes(ctx, key, 'sub'))
            const episodes = listed.episodes
            if (!episodes.length) return failure(404, 'not_found', 'No subtitled episodes found')
            return json({ ...row, poster: row.poster ?? row.cover, source: listed.source ?? entry.source ?? row.source, episodes, partial: false, errors: [] })
        }

        if (route === 'playback') {
            const key = url.searchParams.get('key') || ''
            const episodeId = url.searchParams.get('id') || ''
            const entry = routeEntry(keyInfo(key), 'Invalid playback request')
            if (entry instanceof Response) return entry
            if (!opaque(episodeId)) return failure(400, 'invalid_request', 'Invalid playback request')
            activeProvider = entry.key
            if (entry.unavailable || !entry.playback) return unconfigured(entry)
            const value = await entry.playback(ctxFor(env, fetchImpl, request), key, 'sub', episodeId)
            if (!value.sources.length) return failure(502, 'stream_unavailable', 'Playback service returned no playable stream', true, entry.key)
            return json({ key, episodeId, providerLabel: value.providerLabel, sources: value.sources, subtitles: value.subtitles })
        }
        return failure(404, 'not_found', 'Video route not found')
    } catch (error) {
        if (request.signal.aborted || error?.name === 'AbortError') return failure(499, 'request_cancelled', 'Video request cancelled', true, activeProvider)
        if (error?.code === 'provider_unconfigured') return failure(503, error.code, error.message, false, activeProvider)
        if (error?.code === 'invalid_request') return failure(400, error.code, error.message, false, activeProvider)
        if (error?.code === 'not_found') return failure(404, error.code, error.message, false, activeProvider)
        if (error?.code === 'stream_unavailable') return failure(502, error.code, error.message, true, activeProvider)
        return failure(502, 'provider_unavailable', 'Anime provider is unavailable', true, activeProvider)
    }
}

export default { fetch: (request, env) => handleAnimeRequest(request, env) }
