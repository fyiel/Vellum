const DB = 'vellum'
const STORE = 'cache'
const MEM_MAX = 300
const DISK_MAX = 800

const mem = new Map()
const inflight = new Map()
const refreshing = new Set()

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

async function load(key, ttlMs, loader, negTtlMs, accept) {
    const v = await loader()
    const ttl = accept(v) ? ttlMs : negTtlMs
    if (ttl > 0) put(key, { v, exp: Date.now() + ttl, at: Date.now() })

    return v
}

function background(key, ttlMs, loader, negTtlMs, accept) {
    if (refreshing.has(key)) return
    refreshing.add(key)
    load(key, ttlMs, loader, negTtlMs, accept).catch(() => {}).finally(() => refreshing.delete(key))
}

async function resolve(key, ttlMs, loader, swr, negTtlMs, accept) {
    const now = Date.now()
    const disk = await idbGet(key)
    // a stored value that no longer passes accept (eg an empty page cached while a source was down) is
    // treated as a miss, so a transient outage never gets stuck for the full ttl
    if (disk && accept(disk.v)) {
        mem.set(key, disk)
        if (disk.exp > now) return disk.v
        if (swr) { background(key, ttlMs, loader, negTtlMs, accept); return disk.v }
    }

    return load(key, ttlMs, loader, negTtlMs, accept)
}

export function cached(key, ttlMs, loader, opts = {}) {
    const { swr = true, negTtlMs = 0, accept = v => v !== null && v !== undefined } = opts

    const hot = mem.get(key)
    if (hot && hot.exp > Date.now() && accept(hot.v)) return Promise.resolve(hot.v)

    const pending = inflight.get(key)
    if (pending) return pending

    const p = resolve(key, ttlMs, loader, swr, negTtlMs, accept).finally(() => inflight.delete(key))
    inflight.set(key, p)
    return p
}

export function peek(key) {
    const hot = mem.get(key)
    return hot && hot.exp > Date.now() ? hot.v : undefined
}

export async function clear() {
    mem.clear()
    const d = await db()
    if (d) try { d.transaction(STORE, 'readwrite').objectStore(STORE).clear() } catch {}
}
