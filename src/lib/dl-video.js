import { getVideoPlayback, videoAssetUrl } from './video-api.js'
import { rawFetch } from './http.js'
import { dlEntry, dlPath, dlRead, dlRegister, dlUnregister, dlWriter } from './downloads.js'
import { isMaster, looksFragmentedMp4, parseMaster, parseMedia, pickVariant, resolveUri, segmentIv } from './hls-dl.js'

// in-flight downloads: `${key}:${id}` -> { done, total, ctrl }
const active = new Map()
const listeners = new Set()
const notify = () => listeners.forEach(fn => { try { fn() } catch {} })
export const onVideoDl = fn => { listeners.add(fn); return () => listeners.delete(fn) }
export const videoDlActive = (key, id) => active.get(`${key}:${id}`) || null
export const videoDlEntry = (key, id) => dlEntry('video', key, id)

const HLS_TYPES = ['application/x-mpegURL', 'application/vnd.apple.mpegurl']

// playback sources may be app-relative proxy paths (/read/api/...); fetch and playlist
// resolution both need a fully-qualified URL
const absolute = url => new URL(url, location.href).href

// a hung segment fetch must fail, not stall the download forever
const withTimeout = signal => AbortSignal.any([signal, AbortSignal.timeout(30_000)])

async function fetchBytes(url, signal) {
    const response = await rawFetch(url, { signal: withTimeout(signal) })
    if (!response.ok) throw new Error(`http ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
}

// straight file download with byte-level progress
async function downloadFile(url, writer, progress, signal) {
    const response = await rawFetch(url, { signal: withTimeout(signal) })
    if (!response.ok || !response.body) throw new Error(`http ${response.status}`)
    progress.total = Number(response.headers.get('content-length')) || 0
    const reader = response.body.getReader()
    let size = 0
    for (;;) {
        if (signal.aborted) throw new Error('download cancelled')
        const { done, value } = await reader.read()
        if (done) break
        await writer.write(value)
        size += value.byteLength
        progress.done = size
        notify()
    }
    return size
}

async function aesKey(uri, playlistUrl, signal, cache) {
    const url = resolveUri(playlistUrl, uri)
    if (!cache.has(url)) {
        const bytes = await fetchBytes(url, signal)
        cache.set(url, await crypto.subtle.importKey('raw', bytes, 'AES-CBC', false, ['decrypt']))
    }
    return cache.get(url)
}

async function downloadHls(url, writer, progress, signal) {
    const playlistText = async playlistUrl => (await rawFetch(playlistUrl, { signal: withTimeout(signal) })).text()
    let playlistUrl = url
    let text = await playlistText(playlistUrl)
    if (isMaster(text)) {
        const variant = pickVariant(parseMaster(text))
        if (!variant) throw new Error('no playable variant in stream playlist')
        playlistUrl = resolveUri(url, variant.uri)
        text = await playlistText(playlistUrl)
    }
    const { init, segments } = parseMedia(text)
    if (!segments.length) throw new Error('stream playlist is empty')
    const encrypted = segments[0].key
    if (encrypted && encrypted.method !== 'AES-128') throw new Error(`${encrypted.method} encrypted streams can't be downloaded`)

    // TS segments get remuxed to a single mp4; fMP4 segments concatenate as-is
    const remux = !looksFragmentedMp4(init, segments[0].uri)
    let transmuxer = null
    let initWritten = false
    if (remux) {
        const { default: muxjs } = await import('mux.js')
        transmuxer = new muxjs.mp4.Transmuxer()
        const queue = []
        transmuxer.on('data', segment => {
            if (!initWritten && segment.initSegment) { queue.push(segment.initSegment); initWritten = true }
            if (segment.data?.byteLength) queue.push(segment.data)
        })
        transmuxer.drain = async () => {
            while (queue.length) { const chunk = queue.shift(); await writer.write(chunk); progress.bytes += chunk.byteLength }
        }
    }

    let size = 0
    progress.done = 0
    progress.total = segments.length
    const keyCache = new Map()
    if (init) {
        const bytes = await fetchBytes(resolveUri(playlistUrl, init), signal)
        await writer.write(bytes)
        size += bytes.byteLength
    }
    for (const segment of segments) {
        if (signal.aborted) throw new Error('download cancelled')
        let bytes = await fetchBytes(resolveUri(playlistUrl, segment.uri), signal)
        if (segment.key) {
            const key = await aesKey(segment.key.uri, playlistUrl, signal, keyCache)
            bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: segmentIv(segment.key, segment.sequence) }, key, bytes))
        }
        if (remux) {
            transmuxer.push(bytes)
            transmuxer.flush()
            await transmuxer.drain()
            size = progress.bytes
        } else {
            await writer.write(bytes)
            size += bytes.byteLength
        }
        progress.done++
        notify()
    }
    return size
}

export async function downloadVideoEpisode(key, id, meta = {}) {
    const tag = `${key}:${id}`
    if (active.has(tag) || dlEntry('video', key, id)) return
    const ctrl = new AbortController()
    const progress = { done: 0, total: 0, bytes: 0, ctrl }
    active.set(tag, progress)
    notify()
    const writer = await dlWriter(dlPath.video(key, id))
    try {
        const playback = await getVideoPlayback(key, id, { signal: ctrl.signal })
        const direct = playback.sources.filter(source => source.kind === 'direct')
        const file = direct.find(source => ['video/mp4', 'video/webm'].includes(source.type))
        const hls = direct.find(source => HLS_TYPES.includes(source.type))
        let size
        if (file) size = await downloadFile(absolute(videoAssetUrl(file.url)), writer, progress, ctrl.signal)
        else if (hls) size = await downloadHls(absolute(videoAssetUrl(hls.url)), writer, progress, ctrl.signal)
        else throw new Error('this provider has no downloadable stream')
        await writer.close()
        dlRegister({ kind: 'video', key, id, title: meta.title, label: meta.label, size })
    } catch (error) {
        await writer.abort()
        throw error
    } finally {
        active.delete(tag)
        notify()
    }
}

export function cancelVideoDownload(key, id) {
    active.get(`${key}:${id}`)?.ctrl.abort()
}

export async function deleteVideoDownload(key, id) {
    cancelVideoDownload(key, id)
    await dlUnregister('video', key, id, dlPath.video(key, id))
}

export async function loadDownloadedVideoUrl(key, id) {
    if (!dlEntry('video', key, id)) return null
    const blob = await dlRead(dlPath.video(key, id))
    if (!blob || !blob.size) return null
    return URL.createObjectURL(blob)
}
