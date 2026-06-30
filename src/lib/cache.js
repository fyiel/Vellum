// persistent request cache. fast means we never wait for what we already have. an in memory layer
// answers instantly inside a session, indexeddb keeps the data across launches so a reopened chapter
// or series paints with no network at all. every entry carries a ttl. a stale entry still serves
// right away while a fresh copy loads in the background, and concurrent callers share one load

const DB = 'vellum'
const STORE = 'cache'
const MEM_MAX = 300        // entries kept hot in memory before the oldest fall back to disk only
const DISK_MAX = 800       // entries kept on disk before the oldest get swept

// memory L1, insertion ordered so the oldest is always the first key
const mem = new Map()
// shared loads so fast typing or a racing prefetch hits the network once
const inflight = new Map()
// background revalidations in progress, so a stale key is not refreshed twice at once
const refreshing = new Set()

// indexeddb, opened once and reused. if it is unavailable we silently run memory only
let dbp
function db() {
    if (dbp) return dbp
    dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, 1)
        req.onupgradeneeded = () => {
            const os = req.result.createObjectStore(STORE)
            os.createIndex('at', 'at')
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    }).catch(() => null)
    return dbp
}

async function idbGet(key) {
    const d = await db()
    if (!d) return undefined

    return new Promise(res => {
        const r = d.transaction(STORE, 'readonly').objectStore(STORE).get(key)
        r.onsuccess = () => res(r.result)
        r.onerror = () => res(undefined)
    })
}

async function idbSet(key, rec) {
    const d = await db()
    if (!d) return
    try { d.transaction(STORE, 'readwrite').objectStore(STORE).put(rec, key) } catch {}
}

function idbCount(d) {
    return new Promise(res => {
        const r = d.transaction(STORE, 'readonly').objectStore(STORE).count()
        r.onsuccess = () => res(r.result)
        r.onerror = () => res(0)
    })
}

// sweep the oldest entries by write time once the store grows past its cap. throttled so a burst of
// writes only triggers one pass
let evictScheduled = false
function maybeEvict() {
    if (evictScheduled) return
    evictScheduled = true
    setTimeout(async () => {
        evictScheduled = false
        const d = await db()
        if (!d) return
        let over = (await idbCount(d)) - DISK_MAX
        if (over <= 0) return

        const cur = d.transaction(STORE, 'readwrite').objectStore(STORE).index('at').openCursor()
        cur.onsuccess = e => {
            const c = e.target.result
            if (c && over > 0) { c.delete(); over--; c.continue() }
        }
    }, 2000)
}

function put(key, rec) {
    mem.set(key, rec)
    if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value)
    idbSet(key, rec).then(maybeEvict)
}

async function load(key, ttlMs, loader, negTtlMs) {
    const v = await loader()
    const ttl = v === null || v === undefined ? negTtlMs : ttlMs
    if (ttl > 0) put(key, { v, exp: Date.now() + ttl, at: Date.now() })

    return v
}

// refresh a stale entry without blocking the caller that already got the stale value
function background(key, ttlMs, loader, negTtlMs) {
    if (refreshing.has(key)) return
    refreshing.add(key)
    load(key, ttlMs, loader, negTtlMs).catch(() => {}).finally(() => refreshing.delete(key))
}

async function resolve(key, ttlMs, loader, swr, negTtlMs) {
    const now = Date.now()
    const disk = await idbGet(key)
    if (disk) {
        mem.set(key, disk)
        if (disk.exp > now) return disk.v
        if (swr) { background(key, ttlMs, loader, negTtlMs); return disk.v }
    }

    return load(key, ttlMs, loader, negTtlMs)
}

// the one entry point. returns the cached value when fresh, a stale value while it revalidates, or
// awaits the loader on a cold miss. a loader that throws propagates so the caller can show a retry,
// and nothing gets cached. negTtlMs briefly caches an empty result so a dead source is not re hammered
export function cached(key, ttlMs, loader, opts = {}) {
    const { swr = true, negTtlMs = 0 } = opts

    const hot = mem.get(key)
    if (hot && hot.exp > Date.now()) return Promise.resolve(hot.v)

    const pending = inflight.get(key)
    if (pending) return pending

    const p = resolve(key, ttlMs, loader, swr, negTtlMs).finally(() => inflight.delete(key))
    inflight.set(key, p)
    return p
}

// a fresh in memory hit without touching disk, for code that wants to decide synchronously
export function peek(key) {
    const hot = mem.get(key)
    return hot && hot.exp > Date.now() ? hot.v : undefined
}

// wipe everything, for a future clear cache control
export async function clear() {
    mem.clear()
    const d = await db()
    if (d) try { d.transaction(STORE, 'readwrite').objectStore(STORE).clear() } catch {}
}
