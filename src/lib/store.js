// everything the reader remembers lives client side. read state, scroll positions, the library and the
// reader settings all sit in localStorage under a vellum namespace. keys are scoped per slug where it matters

const NS = 'vellum'
const lsGet = (k, fb) => { try { return JSON.parse(localStorage.getItem(k)) ?? fb } catch { return fb } }
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

// read state: the set of chapter numbers already seen for a slug
export const readSet = slug => new Set(lsGet(`${NS}:read:${slug}`, []))
export const saveRead = (slug, set) => lsSet(`${NS}:read:${slug}`, [...set])

// reading position: { n, p, at } where p is the progress fraction inside chapter n
export const posGet = slug => lsGet(`${NS}:pos:${slug}`, null)
export const posSet = (slug, pos) => lsSet(`${NS}:pos:${slug}`, pos)

// library: most recently read first, capped so a long history does not grow forever
export const library = () => lsGet(`${NS}:lib`, [])

export const touchLibrary = entry => {
    const lib = library().filter(e => e.slug !== entry.slug)
    lib.unshift({ ...entry, updatedAt: Date.now() })
    lsSet(`${NS}:lib`, lib.slice(0, 60))
}

export const dropLibrary = slug => lsSet(`${NS}:lib`, library().filter(e => e.slug !== slug))

// reader settings. defaults match the options the design exposes and merge over whatever was saved
export const SET_DEFAULT = { theme: 'black', font: 'sans', size: 17, lh: 1.3, width: 'normal' }
export const loadSettings = () => ({ ...SET_DEFAULT, ...lsGet(`${NS}:settings`, {}) })
export const saveSettings = s => lsSet(`${NS}:settings`, s)
