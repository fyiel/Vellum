// Offline copies of cover art. Every thumbnail in the app is painted from a remote url, so with
// no network each one falls through to the resolver and then to nothing at all. Covers seen
// while online are kept in the download store (tauri fs / opfs) behind a bounded url -> path
// registry, and coverImg's error fallback swaps the stored copy in when the network fails.

import { dlPath, dlRead, dlRemove, dlWrite } from './downloads.js'
import { apiUrl, rawFetch } from './http.js'

const NS = 'vellum'
// covers are small; this bounds the cache at a few tens of MB even at the high end
const MAX = 240

const load = () => {
    try {
        const value = JSON.parse(localStorage.getItem(`${NS}:covers`))
        return value && typeof value === 'object' ? value : {}
    } catch { return {} }
}
const save = map => { try { localStorage.setItem(`${NS}:covers`, JSON.stringify(map)) } catch {} }

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
// A browser can only read bytes from a host that serves CORS headers, and a doomed attempt both
// wastes the request and logs a console error. The API can resolve a title itself and stream the
// bytes back (`proxy=1`), which is same-origin in dev and CORS-enabled on pages; desktop reads
// the exact url, CORS-free. A cold title costs the API a few upstream searches, so this is only
// asked for by the download surfaces, never for a whole feed.
const isTauri = () => !!window.__TAURI_INTERNALS__
const sourceFor = (url, title) => {
    if (isTauri()) return url
    if (placeholder(url) && !title) return null
    const target = apiUrl(`/read/api/cover?t=${encodeURIComponent(title || '')}`)
    return `${target}${target.includes('?') ? '&' : '?'}proxy=1`
}
const placeholder = url => !url || NO_IMAGE.test(url)
export async function storeCover(url, title) {
    if (!cacheable(url) || navigator.onLine === false) return null
    const source = sourceFor(url, title)
    if (!source) return null
    const known = load()
    if (known[url]) return known[url]
    if (inflight.has(url)) return null
    inflight.add(url)
    try {
        const response = await rawFetch(source).catch(() => null)
        if (!response?.ok) return null
        const blob = await response.blob().catch(() => null)
        if (!blob?.size) return null
        const type = blob.type || response.headers.get('content-type') || ''
        // never keep an error page or a redirect body as if it were art
        if (type && !type.toLowerCase().startsWith('image/')) return null
        const path = dlPath.cover(`${hash(url)}.${storedExt(type, url)}`)
        await dlWrite(path, blob)
        const next = load()
        next[url] = path
        // evict oldest first, and take the bytes with them
        for (const key of Object.keys(next).slice(0, Math.max(0, Object.keys(next).length - MAX))) {
            dlRemove(next[key]).catch(() => {})
            delete next[key]
        }
        save(next)
        return path
    } catch { return null } finally { inflight.delete(url) }
}

// the stored bytes for a url, or null when this cover was never seen online
export async function localCover(url) {
    if (!cacheable(url)) return null
    const path = load()[url]
    if (!path) return null
    return await dlRead(path).catch(() => null)
}
