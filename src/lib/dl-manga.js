import { getMangaChapter, getMangaSeries, mangaPageUrl } from './manga-api.js'
import { rawFetch } from './http.js'
import { dlEntry, dlPath, dlRead, dlRegister, dlRemove, dlUnregister, dlWrite } from './downloads.js'

// in-flight downloads: `${key}:${id}` -> { done, total, ctrl }
const active = new Map()
const listeners = new Set()
const notify = () => listeners.forEach(fn => { try { fn() } catch {} })
export const onMangaDl = fn => { listeners.add(fn); return () => listeners.delete(fn) }
export const mangaDlActive = (key, id) => active.get(`${key}:${id}`) || null
export const mangaDlEntry = (key, id) => dlEntry('manga', key, id)

const chapterLabel = chapter => chapter?.number == null ? (chapter?.title || 'Special') : `Ch. ${chapter.number}`

export async function downloadMangaChapter(key, id) {
    const tag = `${key}:${id}`
    if (active.has(tag) || dlEntry('manga', key, id)) return
    const ctrl = new AbortController()
    const progress = { done: 0, total: 0, ctrl }
    active.set(tag, progress)
    notify()
    try {
        const [series, content] = await Promise.all([
            getMangaSeries(key, { signal: ctrl.signal }),
            getMangaChapter(key, id, { signal: ctrl.signal }),
        ])
        if (ctrl.signal.aborted) throw new Error('download cancelled')
        const chapter = content.chapter
        progress.total = content.pages.length
        let size = 0
        for (let index = 0; index < content.pages.length; index++) {
            if (ctrl.signal.aborted) throw new Error('download cancelled')
            const response = await rawFetch(mangaPageUrl(content.pages[index]), { signal: ctrl.signal })
            if (!response.ok) throw new Error(`page ${index + 1} failed (http ${response.status})`)
            const blob = await response.blob()
            if (!blob.size) throw new Error(`page ${index + 1} failed (empty)`)
            if (ctrl.signal.aborted) throw new Error('download cancelled')
            await dlWrite(dlPath.mangaPage(key, id, index), blob)
            size += blob.size
            progress.done = index + 1
            notify()
        }
        // A cancellation during the final disk write must not publish a copy.
        if (ctrl.signal.aborted) throw new Error('download cancelled')
        dlRegister({
            kind: 'manga', key, id,
            title: series.title,
            format: series.format,
            label: chapterLabel(chapter),
            number: chapter.number,
            chapterTitle: chapter.title,
            pages: content.pages.length,
            size,
        })
    } catch (error) {
        await dlRemove(dlPath.manga(key, id))
        throw error
    } finally {
        active.delete(tag)
        notify()
    }
}

export function cancelMangaDownload(key, id) {
    active.get(`${key}:${id}`)?.ctrl.abort()
}

export async function deleteMangaDownload(key, id) {
    cancelMangaDownload(key, id)
    await dlUnregister('manga', key, id, dlPath.manga(key, id))
}

// offline reader payload: same shape as getMangaChapter, but pages point at object URLs
export async function loadDownloadedMangaChapter(key, id, { signal } = {}) {
    const entry = dlEntry('manga', key, id)
    if (!entry || !Number.isSafeInteger(entry.pages) || entry.pages < 1 || signal?.aborted) return null
    const pages = new Array(entry.pages)
    let next = 0
    let missing = false
    // Bounded concurrency removes the per-page filesystem round trip from the
    // critical path without opening hundreds of files at once on large chapters.
    const worker = async () => {
        while (next < entry.pages && !missing && !signal?.aborted) {
            const index = next++
            const blob = await dlRead(dlPath.mangaPage(key, id, index))
            if (!blob) { missing = true; return }
            if (missing || signal?.aborted) return
            pages[index] = { url: URL.createObjectURL(blob) }
        }
    }
    // Wait for every worker before cleanup; otherwise late reads can allocate
    // object URLs after the partial/cancelled copy has already been abandoned.
    const results = await Promise.allSettled(Array.from({ length: Math.min(6, entry.pages) }, worker))
    const error = results.find(result => result.status === 'rejected')?.reason
    if (missing || signal?.aborted || error) {
        for (const page of pages) if (page?.url) URL.revokeObjectURL(page.url)
        if (error) throw error
        return null
    }
    return {
        entry,
        content: {
            key,
            chapter: { id, number: entry.number ?? null, title: entry.chapterTitle },
            pages,
        },
    }
}
