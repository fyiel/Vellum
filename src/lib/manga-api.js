import { apiGet, apiUrl } from './http.js'
import { cached } from './cache.js'

const enc = encodeURIComponent
const MIN = 60 * 1000
const HOUR = 60 * MIN
const MANGA_TIMEOUT = 20_000
const KEY = /^(mf|mh):([a-z0-9][a-z0-9._-]{0,199})$/i
const ID = /^[a-z0-9][a-z0-9._-]{0,199}$/i
const PROVIDER = new Set(['all', 'mf', 'mh'])
const FORMAT = new Set(['all', 'manga', 'manhwa', 'manhua'])
const PROVIDER_NAME = { mf: 'MangaFire', mh: 'MangaHub' }

export const mangaProviderName = provider => PROVIDER_NAME[String(provider || '').toLowerCase()] || 'Manga source'

export function mangaKey(provider, id) {
    const key = `${String(provider).toLowerCase()}:${id}`
    if (!KEY.test(key)) throw new Error('invalid manga key')
    return key
}

export function parseMangaKey(key) {
    const match = String(key || '').match(KEY)
    return match ? { provider: match[1].toLowerCase(), id: match[2] } : null
}

const validId = value => ID.test(String(value || ''))
const validTitle = value => typeof value === 'string' && value.trim().length > 0
const validOptionalString = value => value == null || typeof value === 'string'
const validStringList = value => value == null || (Array.isArray(value) && value.every(item => typeof item === 'string'))
const canonicalKey = value => {
    const parsed = parseMangaKey(value)
    return parsed ? mangaKey(parsed.provider, parsed.id) : null
}
const sameKey = (actual, expected) => canonicalKey(actual) != null && (!expected || canonicalKey(actual) === canonicalKey(expected))
const validPageUrl = (value, key, chapterId, page) => {
    if (typeof value !== 'string' || !value.startsWith('/read/api/manga/image?')) return false
    const url = new URL(value, 'https://vellum.invalid')
    return url.pathname === '/read/api/manga/image'
        && sameKey(url.searchParams.get('key'), key)
        && url.searchParams.get('id') === String(chapterId)
        && url.searchParams.get('page') === String(page)
}

// downloaded pages carry blob: object URLs — pass any absolute/scheme URL through untouched
export const mangaPageUrl = page => /^[a-z][a-z0-9+.-]*:/i.test(page?.url || '') ? page.url : apiUrl(page?.url || '')

export const validMangaSeries = (value, expectedKey) =>
    sameKey(value?.key, expectedKey)
    && value?.kind === 'manga'
    && validTitle(value?.title)
    && ['manga', 'manhwa', 'manhua'].includes(value?.format)
    && ['cover', 'status', 'synopsis', 'sourceUrl'].every(key => validOptionalString(value?.[key]))
    && ['alternateTitles', 'authors', 'artists', 'genres'].every(key => validStringList(value?.[key]))

const validChapter = chapter => {
    const number = chapter?.number
    return validId(chapter?.id)
        && (number === null || Number.isFinite(number))
        && ['title', 'language', 'sourceUrl'].every(key => validOptionalString(chapter?.[key]))
}

export const validMangaChapters = (value, expectedKey) => {
    if (!sameKey(value?.key, expectedKey) || !Array.isArray(value?.chapters) || !value.chapters.length) return false
    const ids = new Set()
    return value.chapters.every(chapter => {
        const id = String(chapter?.id || '')
        if (!validChapter(chapter) || ids.has(id)) return false
        ids.add(id)
        return true
    })
}

export const validMangaChapter = (value, key, chapterId) =>
    sameKey(value?.key, key)
    && String(value?.chapter?.id || '') === String(chapterId)
    && validChapter(value?.chapter)
    && Array.isArray(value?.pages)
    && value.pages.length > 0
    && value.pages.every((page, index) => validPageUrl(page?.url, key, chapterId, index)
        && (page.width == null || (Number.isFinite(page.width) && page.width > 0))
        && (page.height == null || (Number.isFinite(page.height) && page.height > 0)))

const requireValue = (promise, accept, message) => promise.then(value => {
    if (!accept(value)) throw new Error(message)
    return value
})

const query = params => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params || {})) {
        if (value == null || value === '') continue
        search.set(key, String(value))
    }
    return search.toString()
}

const validProviderError = error => error && typeof error === 'object'
    && (error.provider == null || Object.hasOwn(PROVIDER_NAME, error.provider))
    && ['code', 'message'].every(key => validOptionalString(error[key]))
    && (error.retryable == null || typeof error.retryable === 'boolean')
const validMeta = value => (value?.partial == null || typeof value.partial === 'boolean')
    && (value?.errors == null || (Array.isArray(value.errors) && value.errors.every(validProviderError)))
const validResults = (value, page) => Array.isArray(value?.results)
    && value.results.every(item => validMangaSeries(item))
    && typeof value?.hasMore === 'boolean'
    && (value.page == null || value.page === page)
    && validMeta(value)
const completeResponse = value => (value?.partial == null || value.partial === false)
    && (value?.errors == null || (Array.isArray(value.errors) && value.errors.length === 0))
const cacheableResults = value => Array.isArray(value?.results)
    && value.results.length > 0
    && completeResponse(value)
const mangaGet = (path, signal) => apiGet(path, { signal, timeoutMs: MANGA_TIMEOUT })

const normalizeResults = (value, source, format) => {
    const seen = new Set()
    const results = value.results.filter(item => {
        const provider = parseMangaKey(item.key)?.provider
        const keep = !seen.has(item.key)
            && (source === 'all' || provider === source)
            && (format === 'all' || item.format === format)
        seen.add(item.key)
        return keep
    })
    if (results.length === value.results.length) return value
    return {
        ...value,
        results,
        partial: true,
        errors: [...(value.errors || []), { code: 'invalid_results', message: 'Unexpected manga results were ignored' }],
    }
}

const resultRequest = (kind, qs, { source, format, page, signal }, message, onFresh) => {
    const accept = value => validResults(value, page)
    const cacheAccept = value => accept(value) && cacheableResults(value) && normalizeResults(value, source, format) === value
    return cached(`manga:${kind}:${qs}`, kind === 'search' ? 5 * MIN : 10 * MIN,
        () => requireValue(mangaGet(`/read/api/manga/${kind}?${qs}`, signal), accept, message)
            .then(value => normalizeResults(value, source, format)),
        { accept: cacheAccept, signal, onFresh })
}

const validRequest = (source, format, page, limit) => PROVIDER.has(source) && FORMAT.has(format)
    && Number.isInteger(page) && page > 0 && Number.isInteger(limit) && limit > 0 && limit <= 100

export const searchManga = (text, { source = 'all', format = 'all', page = 1, limit = 30, signal, onFresh } = {}) => {
    const q = String(text || '').trim()
    if (!q) return Promise.resolve({ page: 1, results: [], hasMore: false })
    if (!validRequest(source, format, page, limit)) return Promise.reject(new Error('invalid manga search'))
    const qs = query({ q, source, format: format === 'all' ? undefined : format, page, limit })
    return resultRequest('search', qs, { source, format, page, signal }, 'manga search unavailable', onFresh)
}

export const discoverManga = (params = {}, { signal, onFresh } = {}) => {
    const { source = 'all', format = 'all', page = 1, limit = 30 } = params
    if (!validRequest(source, format, page, limit)) return Promise.reject(new Error('invalid manga discovery'))
    const qs = query({ source, format: format === 'all' ? undefined : format, page, limit })
    return resultRequest('discover', qs, { source, format, page, signal }, 'manga catalogue unavailable', onFresh)
}

export const getMangaSeries = (key, { signal } = {}) => {
    const normalized = canonicalKey(key)
    if (!normalized) return Promise.reject(new Error('invalid manga key'))
    const accept = value => validMangaSeries(value, normalized) && validMeta(value) && completeResponse(value)
    return cached(`manga:series:${normalized}`, 6 * HOUR,
        () => requireValue(mangaGet(`/read/api/manga/series/${enc(normalized)}`, signal), accept, 'manga unavailable'),
        { accept, signal })
}

export const getMangaChapters = (key, { signal } = {}) => {
    const normalized = canonicalKey(key)
    if (!normalized) return Promise.reject(new Error('invalid manga key'))
    const accept = value => validMangaChapters(value, normalized) && completeResponse(value)
    return cached(`manga:chapters:${normalized}`, 30 * MIN,
        () => requireValue(mangaGet(`/read/api/manga/chapters?key=${enc(normalized)}`, signal), accept, 'chapter list unavailable'),
        { accept, signal })
}

export const getMangaChapter = (key, chapterId, { signal } = {}) => {
    const normalized = canonicalKey(key)
    if (!normalized || !validId(chapterId)) return Promise.reject(new Error('invalid manga chapter'))
    const accept = value => validMangaChapter(value, normalized, chapterId) && validMeta(value) && completeResponse(value)
    return cached(`manga:chapter:${normalized}:${chapterId}`, 12 * HOUR,
        () => requireValue(mangaGet(`/read/api/manga/chapter?key=${enc(normalized)}&id=${enc(chapterId)}`, signal), accept, 'chapter unavailable'),
        { accept, signal })
}

export const orderMangaChapters = chapters => [...chapters].sort((a, b) => {
    if (a.number == null && b.number == null) return a.id.localeCompare(b.id)
    if (a.number == null) return 1
    if (b.number == null) return -1
    return a.number - b.number || a.id.localeCompare(b.id)
})

export function mangaErrorMessage(error, fallback) {
    const message = typeof error?.message === 'string' && error.message ? error.message : fallback || 'Manga unavailable'
    const provider = PROVIDER_NAME[error?.provider]
    return provider && !message.toLowerCase().includes(provider.toLowerCase()) ? `${provider}: ${message}` : message
}

export function mangaResponseNotice(value, source = 'all') {
    if (!value?.partial && !value?.errors?.length) return ''
    if (value?.errors?.some(error => error.code === 'invalid_results')) return 'Some unexpected results were ignored.'
    const providers = [...new Set((value?.errors || []).map(error => error.provider).filter(provider => PROVIDER_NAME[provider]))]
    if (source !== 'all' && providers.includes(source)) return `${mangaProviderName(source)} is unavailable right now.`
    if (providers.length) return `${providers.map(mangaProviderName).join(' and ')} unavailable — showing available results.`
    return 'Some manga results could not be loaded.'
}

export const prefetchMangaChapter = (key, chapterId, opts) => {
    getMangaChapter(key, chapterId, opts).catch(() => {})
}
