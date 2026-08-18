// Downloaded-content store. Two backends behind one interface:
//   desktop (Tauri) — real files under the app data dir via plugin-fs
//   web             — OPFS (origin private file system)
// Everything below deals in app-relative posix paths ("manga/mf_x/123/0"); the
// registry of what is downloaded lives in localStorage so the UI can list it
// without touching the filesystem.

const isTauri = () => !!window.__TAURI_INTERNALS__
const safe = value => encodeURIComponent(String(value))

// ---- paths ----------------------------------------------------------------

export const dlPath = {
    manga: (key, id) => `manga/${safe(key)}/${safe(id)}`,
    mangaPage: (key, id, page) => `${dlPath.manga(key, id)}/${page}`,
    novel: key => `novel/${safe(key)}`,
    novelChapter: (key, n) => `${dlPath.novel(key)}/${n}.json`,
    video: (key, id) => `video/${safe(key)}/${safe(id)}.mp4`,
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
    if (isTauri()) {
        const { fs, baseDir } = await tauri()
        const parent = path.split('/').slice(0, -1).join('/')
        await fs.mkdir(tpath(parent), { baseDir, recursive: true }).catch(() => {})
        const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data
        await fs.writeFile(tpath(path), bytes, { baseDir })
        return
    }
    const parts = path.split('/')
    const dir = await opfsDir(parts.slice(0, -1), true)
    const handle = await dir.getFileHandle(parts.at(-1), { create: true })
    const writable = await handle.createWritable()
    await writable.write(data)
    await writable.close()
}

// incremental writer for large payloads (video): write(chunk) then close(); abort() drops the file
export async function dlWriter(path) {
    if (isTauri()) {
        const { fs, baseDir } = await tauri()
        const parent = path.split('/').slice(0, -1).join('/')
        await fs.mkdir(tpath(parent), { baseDir, recursive: true }).catch(() => {})
        await fs.writeFile(tpath(path), new Uint8Array(0), { baseDir })
        const file = await fs.open(tpath(path), { baseDir, append: true })
        return {
            write: async chunk => file.write(chunk instanceof Blob ? new Uint8Array(await chunk.arrayBuffer()) : chunk),
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
            try { await writable.close() } catch {}
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

// removes a file or a directory subtree; missing paths are fine
export async function dlRemove(path) {
    if (isTauri()) {
        const { fs, baseDir } = await tauri()
        await fs.remove(tpath(path), { baseDir, recursive: true }).catch(() => {})
        return
    }
    try {
        const parts = path.split('/')
        const dir = await opfsDir(parts.slice(0, -1), false)
        await dir.removeEntry(parts.at(-1), { recursive: true })
    } catch {}
}

// ---- registry -------------------------------------------------------------

const NS = 'vellum'
const listeners = new Set()
const load = () => { try { return JSON.parse(localStorage.getItem(`${NS}:dl`)) ?? [] } catch { return [] } }
const save = entries => {
    try { localStorage.setItem(`${NS}:dl`, JSON.stringify(entries)) } catch {}
    listeners.forEach(fn => { try { fn() } catch {} })
}
export const dlListen = fn => { listeners.add(fn); return () => listeners.delete(fn) }

export const dlEntries = () => load()
export const dlEntry = (kind, key, id) => load().find(entry => entry.kind === kind && entry.key === key && entry.id === String(id)) || null

export function dlRegister(entry) {
    const rest = load().filter(item => !(item.kind === entry.kind && item.key === entry.key && item.id === String(entry.id)))
    rest.unshift({ ...entry, id: String(entry.id), at: Date.now() })
    save(rest)
}

// drops the registry row and the stored bytes (path may be a file or a directory)
export async function dlUnregister(kind, key, id, path) {
    save(load().filter(item => !(item.kind === kind && item.key === key && item.id === String(id))))
    if (path) await dlRemove(path)
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
