import { createCipheriv } from 'node:crypto'

/*
KissKH drama provider (kisskh.co). Public API with no auth or cookies; episode and
subtitle resolution require a deterministic per-episode `kkey` — a custom AES-128-CBC
over a fixed part list whose guid constants are hardcoded in the SPA and server-validated
(a random guid is rejected with 403).

Playback: only Type 1 is a stream this server can hand out — direct HLS
(application/vnd.apple.mpegurl) on the kisskh CDN. A third-party interactive anti-bot
embed (the awish/dwish `.pro/e/…` FingerprintJS + window.location.replace funnel) rides
along with a non-1 Type and is not playable server-side or in an iframe, so anything that
is not exactly Type 1 fails closed with stream_unavailable. Re-probed 2026-09-18: the
embed marker seen live is Type 0 (dwish.pro), whose payload also carries a signed .mp4
Video — still refused, because the Type gate is the contract the embedder relies on.

Deploy constraint: kisskh.co and the HLS CDNs Cloudflare-challenge / ASN-block
datacenter egress (observed 403 'Just a moment' + error 1005 from the pm host), so
this provider is only usable from an egress the site allows. The CDNs also serve
wrong content-types (image/png / text/vnd.trolltech.linguist for MPEG-TS segments,
.jpg-named) — any proxied media route must force video/mp2t for segments and
application/vnd.apple.mpegurl for playlists (see anime-adapter.mjs animeDbMedia).

Live probe 2026-09-17 (residential egress, kisskh.co unchanged, no host move):
  GET /api/DramaList/LastUpdate?ispc=1         200  0.53s  4.2 KB
  GET /api/DramaList/Search?q=blade&type=0     200  0.42s  3.0 KB
  GET /api/DramaList/Drama/13742?isq=true      200  0.44s  1.2 KB
  GET /api/DramaList/Episode/224512.png?kkey=… 200  0.29s  Type 1 + signed HLS
  GET /api/Sub/224512?kkey=…                   200  0.29s  6 tracks
  range GET on the signed m3u8                 206  0.28-0.39s (still valid 10 min later)
so every upstream call is sub-second and the budget below is ~7x the worst sample.
The two API failure shapes that matter: a missing numeric id answers 400 with an
application/problem+json body (not 404), and a wrong/replayed kkey answers 403 with an
empty body — the latter fails closed as provider_blocked so a scheme change cannot be
mistaken for a transport blip.

Re-probe 2026-09-18 (same egress, port validation): 12 episodes across 12 dramas — 11 Type 1
(ThirdParty null, HLS on hlsNN.cdnvideo11.shop) and 1 Type 0 (drama 9777, ThirdParty
dwish.pro/e/…, Video a signed video/mp4 on videocdndelivery05.site that answered 206).
Type 2 — the sweep's capture — was not observed; the Type gate is what keeps all of them out.
*/

const BASE = 'https://kisskh.co/api'
const KISS_ID = /^\d+$/
const MINUTE = 60_000
const KISS_KEY = Buffer.from('4f6bdaa39e2f8cb07f5e722d9edef314', 'hex')
const KISS_IV = Buffer.from('01504af356e619cf2e42bba68c3f70f9', 'hex')
const KISS_VI_GUID = '62f176f3bb1b5b8e70e39932ad34a0c7'
const KISS_SUB_GUID = 'VgV52sWhwvBSf8BsM3BRY9weWiiCbtGp'
const UA = 'Vellum/1.0 (+https://pumg.fyi/read)'

// one upstream call is capped at 4.5s and a whole logical lookup (with its retries) at 8s, so a
// stalled origin costs one bounded wait instead of the 18s the caller used to sit through
const ATTEMPT_MS = 4_500
const BUDGET_MS = 8_000
const RETRY_DELAY_MS = [400, 1_200]
const MAX_RETRY_AFTER_MS = 3_000
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 527])
const REQUEST_HEADERS = { 'user-agent': UA, accept: 'application/json, text/plain, */*' }

// catalogue 10 min, series 30 min, subtitle tracks 15 min (static .srt on the CDN), episode
// resolution 5 min (the signed CDN URL still served after 10 min, and the client re-asks it on
// every open/replay). Everything is stale-served while it refreshes, so a long TTL never shows a
// reader an empty page — only the episode entry keeps a short stale window, because its value is a
// signed URL that has to stay plausible.
const TTL = { list: 10 * MINUTE, drama: 30 * MINUTE, subs: 15 * MINUTE, episode: 5 * MINUTE }
const MISS_TTL = 60_000
const STALE_MS = 12 * 60 * 60_000
const EPISODE_STALE_MS = 30 * MINUTE
const REFRESH_RETRY_MS = 30_000
const MAX_ENTRIES = 256

const str = value => typeof value === 'string' ? value : null
const num = value => {
    const parsed = Number(value)
    return value == null || value === '' || !Number.isFinite(parsed) ? null : parsed
}
const trimmed = value => str(value)?.trim() || null

const providerError = (code, message, retryable = false) => Object.assign(new Error(message), { code, retryable })
const blocked = message => providerError('provider_blocked', message)
const unavailable = message => providerError('provider_unavailable', message, true)
const notFound = message => providerError('not_found', message)
const invalid = message => providerError('invalid_request', message)
const streamUnavailable = message => providerError('stream_unavailable', message, true)
// codes an injected transport may already have decided for itself — see kissRequest
const CLASSIFIED = new Set(['provider_blocked', 'provider_unavailable', 'not_found', 'invalid_request', 'stream_unavailable'])
const cancelled = () => Object.assign(new Error('KissKH request cancelled'), { name: 'AbortError', code: 'request_cancelled' })
// a cancelled or teardown-shaped failure is about this one caller and must never be memorised
const shareable = error => error?.code !== 'request_cancelled' && error?.name !== 'AbortError'

const scope = (parent, ms) => {
    const ctrl = new AbortController()
    const abort = () => ctrl.abort()
    if (parent?.aborted) abort()
    else parent?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, ms)
    return { signal: ctrl.signal, close: () => { clearTimeout(timer); parent?.removeEventListener('abort', abort) } }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(cancelled()) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
})

const retryAfterMs = headers => {
    const raw = headers?.get?.('retry-after')
    const seconds = Number(raw)
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : null
}

// a missing numeric id answers 400/problem+json (there is no 404 on this API); a rejected kkey
// answers 403 with an empty body, which is a scheme problem, not a transport one
const httpError = (status, body, headers) => {
    if (status === 404) return notFound('KissKH has no such title')
    if (status === 400 && /problem\+json|"status"\s*:\s*400/.test(`${headers?.get?.('content-type') ?? ''} ${body.slice(0, 200)}`)) {
        return notFound('KissKH has no such title')
    }
    if (status === 401 || status === 403) return blocked('KissKH rejected the request')
    if (status === 429) return Object.assign(blocked('KissKH rate limited this server'), { retryable: true, retryAfter: retryAfterMs(headers) })
    if (RETRY_STATUS.has(status)) return Object.assign(unavailable(`KissKH http ${status}`), { retryAfter: retryAfterMs(headers) })
    return providerError('provider_unavailable', `KissKH http ${status}`)
}

// retried on 429/5xx and on transport errors; a challenge or a rejected signature is not retried
async function kissRequest(ctx, path, parent) {
    const deadline = Date.now() + BUDGET_MS
    let failure = null
    for (let attempt = 0; attempt <= RETRY_DELAY_MS.length; attempt++) {
        if (parent?.aborted) throw cancelled()
        if (attempt > 0) {
            const delay = Math.min(failure?.retryAfter ?? RETRY_DELAY_MS[attempt - 1], MAX_RETRY_AFTER_MS)
            if (Date.now() + delay >= deadline) break
            await sleep(delay, parent)
            if (parent?.aborted) throw cancelled()
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        const scoped = scope(parent, Math.min(ATTEMPT_MS, remaining))
        let response = null
        let body = ''
        try {
            response = await ctx.fetchImpl(`${BASE}${path}`, { headers: REQUEST_HEADERS, signal: scoped.signal })
            body = await response.text()
        } catch (error) {
            scoped.close()
            if (parent?.aborted) throw cancelled()
            // our own per-attempt timeout — worth one more try
            if (error?.name === 'AbortError') {
                failure = unavailable('KissKH timed out')
                continue
            }
            // a transport is injected into every provider (handleAnimeRequest's fetchImpl), and a
            // caller that already classified its own failure must not have that verdict flattened
            // into a generic blip — nor a non-retryable one retried
            if (CLASSIFIED.has(error?.code)) {
                if (!error.retryable) throw error
                failure = error
                continue
            }
            // a plain transport failure: worth one more try
            failure = unavailable(`KissKH transport error: ${error?.message ?? error}`)
            continue
        }
        scoped.close()
        if (response.ok) return body
        failure = httpError(response.status, body, response.headers)
        if (!failure.retryable || (failure.retryAfter ?? 0) > MAX_RETRY_AFTER_MS) throw failure
    }
    throw failure ?? unavailable('KissKH is unavailable')
}

const CHALLENGE = /Just a moment|Attention Required|cf-browser-verification|Enable JavaScript and cookies/i
// browsers render these endpoints as <pre>-wrapped HTML; only a JSON-looking body is parsed, so a
// challenge or error page is classified instead of being read as a malformed payload
const kissJson = body => {
    const text = String(body ?? '').replace(/^\uFEFF/, '').trim()
    if (text.startsWith('[') || text.startsWith('{')) {
        try { return JSON.parse(text) } catch { throw unavailable('KissKH returned an invalid payload') }
    }
    if (CHALLENGE.test(text.slice(0, 4_096))) throw blocked('KissKH is protected by a challenge')
    throw unavailable(text.length ? 'KissKH returned an unexpected payload' : 'KissKH returned an empty payload')
}

/*
Per-source cache: a hit returns its value synchronously (no microtask, no upstream call), an
expired positive entry is served instantly while the refresh runs behind the request, and a failed
refresh never drops the last good copy. Failures are memorised for MISS_TTL only, so one blip
cannot hide content for hours while a genuinely dead id stops being re-fetched on every request.

Every store is keyed by the caller's fetch identity — the same identity the adapter keys its own
`cached` on — so a payload fetched for one request can never be handed to another one; a store dies
with the last context that used it.
*/
const stores = new WeakMap()
const sharedStore = { entries: new Map(), inflight: new Map() }
const keyable = value => typeof value === 'function' || (typeof value === 'object' && value !== null)
// a caller that supplies neither an identity nor a cache has nothing to key on (the adapter always
// passes both), so it shares one store
const storeFor = ctx => {
    if (!keyable(ctx?.fetchImpl)) return sharedStore
    let store = stores.get(ctx.fetchImpl)
    if (!store) { store = { entries: new Map(), inflight: new Map() }; stores.set(ctx.fetchImpl, store) }
    return store
}

// the value leg goes through the adapter's `cached(fetchImpl, key, ttl, load)` whenever one is
// supplied, so a cache the embedder injected is the one holding the payload; the bookkeeping below
// exists because that signature has no vocabulary for stale serving or for a bounded failure window
const throughCache = (ctx, key, ttl, fetcher) => keyable(ctx?.fetchImpl) && typeof ctx.cached === 'function'
    ? ctx.cached(ctx.fetchImpl, `kiss:${key}`, ttl, fetcher)
    : fetcher()

const remember = (store, key, entry) => {
    store.entries.delete(key)
    store.entries.set(key, entry)
    while (store.entries.size > MAX_ENTRIES) store.entries.delete(store.entries.keys().next().value)
}

const load = (ctx, key, ttl, staleMs, fetcher, negative) => {
    const store = storeFor(ctx)
    const running = store.inflight.get(key)
    if (running) return running
    const promise = throughCache(ctx, key, ttl, fetcher).then(value => {
        remember(store, key, { value, expires: Date.now() + ttl, stale: Date.now() + ttl + staleMs })
        return value
    }, error => {
        if (shareable(error)) remember(store, key, { error, expires: Date.now() + negative, stale: Date.now() + negative })
        throw error
    }).finally(() => { if (store.inflight.get(key) === promise) store.inflight.delete(key) })
    store.inflight.set(key, promise)
    return promise
}

const refresh = (ctx, key, ttl, staleMs, fetcher, previous) => {
    const store = storeFor(ctx)
    if (store.inflight.has(key)) return
    const promise = throughCache(ctx, key, ttl, fetcher).then(value => {
        remember(store, key, { value, expires: Date.now() + ttl, stale: Date.now() + ttl + staleMs })
    }, () => {
        // keep the last good copy; push its stale deadline out so a down upstream is re-tried at
        // most every REFRESH_RETRY_MS instead of once per request
        if (store.entries.get(key) === previous) remember(store, key, { ...previous, stale: Date.now() + REFRESH_RETRY_MS })
    }).finally(() => { if (store.inflight.get(key) === promise) store.inflight.delete(key) })
    store.inflight.set(key, promise)
}

const kissCached = (ctx, key, ttl, fetcher, { negative = MISS_TTL, staleMs = STALE_MS } = {}) => {
    const store = storeFor(ctx)
    const hit = store.entries.get(key)
    if (hit) {
        const now = Date.now()
        if (hit.expires > now) {
            remember(store, key, hit)
            if (hit.error) throw hit.error
            return hit.value
        }
        if (!hit.error && hit.stale > now) {
            remember(store, key, hit)
            refresh(ctx, key, ttl, staleMs, fetcher, hit)
            return hit.value
        }
    }
    return load(ctx, key, ttl, staleMs, fetcher, negative)
}

// a fresh value without triggering a load — the only way prefetch may decide what is missing
const peek = (ctx, key) => {
    const store = storeFor(ctx)
    const hit = store.entries.get(key)
    if (!hit || hit.error || hit.expires <= Date.now()) return null
    remember(store, key, hit)
    return hit.value
}

/*
Route-driven prefetch: a reader who just played an episode is very likely to play the next one, so
the next episode's resolution is warmed behind the response. It is deliberately narrow — it can only
run off a cached episode list (looking one up purely to guess the next id would cost more than it
saves), it warms exactly one episode ahead, it never routes through `playback` itself (so the queue
cannot self-perpetuate), a warm failure is never memorised as a real answer, and a warm fetch is
detached from the caller's request so it finishes after the response is sent.
*/
const warmQueue = []
let warmBusy = false
const warmPump = async () => {
    if (warmBusy) return
    warmBusy = true
    try {
        while (warmQueue.length) await warmQueue.shift()()
    } finally { warmBusy = false }
}
const warmNextEpisode = (ctx, seriesId, episodeId) => {
    const doc = peek(ctx, `drama:${seriesId}`)
    const listed = (Array.isArray(doc?.episodes) ? doc.episodes : []).filter(episode => KISS_ID.test(String(episode?.id ?? '')))
    if (listed.length < 2) return
    const ordered = [...listed].sort((a, b) => (num(a.number) ?? -1) - (num(b.number) ?? -1))
    const next = ordered[ordered.findIndex(episode => String(episode.id) === episodeId) + 1]
    if (!next) return
    const nextId = String(next.id)
    if (peek(ctx, `episode:${nextId}`) && peek(ctx, `subs:${nextId}`)) return
    if (warmQueue.length >= 2 || warmQueue.some(job => job.id === nextId)) return
    const detached = { ...ctx, request: undefined }
    const job = async () => { await Promise.allSettled([kissEpisode(detached, nextId, 0), kissSubtitles(detached, nextId, 0)]) }
    job.id = nextId
    warmQueue.push(job)
    void warmPump()
}

// deterministic per-episode signature; verified against the live API (episode 129348)
export const kisskhKkey = (episodeId, guid = KISS_VI_GUID) => {
    const parts = ['', String(episodeId), null, 'mg3c3b04ba', '2.8.10', guid, 4830201,
        'kisskh', 'kisskh', 'kisskh', 'kisskh', 'kisskh', 'kisskh', '00', '']
    let h = 0
    const joined = parts.join('|')
    for (let i = 0; i < joined.length; i++) h = (h << 5) - h + joined.charCodeAt(i)
    parts.splice(1, 0, h)
    const cipher = createCipheriv('aes-128-cbc', KISS_KEY, KISS_IV)
    return Buffer.concat([cipher.update(parts.join('|'), 'utf8'), cipher.final()]).toString('hex').toUpperCase()
}

const listPath = query => query ? `/DramaList/Search?q=${encodeURIComponent(query)}&type=0` : '/DramaList/LastUpdate?ispc=1'
const dramaPath = id => `/DramaList/Drama/${id}?isq=true`
const episodePath = id => `/DramaList/Episode/${id}.png?err=false&ts=&time=&kkey=${kisskhKkey(id)}`
const subtitlePath = id => `/Sub/${id}?kkey=${kisskhKkey(id, KISS_SUB_GUID)}`

const kissList = async (ctx, query) => kissCached(ctx, `list:${query.toLowerCase()}`, TTL.list, async () => {
    const path = listPath(query)
    const rows = kissJson(await kissRequest(ctx, path, ctx.request?.signal))
    return Array.isArray(rows) ? rows : []
}, { negative: 30_000 })

// series metadata and the episode list are the same upstream document, so both routes share one
// entry: a series request with its episode list costs exactly one call to /DramaList/Drama/<id>
const kissDrama = async (ctx, id) => kissCached(ctx, `drama:${id}`, TTL.drama, async () => {
    const path = dramaPath(id)
    const row = kissJson(await kissRequest(ctx, path, ctx.request?.signal))
    if (!row || typeof row !== 'object' || Array.isArray(row) || !trimmed(row.title)) throw notFound('KissKH series not found')
    return row
})

const kissEpisode = async (ctx, id, negative = MISS_TTL) => kissCached(ctx, `episode:${id}`, TTL.episode, async () => {
    const path = episodePath(id)
    const row = kissJson(await kissRequest(ctx, path, ctx.request?.signal))
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw unavailable('KissKH returned no episode payload')
    return row
}, { staleMs: EPISODE_STALE_MS, negative })

// subtitle tracks resolve via a separate subGuid-based kkey; episodes with sub:0 return []
// (async so a memorised failure or the cache's synchronous hit path still hands back a promise)
const kissSubtitles = async (ctx, id, negative = 30_000) => kissCached(ctx, `subs:${id}`, TTL.subs, async () => {
    const path = subtitlePath(id)
    const tracks = kissJson(await kissRequest(ctx, path, ctx.request?.signal))
    return (Array.isArray(tracks) ? tracks : [])
        .map(track => {
            const label = trimmed(track?.label)
            const land = trimmed(track?.land)
            return { url: str(track?.src), label: label || land, lang: land || label }
        })
        .filter(track => track.url?.startsWith('https://') && track.lang)
}, { negative })

export async function discover(ctx, { search } = {}) {
    const query = String(search || '').trim()
    try {
        const rows = await kissList(ctx, query)
        return {
            rows: rows.map(row => ({
                key: `kiss:${row?.id}`, kind: 'drama', title: trimmed(row?.title) || 'Untitled',
                source: 'KissKH', poster: str(row?.thumbnail) || null,
            })).filter(row => KISS_ID.test(row.key.slice(5))),
            hasMore: false, partial: false, error: null,
        }
    } catch (error) {
        return { rows: [], hasMore: false, partial: true, error: { provider: 'kiss', code: error?.code === 'provider_blocked' ? 'provider_blocked' : 'provider_unavailable', message: error?.message } }
    }
}

const dramaId = key => {
    const id = String(key || '').split(':')[1] ?? ''
    if (!KISS_ID.test(id)) throw invalid('Invalid KissKH series')
    return id
}

const episodeKey = value => {
    const id = String(value ?? '')
    if (!KISS_ID.test(id)) throw invalid('Invalid KissKH episode')
    return id
}

export async function series(ctx, key) {
    const id = dramaId(key)
    const d = await kissDrama(ctx, id)
    return {
        key, kind: 'drama', title: trimmed(d.title) || 'Untitled', source: 'KissKH', poster: str(d.thumbnail) || null,
        synopsis: str(d.description), country: str(d.country), status: str(d.status),
        year: typeof d.releaseDate === 'string' ? d.releaseDate.slice(0, 4) : null,
        episodeCount: num(d.episodesCount) ?? null,
    }
}

export async function episodes(ctx, key) {
    const id = dramaId(key)
    const d = await kissDrama(ctx, id)
    return (Array.isArray(d.episodes) ? d.episodes : [])
        .filter(episode => KISS_ID.test(String(episode?.id ?? '')))
        .map(episode => {
            const number = num(episode.number)
            return {
                id: String(episode.id), number,
                title: number != null ? `Episode ${number}` : 'Episode',
                description: null, image: null, airDate: null,
            }
        })
        .sort((a, b) => (a.number ?? -1) - (b.number ?? -1))
}

export async function playback(ctx, key, language, episodeId) {
    const seriesId = dramaId(key)
    const id = episodeKey(episodeId)
    // the two lookups are independent, so the subtitle track list is already in flight while the
    // episode resolves; both are cached, so a replay of the same episode costs no upstream call
    const pendingSubs = kissSubtitles(ctx, id)
    pendingSubs.catch(() => {}) // the rejection is consumed below — keep it out of the unhandled set
    let ep
    try {
        ep = await kissEpisode(ctx, id)
    } catch (error) {
        if (error?.code === 'not_found') throw streamUnavailable('KissKH returned no playable stream')
        throw error
    }
    // Type 2 / ThirdParty are awish.pro anti-bot embeds — not playable; fail closed
    if (num(ep.Type) !== 1) throw streamUnavailable('KissKH returned no playable stream')
    // the API hands out both `https://…` and protocol-relative `//…` (the latter only seen on the
    // Type 2 countdown widget so far); on an https origin `//host` means https, and a plain-http
    // stream is refused because the client would block it as mixed content
    const video = str(ep.Video)
    const url = video?.startsWith('//') ? `https:${video}` : video
    if (!url?.startsWith('https://')) throw streamUnavailable('KissKH returned no playable stream')
    // a dead subtitle leg must not take a playable stream down with it (a cancelled request is
    // not a dead leg — it must still surface as 499)
    const subtitles = await pendingSubs.catch(error => {
        if (error?.name === 'AbortError' || error?.code === 'request_cancelled') throw error
        return []
    })
    // the reader is here, the next episode is the likeliest next read: warm it behind the response
    if (!ctx.request?.signal?.aborted) warmNextEpisode(ctx, seriesId, id)
    return { sources: [{ kind: 'direct', url, type: 'application/vnd.apple.mpegurl' }], subtitles, providerLabel: 'KissKH' }
}

export const kisskh = {
    key: 'kiss', label: 'KissKH', kinds: ['drama'], source: 'KissKH',
    discover, series, episodes, playback,
}
