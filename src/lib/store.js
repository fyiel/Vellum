const NS = 'vellum'
const lsGet = (k, fb) => { try { return JSON.parse(localStorage.getItem(k)) ?? fb } catch { return fb } }
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

export const readSet = slug => new Set(lsGet(`${NS}:read:${slug}`, []))
export const saveRead = (slug, set) => lsSet(`${NS}:read:${slug}`, [...set])

export const posGet = slug => lsGet(`${NS}:pos:${slug}`, null)
export const posSet = (slug, pos) => lsSet(`${NS}:pos:${slug}`, pos)

export const library = () => lsGet(`${NS}:lib`, [])

export const touchLibrary = entry => {
    const lib = library()
    const old = lib.find(e => e.slug === entry.slug)
    const rest = lib.filter(e => e.slug !== entry.slug)
    rest.unshift({ ...old, ...entry, updatedAt: Date.now() })
    lsSet(`${NS}:lib`, rest.slice(0, 60))
}

export const dropLibrary = slug => lsSet(`${NS}:lib`, library().filter(e => e.slug !== slug))

export const SET_DEFAULT = { theme: 'black', font: 'sans', size: 17, lh: 1.3, width: 'normal' }
export const loadSettings = () => ({ ...SET_DEFAULT, ...lsGet(`${NS}:settings`, {}) })
export const saveSettings = s => lsSet(`${NS}:settings`, s)

export const FEEL_DEFAULT = { scheme: 'Graphite', density: 'comfortable' }
export const loadFeel = () => ({ ...FEEL_DEFAULT, ...lsGet(`${NS}:feel`, {}) })
export const saveFeel = f => lsSet(`${NS}:feel`, f)

export const LIB_SORT_DEFAULT = { sortKey: 'recent', sortDir: 'desc' }
export const loadLibSort = () => ({ ...LIB_SORT_DEFAULT, ...lsGet(`${NS}:libsort`, {}) })
export const saveLibSort = s => lsSet(`${NS}:libsort`, s)

export const loadUpdLedger = () => lsGet(`${NS}:updates`, {})
export const saveUpdLedger = l => lsSet(`${NS}:updates`, l)
