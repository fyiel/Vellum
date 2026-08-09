import { apiGet } from './http.js'
import { openDB } from './cache.js'
import { getChapters, getSeries, seriesKey } from './api.js'
import { loadUpdLedger } from './store.js'

// per-series durable offline shelf: raw chapter html in a dedicated IDB store, a
// localStorage manifest per series carries the bookkeeping. downloads are not version
// keyed and never touch the cache store, so version bumps and cache eviction cannot wipe them
const NS = 'vellum'
const STORE = 'downloads'
export const MAX_DL_BYTES = 200 * 1024 * 1024 // refuse a series that would exceed this
export const WARN_DL_BYTES = 50 * 1024 * 1024 // warn once the whole shelf crosses this
const SAVE_EVERY_MS = 800 // persist the manifest at most this often mid job

const enc = encodeURIComponent
const dlKey = slug => `${NS}:dl:${slug}`
const rowKey = (slug, n) => `${slug}:${n}`

const lsGet = (k, fb) => { try { return JSON.parse(localStorage.getItem(k)) ?? fb } catch { return fb } }
// the manifest is small and the quota shed in store.js only touches the updates newNums
// snapshots, so a plain write is all the protection it needs
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

export const fmtBytes = b => {
    if (!Number.isFinite(b) || b <= 0) return '0 B'
    const u = ['B', 'KB', 'MB', 'GB']
    let v = b, i = 0
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}

export const byteLen = s => { try { return new TextEncoder().encode(s).length } catch { return String(s).length * 2 } }

// ---- manifest ----
export const dlGet = slug => {
    const m = lsGet(dlKey(slug), null)
    return m && Array.isArray(m?.chapters) ? m : null
}

export function saveDl(slug, m) {
    m.at = Date.now()
    m.status = m.total > 0 && m.chapters.length >= m.total ? 'complete' : 'partial'
    lsSet(dlKey(slug), m)
}

export function clearDl(slug) { try { localStorage.removeItem(dlKey(slug)) } catch {} }

export const allDls = () => {
    const out = []
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i)
            if (!k || !k.startsWith(`${NS}:dl:`)) continue
            const m = lsGet(k, null)
            if (m?.chapters?.length) out.push({ slug: k.slice(NS.length + 4), ...m })
        }
    } catch {}
    return out.sort((a, b) => b.at - a.at)
}

export const totalBytes = () => allDls().reduce((n, m) => n + (m.bytes || 0), 0)

// ---- storage ----
let dbp
const db = () => { dbp ||= openDB().catch(() => null); return dbp }

export async function getChapterRaw(slug, n) {
    const d = await db()
    if (!d) return undefined
    return new Promise(res => {
        try {
            const r = d.transaction(STORE, 'readonly').objectStore(STORE).get(rowKey(slug, n))
            r.onsuccess = () => res(r.result)
            r.onerror = () => res(undefined)
        } catch { res(undefined) }
    })
}

// accept gate: only a non-empty string body is stored, anything else is refused
export async function setChapter(slug, n, html) {
    if (typeof html !== 'string' || !html.trim()) return false
    const d = await db()
    if (!d) return false
    return new Promise((res, rej) => {
        try {
            const tx = d.transaction(STORE, 'readwrite')
            tx.objectStore(STORE).put(html, rowKey(slug, n))
            tx.oncomplete = () => res(true)
            tx.onerror = () => rej(tx.error)
            tx.onabort = () => rej(tx.error)
        } catch (e) { rej(e) }
    })
}

export async function deleteSeries(slug) {
    const j = jobs.get(slug)
    if (j) j.cancel = true
    const m = dlGet(slug)
    if (m?.chapters?.length) {
        const d = await db()
        if (d) {
            try {
                await new Promise(res => {
                    const tx = d.transaction(STORE, 'readwrite')
                    const os = tx.objectStore(STORE)
                    for (const n of m.chapters) os.delete(rowKey(slug, n))
                    tx.oncomplete = () => res()
                    tx.onerror = () => res()
                })
            } catch {}
        }
    }
    clearDl(slug)
    emit({ type: 'removed', slug })
}

// ---- quota preflight ----
export async function estimate() {
    try {
        if (navigator.storage?.estimate) {
            const e = await navigator.storage.estimate()
            return { usage: e.usage ?? null, quota: e.quota ?? null }
        }
    } catch {}
    return { usage: null, quota: null }
}

// ---- jobs: one download at a time per series, resumable, cancellable ----
const jobs = new Map() // slug -> job
const listeners = new Set()
export const onDl = fn => { listeners.add(fn); return () => listeners.delete(fn) }
const emit = ev => { for (const fn of [...listeners]) { try { fn(ev) } catch {} } }

export const dlJob = slug => {
    const j = jobs.get(slug)
    return j ? { done: j.done, total: j.total, bytes: j.bytes } : null
}

const pickMeta = s => s && ({
    id: s.id, title: s.title, cover: s.cover, author: s.author,
    nfSlug: s.nfSlug, key: s.key, status: s.status, nfStatus: s.nfStatus,
})

const mergeList = (a, b) => {
    const byN = new Map()
    for (const c of a || []) if (c && Number.isFinite(c.n)) byN.set(c.n, c)
    for (const c of b || []) if (c && Number.isFinite(c.n)) byN.set(c.n, c)
    return [...byN.values()].sort((x, y) => x.n - y.n)
}

export function downloadSeries(slug, nums, opts = {}) {
    if (jobs.has(slug)) return jobs.get(slug).promise
    const job = { slug, done: 0, total: 0, bytes: 0, cancel: false, final: null }
    // terminal events fire only after the job leaves the map, so listeners always
    // render the settled state, never a finished job still reporting progress
    job.promise = runJob(job, slug, nums, opts).finally(() => {
        if (jobs.get(slug) === job) {
            jobs.delete(slug)
            if (job.final) emit(job.final)
        }
    })
    jobs.set(slug, job)
    return job.promise
}

async function runJob(job, slug, nums, opts) {
    const { sizeHint, meta, list, total } = opts
    const m = dlGet(slug) || { chapters: [], list: [], total: 0, bytes: 0, status: 'partial', at: 0, meta: null, auto: false }
    if (meta) m.meta = pickMeta(meta)
    if (list?.length) m.list = mergeList(m.list, list)
    if (total) m.total = total

    // the caller may not have the chapter list (downloads view sync, list failed to load):
    // fetch the snapshot here so the manifest always carries bootable n+titles
    if (!m.list.length || !m.total) {
        try {
            const d = await getChapters(slug)
            if (!Array.isArray(d?.chapters)) throw new Error('bad chapter list')
            m.total = d.chapters.length
            m.list = mergeList(m.list, d.chapters.map(c => ({ n: c.n, t: c.t })))
        } catch {
            job.final = { type: 'error', slug, message: 'need a connection to start a download', m }
            return
        }
    }
    if (!m.meta) {
        const s = await getSeries(seriesKey(slug)).catch(() => null)
        if (s) m.meta = pickMeta(s)
    }

    const have = new Set(m.chapters)
    // resume semantics: chapters already stored are skipped
    const todo = [...new Set(nums)].filter(n => Number.isFinite(n) && !have.has(n)).sort((a, b) => a - b)
    if (!todo.length) {
        saveDl(slug, m)
        job.final = { type: 'done', slug, m }
        return
    }

    job.done = 0
    job.total = todo.length
    job.bytes = m.bytes

    // preflight: refuse a series over the per-series budget or past the storage quota
    const proj = m.bytes + (sizeHint || 0) * todo.length
    if (proj > MAX_DL_BYTES) {
        job.final = { type: 'error', slug, message: `too large — ≈ ${fmtBytes(proj)} is over the 200 MB download limit`, m }
        return
    }
    const est = await estimate()
    if (est.quota != null && est.quota > 0 && est.usage != null && est.usage + proj > est.quota) {
        job.final = { type: 'error', slug, message: 'storage full — not enough space', m }
        return
    }

    const listN = new Set(m.list.map(c => c.n))
    let nextSave = 0
    try {
        for (const n of todo) {
            if (job.cancel) return
            const d = await apiGet(`/read/api/chapter?slug=${enc(slug)}&n=${n}`)
            if (typeof d?.html !== 'string' || !d.html.trim()) continue
            if (!(await setChapter(slug, n, d.html))) throw new Error('storage unavailable')
            const b = byteLen(d.html)
            m.bytes += b
            m.chapters.push(n)
            if (!listN.has(n)) { listN.add(n); m.list.push({ n, t: d.title || '' }) }
            job.done++
            job.bytes = m.bytes
            const now = Date.now()
            if (now - nextSave > SAVE_EVERY_MS) { nextSave = now; saveDl(slug, m) }
            emit({ type: 'progress', slug, done: job.done, total: job.total, bytes: m.bytes, n })
        }
        if (!job.cancel) {
            m.list.sort((a, b) => a.n - b.n)
            saveDl(slug, m)
            job.final = { type: 'done', slug, m }
        }
    } catch (e) {
        if (!job.cancel) {
            saveDl(slug, m)
            const quota = e?.name?.includes('Quota') || /quota|storage full/i.test(e?.message || '')
            job.final = {
                type: 'error', slug, m,
                message: quota ? `storage full — downloaded ${m.chapters.length} of ${m.total || job.total}` : (e?.message || 'download failed'),
            }
        }
    }
}

// ---- auto refresh: keep a toggled series offline, fed from the updates ledger's newNums ----
export async function syncAutoSeries(slug) {
    const m = dlGet(slug)
    if (!m?.auto) return
    const have = new Set(m.chapters)
    let chapters = null
    let want = (loadUpdLedger()[slug]?.newNums || []).filter(n => !have.has(n))
    if (!want.length) {
        try { chapters = (await getChapters(slug))?.chapters } catch { return }
        if (!Array.isArray(chapters)) return
        want = chapters.map(c => c.n).filter(n => !have.has(n))
    }
    if (!want.length) return
    const meta = m.meta || (await getSeries(seriesKey(slug)).catch(() => null))
    return downloadSeries(slug, want, {
        meta: meta ? pickMeta(meta) : undefined,
        total: chapters?.length || m.total || undefined,
        list: chapters?.length ? chapters.map(c => ({ n: c.n, t: c.t })) : undefined,
    })
}
