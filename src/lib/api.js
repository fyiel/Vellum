import { apiGet } from './http.js'

// thin wrappers over the reader backend routes. these return the raw json shapes the backend sends
const enc = encodeURIComponent

// search returns { results: [...] }, each result keyed for the series route
export const searchNovels = q => apiGet(`/read/api/search?q=${enc(q)}`)

// series detail by key (mb:<id> for a metadata hit, or <source>:<slug> for a readable source)
export const getSeries = key => apiGet(`/read/api/series/${enc(key)}`)

// full ordered chapter list for a readable slug, returns { chapters: [{ n, t }] }
export const getChapters = slug => apiGet(`/read/api/chapters?slug=${enc(slug)}`)

// one chapter of prose, returns { n, title, html }
export const getChapter = (slug, n) => apiGet(`/read/api/chapter?slug=${enc(slug)}&n=${n}`)
