// Offline copies of cover art. Every thumbnail in the app is painted from a remote url, so with
// no network each one falls through to the resolver and then to nothing at all. Covers seen
// while online are kept in the download store (tauri fs / opfs) behind a bounded url -> path
// registry, and coverImg's error fallback swaps the stored copy in when the network fails.

import { dlExists, dlPath, dlRead, dlRemove, dlWrite } from './downloads.js'
import { apiUrl, isNative, rawFetch } from './http.js'

const NS = 'vellum'
// covers are small; this bounds the cache at a few tens of MB even at the high end
const MAX = 240

let snapshotRaw
let snapshot = {}
const load = () => {
    let raw
    try { raw = localStorage.getItem(`${NS}:covers`) } catch { raw = null }
    if (raw === snapshotRaw) return snapshot
    let value
    try { value = JSON.parse(raw) } catch {}
    snapshotRaw = raw
    snapshot = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    return snapshot
}
const save = map => {
    try {
        const raw = JSON.stringify(map)
        localStorage.setItem(`${NS}:covers`, raw)
        snapshotRaw = raw
        snapshot = map
        return true
    }
    catch { return false }
}

const NO_IMAGE = /noimagemid/i
const cacheable = url => typeof url === 'string' && url.length > 0 && !NO_IMAGE.test(url)
    && (/^https:\/\//i.test(url) || url.startsWith('/read/api/cover?'))

// Stable, filename-safe key for an arbitrary URL. DJB2 alone collides even for
// ordinary two-letter differences (e.g. /Ab.jpg and /BA.jpg); combine it with
// an independent hash so storing one cover cannot overwrite the other.
// Existing downloads keep their original filenames through the URL -> path index.
const hash = url => {
    let h = 5381
    let second = 2166136261
    for (let i = 0; i < url.length; i++) {
        const char = url.charCodeAt(i)
        h = ((h << 5) + h + char) >>> 0
        second = Math.imul(second ^ char, 16777619) >>> 0
    }
    return `${h.toString(36)}-${second.toString(36)}`
}
// opfs derives a file's type from its name, so the stored extension has to match the bytes:
// cover urls routinely lie (a .jpg that serves webp), and a mismatched name makes the browser
// refuse to decode the offline copy
const EXT_BY_TYPE = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif',
    'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
}
const urlExt = url => String(url.match(/\.(jpe?g|png|webp|avif|gif|bmp|svg)(?:[?#]|$)/i)?.[1] || '').toLowerCase()
const storedExt = (type, url) => EXT_BY_TYPE[String(type || '').split(';')[0].trim().toLowerCase()] || urlExt(url) || 'img'

const inflight = new Set()
// Web cover hosts commonly omit CORS. Tauri's HTTP transport is CORS-free, but
// its existing capability deliberately permits only the configured reader backend.
// Keep cover downloads within that boundary instead of expanding native permissions.
const sourcesFor = (url, title) => {
    if (isNative && !window.__TAURI_INTERNALS__) return [url] // Capacitor transport
    const fallback = title ? apiUrl(`/read/api/cover?t=${encodeURIComponent(title)}&proxy=1`) : null
    if (!window.__TAURI_INTERNALS__) return fallback ? [fallback] : []
    try {
        const backend = new URL(apiUrl('/'), location.href)
        const source = new URL(url, backend)
        if (source.origin === backend.origin) {
            // The default cover endpoint redirects to an external CDN. Explicit proxy mode
            // returns bytes from the already-authorized backend instead.
            if (source.pathname === '/read/api/cover') source.searchParams.set('proxy', '1')
            return [source.href]
        }
        // The backend validates exact-image URLs and every redirect against its allowlist.
        // Unsupported hosts can still use the existing server-side title resolver.
        return [apiUrl(`/read/api/image?url=${encodeURIComponent(source.href)}`), fallback].filter(Boolean)
    } catch { return fallback ? [fallback] : [] }
}
// One cold title costs the API several upstream searches, and the library renders every
// downloaded series at once on boot, so the work is queued instead of fired together
const queue = []
const LIMIT = 2
const FETCH_TIMEOUT_MS = 15_000
let active = 0
const pump = () => {
    while (active < LIMIT && queue.length) {
        const job = queue.shift()
        active += 1
        job().catch(() => {}).finally(() => { active -= 1; pump() })
    }
}
// fire and forget: covers fill in over the session rather than all at once
export function storeCover(url, title) {
    if (!cacheable(url) || navigator.onLine === false) return
    if (load()[url] || inflight.has(url)) return
    inflight.add(url)
    queue.push(() => keep(url, title))
    pump()
}

async function fetchCover(source) {
    const ctrl = new AbortController()
    let timer
    try {
        // Bound both the response and its body, even if a native transport ignores abort.
        return await Promise.race([
            (async () => {
                const response = await rawFetch(source, { signal: ctrl.signal })
                if (!response?.ok) return null
                const blob = await response.blob()
                if (!blob?.size) return null
                const type = blob.type || response.headers.get('content-type') || ''
                return type && !type.toLowerCase().startsWith('image/') ? null : { blob, type }
            })().catch(() => null),
            new Promise(resolve => {
                timer = setTimeout(() => { ctrl.abort(); resolve(null) }, FETCH_TIMEOUT_MS)
            }),
        ])
    } finally { clearTimeout(timer) }
}

async function keep(url, title) {
    try {
        let blob, type
        for (const source of sourcesFor(url, title)) {
            const image = await fetchCover(source)
            if (!image) continue
            blob = image.blob
            type = image.type
            break
        }
        if (!blob) return null
        const path = dlPath.cover(`${hash(url)}.${storedExt(type, url)}`)
        await dlWrite(path, blob)
        // The cached registry must stay untouched if the storage write fails.
        const next = { ...load() }
        next[url] = path
        const keys = Object.keys(next)
        const evicted = []
        for (const key of keys.slice(0, Math.max(0, keys.length - MAX))) {
            evicted.push(next[key])
            delete next[key]
        }
        // Only delete evicted bytes after the registry was durably updated. Otherwise
        // a quota failure strands existing entries pointing at removed offline covers.
        if (!save(next)) {
            if (!Object.values(load()).includes(path)) await dlRemove(path).catch(() => {})
            return null
        }
        const retained = new Set(Object.values(next))
        for (const oldPath of evicted) if (!retained.has(oldPath)) dlRemove(oldPath).catch(() => {})
        return path
    } finally { inflight.delete(url) }
}

// the stored bytes for a url, or null when this cover was never seen online
export async function localCover(url) {
    if (!cacheable(url)) return null
    const path = load()[url]
    if (!path) return null
    const blob = await dlRead(path).catch(() => null)
    if (blob?.size) return blob
    if (!blob) {
        // dlRead also returns null for transient filesystem errors. Keep the
        // index if the file still exists or its presence cannot be checked.
        try { if (await dlExists(path)) return null }
        catch { return null }
    }
    // Browsers can evict OPFS independently of localStorage. An absent or empty
    // file must not keep this URL marked as cached forever: the next library
    // render can then queue a fresh copy when the user is online.
    const current = load()
    if (current[url] === path) {
        const next = { ...current }
        delete next[url]
        save(next)
    }
    return null
}
