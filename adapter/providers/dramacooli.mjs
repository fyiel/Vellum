const DC_ID = /^[a-z0-9._-]{1,100}$/
const EPISODE_SLUG = /-episode-(\d+)$/i
const EPISODE_ANY = /-episode-(\d+)/i
const FULL_MOVIE_SLUG = /-full-movie$/i
const MINUTE = 60_000
export const DEFAULT_LIMIT = 100

// ── origin ──────────────────────────────────────────────────────────────────
// DramaCool publishes stable entry hosts that 301 through a rotating chain to whichever domain is
// live right now, and the family rotates the letter with it: on 2026-09-17 dramacooli.buzz 301'd
// to dramacoolb.top to dramacooli.top and then to dramacoole.buzz, which does not resolve, so a
// single pinned entry took the whole provider down. Entries are followed in turn, each landing is
// validated as a live catalogue (it must reference its own host and look like the theme), and when
// every known host is gone the family is walked as dramacool<letter>.<tld>. The resolved origin is
// kept; a request that stops looking like a real DramaCool API drops it and resolves again, so a
// rotation costs one extra round trip instead of every request. The host the family rotated to
// most recently is listed first, so a cold process pays one redirect chain, not one per dead entry.
const DRAMACOOL_ENTRIES = [
    'https://dramacoolt.top',
    'https://dramacooli.buzz',
    'https://dramacoolu.top',
    'https://dramacool.com.tr',
]
const DRAMACOOL_HOPS = 8
const DRAMACOOL_UA = 'Vellum/1.0 (+https://pumg.fyi/read)'
const DRAMACOOL_ENTRY_TIMEOUT_MS = 5_000
// one rotation lookup is one round trip per live host; the budget bounds a pathological chain of
// hosts that answer slowly without ever landing on the catalogue
const DRAMACOOL_RESOLVE_BUDGET_MS = 15_000
const DRAMACOOL_PROBE_TLDS = ['top', 'buzz', 'ws', 'sbs', 'vip', 'cc', 'io', 'site', 'xyz']
const DRAMACOOL_PROBE_ALPHABET = 'tuvsyrzqwxipnolamkjhgfedcb'
const DRAMACOOL_PROBE_CONCURRENCY = 8
const DRAMACOOL_PROBE_TIMEOUT_MS = 4_000
const DRAMACOOL_PROBE_BUDGET_MS = 10_000
const DRAMACOOL_PROBE_COOLDOWN_MS = 10 * MINUTE
// a dead family is retried sooner than the family walk, but not on every request
const DRAMACOOL_FAILURE_COOLDOWN_MS = 30_000
let dramaCoolOrigin = null
let dramaCoolResolving = null
let dramaCoolProbeAfter = 0
let dramaCoolFailure = null

// ── budgets and retries ─────────────────────────────────────────────────────
// measured on 2026-09-17 against the live origin: the WP REST API answers in 0.8-2.6s (page 1 of
// a 100-row category is ~1.3s) and the episode page in 1.7s (103KB). Budgets are ~3x the p95 so
// a slow upstream is cut off instead of holding the request, and they are per logical call: every
// retry and every backoff draws from the same deadline.
const JSON_BUDGET_MS = 9_000
const PAGE_BUDGET_MS = 12_000
const RETRY_ATTEMPTS = 3
const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
const JSON_HEADERS = { accept: 'application/json' }
const HTML_HEADERS = { accept: 'text/html,application/xhtml+xml', 'user-agent': DRAMACOOL_UA }
// the theme ships ~24KB of fields per post and ~4.7KB per category, almost all of it yoast HTML
// and link scaffolding the provider never reads; asking for the fields it uses cuts a 100-row
// page from 1.27MB to ~15KB, and page 1 also carries the seo block that holds the series poster
const CATEGORY_FIELDS = 'id,slug,name,description,count'
const POST_FIELDS = 'id,slug,link,title,excerpt'
const POST_FIELDS_COVER = `${POST_FIELDS},yoast_head_json`
const POST_PAGES = 10
const CATALOGUE_TTL = 30 * MINUTE
const CATEGORY_TTL = 6 * 60 * MINUTE
const POSTS_TTL = 30 * MINUTE
const PAGE_TTL = 20 * MINUTE
const MISS_TTL_MS = 60_000

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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const backoffMs = attempt => Math.min(300 * 2 ** attempt, 2_500)
// a throttled upstream names its own wait; drop an unusable header rather than trust it
const retryAfterMs = response => {
    const header = Number(response?.headers?.get?.('retry-after'))
    return Number.isFinite(header) && header > 0 ? Math.min(header * 1000, 4_000) : null
}

// a fetch implementation that ignores the abort signal must not be able to hold the caller past
// its budget, so every upstream await is raced against its scoped signal
const timedOut = () => Object.assign(new Error('DramaCool request timed out'), { status: 504, code: 'upstream_timeout' })
const aborted = signal => new Promise((_, reject) => {
    const fail = () => reject(timedOut())
    if (signal.aborted) return fail()
    signal.addEventListener('abort', fail, { once: true })
})
const bounded = (signal, work) => {
    const guard = aborted(signal)
    guard.catch(() => {})
    return Promise.race([work, guard])
}

// one logical call gets one budget: retries and backoff draw from the same deadline, so an
// upstream that throttles or stalls delays an attempt but never the caller past its budget
async function requestText(ctx, url, { budget, headers }) {
    const deadline = Date.now() + budget
    let failure = null
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
        const remaining = deadline - Date.now()
        if (remaining < 400) break
        const scoped = timeout(ctx.request?.signal, remaining)
        try {
            const response = await bounded(scoped.signal, ctx.fetchImpl(url, { headers, signal: scoped.signal }))
            const text = await bounded(scoped.signal, response.text())
            const final = response.url || url
            if (!RETRY_STATUSES.has(response.status)) return { status: response.status, ok: response.ok, text, url: final }
            // a retryable status on the last attempt is reported, not retried for ever
            if (attempt === RETRY_ATTEMPTS - 1) return { status: response.status, ok: false, text, url: final }
            failure = Object.assign(new Error(`http ${response.status}`), { status: response.status })
            await sleep(Math.min(retryAfterMs(response) ?? backoffMs(attempt), Math.max(0, deadline - Date.now() - 250)))
        } catch (error) {
            if (ctx.request?.signal?.aborted) throw error
            failure = error
            if (attempt === RETRY_ATTEMPTS - 1) break
            await sleep(Math.min(backoffMs(attempt), Math.max(0, deadline - Date.now() - 250)))
        } finally { scoped.close() }
    }
    throw failure ?? timedOut()
}

const parseJson = text => { try { return JSON.parse(text) } catch { return null } }

const notFound = message => Object.assign(new Error(message), { code: 'not_found', status: 404 })

// a miss is a fact about a slug, not about the network: a deleted or invalid id is remembered
// briefly so it cannot turn every request into a fresh upstream call, and it is only ever
// replayed as the same error, never as an empty value
const misses = new Map()
const missHit = key => {
    const until = misses.get(key)
    if (until == null) return false
    if (until <= Date.now()) { misses.delete(key); return false }
    return true
}
const markMiss = key => {
    if (misses.size >= 200) misses.delete(misses.keys().next().value)
    misses.set(key, Date.now() + MISS_TTL_MS)
}

const cataloguePage = html => /entry-title|bsx|ep-item|listupd/i.test(html)

// follow one entry through its redirect chain; the first hop that answers with a real page wins,
// anything else (NXDOMAIN, challenge interstitial, parked page) fails fast and the next entry is
// tried, so a dead host costs one lookup instead of the provider. Each hop draws from the
// resolution deadline, so a host that accepts a connection and then stalls cannot extend the
// chain past the budget the way a per-hop timeout alone allows.
async function resolveEntry(ctx, entry, { deadline, timeoutMs = DRAMACOOL_ENTRY_TIMEOUT_MS, requireCurrentYear = false }) {
    let target = entry
    for (let hop = 0; hop <= DRAMACOOL_HOPS; hop += 1) {
        const budget = Math.min(timeoutMs, deadline - Date.now())
        if (budget < 300) throw new Error(`${entry} resolution ran out of time`)
        const scoped = timeout(ctx.request?.signal, budget)
        try {
            const response = await bounded(scoped.signal, ctx.fetchImpl(target, { redirect: 'manual', headers: HTML_HEADERS, signal: scoped.signal }))
            const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
            if (location) { target = new URL(location, target).href; continue }
            if (!response.ok) throw Object.assign(new Error(`${entry} answered ${response.status}`), { status: response.status })
            const html = await bounded(scoped.signal, response.text())
            const origin = new URL(response.url || target).origin
            if (!cataloguePage(html)) throw new Error(`${entry} landed on a page that is not DramaCool`)
            if (!html.includes(new URL(origin).host)) throw new Error(`${entry} does not reference its own host`)
            if (requireCurrentYear && !html.includes(String(new Date().getFullYear()))) throw new Error(`${entry} looks stale`)
            return origin
        } finally { scoped.close() }
    }
    throw new Error(`${entry} redirect chain was too long`)
}

// a rotation must not need a human: when every known entry is gone the family is walked once,
// budgeted and throttled, so a dead family never turns every request into a scan
const familyCandidates = () => DRAMACOOL_PROBE_TLDS.flatMap(tld => [
    ...DRAMACOOL_PROBE_ALPHABET.split('').map(letter => `https://dramacool${letter}.${tld}`),
    `https://dramacool.${tld}`,
])
async function probeFamily(ctx) {
    const candidates = familyCandidates()
    const deadline = Date.now() + DRAMACOOL_PROBE_BUDGET_MS
    let cursor = 0
    let found = null
    const worker = async () => {
        while (!found && cursor < candidates.length && Date.now() < deadline) {
            const candidate = candidates[cursor]
            cursor += 1
            try {
                const origin = await resolveEntry(ctx, candidate, { deadline, timeoutMs: DRAMACOOL_PROBE_TIMEOUT_MS, requireCurrentYear: true })
                found = found ?? origin
            } catch {}
        }
    }
    // the walk is budgeted, not merely gated between candidates: a hop in flight when the budget
    // ends cannot hold the pass open past one entry timeout
    await Promise.race([
        Promise.all(Array.from({ length: DRAMACOOL_PROBE_CONCURRENCY }, worker)),
        sleep(DRAMACOOL_PROBE_BUDGET_MS + DRAMACOOL_PROBE_TIMEOUT_MS),
    ])
    return found
}

async function resolveDramaCool(ctx) {
    // an entirely dead family answers nothing, so the failure is remembered briefly: without it
    // every request during an outage would pay the whole resolution budget again
    if (dramaCoolFailure && Date.now() - dramaCoolFailure.at < DRAMACOOL_FAILURE_COOLDOWN_MS) throw dramaCoolFailure.error
    const deadline = Date.now() + DRAMACOOL_RESOLVE_BUDGET_MS
    let failure = null
    for (const entry of DRAMACOOL_ENTRIES) {
        if (Date.now() >= deadline) break
        try {
            const origin = await resolveEntry(ctx, entry, { deadline })
            dramaCoolFailure = null
            return (dramaCoolOrigin = origin)
        } catch (error) { failure = failure ?? error }
    }
    if (Date.now() >= dramaCoolProbeAfter) {
        const discovered = await probeFamily(ctx)
        if (discovered) {
            dramaCoolFailure = null
            return (dramaCoolOrigin = discovered)
        }
        dramaCoolProbeAfter = Date.now() + DRAMACOOL_PROBE_COOLDOWN_MS
    }
    const error = failure instanceof Error ? failure : new Error('no DramaCool entry answered')
    dramaCoolFailure = { at: Date.now(), error }
    throw error
}
function dramaCoolBase(ctx) {
    if (dramaCoolOrigin) return Promise.resolve(dramaCoolOrigin)
    if (dramaCoolResolving) return dramaCoolResolving
    dramaCoolResolving = resolveDramaCool(ctx).finally(() => { dramaCoolResolving = null })
    return dramaCoolResolving
}
// the cached origin is only dropped by the request that noticed it went stale, so a rotation
// does not stampede every in-flight call into re-resolving at once. A rotated origin answers 404
// for paths that exist on the live site, so even a miss is only final once the origin has been
// re-resolved; a rate limit and our own budget are the only failures that do not mean staleness,
// because the upstream has already answered and a resolution would only add load.
const staleOrigin = origin => {
    if (dramaCoolOrigin !== origin) return false
    dramaCoolOrigin = null
    return true
}
const mayBeStale = error => error?.status !== 429 && error?.code !== 'upstream_timeout'

async function wpJson(ctx, path, retry = true) {
    const origin = await dramaCoolBase(ctx)
    try {
        const { ok, status, text } = await requestText(ctx, new URL(path, origin).href, { budget: JSON_BUDGET_MS, headers: JSON_HEADERS })
        // a parked domain answers 200 with an HTML page, so a non-JSON body counts as stale too
        const body = ok ? parseJson(text) : null
        if (body != null) return body
        // WordPress names the reason in the body ("rest_post_invalid_page_number" for a page past
        // the end); keeping it lets the caller tell an ended list from a rejected query
        const named = str(parseJson(text)?.code)
        throw Object.assign(new Error(named ?? `http ${status}`), { status, wpCode: named })
    } catch (error) {
        if (retry && mayBeStale(error) && staleOrigin(origin)) return wpJson(ctx, path, false)
        throw error
    }
}

// the player only exists in the rendered episode page; the REST content field is empty for this
// theme, so playback reads the page the API points at instead of the post body
async function episodePage(ctx, link, retry = true) {
    const origin = await dramaCoolBase(ctx)
    const target = new URL(link, origin)
    if (target.protocol !== 'https:' || target.origin !== origin) {
        throw Object.assign(new Error('DramaCool episode link was invalid'), { code: 'invalid_request', status: 502 })
    }
    try {
        return await ctx.cached(ctx.fetchImpl, `dc:page:${target.href}`, PAGE_TTL, async () => {
            const { ok, status, text, url } = await requestText(ctx, target.href, { budget: PAGE_BUDGET_MS, headers: HTML_HEADERS })
            if (!ok) throw Object.assign(new Error(`http ${status}`), { status })
            // an unknown episode is answered with a 301 to the homepage, which would otherwise look
            // like a page that simply carries no player, so the served page has to be the one asked
            // for before it counts as an episode
            if (!new URL(url).pathname.includes(new URL(target.href).pathname.split('/').filter(Boolean).pop())) {
                throw Object.assign(new Error('DramaCool episode page was missing'), { status: 404 })
            }
            if (!text.includes(new URL(origin).host)) throw Object.assign(new Error('DramaCool request was blocked'), { status: 503 })
            return text
        })
    } catch (error) {
        if (retry && mayBeStale(error) && staleOrigin(origin)) return episodePage(ctx, link, false)
        throw error
    }
}

// keys are series slugs, the same ids the K-drama leg hands out, so both paths resolve a
// `dc:` key identically
const category = (ctx, slug) => {
    const key = `dc:category:${slug}`
    if (missHit(key)) return Promise.reject(notFound('Drama not found'))
    return ctx.cached(ctx.fetchImpl, key, CATEGORY_TTL, async () => {
        const data = await wpJson(ctx, `/wp-json/wp/v2/categories?slug=${encodeURIComponent(slug)}&per_page=1&_fields=${CATEGORY_FIELDS}`)
        const found = Array.isArray(data) ? data.find(row => row && row.id != null) : null
        if (!found) { markMiss(key); throw notFound('Drama not found') }
        return found
    })
}

async function posts(ctx, slug) {
    const cat = await category(ctx, slug)
    const id = Number(cat.id)
    if (!Number.isFinite(id)) throw notFound('Drama not found')
    return ctx.cached(ctx.fetchImpl, `dc:posts:${slug}`, POSTS_TTL, async () => {
        const found = []
        for (let page = 1; page <= POST_PAGES; page += 1) {
            // the poster only ever comes from the newest episode, so the seo block is asked for on
            // the first page alone
            const fields = page === 1 ? POST_FIELDS_COVER : POST_FIELDS
            const data = await wpJson(ctx, `/wp-json/wp/v2/posts?categories=${id}&per_page=${DEFAULT_LIMIT}&page=${page}&_fields=${fields}`)
                .catch(error => {
                    // past the last page WordPress answers rest_post_invalid_page_number and the list
                    // has ended; on the first page a rejection is a real failure, never an empty series
                    if (page > 1 && error?.wpCode === 'rest_post_invalid_page_number') return null
                    throw error
                })
            if (!Array.isArray(data) || !data.length) break
            found.push(...data)
            if (data.length < DEFAULT_LIMIT) break
        }
        return found
    })
}

const slugNumber = slug => {
    const value = String(slug || '')
    const match = value.match(EPISODE_SLUG) ?? value.match(EPISODE_ANY)
    if (match) return Number(match[1])
    return FULL_MOVIE_SLUG.test(value) ? 1 : null
}

const slugFromLink = link => {
    try { return new URL(link).pathname.split('/').filter(Boolean).pop() || null } catch { return null }
}

const episodeFromPost = post => {
    const id = str(post?.slug) ?? (str(post?.link) ? slugFromLink(post.link) : null)
    const number = slugNumber(id)
    if (!id || !DC_ID.test(id) || number == null) return null
    return { id, number, title: clean(post?.title?.rendered) || `Episode ${number}`, description: null, image: null, airDate: null }
}

// the theme's own featured-media embed answers 401 for anonymous callers, so the seo block is the
// free cover; a sibling domain that ships a different plugin simply leaves the poster unset and
// the reader falls back to its own resolver
const cover = post => {
    const image = post?.yoast_head_json?.og_image?.[0]
    return httpsUrl(typeof image === 'string' ? image : image?.url)
        ?? httpsUrl(post?.jetpack_featured_media_url)
        ?? httpsUrl(post?._embedded?.['wp:featuredmedia']?.[0]?.source_url)
}

export async function discover(ctx, { page = 1, limit = DEFAULT_LIMIT, search = null } = {}) {
    const perPage = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), DEFAULT_LIMIT)
    const offset = Math.max(1, Number(page) || 1)
    const query = `/wp-json/wp/v2/categories?orderby=count&order=desc&hide_empty=true&per_page=${perPage}&page=${offset}&_fields=${CATEGORY_FIELDS}`
        + (search ? `&search=${encodeURIComponent(search)}` : '')
    // a 100-row catalogue page costs one upstream call, so it is held with the same lifetime the
    // K-drama leg gives its catalogue; a new episode appears within the window, a browse does not
    // pay for it
    const data = await ctx.cached(ctx.fetchImpl, `dc:catalogue:${query}`, CATALOGUE_TTL, async () => {
        // past the last page the catalogue has simply ended, and this WordPress answers that with an
        // empty list; a 400 on a later page means the same, but on the first page it is a rejected
        // query and must surface rather than look like an empty catalogue
        return wpJson(ctx, query).catch(error => {
            if (offset > 1 && (error?.status === 400 || error?.wpCode === 'rest_post_invalid_page_number')) return []
            throw error
        })
    })
    const rows = (Array.isArray(data) ? data : []).map(cat => {
        const id = str(cat?.slug)
        const title = clean(cat?.name)
        if (!id || !DC_ID.test(id) || !title) return null
        return { key: `dc:${id}`, kind: 'drama', title, source: 'DramaCooli', poster: null }
    }).filter(Boolean)
    return { rows, hasMore: Array.isArray(data) && data.length >= perPage, partial: false, error: null }
}

export async function series(ctx, key) {
    const slug = String(key || '').split(':')[1] || ''
    if (!DC_ID.test(slug)) throw Object.assign(new Error('Invalid DramaCooli series'), { code: 'invalid_request' })
    const cat = await category(ctx, slug)
    const found = await posts(ctx, slug)
    return {
        key, kind: 'drama', title: clean(cat?.name) || 'Drama', source: 'DramaCooli',
        poster: cover(found[0]),
        synopsis: clean(cat?.description) || clean(found[0]?.excerpt?.rendered),
    }
}

export async function episodes(ctx, key) {
    const slug = String(key || '').split(':')[1] || ''
    if (!DC_ID.test(slug)) throw Object.assign(new Error('Invalid DramaCooli series'), { code: 'invalid_request' })
    const found = await posts(ctx, slug)
    return found.map(episodeFromPost).filter(Boolean).sort((a, b) => a.number - b.number || a.id.localeCompare(b.id))
}

// the theme's permalink is /<post-slug>/, so the page is reachable without asking the API for the
// link; the lookup stays as the fallback for a sibling domain that permalinks differently, and
// both paths are cached, so a play costs one upstream call
async function episodeLink(ctx, id) {
    const key = `dc:post:${id}`
    if (missHit(key)) throw notFound('DramaCooli episode not found')
    const origin = await dramaCoolBase(ctx)
    const guess = new URL(`/${encodeURIComponent(id)}/`, origin).href
    // the permalink is constructed, so a 404 here means the guess was wrong rather than the origin
    // rotated; the authoritative lookup below is the one that pays for a re-resolution
    const page = await episodePage(ctx, guess, false).catch(() => null)
    if (page) return page
    const post = await ctx.cached(ctx.fetchImpl, key, 2 * 60 * MINUTE, async () => {
        const data = await wpJson(ctx, `/wp-json/wp/v2/posts?slug=${encodeURIComponent(id)}&_fields=id,slug,link`)
        const link = str(Array.isArray(data) ? data[0]?.link : null)
        if (!link) { markMiss(key); throw notFound('DramaCooli episode not found') }
        return link
    })
    return episodePage(ctx, post)
}

// an episode page carries one player iframe, but a theme variant can add trailer or ad frames
// ahead of it, so every frame is scanned for a supported host instead of only the first
const playerFrame = (html, request) => {
    for (const tag of html.match(/<iframe\b[^>]*>/gi) ?? []) {
        const url = embedUrl(htmlAttr(tag, 'src') || htmlAttr(tag, 'data-src'), request)
        if (url) return url
    }
    for (const tag of html.match(/<div\b[^>]*>/gi) ?? []) {
        const url = embedUrl(htmlAttr(tag, 'data-video') || htmlAttr(tag, 'data-embed') || htmlAttr(tag, 'data-src'), request)
        if (url) return url
    }
    return null
}

export async function playback(ctx, key, language, episodeId) {
    const id = str(episodeId)
    if (!id || !DC_ID.test(id)) throw Object.assign(new Error('Invalid DramaCooli episode'), { code: 'invalid_request' })
    const html = await episodeLink(ctx, id)
    const url = playerFrame(html, ctx.request)
    if (!url) throw Object.assign(new Error('DramaCooli returned no playable embed'), { code: 'stream_unavailable' })
    return { sources: [{ kind: 'embed', url }], subtitles: [], providerLabel: 'DramaCooli' }
}

export const dramacooli = {
    key: 'dc', label: 'DramaCooli', kinds: ['drama'], source: 'DramaCooli',
    discover, series, episodes, playback,
}
