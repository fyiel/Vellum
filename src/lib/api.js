import { apiGet } from './http.js'
import { cached } from './cache.js'

// the backend marks every response no store, but we own the client so we cache aggressively anyway.
// ttls reflect how fast each thing really changes. prose is effectively immutable, a chapter list grows
// slowly, search drifts. all of it serves stale instantly and revalidates behind the scenes
const enc = encodeURIComponent
const MIN = 60 * 1000
const HOUR = 60 * MIN

// search returns { results }, keyed and normalised so the same query in any casing shares one entry
export const searchNovels = q =>
    cached(`search:${q.trim().toLowerCase()}`, 5 * MIN, () => apiGet(`/read/api/search?q=${enc(q)}`))

// series detail by key, mb:<id> or <source>:<slug>
export const getSeries = key =>
    cached(`series:${key}`, 6 * HOUR, () => apiGet(`/read/api/series/${enc(key)}`))

// full ordered chapter list, { chapters: [{ n, t }] }
export const getChapters = slug =>
    cached(`chapters:${slug}`, 30 * MIN, () => apiGet(`/read/api/chapters?slug=${enc(slug)}`))

// one chapter of prose, { n, title, html }. cached a full day since the text rarely moves
export const getChapter = (slug, n) =>
    cached(`chapter:${slug}:${n}`, 24 * HOUR, () => apiGet(`/read/api/chapter?slug=${enc(slug)}&n=${n}`))

// warm the cache ahead of need. the reader prefetches the next chapters, a search list can prefetch
// the series a tap is heading toward. failures are swallowed since this is purely speculative
export const prefetchSeries = key => { getSeries(key).catch(() => {}) }
export const prefetchChapters = slug => { getChapters(slug).catch(() => {}) }
export const prefetchChapter = (slug, n) => { getChapter(slug, n).catch(() => {}) }
