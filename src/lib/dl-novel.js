import { getChapter } from './api.js'
import { apiUrl, rawFetch } from './http.js'
import { dlEntry, dlPath, dlRead, dlRegister, dlRemove, dlUnregister, dlWrite } from './downloads.js'

// in-flight downloads: `${key}:${n}` -> { ctrl }
const active = new Map()
const listeners = new Set()
const notify = () => listeners.forEach(fn => { try { fn() } catch {} })
export const onNovelDl = fn => { listeners.add(fn); return () => listeners.delete(fn) }
export const novelDlActive = (key, n) => active.get(`${key}:${n}`) || null
export const novelDlEntry = (key, n) => dlEntry('novel', key, String(n))

// some image hosts send no CORS headers (noveldex), which only matters for fetch() in
// the web build — the backend proxy carries those images instead
const fetchImage = async (url, signal) => {
    const direct = await rawFetch(url, { signal }).catch(() => null)
    if (direct?.ok) return direct
    return rawFetch(apiUrl(`/read/api/image?url=${encodeURIComponent(url)}`), { signal })
}

// some chapters carry illustrations (<figure class="illust"><img src="https://…">);
// fetch them alongside the text and rewrite the src to a dlimg:N placeholder, which
// loadDownloadedNovelChapter swaps for a local blob url. an image that fails keeps its
// remote src — the chapter text is still complete without it
async function downloadImages(key, n, html, signal) {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const imgs = [...doc.querySelectorAll('img[src]')].filter(img => /^(https?:)?\/\//i.test(img.getAttribute('src')))
    let size = 0
    for (const [i, img] of imgs.entries()) {
        if (signal.aborted) throw new Error('download cancelled')
        try {
            const response = await fetchImage(new URL(img.getAttribute('src'), location.href).href, signal)
            if (!response.ok) continue
            const blob = await response.blob()
            if (!blob.size) continue
            await dlWrite(dlPath.novelImage(key, n, i), blob)
            img.setAttribute('src', `dlimg:${i}`)
            size += blob.size
        } catch (error) {
            if (signal.aborted) throw error
        }
    }
    return { html: doc.body.innerHTML, size }
}

export async function downloadNovelChapter(key, n, title) {
    const id = String(n)
    const tag = `${key}:${id}`
    if (active.has(tag) || dlEntry('novel', key, id)) return
    const ctrl = new AbortController()
    active.set(tag, { ctrl })
    notify()
    try {
        const chapter = await getChapter(key, n, { signal: ctrl.signal })
        if (ctrl.signal.aborted) throw new Error('download cancelled')
        const images = await downloadImages(key, n, chapter.html, ctrl.signal)
        const text = JSON.stringify({ ...chapter, html: images.html })
        await dlWrite(dlPath.novelChapter(key, n), text)
        dlRegister({ kind: 'novel', key, id, title, label: `Ch. ${n}`, size: text.length + images.size })
    } catch (error) {
        await dlRemove(dlPath.novelChapter(key, n))
        await dlRemove(dlPath.novelImages(key, n))
        throw error
    } finally {
        active.delete(tag)
        notify()
    }
}

export function cancelNovelDownload(key, n) {
    active.get(`${key}:${n}`)?.ctrl.abort()
}

export async function deleteNovelDownload(key, n) {
    cancelNovelDownload(key, n)
    await dlUnregister('novel', key, String(n), dlPath.novelChapter(key, n))
    await dlRemove(dlPath.novelImages(key, n))
}

// offline reader payload: same shape as getChapter (parsed { html, title?, ... }),
// with dlimg:N placeholders swapped for local blob urls
export async function loadDownloadedNovelChapter(key, n) {
    if (!dlEntry('novel', key, String(n))) return null
    const blob = await dlRead(dlPath.novelChapter(key, n))
    if (!blob) return null
    try {
        const value = JSON.parse(await blob.text())
        if (typeof value?.html !== 'string' || !value.html.trim()) return null
        const swaps = [...value.html.matchAll(/src="dlimg:(\d+)"/g)]
        for (const [, i] of swaps) {
            const image = await dlRead(dlPath.novelImage(key, n, i))
            if (image) value.html = value.html.replaceAll(`src="dlimg:${i}"`, `src="${URL.createObjectURL(image)}"`)
        }
        return value
    } catch { return null }
}
