import { apiGet } from './http.js'
import { cached } from './cache.js'

const enc = encodeURIComponent
const MIN = 60 * 1000
const HOUR = 60 * MIN
const TIMEOUT = 20_000
const KEY = /^(gp|dc):([a-z0-9][a-z0-9._~-]{0,299})$/i
const ID = /^[a-z0-9][a-z0-9._~-]{0,299}$/i
const PROVIDERS = ['gp', 'dc']
const PROVIDER_NAME = { gp: 'GoPlay', dc: 'DramaCool' }

export const kDramaProviderName = provider => PROVIDER_NAME[String(provider || '').toLowerCase()] || 'K-drama source'

export function kDramaKey(provider, id) {
    const key = `${String(provider).toLowerCase()}:${id}`
    if (!KEY.test(key)) throw new Error('invalid K-drama key')
    return key
}

export function parseKDramaKey(key) {
    const match = String(key || '').match(KEY)
    return match ? { provider: match[1].toLowerCase(), id: match[2] } : null
}

const canonicalKey = value => {
    const parsed = parseKDramaKey(value)
    return parsed ? kDramaKey(parsed.provider, parsed.id) : null
}
const sameKey = (actual, expected) => canonicalKey(actual) != null && (!expected || canonicalKey(actual) === canonicalKey(expected))
const validId = value => ID.test(String(value || ''))
const validTitle = value => typeof value === 'string' && value.trim().length > 0
const validOptionalString = value => value == null || typeof value === 'string'
const validStringList = value => value == null || (Array.isArray(value) && value.every(item => validTitle(item)))
const validSourceUrl = value => {
    if (value == null) return true
    if (typeof value !== 'string') return false
    try { return new URL(value).protocol === 'https:' } catch { return false }
}
const validCover = value => value == null || (typeof value === 'string'
    && (value.startsWith('https://') || value.startsWith('data:image/') || value.startsWith('/read/api/kdrama/image?')))

export const validKDramaSeries = (value, expectedKey) =>
    sameKey(value?.key, expectedKey)
    && value?.kind === 'kdrama'
    && validTitle(value?.title)
    && validCover(value?.cover)
    && validSourceUrl(value?.sourceUrl)
    && ['status', 'country', 'synopsis'].every(key => validOptionalString(value?.[key]))
    && ['alternateTitles', 'genres'].every(key => validStringList(value?.[key]))
    && (value?.year == null || (Number.isInteger(value.year) && value.year >= 1800 && value.year <= 3000))
    && (value?.episodeCount == null || (Number.isInteger(value.episodeCount) && value.episodeCount >= 0))

const validEpisode = episode => validId(episode?.id)
    && (episode?.number === null || (Number.isFinite(episode?.number) && episode.number >= 0))
    && ['title', 'airedAt', 'duration', 'sourceUrl'].every(key => validOptionalString(episode?.[key]))
    && validSourceUrl(episode?.sourceUrl)

export const validKDramaEpisodes = (value, expectedKey) => {
    if (!sameKey(value?.key, expectedKey) || !Array.isArray(value?.episodes)) return false
    const ids = new Set()
    return value.episodes.every(episode => {
        const id = String(episode?.id || '')
        if (!validEpisode(episode) || ids.has(id)) return false
        ids.add(id)
        return true
    })
}

export const validKDramaEpisode = (value, key, episodeId) =>
    sameKey(value?.key, key)
    && String(value?.episode?.id || '') === String(episodeId)
    && validEpisode(value?.episode)
    && (value?.available == null || typeof value.available === 'boolean')

const validProviderError = error => error && typeof error === 'object'
    && (error.provider == null || Object.hasOwn(PROVIDER_NAME, error.provider))
    && ['code', 'message'].every(key => validOptionalString(error[key]))
    && (error.retryable == null || typeof error.retryable === 'boolean')
    && (error.retryAfterMs == null || (Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0))
const validMeta = value => (value?.partial == null || typeof value.partial === 'boolean')
    && (value?.errors == null || (Array.isArray(value.errors) && value.errors.every(validProviderError)))
const complete = value => (value?.partial == null || value.partial === false) && (!value?.errors || value.errors.length === 0)
const validResults = (value, page) => Array.isArray(value?.results)
    && value.results.every(item => validKDramaSeries(item))
    && typeof value?.hasMore === 'boolean'
    && (value.page == null || value.page === page)
    && validMeta(value)

const query = params => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) if (value != null && value !== '') search.set(key, String(value))
    return search.toString()
}
const dramaGet = (path, signal) => apiGet(path, { signal, timeoutMs: TIMEOUT })
const requireValue = (promise, accept, message) => promise.then(value => {
    if (!accept(value)) throw new Error(message)
    return value
})

const normalizeProviderResults = (value, provider) => {
    const seen = new Set()
    const results = value.results.filter(item => {
        const keep = parseKDramaKey(item.key)?.provider === provider && !seen.has(item.key)
        seen.add(item.key)
        return keep
    })
    const errorProviderChanged = (value.errors || []).some(error => error.provider !== provider)
    if (results.length === value.results.length && !errorProviderChanged) return value
    const errors = (value.errors || []).map(error => ({ ...error, provider }))
    return {
        ...value,
        results,
        partial: true,
        errors: results.length === value.results.length
            ? errors
            : [...errors, { provider, code: 'invalid_results', message: 'Unexpected K-drama results were ignored' }],
    }
}

const providerError = (error, provider) => ({
    provider,
    code: typeof error?.code === 'string' ? error.code : 'provider_unavailable',
    message: typeof error?.message === 'string' && error.message ? error.message : `${kDramaProviderName(provider)} unavailable`,
    retryable: typeof error?.retryable === 'boolean' ? error.retryable : true,
    ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
})

async function providerResults(kind, qs, provider, page, signal) {
    const value = await requireValue(
        dramaGet(`/read/api/kdrama/${kind}?${qs}&source=${provider}`, signal),
        result => validResults(result, page),
        `${kDramaProviderName(provider)} response unavailable`,
    )
    return normalizeProviderResults(value, provider)
}

async function loadResults(kind, params, signal) {
    const providers = params.source === 'all' ? PROVIDERS : [params.source]
    const qs = query({ ...(kind === 'search' ? { q: params.q } : {}), page: params.page, limit: params.limit })
    const settled = await Promise.allSettled(providers.map(provider => providerResults(kind, qs, provider, params.page, signal)))
    if (signal?.aborted) throw Object.assign(new Error('request aborted'), { name: 'AbortError' })
    const results = []
    const errors = []
    let hasMore = false
    let partial = false
    settled.forEach((result, index) => {
        const provider = providers[index]
        if (result.status === 'rejected') {
            partial = true
            errors.push(providerError(result.reason, provider))
            return
        }
        results.push(...result.value.results)
        hasMore ||= result.value.hasMore
        partial ||= Boolean(result.value.partial) || Boolean(result.value.errors?.length)
        errors.push(...(result.value.errors || []))
    })
    return { page: params.page, results, hasMore, partial, errors }
}

const validRequest = ({ source, page, limit }) => (source === 'all' || PROVIDERS.includes(source))
    && Number.isInteger(page) && page > 0 && Number.isInteger(limit) && limit > 0 && limit <= 100

const resultsRequest = (kind, params, signal) => {
    if (!validRequest(params)) return Promise.reject(new Error(`invalid K-drama ${kind}`))
    const cacheKey = query(params)
    const accept = value => validResults(value, params.page) && value.results.length > 0 && complete(value)
    return cached(`kdrama:${kind}:${cacheKey}`, kind === 'search' ? 5 * MIN : 10 * MIN,
        () => loadResults(kind, params, signal), { accept, signal })
}

export const searchKDrama = (text, { source = 'all', page = 1, limit = 30, signal } = {}) => {
    const q = String(text || '').trim()
    if (!q) return Promise.resolve({ page: 1, results: [], hasMore: false, partial: false, errors: [] })
    return resultsRequest('search', { q, source, page, limit }, signal)
}

export const discoverKDrama = ({ source = 'all', page = 1, limit = 30, signal } = {}) =>
    resultsRequest('discover', { source, page, limit }, signal)

export const getKDramaSeries = (key, { signal } = {}) => {
    const normalized = canonicalKey(key)
    if (!normalized) return Promise.reject(new Error('invalid K-drama key'))
    const accept = value => validKDramaSeries(value, normalized) && validMeta(value) && complete(value)
    return cached(`kdrama:series:${normalized}`, 6 * HOUR,
        () => requireValue(dramaGet(`/read/api/kdrama/series/${enc(normalized)}`, signal), accept, 'K-drama unavailable'),
        { accept, signal })
}

export const getKDramaEpisodes = (key, { signal } = {}) => {
    const normalized = canonicalKey(key)
    if (!normalized) return Promise.reject(new Error('invalid K-drama key'))
    const accept = value => validKDramaEpisodes(value, normalized) && validMeta(value)
    const cacheable = value => accept(value) && value.episodes.length > 0 && complete(value)
    return cached(`kdrama:episodes:${normalized}`, 10 * MIN,
        () => requireValue(dramaGet(`/read/api/kdrama/episodes?key=${enc(normalized)}`, signal), accept, 'Episode list unavailable'),
        { accept: cacheable, signal })
}

export const getKDramaEpisode = (key, episodeId, { signal } = {}) => {
    const normalized = canonicalKey(key)
    if (!normalized || !validId(episodeId)) return Promise.reject(new Error('invalid K-drama episode'))
    const accept = value => validKDramaEpisode(value, normalized, episodeId) && validMeta(value) && complete(value)
    return cached(`kdrama:episode:${normalized}:${episodeId}`, 2 * MIN,
        () => requireValue(dramaGet(`/read/api/kdrama/episode?key=${enc(normalized)}&id=${enc(episodeId)}`, signal), accept, 'Episode unavailable'),
        { accept, signal })
}

export function kDramaErrorMessage(error, fallback = 'K-drama unavailable') {
    const message = typeof error?.message === 'string' && error.message ? error.message : fallback
    const provider = PROVIDER_NAME[error?.provider]
    return provider && !message.toLowerCase().includes(provider.toLowerCase()) ? `${provider}: ${message}` : message
}

export function kDramaResponseNotice(value, source = 'all') {
    if (!value?.partial && !value?.errors?.length) return ''
    const invalid = value?.errors?.some(error => error.code === 'invalid_results')
    const providers = [...new Set((value?.errors || []).filter(error => error.code !== 'invalid_results')
        .map(error => error.provider).filter(provider => PROVIDER_NAME[provider]))]
    if (source !== 'all' && providers.includes(source)) return `${kDramaProviderName(source)} is unavailable right now.`
    if (providers.length) return `${providers.map(kDramaProviderName).join(' and ')} unavailable — showing available titles.${invalid ? ' Some unexpected results were ignored.' : ''}`
    if (invalid) return 'Some unexpected results were ignored.'
    return 'Some K-drama results could not be loaded.'
}
