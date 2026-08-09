import { localDayKey, dayAfter } from './time.js'

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

// ---- reading stats (daily buckets, the F5 contract) ----
// vellum:stats:YYYY-MM-DD = { ms, ch }, written through the no-shed path. buckets older
// than the 7-day weekly window roll into vellum:stats:archive = { ms, days, bestStreak }
const STATS_NS = `${NS}:stats`
const ARCHIVE_KEY = `${STATS_NS}:archive`

export const statsGet = date => lsGet(`${STATS_NS}:${date}`, null)

export const statsAdd = (date, ms, ch = 0) => {
    const k = `${STATS_NS}:${date}`
    const b = lsGet(k, null) || {}
    const cur = { ms: Number.isFinite(b.ms) ? b.ms : 0, ch: Number.isFinite(b.ch) ? b.ch : 0 }
    lsSet(k, { ms: cur.ms + Math.max(0, ms || 0), ch: cur.ch + Math.max(0, ch || 0) })
}

// roll every bucket outside the weekly window into the archive and refresh bestStreak,
// the longest consecutive-day reading run seen so far
export const statsSweep = () => {
    const t = new Date()
    const cutoff = localDayKey(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 7).getTime())
    const arch = lsGet(ARCHIVE_KEY, { ms: 0, days: 0, bestStreak: 0, lastDay: null, curStreak: 0 })
    for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i)
        if (!k || !k.startsWith(`${STATS_NS}:`) || k === ARCHIVE_KEY) continue
        const date = k.slice(STATS_NS.length + 1)
        if (date >= cutoff) continue
        const b = lsGet(k, null)
        localStorage.removeItem(k)
        if (!b || !(b.ms > 0)) continue
        arch.ms += b.ms
        arch.days += 1
        arch.curStreak = arch.lastDay && dayAfter(arch.lastDay) === date ? arch.curStreak + 1 : 1
        arch.lastDay = date
        if (arch.curStreak > arch.bestStreak) arch.bestStreak = arch.curStreak
    }
    lsSet(ARCHIVE_KEY, arch)
}

// ---- focus session (timer state and goals in ONE blob, never vellum:settings) ----
// the countdown is derived from timestamps: monotonic for the live tick (clock-jump safe)
// and the persisted startWall for kill recovery; reading minutes accrue only while a
// session runs and the reader is visible, latched per session by the live ticker
export const FOCUS_KEY = `${NS}:focus`

export const FOCUS_DEFAULT = {
    focusMin: 25, goalDay: 0, goalWeek: 0,
    sessionId: null, sessionMs: 0, startWall: 0, startDate: null,
    endMonotonic: 0, elapsedSoFar: 0, pausedAt: null, pausedWall: null, acked: false,
}

export const loadFocus = () => {
    const f = { ...FOCUS_DEFAULT, ...lsGet(FOCUS_KEY, {}) }
    f.focusMin = num(f.focusMin, 1, 600, FOCUS_DEFAULT.focusMin)
    f.goalDay = num(f.goalDay, 0, 1440, 0)
    f.goalWeek = num(f.goalWeek, 0, 10080, 0)
    f.elapsedSoFar = Math.max(0, Number(f.elapsedSoFar) || 0)
    f.sessionMs = Math.max(0, Number(f.sessionMs) || 0)
    return f
}
export const saveFocus = f => lsSet(FOCUS_KEY, f)
