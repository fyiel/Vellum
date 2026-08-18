import { getChapter } from './api.js'
import { dlEntry, dlPath, dlRead, dlRegister, dlRemove, dlUnregister, dlWrite } from './downloads.js'

// in-flight downloads: `${key}:${n}` -> { ctrl }
const active = new Map()
const listeners = new Set()
const notify = () => listeners.forEach(fn => { try { fn() } catch {} })
export const onNovelDl = fn => { listeners.add(fn); return () => listeners.delete(fn) }
export const novelDlActive = (key, n) => active.get(`${key}:${n}`) || null
export const novelDlEntry = (key, n) => dlEntry('novel', key, String(n))

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
        const text = JSON.stringify(chapter)
        await dlWrite(dlPath.novelChapter(key, n), text)
        dlRegister({ kind: 'novel', key, id, title, label: `Ch. ${n}`, size: text.length })
    } catch (error) {
        await dlRemove(dlPath.novelChapter(key, n))
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
}

// offline reader payload: same shape as getChapter (parsed { html, title?, ... })
export async function loadDownloadedNovelChapter(key, n) {
    if (!dlEntry('novel', key, String(n))) return null
    const blob = await dlRead(dlPath.novelChapter(key, n))
    if (!blob) return null
    try {
        const value = JSON.parse(await blob.text())
        return typeof value?.html === 'string' && value.html.trim() ? value : null
    } catch { return null }
}
