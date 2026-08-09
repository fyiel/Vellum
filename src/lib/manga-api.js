import { apiGet, apiUrl } from './http.js'
import { cached } from './cache.js'

const enc = encodeURIComponent
const MIN = 60 * 1000
const HOUR = 60 * MIN
const MANGA_TIMEOUT = 70_000
const KEY = /^(mf|mh):([a-z0-9][a-z0-9._-]{0,199})$/i
const ID = /^[a-z0-9][a-z0-9._-]{0,199}$/i

export function mangaKey(provider, id) {
    const key = `${provider}:${id}`
    if (!KEY.test(key)) throw new Error('invalid manga key')
    return key.toLowerCase()
}

export function parseMangaKey(key) {
    const match = String(key || '').match(KEY)
    return match ? { provider: match[1].toLowerCase(), id: match[2] } : null
}

const validId = value => ID.test(String(value || ''))
const validTitle = value => typeof value === 'string' && value.trim().length > 0
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

export const mangaPageUrl = page => apiUrl(page?.url || '')

export const validMangaSeries = (value, expectedKey) =>
    sameKey(value?.key, expectedKey)
    && value?.kind === 'manga'
    && validTitle(value?.title)
    && ['manga', 'manhwa', 'manhua'].includes(value?.format)

export const validMangaChapters = (value, expectedKey) => {
    if (!sameKey(value?.key, expectedKey) || !Array.isArray(value?.chapters) || !value.chapters.length) return false
    const ids = new Set()
    return value.chapters.every(chapter => {
        const id = String(chapter?.id || '')
        const number = chapter?.number
        if (!validId(id) || ids.has(id) || (number !== null && !Number.isFinite(number))) return false
        ids.add(id)
        return true
    })
}

export const validMangaChapter = (value, key, chapterId) =>
    sameKey(value?.key, key)
    && String(value?.chapter?.id || '') === String(chapterId)
    && Array.isArray(value?.pages)
    && value.pages.length > 0
    && value.pages.every((page, index) => validPageUrl(page?.url, key, chapterId, index)
        && (page.width == null || Number(page.width) > 0)
        && (page.height == null || Number(page.height) > 0))

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

const validResults = value => Array.isArray(value?.results)
    && value.results.every(item => validMangaSeries(item))
    && typeof value?.hasMore === 'boolean'
const completeResponse = value => (value?.partial == null || value.partial === false)
    && (value?.errors == null || (Array.isArray(value.errors) && value.errors.length === 0))
const cacheableResults = value => validResults(value)
    && value.results.length > 0
    && completeResponse(value)
const mangaGet = (path, signal) => apiGet(path, { signal, timeoutMs: MANGA_TIMEOUT })

export const searchManga = (text, { source = 'all', format = 'all', page = 1, limit = 30, signal } = {}) => {
    const q = String(text || '').trim()
    if (!q) return Promise.resolve({ page: 1, results: [], hasMore: false })
    const qs = query({ q, source, format: format === 'all' ? undefined : format, page, limit })
    return cached(`manga:search:${qs}`, 5 * MIN,
        () => requireValue(mangaGet(`/read/api/manga/search?${qs}`, signal), validResults, 'manga search unavailable'),
        { accept: cacheableResults, signal })
}

export const discoverManga = (params = {}, { signal } = {}) => {
    const qs = query(params)
    return cached(`manga:discover:${qs}`, 10 * MIN,
        () => requireValue(mangaGet(`/read/api/manga/discover?${qs}`, signal), validResults, 'manga catalogue unavailable'),
        { accept: cacheableResults, signal })
}

export const getMangaSeries = (key, { signal } = {}) => {
    const normalized = canonicalKey(key)
    if (!normalized) return Promise.reject(new Error('invalid manga key'))
    const accept = value => validMangaSeries(value, normalized)
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
    const accept = value => validMangaChapter(value, normalized, chapterId)
    return cached(`manga:chapter:${normalized}:${chapterId}`, 12 * HOUR,
        () => requireValue(mangaGet(`/read/api/manga/chapter?key=${enc(normalized)}&id=${enc(chapterId)}`, signal), accept, 'chapter unavailable'),
        { accept, signal })
}

export const prefetchMangaChapter = (key, chapterId, opts) => {
    getMangaChapter(key, chapterId, opts).catch(() => {})
}
