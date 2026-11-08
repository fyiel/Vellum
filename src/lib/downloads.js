// Downloaded-content store. Two backends behind one interface:
//   desktop (Tauri) — real files under the app data dir via plugin-fs
//   web             — OPFS (origin private file system)
// Everything below deals in app-relative posix paths ("manga/mf_x/123/0"); the
// registry of what is downloaded lives in localStorage so the UI can list it
// without touching the filesystem.

import { preserveOfflineStorage } from './persistence.js'

const isTauri = () => !!window.__TAURI_INTERNALS__
const safe = value => encodeURIComponent(String(value))

// ---- paths ----------------------------------------------------------------

export const dlPath = {
    manga: (key, id) => `manga/${safe(key)}/${safe(id)}`,
    mangaPage: (key, id, page) => `${dlPath.manga(key, id)}/${page}`,
    novel: key => `novel/${safe(key)}`,
    novelChapter: (key, n) => `${dlPath.novel(key)}/${n}.json`,
    novelImages: (key, n) => `${dlPath.novel(key)}/${n}.img`,
    novelImage: (key, n, i) => `${dlPath.novelImages(key, n)}/${i}`,
    video: (key, id) => `video/${safe(key)}/${safe(id)}.mp4`,
    cover: name => `covers/${safe(name)}`,
}

// ---- backend: tauri -------------------------------------------------------

let tauriFs = null
async function tauri() {
    if (!tauriFs) {
        tauriFs = await import('@tauri-apps/plugin-fs')
        await tauriFs.mkdir('downloads', { baseDir: tauriFs.BaseDirectory.AppLocalData, recursive: true }).catch(() => {})
    }
    return { fs: tauriFs, baseDir: tauriFs.BaseDirectory.AppLocalData }
}
const tpath = path => `downloads/${path}`

// ---- backend: opfs --------------------------------------------------------

let opfsRoot = null
async function opfs() {
    if (!opfsRoot) {
        const root = await navigator.storage.getDirectory()
        opfsRoot = await root.getDirectoryHandle('downloads', { create: true })
    }
    return opfsRoot
}
async function opfsDir(parts, create) {
    let dir = await opfs()
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create })
    return dir
}

// ---- uniform interface ----------------------------------------------------

export async function dlWrite(path, data) {
    void preserveOfflineStorage()
    if (isTauri()) {
        const { fs, baseDir } = await tauri()
        const parent = path.split('/').slice(0, -1).join('/')
        await fs.mkdir(tpath(parent), { baseDir, recursive: true }).catch(() => {})
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data)
            : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data
        await fs.writeFile(tpath(path), bytes, { baseDir })
        return
    }
    const parts = path.split('/')
    const dir = await opfsDir(parts.slice(0, -1), true)
    const handle = await dir.getFileHandle(parts.at(-1), { create: true })
    const writable = await handle.createWritable()
    try {
        await writable.write(data)
        await writable.close()
    } catch (error) {
        // Release an OPFS write lock even when quota or a device error interrupts it.
        await writable.abort().catch(() => {})
        throw error
    }
}

// incremental writer for large payloads (video): write(chunk) then close(); abort() drops the file
export async function dlWriter(path) {
    void preserveOfflineStorage()
    if (isTauri()) {
        const { fs, baseDir } = await tauri()
        const parent = path.split('/').slice(0, -1).join('/')
        await fs.mkdir(tpath(parent), { baseDir, recursive: true }).catch(() => {})
        await fs.writeFile(tpath(path), new Uint8Array(0), { baseDir })
        const file = await fs.open(tpath(path), { baseDir, append: true })
        return {
            write: async chunk => {
                const bytes = chunk instanceof Blob ? new Uint8Array(await chunk.arrayBuffer()) : chunk
                let offset = 0
                while (offset < bytes.byteLength) {
                    const count = await file.write(bytes.subarray(offset))
                    if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.byteLength - offset) {
                        throw new Error('incomplete native file write')
                    }
                    offset += count
                }
            },
            close: () => file.close(),
            abort: async () => { try { await file.close() } catch {}; await fs.remove(tpath(path), { baseDir }).catch(() => {}) },
        }
    }
    const parts = path.split('/')
    const dir = await opfsDir(parts.slice(0, -1), true)
    const handle = await dir.getFileHandle(parts.at(-1), { create: true })
    const writable = await handle.createWritable({ keepExistingData: false })
    let offset = 0
    return {
        write: async chunk => {
            await writable.write({ type: 'write', position: offset, data: chunk })
            offset += chunk instanceof Blob ? chunk.size : chunk.byteLength
        },
        close: () => writable.close(),
        abort: async () => {
            // Closing commits the partial video before removing it. Abort the
            // transaction so a busy filesystem cannot strand those bytes if
            // the subsequent file deletion fails.
            try { await writable.abort() } catch {}
            await dir.removeEntry(parts.at(-1)).catch(() => {})
        },
    }
}

export async function dlRead(path) {
    if (isTauri()) {
        const { fs, baseDir } = await tauri()
        try {
            const bytes = await fs.readFile(tpath(path), { baseDir })
            return new Blob([bytes])
        } catch { return null }
    }
    try {
        const parts = path.split('/')
        const dir = await opfsDir(parts.slice(0, -1), false)
        const handle = await dir.getFileHandle(parts.at(-1), { create: false })
        return await handle.getFile()
    } catch { return null }
}

// Distinguish an evicted file from a transient read failure before clearing
// any persistent registry record that says the download exists.
export async function dlExists(path, { directory = false } = {}) {
    if (isTauri()) {
        const { fs, baseDir } = await tauri()
        return fs.exists(tpath(path), { baseDir })
    }
    try {
        const parts = path.split('/')
        if (directory) { await opfsDir(parts, false); return true }
        const dir = await opfsDir(parts.slice(0, -1), false)
        await dir.getFileHandle(parts.at(-1), { create: false })
        return true
    } catch (error) {
        if (error?.name === 'NotFoundError') return false
        throw error
    }
}

// Removes a file or directory subtree. Cleanup is best-effort, but user-initiated
// deletion needs strict errors so the registry can keep a failed download visible.
export async function dlRemove(path, { strict = false } = {}) {
    if (isTauri()) {
        const { fs, baseDir } = await tauri()
        try { await fs.remove(tpath(path), { baseDir, recursive: true }) }
        catch (error) {
            if (!strict) return
            // Native fs errors do not consistently expose a NotFoundError name.
            // Missing files are already gone; other failures must reach the caller.
            try { if (!await fs.exists(tpath(path), { baseDir })) return } catch {}
            throw error
        }
        return
    }
    try {
        const parts = path.split('/')
        const dir = await opfsDir(parts.slice(0, -1), false)
        await dir.removeEntry(parts.at(-1), { recursive: true })
    } catch (error) {
        if (strict && error?.name !== 'NotFoundError') throw error
    }
}

// ---- registry -------------------------------------------------------------

const NS = 'vellum'
const listeners = new Set()
const notify = () => listeners.forEach(fn => { try { fn() } catch {} })
let snapshotRaw
let snapshot = []
let lookup = new Map()
const entryKey = (kind, key, id) => JSON.stringify([kind, key, String(id)])
const load = () => {
    let raw
    try { raw = localStorage.getItem(`${NS}:dl`) } catch { raw = null }
    if (raw === snapshotRaw) return snapshot

    let parsed
    try { parsed = JSON.parse(raw) } catch {}
    snapshotRaw = raw
    snapshot = Array.isArray(parsed) ? parsed.filter(entry => entry && typeof entry === 'object') : []
    lookup = new Map()
    for (const entry of snapshot) {
        const key = entryKey(entry.kind, entry.key, entry.id)
        if (!lookup.has(key)) lookup.set(key, entry)
    }
    return snapshot
}
const save = entries => {
    try { localStorage.setItem(`${NS}:dl`, JSON.stringify(entries)) } catch (cause) {
        // Bytes alone are not a usable download: readers find them through this registry.
        // Reject so callers clean up a new copy and never report it as saved.
        throw new Error('Could not save the download list. Free some storage and try again.', { cause })
    }
    notify()
}
export const dlListen = fn => { listeners.add(fn); return () => listeners.delete(fn) }

// Storage events are delivered to other tabs, not the tab performing the write.
// Keep the same listeners reactive when another tab adds, removes, or clears downloads.
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
    if (event.storageArea === localStorage && (event.key === `${NS}:dl` || event.key === null)) notify()
})

// Read the storage value each time so changes in other tabs remain visible
// Parse and index only when it changes instead of once per chapter row
export const dlEntries = () => load().map(entry => ({ ...entry }))
export const dlEntry = (kind, key, id) => {
    load()
    const entry = lookup.get(entryKey(kind, key, id))
    return entry ? { ...entry } : null
}

export function dlRegister(entry) {
    const rest = load().filter(item => !(item.kind === entry.kind && item.key === entry.key && item.id === String(entry.id)))
    rest.unshift({ ...entry, id: String(entry.id), at: Date.now() })
    save(rest)
}

// drops the registry row and the stored bytes (path may be a file or a directory)
export async function dlUnregister(kind, key, id, path) {
    const matches = item => item.kind === kind && item.key === key && item.id === String(id)
    const entries = load()
    save(entries.filter(item => !matches(item)))
    if (!path) return
    try { await dlRemove(path, { strict: true }) }
    catch (error) {
        // Removing bytes failed after the registry was written. Restore the saved
        // entry so the user can retry, while preserving concurrent registry edits.
        const current = load()
        if (!current.some(matches)) {
            const removed = entries.filter(matches)
            if (removed.length) {
                const restored = [...current]
                restored.splice(Math.min(entries.findIndex(matches), restored.length), 0, ...removed)
                save(restored)
            }
        }
        throw error
    }
}

export const dlTotalSize = () => load().reduce((sum, entry) => sum + (entry.size || 0), 0)

// sequential batch runner for the "download next/all" buttons: fn(item) per item,
// a user cancel (abort) stops the batch, other failures are counted and keep going
export async function dlBatch(items, fn, { onStep, onError } = {}) {
    let done = 0, failed = 0
    for (const item of items) {
        onStep?.(done + failed, items.length)
        try { await fn(item); done++ }
        catch (error) {
            if (/cancel|abort/i.test(String(error?.message))) break
            failed++
            onError?.(item, error)
        }
    }
    return { done, failed }
}
