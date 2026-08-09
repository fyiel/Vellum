import { apiGet } from './http.js'
import { cached } from './cache.js'

const enc = encodeURIComponent
const MIN = 60 * 1000
const HOUR = 60 * MIN

// canonical key form, the api accepts both but the cache key must not depend on the caller
export const seriesKey = key => (key || '').includes(':') ? key : `nf:${key || ''}`

const hasResults = d => Array.isArray(d?.results) && d.results.length > 0
const requireValue = (promise, accept, message) => promise.then(value => {
    if (!accept(value)) throw new Error(message)
    return value
})

export const searchNovels = q =>
    cached(`search:${q.trim().toLowerCase()}`, 5 * MIN, () => apiGet(`/read/api/search?q=${enc(q)}`), { accept: hasResults })

export const getSeries = (key, { signal } = {}) => {
    const accept = d => typeof d?.title === 'string' && d.title.trim().length > 0
    return cached(`series:${key}`, 6 * HOUR, () => requireValue(apiGet(`/read/api/series/${enc(key)}`, { signal }), accept, 'series unavailable'), { accept, signal })
}

export const getChapters = (slug, { signal } = {}) => {
    const accept = d => Array.isArray(d?.chapters)
        && d.chapters.length > 0
        && d.chapters.every(c => Number.isFinite(c?.n))
        && (d.total == null || (Number.isInteger(d.total) && d.total === d.chapters.length))
    return cached(`chapters:${slug}`, 30 * MIN, () => requireValue(apiGet(`/read/api/chapters?slug=${enc(slug)}`, { signal }), accept, 'chapter list unavailable'), { accept, signal })
}

export const getChapter = (slug, n, { signal } = {}) => {
    const accept = d => typeof d?.html === 'string' && d.html.trim().length > 0
    return cached(`chapter:${slug}:${n}`, 24 * HOUR, () => requireValue(apiGet(`/read/api/chapter?slug=${enc(slug)}&n=${n}`, { signal }), accept, 'chapter unavailable'), { accept, signal })
}

export const prefetchChapter = (slug, n, opts) => { getChapter(slug, n, opts).catch(() => {}) }

const discoverQuery = params => {
    const sp = new URLSearchParams()
    for (const [k, v] of Object.entries(params || {})) {
        if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue
        sp.set(k, Array.isArray(v) ? v.join(',') : String(v))
    }
    return sp.toString()
}

export const discover = params => {
    const query = discoverQuery(params)
    return cached(`discover:${query}`, 10 * MIN, () => apiGet(`/read/api/discover?${query}`), { accept: hasResults })
}

export const discoverTaxonomy = () =>
    cached('discover:taxonomy', 24 * HOUR, () => apiGet('/read/api/discover/taxonomy'))
