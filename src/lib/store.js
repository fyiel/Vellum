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

// --- reading ledger ---
// one bucket per local day ({ms, ch}) plus a single archive for rolled-up history.
// writes deliberately avoid lsSet: its quota shed would wipe the update ledger's
// newNums, so stats use their own retry ladder (roll up, retry, then an in-memory
// ring) and surface a capped signal instead of silently losing deltas.
const STATS_PREFIX = `${NS}:stats:`
const STATS_ARCHIVE = `${NS}:stats:archive`
const STATS_CAP = `${NS}:stats:cap`
const STATS_MAX_DAYS = 366
const STREAK_MS = 60000
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const PENDING_MAX = 60 // about an hour of minute flushes

const dayOf = k => k.slice(STATS_PREFIX.length)

export const statsGet = date => ({ ms: 0, ch: 0, ...(lsGet(`${STATS_PREFIX}${date}`, {}) || {}) })
export const statsArchive = () => ({ ms: 0, days: 0, bestStreak: 0, ch: 0, ...(lsGet(STATS_ARCHIVE, {}) || {}) })
export const statsActive = obj => !!obj && ((obj.ms || 0) >= STREAK_MS || (obj.ch || 0) > 0)

let statsPending = [] // {date, ms?, ch?} deltas that failed to persist twice
let statsCapped = false

function rollupStats() {
    // move the oldest day buckets past the window into the archive (best effort)
    try {
        const keys = []
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i)
            if (k && k.startsWith(STATS_PREFIX) && DAY_RE.test(dayOf(k))) keys.push(k)
        }
        if (keys.length <= STATS_MAX_DAYS) return
        keys.sort()
        const arch = statsArchive()
        const rolled = keys.slice(0, keys.length - STATS_MAX_DAYS)
        let ms = arch.ms || 0
        let days = arch.days || 0
        let ch = arch.ch || 0
        let best = arch.bestStreak || 0
        let run = 0
        for (const k of rolled) {
            const obj = lsGet(k, {})
            const active = statsActive(obj)
            ms += obj.ms || 0
            ch += obj.ch || 0
            run = active ? run + 1 : 0
            if (run > best) best = run
            if (active) days++
            try { localStorage.removeItem(k) } catch {}
        }
        localStorage.setItem(STATS_ARCHIVE, JSON.stringify({ ms, days, bestStreak: best, ch }))
    } catch {}
}

const writeDay = (date, obj) => {
    const k = `${STATS_PREFIX}${date}`
    try {
        localStorage.setItem(k, JSON.stringify(obj))
        return true
    } catch {
        rollupStats()
        try { localStorage.setItem(k, JSON.stringify(obj)); return true } catch { return false }
    }
}

const flushPending = () => {
    if (!statsPending.length) return
    const left = []
    for (const d of statsPending) {
        const obj = statsGet(d.date)
        if (d.ms) obj.ms += d.ms
        if (d.ch) obj.ch += d.ch
        if (!writeDay(d.date, obj)) left.push(d)
    }
    statsPending = left
    // storage recovered and the ring drained, make the capped signal durable
    if (statsCapped && !statsPending.length) {
        try { localStorage.setItem(STATS_CAP, '1') } catch {}
    }
}

const queueDelta = d => {
    statsPending.push(d)
    if (statsPending.length <= PENDING_MAX) return
    statsPending.splice(0, statsPending.length - PENDING_MAX) // drop the oldest deltas
    statsCapped = true
    try { localStorage.setItem(STATS_CAP, '1') } catch {}
}

export const statsAdd = (date, ms) => {
    if (!(ms > 0)) return
    flushPending()
    const obj = statsGet(date)
    obj.ms += ms
    if (!writeDay(date, obj)) queueDelta({ date, ms })
}

export const statsCh = date => {
    flushPending()
    const obj = statsGet(date)
    obj.ch = (obj.ch || 0) + 1
    if (!writeDay(date, obj)) queueDelta({ date, ch: 1 })
}

export const statsCap = () => {
    if (statsCapped) return true
    try { return localStorage.getItem(STATS_CAP) === '1' } catch { return false }
}

export const statsAll = () => {
    const days = new Map()
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i)
            if (k && k.startsWith(STATS_PREFIX) && DAY_RE.test(dayOf(k))) {
                const d = dayOf(k)
                days.set(d, statsGet(d))
            }
        }
    } catch {}
    return { days, archive: statsArchive() }
}
