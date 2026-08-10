const CINEBY = 'https://cineby.su'
const CINEBY_LISTING = '/browse'
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'
const PLAYER_FIELDS = ['src', 'hls', 'embed', 'iframe']
const MINUTE = 60_000

const str = value => typeof value === 'string' ? value : null
const num = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
const tmdbId = key => String(key || '').match(/^cineby:(\d+)$/)?.[1] || null
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
const yearOf = media => num(media?.year) ?? num(media?.release_date?.slice(0, 4)) ?? num(media?.first_air_date?.slice(0, 4))
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

const nextData = html => {
    const match = String(html || '').match(/<script\s+id="__NEXT_DATA__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/i)
    if (!match) return null
    try { return JSON.parse(match[1]) } catch { return null }
}

const firstMatch = (node, visit, depth = 0) => {
    if (node == null || depth > 10) return null
    if (Array.isArray(node)) {
        for (const item of node) {
            const found = firstMatch(item, visit, depth + 1)
            if (found) return found
        }
        return null
    }
    if (typeof node === 'object') {
        const hit = visit(node)
        if (hit) return hit
        for (const key of Object.keys(node)) {
            const found = firstMatch(node[key], visit, depth + 1)
            if (found) return found
        }
    }
    return null
}

const walk = (node, visit, depth = 0) => {
    if (node == null || depth > 10) return
    if (Array.isArray(node)) {
        for (const item of node) walk(item, visit, depth + 1)
        return
    }
    if (typeof node === 'object') {
        visit(node)
        for (const key of Object.keys(node)) walk(node[key], visit, depth + 1)
    }
}

const findMedia = (node, id) => firstMatch(node, value => Number(value?.tmdb_id) === Number(id) && typeof value?.title === 'string' ? value : null)
const isPlayer = value => PLAYER_FIELDS.some(field => typeof value?.[field] === 'string' && value[field]) ? value : null

const containerOf = (node, target, depth = 0, parent = null) => {
    if (node == null || depth > 10) return null
    if (Array.isArray(node)) {
        for (const item of node) {
            const found = containerOf(item, target, depth + 1, parent)
            if (found) return found
        }
        return null
    }
    if (typeof node === 'object') {
        if (Object.values(node).includes(target)) return node
        for (const key of Object.keys(node)) {
            const found = containerOf(node[key], target, depth + 1, node)
            if (found) return found
        }
    }
    return null
}

const findPlayer = (node, id, episodeId) => {
    const media = findMedia(node, id)
    if (!media) return null
    const seasons = Array.isArray(media?.seasons) ? media.seasons : []
    const match = /^s(\d+)e(\d+)$/.exec(String(episodeId || ''))
    if (seasons.length) {
        const requested = seasons
            .find(season => num(season?.season_number) === Number(match?.[1]))
            ?.episodes?.find(episode => num(episode?.episode_number) === Number(match?.[2]))
        if (!requested) return null
        return firstMatch(requested, isPlayer)
    }
    const own = firstMatch(media, isPlayer)
    if (own) return own
    const container = containerOf(node, media)
    if (!container) return null
    for (const value of Object.values(container)) {
        if (value === media) continue
        const found = firstMatch(value, isPlayer)
        if (found) return found
    }
    return null
}

async function fetchHtml(ctx, path) {
    const scoped = timeout(ctx.request?.signal)
    try {
        const response = await ctx.fetchImpl(new URL(path, CINEBY).href, { signal: scoped.signal, headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' } })
        if (!response.ok) throw Object.assign(new Error(`http ${response.status}`), { status: response.status })
        return await response.text()
    } finally { scoped.close() }
}

const page = (ctx, id) => ctx.cached(ctx.fetchImpl, `cineby:page:${id}`, 10 * MINUTE, async () => {
    const html = await fetchHtml(ctx, `/movie/${id}`)
    const data = nextData(html)
    if (!data) throw Object.assign(new Error('Cineby page did not expose __NEXT_DATA__'), { code: 'provider_unavailable' })
    return data
})

export async function discover(ctx) {
    try {
        const data = await ctx.cached(ctx.fetchImpl, 'cineby:listing', 30 * MINUTE, async () => {
            const html = await fetchHtml(ctx, CINEBY_LISTING)
            const parsed = nextData(html)
            if (!parsed) throw new Error('Cineby listing did not expose __NEXT_DATA__')
            return parsed
        })
        const rows = []
        const seen = new Set()
        walk(data, media => {
            const id = num(media?.tmdb_id)
            const title = clean(media?.title)
            if (id == null || !title || seen.has(id)) return
            seen.add(id)
            rows.push({ key: `cineby:${id}`, kind: 'anime', title, poster: httpsUrl(media?.poster) || httpsUrl(media?.image), year: yearOf(media) })
        })
        if (!rows.length) throw new Error('Cineby listing contained no titles')
        return { rows, hasMore: false, partial: false, error: null }
    } catch (error) {
        return { rows: [], hasMore: false, partial: true, error: { provider: 'cineby', code: 'provider_unavailable', message: 'Cineby listing is unavailable' } }
    }
}

export async function series(ctx, key) {
    const id = tmdbId(key)
    if (!id) throw Object.assign(new Error('Invalid Cineby key'), { code: 'invalid_request' })
    const data = await page(ctx, id)
    const media = findMedia(data, id)
    if (!media) throw Object.assign(new Error('Cineby title not found'), { code: 'not_found' })
    return {
        key, kind: 'anime', title: clean(media.title),
        poster: httpsUrl(media?.poster) || httpsUrl(media?.image),
        synopsis: clean(media?.synopsis) || clean(media?.description) || clean(media?.overview),
        year: yearOf(media),
    }
}

export async function episodes(ctx, key) {
    const id = tmdbId(key)
    if (!id) throw Object.assign(new Error('Invalid Cineby key'), { code: 'invalid_request' })
    const data = await page(ctx, id)
    const media = findMedia(data, id)
    if (!media) throw Object.assign(new Error('Cineby title not found'), { code: 'not_found' })
    const seasons = Array.isArray(media?.seasons) ? media.seasons : []
    const episodes = []
    for (const season of seasons) {
        const s = num(season?.season_number)
        if (s == null) continue
        for (const item of Array.isArray(season?.episodes) ? season.episodes : []) {
            const e = num(item?.episode_number)
            if (e == null) continue
            episodes.push({ id: `s${s}e${e}`, number: e, season: s, title: clean(item?.title) || `Episode ${e}`, description: null, image: null, airDate: null })
        }
    }
    if (!seasons.length) episodes.push({ id: 's1e1', number: 1, season: 1, title: clean(media.title), description: null, image: null, airDate: null })
    if (!episodes.length) throw Object.assign(new Error('Cineby returned no episodes'), { code: 'not_found' })
    return episodes.sort((a, b) => a.season - b.season || a.number - b.number)
}

export async function playback(ctx, key, language, episodeId) {
    const id = tmdbId(key)
    if (!id || !/^s\d+e\d+$/.test(String(episodeId || ''))) throw Object.assign(new Error('Invalid Cineby episode'), { code: 'invalid_request' })
    const data = await page(ctx, id)
    const player = findPlayer(data, id, episodeId)
    const sources = []
    for (const field of PLAYER_FIELDS) {
        const raw = player?.[field]
        if (typeof raw !== 'string') continue
        if (field === 'embed' || field === 'iframe') {
            const url = embedUrl(raw, ctx.request)
            if (url) sources.push({ kind: 'embed', url })
            continue
        }
        let target
        try { target = new URL(raw) } catch { continue }
        if (target.protocol !== 'https:') continue
        if (/\.m3u8/i.test(raw)) sources.push({ kind: 'direct', url: target.href, type: 'application/x-mpegURL' })
        else if (/\.mp4/i.test(raw)) sources.push({ kind: 'direct', url: target.href, type: 'video/mp4' })
        else {
            const url = embedUrl(raw, ctx.request)
            if (url) sources.push({ kind: 'embed', url })
        }
    }
    if (!sources.length) throw Object.assign(new Error('Cineby returned no playable stream'), { code: 'stream_unavailable' })
    return { sources, subtitles: [], providerLabel: 'Cineby' }
}

export const cineby = {
    key: 'cineby', label: 'Cineby', kinds: ['anime'], source: 'Cineby',
    discover, series, episodes, playback,
}
