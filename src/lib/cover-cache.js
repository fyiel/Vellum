// Offline copies of cover art. Every thumbnail in the app is painted from a remote url, so with
// no network each one falls through to the resolver and then to nothing at all. Covers seen
// while online are kept in the download store (tauri fs / opfs) behind a bounded url -> path
// registry, and coverImg's error fallback swaps the stored copy in when the network fails.

import { dlPath, dlRead, dlRemove, dlWrite } from './downloads.js'
import { apiUrl, isNative, rawFetch } from './http.js'

const NS = 'vellum'
// covers are small; this bounds the cache at a few tens of MB even at the high end
const MAX = 240

const load = () => {
    try {
        const value = JSON.parse(localStorage.getItem(`${NS}:covers`))
        return value && typeof value === 'object' ? value : {}
    } catch { return {} }
}
const save = map => {
    try { localStorage.setItem(`${NS}:covers`, JSON.stringify(map)); return true }
    catch { return false }
}

const NO_IMAGE = /noimagemid/i
const cacheable = url => typeof url === 'string' && url.length > 0 && !NO_IMAGE.test(url)
    && (/^https:\/\//i.test(url) || url.startsWith('/read/api/cover?'))

// stable, filename-safe key for an arbitrary url
const hash = url => {
    let h = 5381
    for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) >>> 0
    return h.toString(36)
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
async function keep(url, title) {
    try {
        let blob, type
        for (const source of sourcesFor(url, title)) {
            const response = await rawFetch(source).catch(() => null)
            if (!response?.ok) continue
            const value = await response.blob().catch(() => null)
            if (!value?.size) continue
            const contentType = value.type || response.headers.get('content-type') || ''
            // Never keep an error page or a redirect body as if it were art.
            if (contentType && !contentType.toLowerCase().startsWith('image/')) continue
            blob = value
            type = contentType
            break
        }
        if (!blob) return null
        const path = dlPath.cover(`${hash(url)}.${storedExt(type, url)}`)
        await dlWrite(path, blob)
        const next = load()
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
    return await dlRead(path).catch(() => null)
}
