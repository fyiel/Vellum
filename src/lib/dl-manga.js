import { getMangaChapter, getMangaSeries, mangaPageUrl } from './manga-api.js'
import { raceAbort, rawFetch } from './http.js'
import { dlEntry, dlPath, dlRead, dlRegister, dlRemove, dlUnregister, dlWrite } from './downloads.js'

// in-flight downloads: `${key}:${id}` -> { done, total, ctrl, finished }
const active = new Map()
const listeners = new Set()
const notify = () => listeners.forEach(fn => { try { fn() } catch {} })
const PAGE_WORKERS = 4
export const onMangaDl = fn => { listeners.add(fn); return () => listeners.delete(fn) }
export const mangaDlActive = (key, id) => active.get(`${key}:${id}`) || null
export const mangaDlEntry = (key, id) => dlEntry('manga', key, id)

const chapterLabel = chapter => chapter?.number == null ? (chapter?.title || 'Special') : `Ch. ${chapter.number}`

export async function downloadMangaChapter(key, id) {
    const tag = `${key}:${id}`
    if (active.has(tag) || dlEntry('manga', key, id)) return
    const ctrl = new AbortController()
    let finish
    const finished = new Promise(resolve => { finish = resolve })
    const progress = { done: 0, total: 0, ctrl, finished }
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
        let next = 0
        let failure = null
        const worker = async () => {
            while (next < content.pages.length && !ctrl.signal.aborted) {
                const index = next++
                try {
                    const requestSignal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(60_000)])
                    const response = await raceAbort(rawFetch(mangaPageUrl(content.pages[index]), { signal: requestSignal }), requestSignal)
                    if (!response.ok) throw new Error(`page ${index + 1} failed (http ${response.status})`)
                    const blob = await raceAbort(response.blob(), requestSignal)
                    if (!blob.size) throw new Error(`page ${index + 1} failed (empty)`)
                    if (ctrl.signal.aborted) throw new Error('download cancelled')
                    await dlWrite(dlPath.mangaPage(key, id, index), blob)
                    if (ctrl.signal.aborted) throw new Error('download cancelled')
                    size += blob.size
                    progress.done++
                    notify()
                } catch (error) {
                    if (!failure) { failure = error; ctrl.abort() }
                    return
                }
            }
        }
        // Wait for every in-flight write before deleting partial files on failure.
        await Promise.all(Array.from({ length: Math.min(PAGE_WORKERS, content.pages.length) }, worker))
        if (failure) throw failure
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
        finish()
        notify()
    }
}

export function cancelMangaDownload(key, id) {
    active.get(`${key}:${id}`)?.ctrl.abort()
}

export async function deleteMangaDownload(key, id) {
    const pending = mangaDlActive(key, id)?.finished
    cancelMangaDownload(key, id)
    if (pending) await pending
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
