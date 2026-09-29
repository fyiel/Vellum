// source identity is inconsistent across endpoints (search sends short ids like
// nf, discover sends full names like novelfire) so normalize everything to the full name
const NORM = { nf: 'novelfire', mb: 'mangabaka', dm: 'dreamy', dawn: 'dawn', ndx: 'noveldex' }
const LABEL = { novelfire: 'Novelfire', mangabaka: 'MangaBaka', dreamy: 'Dreamy', dawn: 'Dawn', noveldex: 'NovelDex', jade: 'JadeScrolls', gen: 'Genesis', fen: 'Fenrir Realm', wtl: 'WeTriedTLS', nl: 'NovelLive', rb: 'Ranobes', az: 'Azure Chronicles' }

const norm = s => {
    const k = String(s ?? '').toLowerCase()
    return NORM[k] || k
}

// every source a row is on, so a multi source row matches any of its source chips
export const srcIds = r => {
    const list = [r?.source, ...(Array.isArray(r?.sources) ? r.sources.map(s => typeof s === 'string' ? s : s?.source) : [])].filter(Boolean)
    if (!list.length && r?.sourceName) list.push(r.sourceName)
    return [...new Set(list.map(norm))]
}

export const srcLabel = id => LABEL[String(id ?? '').toLowerCase()] || id

export const srcName = x => typeof x === 'string' ? x : (x?.name || x?.sourceName || x?.source || '')
