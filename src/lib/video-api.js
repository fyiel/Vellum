import { apiGet, apiUrl } from './http.js'
import { cached } from './cache.js'
import { anilistDiscover } from './anilist.js'

/*
Provider adapter boundary. The shared UI only consumes normalized responses from:
  GET /read/api/video/discover
  GET /read/api/video/series/:provider-prefixed-key
  GET /read/api/video/playback?key=...&id=...
Playback sources are a tagged union: { kind:'direct', url, type } or
{ kind:'embed', url }. Both carry a response-level, user-visible providerLabel.
*/

const enc = encodeURIComponent
const MIN = 60 * 1000
const KEY = /^([a-z0-9][a-z0-9-]{0,31}):([a-z0-9][a-z0-9._-]{0,199})$/i
const ID = /^[a-z0-9][a-z0-9._-]{0,199}$/i
const KINDS = ['anime', 'drama']
const TYPES = ['video/mp4', 'video/webm', 'application/x-mpegURL', 'application/vnd.apple.mpegurl']

export const parseVideoKey = key => {
    const match = String(key || '').match(KEY)
    return match ? { provider: match[1].toLowerCase(), id: match[2] } : null
}

const sameKey = (actual, expected) => {
    const a = parseVideoKey(actual)
    const e = parseVideoKey(expected)
    return Boolean(a && (expected == null || (e && a.provider === e.provider && a.id === e.id)))
}
const title = value => typeof value === 'string' && value.trim().length > 0
const safeUrl = value => {
    if (typeof value !== 'string' || !value) return false
    if (value.startsWith('/')) return !value.startsWith('//')
    try { return new URL(value).protocol === 'https:' } catch { return false }
}
const episode = value => ID.test(String(value?.id || ''))
    && (value.number == null || Number.isFinite(value.number))
    && (value.season == null || (Number.isInteger(value.season) && value.season > 0))
const source = value => value?.kind === 'direct'
    ? safeUrl(value.url) && TYPES.includes(value.type)
    : value?.kind === 'embed' && /^https:\/\//i.test(value.url) && safeUrl(value.url)

export const validVideoSeries = (value, expectedKey) => sameKey(value?.key, expectedKey)
    && KINDS.includes(value?.kind)
    && title(value?.title)

export const validVideoDetail = (value, expectedKey) => {
    if (!validVideoSeries(value, expectedKey) || !Array.isArray(value.episodes) || !value.episodes.length) return false
    const ids = new Set()
    return value.episodes.every(item => {
        if (!episode(item) || ids.has(item.id)) return false
        ids.add(item.id)
        return true
    })
}

export const validVideoPlayback = (value, key, episodeId) => sameKey(value?.key, key)
    && String(value?.episodeId || '') === String(episodeId)
    && title(value?.providerLabel)
    && Array.isArray(value.sources)
    && value.sources.length > 0
    && value.sources.every(source)
    && (value.subtitles == null || (Array.isArray(value.subtitles) && value.subtitles.every(track => safeUrl(track?.url) && title(track?.lang))))

const query = params => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params || {})) if (value != null && value !== '') search.set(key, String(value))
    return search.toString()
}
const complete = value => (value?.partial == null || value.partial === false)
    && (value?.errors == null || (Array.isArray(value.errors) && value.errors.length === 0))
const validResults = value => Array.isArray(value?.results)
    && value.results.every(item => validVideoSeries(item))
    && typeof value.hasMore === 'boolean'
const requireValue = (promise, accept, message) => promise.then(value => {
    if (!accept(value)) throw new Error(message)
    return value
})

export const videoAssetUrl = value => /^https:/i.test(value || '') ? value : apiUrl(value || '')

const interleave = (left, right, limit) => {
    const output = []
    for (let index = 0; output.length < limit && index < Math.max(left.length, right.length); index++) {
        if (left[index]) output.push(left[index])
        if (output.length < limit && right[index]) output.push(right[index])
    }
    return output
}

const providerError = (provider, error) => error?.status === 404
    ? { provider, code: 'provider_unconfigured', message: `${provider === 'miruro' ? 'Anime' : 'Drama'} playback is not configured` }
    : { provider, code: 'provider_unavailable', message: `${provider === 'miruro' ? 'Anime' : 'Drama'} provider unavailable` }

export function discoverVideo({ q = '', kind = 'all', page = 1, limit = 30, signal } = {}) {
    const qText = String(q).trim()
    const qs = query({ q: qText, kind, page, limit })
    const dramaLeg = () => apiGet(`/read/api/video/discover?${query({ q: qText, kind: 'drama', page, limit })}`, { signal })
    const load = async () => {
        if (kind === 'drama') {
            return requireValue(dramaLeg(), validResults, 'video catalogue unavailable')
        }
        const [anime, drama] = await Promise.all([
            anilistDiscover({ q: qText, page, limit, signal })
                .then(value => ({ rows: value.rows.map(row => ({ ...row, poster: row.cover })), hasMore: value.hasMore, error: null }))
                .catch(error => ({ rows: [], hasMore: false, error })),
            kind === 'all'
                ? dramaLeg()
                    .then(value => ({ rows: value.results || [], hasMore: Boolean(value.hasMore), partial: Boolean(value.partial), errors: value.errors || [], error: null }))
                    .catch(error => ({ rows: [], hasMore: false, partial: false, errors: [], error }))
                : { rows: [], hasMore: false, partial: false, errors: [], error: null },
        ])
        // anime is client-side (AniList is CORS-open); only drama goes through the proxy
        if (kind === 'anime') {
            if (anime.error) throw anime.error
            return { page, results: anime.rows, hasMore: anime.hasMore, partial: false, errors: [] }
        }
        if (anime.error?.name === 'AbortError' || drama.error?.name === 'AbortError') {
            throw anime.error?.name === 'AbortError' ? anime.error : drama.error
        }
        // initial feed degrades to a notice on a dead leg; a failed "load more" must surface retry
        if (page > 1 && (anime.error || drama.error)) throw anime.error || drama.error
        const errors = [
            ...(drama.errors || []),
            ...(anime.error ? [providerError('miruro', anime.error)] : []),
            ...(drama.error ? [providerError('dc', drama.error)] : []),
        ]
        if (anime.error && drama.error) {
            const error = new Error('video catalogue unavailable')
            error.status = 502
            throw error
        }
        return {
            page,
            results: interleave(anime.rows, drama.rows, limit),
            hasMore: anime.hasMore || drama.hasMore,
            partial: Boolean(anime.error || drama.error || drama.partial),
            errors,
        }
    }
    return cached(`video:discover:${qs}`, 5 * MIN, load, {
        accept: value => validResults(value) && value.results.length > 0 && complete(value), signal,
    })
}

export function getVideoSeries(key, { signal, fresh = false } = {}) {
    if (!parseVideoKey(key)) return Promise.reject(new Error('invalid video key'))
    const accept = value => validVideoDetail(value, key) && complete(value)
    const load = () => requireValue(apiGet(`/read/api/video/series/${enc(key)}`, { signal }), accept, 'series unavailable')
    // 30min: episode lists change slowly and a warm revisit should feel instant
    return fresh ? load() : cached(`video:series:${key}`, 30 * MIN, load, {
        accept, signal,
    })
}

export function getVideoPlayback(key, episodeId, { signal } = {}) {
    if (!parseVideoKey(key) || !ID.test(String(episodeId || ''))) return Promise.reject(new Error('invalid video episode'))
    const qs = query({ key, id: episodeId })
    const accept = value => validVideoPlayback(value, key, episodeId)
    // Stream and embed URLs may be signed or short-lived; ownership stays with this route request.
    return requireValue(apiGet(`/read/api/video/playback?${qs}`, { signal }), accept, 'playback unavailable')
}
