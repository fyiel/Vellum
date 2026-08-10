import { apiGet } from './http.js'
import { cached } from './cache.js'

const enc = encodeURIComponent
const MIN = 60 * 1000
const HOUR = 60 * MIN
const TIMEOUT = 20_000
const FORMATS = new Set(['all', 'tv', 'movie', 'ova', 'ona', 'special', 'music'])
const LANGUAGES = new Set(['sub', 'dub'])

const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
const optionalString = value => value == null || typeof value === 'string'
const stringList = value => value == null || (Array.isArray(value) && value.every(item => typeof item === 'string'))
const title = value => typeof value === 'string' && value.trim().length > 0

export const animeKey = id => {
    if (!opaque(id)) throw new Error('invalid anime id')
    return `miruro:${id}`
}

export const parseAnimeKey = key => {
    const text = String(key || '')
    if (!text.startsWith('miruro:')) return null
    const id = text.slice(7)
    return opaque(id) ? { provider: 'miruro', id } : null
}

const canonicalKey = key => {
    const parsed = parseAnimeKey(key)
    return parsed ? animeKey(parsed.id) : null
}
const sameKey = (actual, expected) => canonicalKey(actual) != null && (!expected || canonicalKey(actual) === canonicalKey(expected))

export const validAnimeSeries = (value, expectedKey) => sameKey(value?.key, expectedKey)
    && value?.kind === 'anime'
    && title(value?.title)
    && optionalString(value?.cover)
    && optionalString(value?.banner)
    && optionalString(value?.synopsis)
    && optionalString(value?.status)
    && optionalString(value?.format)
    && optionalString(value?.season)
    && optionalString(value?.source)
    && optionalString(value?.provider)
    && stringList(value?.alternateTitles)
    && stringList(value?.genres)
    && stringList(value?.studios)
    && (value?.year == null || Number.isInteger(value.year))
    && (value?.totalEpisodes == null || (Number.isInteger(value.totalEpisodes) && value.totalEpisodes >= 0))
    && (value?.duration == null || (Number.isFinite(value.duration) && value.duration >= 0))

const validEpisode = episode => opaque(episode?.id)
    && Number.isFinite(episode?.number)
    && episode.number >= 0
    && optionalString(episode?.title)
    && optionalString(episode?.description)
    && optionalString(episode?.image)
    && optionalString(episode?.airDate)

export const validAnimeEpisodes = (value, key, language) => {
    if (!sameKey(value?.key, key) || value?.language !== language || !Array.isArray(value?.episodes)) return false
    const ids = new Set()
    return value.episodes.every(episode => {
        if (!validEpisode(episode) || ids.has(episode.id)) return false
        ids.add(episode.id)
        return true
    })
}

const validHttps = value => {
    if (typeof value !== 'string') return false
    try { return new URL(value).protocol === 'https:' } catch { return false }
}

export const validAnimeStream = (value, key, language, episodeId) => sameKey(value?.key, key)
    && value?.language === language
    && value?.episode?.id === episodeId
    && validEpisode(value.episode)
    && Array.isArray(value?.sources)
    && value.sources.length > 0
    && value.sources.every(source => validHttps(source?.url)
        && ['hls', 'mp4'].includes(source?.type)
        && optionalString(source?.quality))
    && (value?.subtitles == null || (Array.isArray(value.subtitles)
        && value.subtitles.every(track => validHttps(track?.url) && optionalString(track?.label) && optionalString(track?.language))))

const requireValue = (promise, accept, message) => promise.then(value => {
    if (!accept(value)) throw new Error(message)
    return value
})

const query = params => {
    const out = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) if (value != null && value !== '') out.set(key, String(value))
    return out.toString()
}

const get = (path, signal) => apiGet(path, { signal, timeoutMs: TIMEOUT })
const resultValid = (value, page) => Array.isArray(value?.results)
    && value.results.every(item => validAnimeSeries(item))
    && typeof value?.hasMore === 'boolean'
    && (value.page == null || value.page === page)

const results = (kind, params, signal) => {
    const qs = query(params)
    const accept = value => resultValid(value, params.page)
    return cached(`anime:${kind}:${qs}`, kind === 'search' ? 5 * MIN : 10 * MIN,
        () => requireValue(get(`/read/api/anime/${kind}?${qs}`, signal), accept, `anime ${kind} unavailable`),
        { accept: value => accept(value) && value.results.length > 0, signal })
}

const validPage = (page, limit) => Number.isInteger(page) && page > 0 && Number.isInteger(limit) && limit > 0 && limit <= 50

export const discoverAnime = ({ format = 'all', page = 1, limit = 24 } = {}, { signal } = {}) => {
    if (!FORMATS.has(format) || !validPage(page, limit)) return Promise.reject(new Error('invalid anime discovery'))
    return results('discover', { format: format === 'all' ? undefined : format, page, limit }, signal)
}

export const searchAnime = (text, { format = 'all', page = 1, limit = 24, signal } = {}) => {
    const q = String(text || '').trim()
    if (!q) return Promise.resolve({ page: 1, results: [], hasMore: false })
    if (!FORMATS.has(format) || !validPage(page, limit)) return Promise.reject(new Error('invalid anime search'))
    return results('search', { q, format: format === 'all' ? undefined : format, page, limit }, signal)
}

export const getAnimeSeries = (key, { signal } = {}) => {
    const normalized = canonicalKey(key)
    if (!normalized) return Promise.reject(new Error('invalid anime key'))
    const accept = value => validAnimeSeries(value, normalized)
    return cached(`anime:series:${normalized}`, 6 * HOUR,
        () => requireValue(get(`/read/api/anime/series/${enc(normalized)}`, signal), accept, 'anime unavailable'),
        { accept, signal })
}

export const getAnimeEpisodes = (key, language = 'sub', { signal } = {}) => {
    const normalized = canonicalKey(key)
    if (!normalized || !LANGUAGES.has(language)) return Promise.reject(new Error('invalid anime episodes'))
    const accept = value => validAnimeEpisodes(value, normalized, language)
    return cached(`anime:episodes:${normalized}:${language}`, 20 * MIN,
        () => requireValue(get(`/read/api/anime/episodes?key=${enc(normalized)}&language=${language}`, signal), accept, 'episode list unavailable'),
        { accept: value => accept(value) && value.episodes.length > 0, signal })
}

export const getAnimeStream = (key, language, episodeId, { signal } = {}) => {
    const normalized = canonicalKey(key)
    if (!normalized || !LANGUAGES.has(language) || !opaque(episodeId)) return Promise.reject(new Error('invalid anime stream'))
    const accept = value => validAnimeStream(value, normalized, language, episodeId)
    return cached(`anime:stream:${normalized}:${language}:${episodeId}`, 10 * MIN,
        () => requireValue(get(`/read/api/anime/watch?key=${enc(normalized)}&language=${language}&id=${enc(episodeId)}`, signal), accept, 'stream unavailable'),
        { accept, swr: false, signal })
}

export const orderAnimeEpisodes = episodes => [...episodes].sort((a, b) => a.number - b.number || a.id.localeCompare(b.id))

export function animeErrorMessage(error, fallback = 'Anime unavailable') {
    if (error?.code === 'provider_unconfigured') return 'Anime playback is not configured.'
    if (error?.code === 'provider_unavailable' || error?.status === 502 || error?.status === 503) return 'Anime data is unavailable right now. Try again later.'
    if (error?.message === 'request timed out') return 'Miruro took too long to respond. Try again.'
    return typeof error?.message === 'string' && error.message ? error.message : fallback
}
