const DRAMACOOLI = 'https://dramacooli.ws'
const DC_ID = /^[a-z0-9._-]{1,100}$/
const EPISODE_SLUG = /-episode-(\d+)$/i
const FULL_MOVIE_SLUG = /-full-movie$/i
const MINUTE = 60_000

const str = value => typeof value === 'string' ? value : null
const timeout = (parent, ms = 12_000) => {
    const ctrl = new AbortController()
    const abort = () => ctrl.abort()
    if (parent?.aborted) abort()
    else parent?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, ms)
    return { signal: ctrl.signal, close: () => { clearTimeout(timer); parent?.removeEventListener('abort', abort) } }
}

const htmlEntities = value => value.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
const htmlAttr = (tag, name) => htmlEntities(tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2] || '')
const clean = value => htmlEntities(String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()) || null
const httpsUrl = value => {
    if (typeof value !== 'string' || !value) return null
    try { return new URL(value).protocol === 'https:' ? value : null } catch { return null }
}
const EMBED_HOSTS = ['embedload.cfd', 'dramacool.men', 'player.test', 'ok.test']
// the app origin comes from request headers (Origin on cross-origin fetches, Referer otherwise);
// embeds pointing back at the app would run same-origin with it once the sandbox is gone
const appHost = request => {
    const source = request.headers?.get?.('origin') || request.headers?.get?.('referer')
    if (!source) return null
    try { return new URL(source).hostname } catch { return null }
}
const embedUrl = (value, request) => {
    const url = httpsUrl(value)
    if (!url) return null
    const host = new URL(url).hostname
    const origin = appHost(request)
    if (host === new URL(request.url).hostname || (origin && host === origin)) return null
    return EMBED_HOSTS.some(base => host === base || host.endsWith(`.${base}`)) ? url : null
}

async function wpJson(ctx, path) {
    const scoped = timeout(ctx.request?.signal)
    try {
        const response = await ctx.fetchImpl(new URL(path, DRAMACOOLI).href, { signal: scoped.signal, headers: { accept: 'application/json' } })
        const body = await response.json().catch(() => null)
        if (!response.ok || body == null) throw Object.assign(new Error(body?.message || `http ${response.status}`), { status: response.status })
        return body
    } finally { scoped.close() }
}

const category = (ctx, id) => ctx.cached(ctx.fetchImpl, `dc:category:${id}`, 6 * 60 * MINUTE, () => wpJson(ctx, `/wp-json/wp/v2/categories/${id}`))

async function posts(ctx, id) {
    return ctx.cached(ctx.fetchImpl, `dc:posts:${id}`, 10 * MINUTE, async () => {
        const found = []
        for (let page = 1; page <= 10; page += 1) {
            const data = await wpJson(ctx, `/wp-json/wp/v2/posts?categories=${id}&per_page=100&page=${page}&_embed=1`)
            if (!Array.isArray(data) || !data.length) break
            found.push(...data)
            if (data.length < 100) break
        }
        return found
    })
}

const slugNumber = slug => {
    const match = String(slug || '').match(EPISODE_SLUG)
    if (match) return Number(match[1])
    return FULL_MOVIE_SLUG.test(slug) ? 1 : null
}

const episodeFromPost = post => {
    const id = str(post?.slug)
    const number = slugNumber(id)
    if (!id || !DC_ID.test(id) || number == null) return null
    return { id, number, title: clean(post?.title?.rendered) || `Episode ${number}`, description: null, image: null, airDate: null }
}

const DRAMA_COUNTRY = {
    'korean drama': 'korean',
    'chinese drama': 'chinese',
    'taiwanese drama': 'taiwanese',
}

export async function discover(ctx) {
    const data = await ctx.cached(ctx.fetchImpl, 'dc:categories', 6 * 60 * MINUTE, () => wpJson(ctx, '/wp-json/wp/v2/categories?orderby=count&per_page=100&page=1&hide_empty=true'))
    const rows = (Array.isArray(data) ? data : []).map(cat => {
        const id = cat?.id == null ? '' : String(cat.id)
        const title = clean(cat?.name)
        if (!id || !DC_ID.test(id) || !title) return null
        const country = DRAMA_COUNTRY[title.toLowerCase()]
        return { key: `dc:${id}`, kind: 'drama', title, source: 'DramaCooli', poster: null, ...(country ? { country } : {}) }
    }).filter(Boolean)
    return { rows, hasMore: false, partial: false, error: null }
}

export async function series(ctx, key) {
    const id = String(key || '').split(':')[1] || ''
    if (!DC_ID.test(id)) throw Object.assign(new Error('Invalid DramaCooli series'), { code: 'invalid_request' })
    const cat = await category(ctx, id).catch(error => {
        if (error?.status === 404) throw Object.assign(new Error('Drama not found'), { code: 'not_found' })
        throw error
    })
    const found = await posts(ctx, id)
    const first = found[0]
    return {
        key, kind: 'drama', title: clean(cat?.name) || 'Drama', source: 'DramaCooli',
        poster: httpsUrl(first?._embedded?.['wp:featuredmedia']?.[0]?.source_url), synopsis: clean(first?.excerpt?.rendered),
    }
}

export async function episodes(ctx, key) {
    const id = String(key || '').split(':')[1] || ''
    if (!DC_ID.test(id)) throw Object.assign(new Error('Invalid DramaCooli series'), { code: 'invalid_request' })
    const found = await posts(ctx, id)
    return found.map(episodeFromPost).filter(Boolean).sort((a, b) => a.number - b.number || a.id.localeCompare(b.id))
}

export async function playback(ctx, key, language, episodeId) {
    const id = str(episodeId)
    if (!id || !DC_ID.test(id)) throw Object.assign(new Error('Invalid DramaCooli episode'), { code: 'invalid_request' })
    const post = await ctx.cached(ctx.fetchImpl, `dc:post:${id}`, 10 * MINUTE, () => wpJson(ctx, `/wp-json/wp/v2/posts?slug=${id}&_embed=1`))
    const html = str(Array.isArray(post) ? post[0]?.content?.rendered : null) || ''
    const src = htmlAttr(html.match(/<iframe\b[^>]*>/gi)?.[0] || '', 'src')
    const url = embedUrl(src, ctx.request)
    if (!url) throw Object.assign(new Error('DramaCooli returned no playable embed'), { code: 'stream_unavailable' })
    return { sources: [{ kind: 'embed', url }], subtitles: [], providerLabel: 'DramaCooli' }
}

export const dramacooli = {
    key: 'dc', label: 'DramaCooli', kinds: ['drama'], source: 'DramaCooli',
    discover, series, episodes, playback,
}
