import { apiGet } from './http.js'
import { cached } from './cache.js'

const enc = encodeURIComponent
const MIN = 60 * 1000
const HOUR = 60 * MIN

export const searchNovels = q =>
    cached(`search:${q.trim().toLowerCase()}`, 5 * MIN, () => apiGet(`/read/api/search?q=${enc(q)}`))

export const getSeries = key =>
    cached(`series:${key}`, 6 * HOUR, () => apiGet(`/read/api/series/${enc(key)}`))

export const getChapters = slug =>
    cached(`chapters:${slug}`, 30 * MIN, () => apiGet(`/read/api/chapters?slug=${enc(slug)}`))

export const getChapter = (slug, n) =>
    cached(`chapter:${slug}:${n}`, 24 * HOUR, () => apiGet(`/read/api/chapter?slug=${enc(slug)}&n=${n}`))

export const prefetchSeries = key => { getSeries(key).catch(() => {}) }
export const prefetchChapters = slug => { getChapters(slug).catch(() => {}) }
export const prefetchChapter = (slug, n) => { getChapter(slug, n).catch(() => {}) }

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
    return cached(`discover:${query}`, 10 * MIN, () => apiGet(`/read/api/discover?${query}`))
}

export const discoverTaxonomy = () =>
    cached('discover:taxonomy', 24 * HOUR, () => apiGet('/read/api/discover/taxonomy'))

export const prefetchDiscover = params => { discover(params).catch(() => {}) }
