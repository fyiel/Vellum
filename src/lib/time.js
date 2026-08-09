// local calendar day key for the reading stats buckets, YYYY-MM-DD
export function localDayKey(ts = Date.now()) {
    const d = new Date(ts)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// the day key that follows a key, for streak rolls in the stats archive
export function dayAfter(key) {
    const [y, m, d] = key.split('-').map(Number)
    return localDayKey(new Date(y, m - 1, d + 1).getTime())
}

// relative time for library rows and update buckets, the library version carries the year branch
export function relTime(ts) {
    if (!ts) return ''
    const s = (Date.now() - ts) / 1000
    if (s < 60) return 'now'
    const m = s / 60
    if (m < 60) return `${Math.floor(m)}m`
    const h = m / 60
    if (h < 24) return `${Math.floor(h)}h`
    const d = h / 24
    if (d < 7) return `${Math.floor(d)}d`
    const w = d / 7
    if (w < 5) return `${Math.floor(w)}w`
    const mo = d / 30
    return mo < 12 ? `${Math.floor(mo)}mo` : `${Math.floor(d / 365)}y`
}
