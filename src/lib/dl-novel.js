import { getChapter } from './api.js'
import { apiUrl, rawFetch } from './http.js'
import { dlEntries, dlEntry, dlPath, dlRead, dlRegister, dlRemove, dlUnregister, dlWrite } from './downloads.js'

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
async function downloadImages(key, n, html, signal, written) {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const imgs = [...doc.querySelectorAll('img[src]')].filter(img => /^(https?:)?\/\//i.test(img.getAttribute('src')))
    // Repair only missing remote images, without overwriting existing local image slots.
    const kept = [...new Set([...html.matchAll(/src="dlimg:(\d+)"/g)].map(([, i]) => Number(i)))]
    let next = kept.length ? Math.max(...kept) + 1 : 0
    let size = 0
    for (const i of kept) size += (await dlRead(dlPath.novelImage(key, n, i)))?.size || 0
    for (const img of imgs) {
        if (signal.aborted) throw new Error('download cancelled')
        let path
        try {
            const response = await fetchImage(new URL(img.getAttribute('src'), location.href).href, signal)
            if (!response.ok) continue
            const blob = await response.blob()
            if (!blob.size) continue
            const i = next++
            path = dlPath.novelImage(key, n, i)
            written.push(path)
            await dlWrite(path, blob)
            img.setAttribute('src', `dlimg:${i}`)
            size += blob.size
        } catch (error) {
            if (path) await dlRemove(path)
            if (signal.aborted) throw error
        }
    }
    return { html: doc.body.innerHTML, size }
}

export async function downloadNovelChapter(key, n, title, { force = false } = {}) {
    const id = String(n)
    const tag = `${key}:${id}`
    const saved = dlEntry('novel', key, id)
    if (active.has(tag) || (!force && saved)) return
    const ctrl = new AbortController()
    let finish
    const finished = new Promise(resolve => { finish = resolve })
    active.set(tag, { ctrl, finished })
    notify()
    const written = []
    const chapterPath = dlPath.novelChapter(key, n)
    let previousText = null
    let writeAttempted = false
    try {
        // A repair enriches the saved chapter itself. Re-fetching source HTML would
        // replace already-downloaded illustrations with remote URLs during an outage.
        let chapter = null
        if (saved && force) {
            try {
                const previous = await dlRead(chapterPath)
                if (previous) previousText = await previous.text()
                const value = previousText && JSON.parse(previousText)
                if (typeof value?.html === 'string' && value.html.trim()) chapter = value
            } catch {}
        }
        chapter ??= await getChapter(key, n, { signal: ctrl.signal })
        if (ctrl.signal.aborted) throw new Error('download cancelled')
        const images = await downloadImages(key, n, chapter.html, ctrl.signal, written)
        if (ctrl.signal.aborted) throw new Error('download cancelled')
        const text = JSON.stringify({ ...chapter, html: images.html })
        writeAttempted = true
        await dlWrite(chapterPath, text)
        if (ctrl.signal.aborted) throw new Error('download cancelled')
        dlRegister({ kind: 'novel', key, id, title, label: `Ch. ${n}`, size: new TextEncoder().encode(text).byteLength + images.size })
    } catch (error) {
        if (!saved) {
            await dlRemove(chapterPath)
            await dlRemove(dlPath.novelImages(key, n))
        } else {
            try {
                // Restore the saved chapter if a write or registry update failed.
                if (writeAttempted && previousText != null) await dlWrite(chapterPath, previousText)
            } finally {
                // Old HTML still owns its image slots; only discard this repair's files.
                for (const path of written) await dlRemove(path)
            }
        }
        throw error
    } finally {
        active.delete(tag)
        finish()
        notify()
    }
}

export function cancelNovelDownload(key, n) {
    active.get(`${key}:${n}`)?.ctrl.abort()
}

export async function deleteNovelDownload(key, n) {
    const pending = novelDlActive(key, n)?.finished
    cancelNovelDownload(key, n)
    // A force repair may be writing this chapter. Let its cancellation and
    // rollback finish before deleting, so it cannot restore an orphan afterward.
    if (pending) await pending
    await dlUnregister('novel', key, String(n), dlPath.novelChapter(key, n))
    await dlRemove(dlPath.novelImages(key, n))
}

// offline reader payload: same shape as getChapter (parsed { html, title?, ... }),
// with dlimg:N placeholders swapped for local blob urls
export async function loadDownloadedNovelChapter(key, n, { signal } = {}) {
    if (signal?.aborted || !dlEntry('novel', key, String(n))) return null
    const blob = await dlRead(dlPath.novelChapter(key, n))
    if (!blob || signal?.aborted) return null
    const created = []
    let complete = false
    try {
        const value = JSON.parse(await blob.text())
        if (typeof value?.html !== 'string' || !value.html.trim() || signal?.aborted) return null
        const slots = [...new Set([...value.html.matchAll(/src="dlimg:(\d+)"/g)].map(([, i]) => i))]
        const images = new Array(slots.length)
        let next = 0
        const worker = async () => {
            while (next < slots.length && !signal?.aborted) {
                const index = next++
                images[index] = await dlRead(dlPath.novelImage(key, n, slots[index]))
            }
        }
        // A few parallel file reads shorten cold opening of illustrated chapters
        // while keeping large chapters from opening every image at once.
        const reads = await Promise.allSettled(Array.from({ length: Math.min(4, slots.length) }, worker))
        if (signal?.aborted || reads.some(result => result.status === 'rejected')) return null
        const urls = new Map()
        for (let i = 0; i < slots.length; i++) {
            if (signal?.aborted) return null
            if (!images[i]) continue // missing illustration: keep the saved text
            const url = URL.createObjectURL(images[i])
            created.push(url)
            urls.set(slots[i], url)
        }
        if (signal?.aborted) return null
        value.html = value.html.replace(/src="dlimg:(\d+)"/g, (match, i) => urls.has(i) ? `src="${urls.get(i)}"` : match)
        complete = true
        return value
    } catch { return null }
    finally { if (!complete) for (const url of created) URL.revokeObjectURL(url) }
}

// repair pass for chapters saved before in-chapter images were downloaded: any stored
// chapter whose html still points at remote image urls gets re-downloaded (which now
// fetches the images too). runs once per launch, online only, sequential in the
// background — the registry updates itself as each chapter completes
let upgraded = false
export async function upgradeNovelDownloads() {
    if (upgraded || !navigator.onLine) return
    upgraded = true
    for (const entry of dlEntries()) {
        if (entry.kind !== 'novel') continue
        try {
            const blob = await dlRead(dlPath.novelChapter(entry.key, entry.id))
            if (!blob) continue
            const value = JSON.parse(await blob.text())
            if (typeof value?.html !== 'string') continue
            const doc = new DOMParser().parseFromString(value.html, 'text/html')
            const stale = [...doc.querySelectorAll('img[src]')].some(img => /^(https?:)?\/\//i.test(img.getAttribute('src')))
            if (stale) await downloadNovelChapter(entry.key, entry.id, entry.title, { force: true })
        } catch {}
    }
}
