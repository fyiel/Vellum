import { getChapter } from './api.js'
import { apiUrl, raceAbort, rawFetch } from './http.js'
import { dlEntries, dlEntry, dlExists, dlPath, dlRead, dlRegister, dlRemove, dlUnregister, dlWrite } from './downloads.js'

// in-flight downloads: `${key}:${n}` -> { ctrl }
const active = new Map()
const listeners = new Set()
const IMAGE_FETCHES = 4
// Saved HTML normally uses double quotes, but older or imported chapters may
// carry single-quoted or unquoted src attributes. Match real src attributes,
// excluding data-src and other attribute names that contain the same suffix.
const localImageSrc = /(\s+src\s*=\s*)(?:"dlimg:(\d+)"|'dlimg:(\d+)'|dlimg:(\d+)(?=[\s>]))/gi
const notify = (key, n) => listeners.forEach(fn => { try { fn(key, n) } catch {} })
export const onNovelDl = fn => { listeners.add(fn); return () => listeners.delete(fn) }
export const novelDlActive = (key, n) => active.get(`${key}:${n}`) || null
export const novelDlEntry = (key, n) => dlEntry('novel', key, String(n))

// some image hosts send no CORS headers (noveldex), which only matters for fetch() in
// the web build — the backend proxy carries those images instead
const fetchImage = async (url, signal) => {
    const fetchBlob = async source => {
        // An image host may ignore abort on either the request or its body.
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        const response = await raceAbort(rawFetch(source, { signal: requestSignal }), requestSignal)
        if (!response.ok) return null
        const blob = await raceAbort(response.blob(), requestSignal)
        return blob.size ? blob : null
    }
    try {
        const direct = await fetchBlob(url)
        if (direct) return direct
    } catch (error) { if (signal.aborted) throw error }
    if (signal.aborted) throw new Error('download cancelled')
    return fetchBlob(apiUrl(`/read/api/image?url=${encodeURIComponent(url)}`))
}

// some chapters carry illustrations (<figure class="illust"><img src="https://…">);
// fetch them alongside the text and rewrite the src to a dlimg:N placeholder, which
// loadDownloadedNovelChapter swaps for a local blob url. an image that fails keeps its
// remote src — the chapter text is still complete without it
async function downloadImages(key, n, html, signal, written) {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const sources = [...doc.querySelectorAll('img[src]')]
    const imgs = sources.filter(img => /^(https?:)?\/\//i.test(img.getAttribute('src')))
    // Repair only missing remote images, without overwriting existing local image slots.
    const kept = [...new Set(sources.map(img => /^dlimg:(\d+)$/.exec(img.getAttribute('src'))?.[1]).filter(i => i !== undefined).map(Number))]
    let next = kept.length ? Math.max(...kept) + 1 : 0
    let size = 0
    for (const i of kept) size += (await dlRead(dlPath.novelImage(key, n, i)))?.size || 0
    for (let start = 0; start < imgs.length; start += IMAGE_FETCHES) {
        if (signal.aborted) throw new Error('download cancelled')
        const batch = imgs.slice(start, start + IMAGE_FETCHES)
        // Fetch a small batch together, then persist it in document order so
        // dlimg slots stay stable even if network requests finish out of order.
        const blobs = await Promise.all(batch.map(async img => {
            try { return await fetchImage(new URL(img.getAttribute('src'), location.href).href, signal) }
            catch (error) {
                if (signal.aborted) throw error
                return null
            }
        }))
        for (let i = 0; i < batch.length; i++) {
            if (signal.aborted) throw new Error('download cancelled')
            const blob = blobs[i]
            if (!blob) continue
            let path
            try {
                // A prior chapter file may have been evicted or become corrupt,
                // leaving unregistered illustrations behind. Never overwrite
                // those bytes, including during repair of an existing chapter.
                while (await dlExists(dlPath.novelImage(key, n, next))) next++
                const slot = next++
                path = dlPath.novelImage(key, n, slot)
                written.push(path)
                await dlWrite(path, blob)
                batch[i].setAttribute('src', `dlimg:${slot}`)
                size += blob.size
            } catch (error) {
                if (path) await dlRemove(path)
                if (signal.aborted) throw error
            }
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
    notify(key, n)
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
        if (!saved) {
            // A stale registry row may have been removed while its old chapter
            // bytes remain. Keep them for rollback if the replacement fails.
            const previous = await dlRead(chapterPath)
            if (previous) previousText = await previous.text()
        }
        const images = await downloadImages(key, n, chapter.html, ctrl.signal, written)
        if (ctrl.signal.aborted) throw new Error('download cancelled')
        const text = JSON.stringify({ ...chapter, html: images.html })
        writeAttempted = true
        await dlWrite(chapterPath, text)
        if (ctrl.signal.aborted) throw new Error('download cancelled')
        dlRegister({ kind: 'novel', key, id, title, label: `Ch. ${n}`, size: new TextEncoder().encode(text).byteLength + images.size })
    } catch (error) {
        if (!saved) {
            if (writeAttempted) {
                if (previousText != null) await dlWrite(chapterPath, previousText)
                else await dlRemove(chapterPath)
            }
            // Only remove files this attempt created; orphaned illustrations
            // may still be the sole remaining copy of a failed chapter.
            for (const path of written) await dlRemove(path)
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
        notify(key, n)
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
    const chapterPath = dlPath.novelChapter(key, n)
    const entry = novelDlEntry(key, n)
    // The chapter and its illustrations live in separate paths. Keep the small
    // chapter file so a failed illustration cleanup can restore a usable copy.
    const original = entry ? await dlRead(chapterPath) : null
    if (entry && !original && await dlExists(chapterPath)) {
        throw new Error('Could not read the saved chapter before deleting it')
    }
    // OPFS File objects become unreadable after their underlying entry is removed.
    const backup = original ? new Blob([await original.arrayBuffer()]) : null
    await dlUnregister('novel', key, String(n), chapterPath)
    try {
        await dlRemove(dlPath.novelImages(key, n), { strict: true })
    } catch (error) {
        try {
            if (backup) await dlWrite(chapterPath, backup)
            if (entry) dlRegister(entry)
        } catch (restoreError) {
            throw new AggregateError([error, restoreError], 'Could not delete illustrations or restore the chapter')
        }
        throw error
    }
}

// offline reader payload: same shape as getChapter (parsed { html, title?, ... }),
// with dlimg:N placeholders swapped for local blob urls
export async function loadDownloadedNovelChapter(key, n, { signal } = {}) {
    const id = String(n)
    const entry = dlEntry('novel', key, id)
    if (signal?.aborted || !entry) return null
    const path = dlPath.novelChapter(key, n)
    const blob = await dlRead(path)
    if (signal?.aborted) return null
    let stale = !!blob && !blob.size
    if (!blob) {
        try { stale = !await dlExists(path) }
        catch { return null } // temporary filesystem error; preserve the entry
    }
    const created = []
    let complete = false
    try {
        if (!blob?.size) return null
        const value = JSON.parse(await blob.text())
        if (typeof value?.html !== 'string' || !value.html.trim()) { stale = true; return null }
        if (signal?.aborted) return null
        const slots = [...new Set([...value.html.matchAll(localImageSrc)].map(([, , double, single, bare]) => double ?? single ?? bare))]
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
        value.html = value.html.replace(localImageSrc, (match, prefix, double, single, bare) => {
            const url = urls.get(double ?? single ?? bare)
            return url ? `${prefix}"${url}"` : match
        })
        complete = true
        return value
    } catch (error) {
        if (error instanceof SyntaxError) stale = true
        return null
    } finally {
        if (!complete) for (const url of created) URL.revokeObjectURL(url)
        if (stale && !signal?.aborted && !novelDlActive(key, n)) {
            const current = dlEntry('novel', key, id)
            if (current?.at === entry.at && current?.size === entry.size && current?.title === entry.title) {
                // Remove only the stale index, leaving any remaining bytes for
                // recovery until a fresh download has succeeded.
                await dlUnregister('novel', key, id)
                notify(key, n)
            }
        }
    }
}

// Older saved chapters may still reference remote illustrations. Remember which
// registry revisions were inspected so opening a large offline library doesn't
// read every chapter file again on each launch. This is a disposable hint:
// writes/downloads change the registry revision, and failed repairs are retried.
const imageScanStorageKey = 'vellum:novel-image-scan:v1'
const imageScanId = entry => JSON.stringify([entry.key, String(entry.id)])
const imageScanRevision = entry => JSON.stringify([entry.at, entry.size, entry.title])

// Scan once per launch, online only, sequential in the background. Repairs use
// existing saved text and keep all prior illustration slots intact.
let upgraded = false
export async function upgradeNovelDownloads() {
    if (upgraded || !navigator.onLine) return
    upgraded = true
    let previous = {}
    try { previous = JSON.parse(localStorage.getItem(imageScanStorageKey)) || {} } catch {}
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)) previous = {}
    const checked = new Map()
    for (const entry of dlEntries()) {
        if (entry.kind !== 'novel') continue
        const id = imageScanId(entry), revision = imageScanRevision(entry)
        if (previous[id] === revision) { checked.set(id, revision); continue }
        try {
            const blob = await dlRead(dlPath.novelChapter(entry.key, entry.id))
            if (!blob) continue
            const value = JSON.parse(await blob.text())
            if (typeof value?.html !== 'string') continue
            // Most novel chapters are text-only. Avoid building a full DOM for
            // each one while still parsing any possible <img> for legacy repair.
            if (!/<img(?=[\s/>])/i.test(value.html)) { checked.set(id, revision); continue }
            const doc = new DOMParser().parseFromString(value.html, 'text/html')
            const stale = [...doc.querySelectorAll('img[src]')].some(img => /^(https?:)?\/\//i.test(img.getAttribute('src')))
            if (stale) await downloadNovelChapter(entry.key, entry.id, entry.title, { force: true })
            else checked.set(id, revision)
        } catch {}
    }
    // Recheck revisions: the reader or another tab may have replaced a chapter
    // while the scan was awaiting filesystem or network operations.
    const current = Object.create(null)
    for (const entry of dlEntries()) {
        if (entry.kind !== 'novel') continue
        const id = imageScanId(entry), revision = imageScanRevision(entry)
        if (checked.get(id) === revision) current[id] = revision
    }
    try {
        const next = JSON.stringify(current)
        if (localStorage.getItem(imageScanStorageKey) !== next) localStorage.setItem(imageScanStorageKey, next)
    } catch {} // A failed hint write must never affect saved chapters.
}
