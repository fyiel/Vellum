import { createCipheriv } from 'node:crypto'

/*
KissKH drama provider (kisskh.co). Public API with no auth or cookies; episode and
subtitle resolution require a deterministic per-episode `kkey` — a custom AES-128-CBC
over a fixed part list whose guid constants are hardcoded in the SPA and server-validated
(a random guid is rejected with 403).

Playback: Type 1 = direct HLS (application/vnd.apple.mpegurl) on the kisskh CDN.
Type 2 / ThirdParty = awish.pro interactive anti-bot embeds (FingerprintJS + a
window.location.replace funnel) — not playable server-side or in an iframe, so those
fail closed with stream_unavailable.

Deploy constraint: kisskh.co and the HLS CDNs Cloudflare-challenge / ASN-block
datacenter egress (observed 403 'Just a moment' + error 1005 from the pm host), so
this provider is only usable from an egress the site allows. The CDNs also serve
wrong content-types (image/png / text/vnd.trolltech.linguist for MPEG-TS segments,
.jpg-named) — any proxied media route must force video/mp2t for segments and
application/vnd.apple.mpegurl for playlists (see anime-adapter.mjs animeDbMedia).
*/

const BASE = 'https://kisskh.co/api'
const KISS_ID = /^\d+$/
const MINUTE = 60_000
const KISS_KEY = Buffer.from('4f6bdaa39e2f8cb07f5e722d9edef314', 'hex')
const KISS_IV = Buffer.from('01504af356e619cf2e42bba68c3f70f9', 'hex')
const KISS_VI_GUID = '62f176f3bb1b5b8e70e39932ad34a0c7'
const KISS_SUB_GUID = 'VgV52sWhwvBSf8BsM3BRY9weWiiCbtGp'
const UA = 'Vellum/1.0 (+https://pumg.fyi/read)'

const str = value => typeof value === 'string' ? value : null
const timeout = (parent, ms = 12_000) => {
    const ctrl = new AbortController()
    const abort = () => ctrl.abort()
    if (parent?.aborted) abort()
    else parent?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, ms)
    return { signal: ctrl.signal, close: () => { clearTimeout(timer); parent?.removeEventListener('abort', abort) } }
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

const blocked = message => Object.assign(new Error(message), { code: 'provider_blocked' })

async function kissJson(ctx, path, ttl) {
    return ctx.cached(ctx.fetchImpl, `kiss:${path}`, ttl, async () => {
        const scoped = timeout(ctx.request?.signal)
        try {
            const response = await ctx.fetchImpl(`${BASE}${path}`, { headers: { 'user-agent': UA }, signal: scoped.signal })
            if (response.status === 403 || response.status === 429) throw blocked('KissKH blocked this server')
            if (!response.ok) throw Object.assign(new Error(`KissKH http ${response.status}`), { code: 'provider_unavailable' })
            const text = await response.text()
            if (text.includes('Just a moment') || text.includes('Attention Required')) throw blocked('KissKH is protected by a challenge')
            try { return JSON.parse(text) } catch { throw Object.assign(new Error('KissKH returned an invalid payload'), { code: 'provider_unavailable' }) }
        } finally { scoped.close() }
    })
}

export async function discover(ctx, { search } = {}) {
    const q = String(search || '').trim()
    const path = q ? `/DramaList/Search?q=${encodeURIComponent(q)}&type=0` : '/DramaList/LastUpdate?ispc=1'
    try {
        const rows = await kissJson(ctx, path, 10 * MINUTE)
        return {
            rows: (Array.isArray(rows) ? rows : []).map(row => ({
                key: `kiss:${row.id}`, kind: 'drama', title: str(row.title) || 'Untitled',
                source: 'KissKH', poster: str(row.thumbnail) || null,
            })),
            hasMore: false, partial: false, error: null,
        }
    } catch (error) {
        return { rows: [], hasMore: false, partial: true, error: { provider: 'kiss', code: error.code === 'provider_blocked' ? 'provider_blocked' : 'provider_unavailable', message: error.message } }
    }
}

const dramaId = key => {
    const id = String(key || '').split(':')[1] ?? ''
    if (!KISS_ID.test(id)) throw Object.assign(new Error('Invalid KissKH series'), { code: 'invalid_request' })
    return id
}

export async function series(ctx, key) {
    const id = dramaId(key)
    const d = await kissJson(ctx, `/DramaList/Drama/${id}?isq=true`, 30 * MINUTE)
    if (!d || !d.title) throw Object.assign(new Error('KissKH series not found'), { code: 'not_found' })
    return {
        key, kind: 'drama', title: d.title, source: 'KissKH', poster: str(d.thumbnail) || null,
        synopsis: str(d.description), country: str(d.country), status: str(d.status),
        year: typeof d.releaseDate === 'string' ? d.releaseDate.slice(0, 4) : null,
        episodeCount: d.episodesCount ?? null,
    }
}

export async function episodes(ctx, key) {
    const id = dramaId(key)
    const d = await kissJson(ctx, `/DramaList/Drama/${id}?isq=true`, 30 * MINUTE)
    return (Array.isArray(d?.episodes) ? d.episodes : [])
        .map(episode => ({
            id: String(episode.id), number: Number.isFinite(episode.number) ? episode.number : null,
            title: episode.number != null ? `Episode ${episode.number}` : 'Episode',
            description: null, image: null, airDate: null,
        }))
        .sort((a, b) => (a.number ?? -1) - (b.number ?? -1))
}

export async function playback(ctx, key, language, episodeId) {
    dramaId(key)
    if (!KISS_ID.test(String(episodeId))) throw Object.assign(new Error('Invalid KissKH episode'), { code: 'invalid_request' })
    const kkey = kisskhKkey(episodeId)
    const ep = await kissJson(ctx, `/DramaList/Episode/${episodeId}.png?err=false&ts=&time=&kkey=${kkey}`, 0)
    if (ep?.Type === 1 && typeof ep.Video === 'string' && ep.Video.startsWith('https://')) {
        const subtitles = await kissSubtitles(ctx, episodeId)
        return { sources: [{ kind: 'direct', url: ep.Video, type: 'application/vnd.apple.mpegurl' }], subtitles, providerLabel: 'KissKH' }
    }
    // Type 2 / ThirdParty are awish.pro anti-bot embeds — not playable; fail closed
    throw Object.assign(new Error('KissKH returned no playable stream'), { code: 'stream_unavailable' })
}

// subtitle tracks resolve via a separate subGuid-based kkey; episodes with sub:0 return []
async function kissSubtitles(ctx, episodeId) {
    const subkkey = kisskhKkey(episodeId, KISS_SUB_GUID)
    const tracks = await kissJson(ctx, `/Sub/${episodeId}?kkey=${subkkey}`, 0)
    return (Array.isArray(tracks) ? tracks : [])
        .map(track => ({ url: str(track?.src), label: str(track?.label), lang: str(track?.land) || str(track?.label) }))
        .filter(track => track.url && track.url.startsWith('https://') && track.lang)
}

export const kisskh = {
    key: 'kiss', label: 'KissKH', kinds: ['drama'], source: 'KissKH',
    discover, series, episodes, playback,
}
