const NS = 'vellum'
const lsGet = (k, fb) => { try { return JSON.parse(localStorage.getItem(k)) ?? fb } catch { return fb } }
const lsSet = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)) } catch {
        // quota is full, shed the recomputable update snapshots and retry once
        try {
            const ledger = JSON.parse(localStorage.getItem(`${NS}:updates`) || '{}') || {}
            let changed = false
            for (const e of Object.values(ledger)) if (e.newNums?.length) {
                e.newNums = []
                changed = true
            }
            if (changed) localStorage.setItem(`${NS}:updates`, JSON.stringify(ledger))
            localStorage.setItem(k, JSON.stringify(v))
        } catch {}
    }
}

export const readSet = slug => {
    const v = lsGet(`${NS}:read:${slug}`, [])
    return Array.isArray(v) ? new Set(v) : new Set()
}
export const saveRead = (slug, set) => lsSet(`${NS}:read:${slug}`, [...set])

export const posGet = slug => lsGet(`${NS}:pos:${slug}`, null)
export const posSet = (slug, pos) => lsSet(`${NS}:pos:${slug}`, pos)

export const library = () => lsGet(`${NS}:lib`, [])

export const touchLibrary = entry => {
    const lib = library()
    const old = lib.find(e => e.slug === entry.slug)
    const rest = lib.filter(e => e.slug !== entry.slug)
    // empty fields mean unknown, never let them erase stored values
    const known = Object.fromEntries(Object.entries(entry).filter(([, v]) => v != null && v !== ''))
    rest.unshift({ ...old, ...known, updatedAt: Date.now() })
    lsSet(`${NS}:lib`, rest.slice(0, 60))
}

export const saveLibrary = list => lsSet(`${NS}:lib`, Array.isArray(list) ? list.slice(0, 60) : [])

export const loadLastBackup = () => lsGet(`${NS}:lastbackup`, 0)
export const saveLastBackup = ts => lsSet(`${NS}:lastbackup`, ts)

export const dropLibrary = slug => {
    lsSet(`${NS}:lib`, library().filter(e => e.slug !== slug))
    // unfollowing ends the alert relationship, drop the ledger entry so it cannot grow forever
    const ledger = loadUpdLedger()
    if (ledger[slug]) {
        delete ledger[slug]
        saveUpdLedger(ledger)
    }
}

export const SET_DEFAULT = { theme: 'black', font: 'sans', size: 17, lh: 1.3, width: 'normal' }

const num = (v, lo, hi, fb) => {
    const n = Number(v)
    return v != null && v !== '' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb
}

export const loadSettings = () => {
    const s = { ...SET_DEFAULT, ...lsGet(`${NS}:settings`, {}) }
    s.size = num(s.size, 14, 28, SET_DEFAULT.size)
    s.lh = num(s.lh, 1, 3, SET_DEFAULT.lh)
    return s
}
export const saveSettings = s => lsSet(`${NS}:settings`, s)

export const FEEL_DEFAULT = { scheme: 'Graphite', density: 'comfortable' }
export const loadFeel = () => ({ ...FEEL_DEFAULT, ...lsGet(`${NS}:feel`, {}) })
export const saveFeel = f => lsSet(`${NS}:feel`, f)

export const LIB_SORT_DEFAULT = { sortKey: 'recent', sortDir: 'desc' }
export const loadLibSort = () => ({ ...LIB_SORT_DEFAULT, ...lsGet(`${NS}:libsort`, {}) })
export const saveLibSort = s => lsSet(`${NS}:libsort`, s)

export const loadUpdLedger = () => lsGet(`${NS}:updates`, {})
export const saveUpdLedger = l => lsSet(`${NS}:updates`, l)
