const DB = 'vellum'
const STORE = 'cache'
const MEM_MAX = 300
const DISK_MAX = 800
const VER = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'
const vkey = k => `${VER}|${k}`

const mem = new Map()
const inflight = new Map()
const refreshing = new Set()

let dbp
export function db() {
    if (dbp) return dbp
    dbp = new Promise((resolve, reject) => {
        // version 3 adds the local books store; the cache store is only rebuilt when
        // upgrading from before v2 (the version key already guards stale rows)
        const req = indexedDB.open(DB, 3)
        req.onupgradeneeded = (ev) => {
            const d = req.result
            // oldVersion lives on the event, not the database handle
            if (ev.oldVersion < 2) {
                if (d.objectStoreNames.contains(STORE)) d.deleteObjectStore(STORE)
                d.createObjectStore(STORE).createIndex('at', 'at')
            }
            if (ev.oldVersion < 3 && !d.objectStoreNames.contains('books')) d.createObjectStore('books')
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    }).catch(() => null)
    return dbp
}

let swept = false
function sweepStale(d) {
    // one pass per session, drop rows from older app versions the version key no longer serves
    if (swept) return
    swept = true
    const prefix = `${VER}|`
    const cur = d.transaction(STORE, 'readwrite').objectStore(STORE).openCursor()
    cur.onsuccess = e => {
        const c = e.target.result
        if (c) {
            if (!String(c.key).startsWith(prefix)) c.delete()
            c.continue()
        }
    }
}

async function idbGet(key) {
    const d = await db()
    if (!d) return undefined
    sweepStale(d)

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

function memPut(key, rec) {
    // delete then set so a re read refreshes the recency order for eviction
    if (mem.has(key)) mem.delete(key)
    mem.set(key, rec)
    if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value)
}

function put(key, rec) {
    memPut(key, rec)
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
    // a stored value that fails accept (eg an empty page cached while a source was down) is
    // never served, so a transient outage cannot stick for the full ttl and no caller
    // caches negatives by default (negTtlMs defaults to 0)
    if (disk && accept(disk.v)) {
        memPut(key, disk)
        if (disk.exp > now) return disk.v
        if (swr) { background(key, ttlMs, loader, negTtlMs, accept); return disk.v }
    }

    return load(key, ttlMs, loader, negTtlMs, accept)
}

export function cached(rawKey, ttlMs, loader, opts = {}) {
    const { swr = true, negTtlMs = 0, accept = v => v !== null && v !== undefined } = opts
    const key = vkey(rawKey)

    const hot = mem.get(key)
    if (hot && hot.exp > Date.now() && accept(hot.v)) return Promise.resolve(hot.v)

    const pending = inflight.get(key)
    if (pending) return pending

    const p = resolve(key, ttlMs, loader, swr, negTtlMs, accept).finally(() => inflight.delete(key))
    inflight.set(key, p)
    return p
}
