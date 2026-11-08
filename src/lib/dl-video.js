import { getVideoPlayback, videoAssetUrl } from './video-api.js'
import { raceAbort, rawFetch } from './http.js'
import { dlEntry, dlPath, dlRead, dlRegister, dlUnregister, dlWriter } from './downloads.js'
import { isMaster, looksFragmentedMp4, parseMaster, parseMedia, pickVariant, resolveUri, segmentIv } from './hls-dl.js'

// in-flight downloads: `${key}:${id}` -> { done, total, ctrl, finished }
const active = new Map()
const listeners = new Set()
const notify = () => listeners.forEach(fn => { try { fn() } catch {} })
export const onVideoDl = fn => { listeners.add(fn); return () => listeners.delete(fn) }
export const videoDlActive = (key, id) => active.get(`${key}:${id}`) || null
export const videoDlEntry = (key, id) => dlEntry('video', key, id)

const HLS_TYPES = ['application/x-mpegURL', 'application/vnd.apple.mpegurl']
const HLS_PREFETCH = 4

// playback sources may be app-relative proxy paths (/read/api/...); fetch and playlist
// resolution both need a fully-qualified URL
const absolute = url => new URL(url, location.href).href

// a hung segment fetch must fail, not stall the download forever
const withTimeout = signal => AbortSignal.any([signal, AbortSignal.timeout(30_000)])

async function fetchBytes(url, signal, byteRange) {
    const headers = byteRange ? { Range: `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}` } : undefined
    const requestSignal = withTimeout(signal)
    const response = await raceAbort(rawFetch(url, { signal: requestSignal, headers }), requestSignal)
    if (!response.ok) throw new Error(`http ${response.status}`)
    if (byteRange && response.status !== 206) throw new Error('HLS byte range request was ignored')
    const bytes = new Uint8Array(await raceAbort(response.arrayBuffer(), requestSignal))
    if (byteRange) {
        const contentRange = response.headers.get('content-range')
        const match = contentRange && /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i.exec(contentRange)
        if (bytes.length !== byteRange.length || !match
            || Number(match[1]) !== byteRange.offset
            || Number(match[2]) !== byteRange.offset + byteRange.length - 1) {
            throw new Error('invalid HLS byte range response')
        }
    }
    return bytes
}

// straight file download with byte-level progress
async function downloadFile(url, writer, progress, signal) {
    // A whole episode commonly takes more than 30 seconds. Bound periods without
    // network progress, not the total transfer, and pause the clock for disk writes.
    const ctrl = new AbortController()
    const onAbort = () => ctrl.abort(signal.reason)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    let timer
    const arm = () => {
        clearTimeout(timer)
        timer = setTimeout(() => ctrl.abort(new Error('download timed out')), 30_000)
    }
    let reader
    let completed = false
    try {
        arm()
        const response = await raceAbort(rawFetch(url, { signal: ctrl.signal }), ctrl.signal)
        if (!response.ok || !response.body) throw new Error(`http ${response.status}`)
        const declaredSize = Number(response.headers.get('content-length')) || 0
        progress.total = declaredSize
        reader = response.body.getReader()
        let size = 0
        for (;;) {
            if (signal.aborted) throw new Error('download cancelled')
            arm()
            const { done, value } = await raceAbort(reader.read(), ctrl.signal)
            clearTimeout(timer)
            if (done) { completed = true; break }
            await writer.write(value)
            size += value.byteLength
            progress.done = size
            notify()
        }
        // A cleanly closed stream can still be short. Do not register a broken
        // offline episode when the server declared how many bytes it would send.
        const encoding = response.headers.get('content-encoding')?.toLowerCase()
        if (Number.isSafeInteger(declaredSize) && declaredSize > 0
            && (!encoding || encoding === 'identity') && size !== declaredSize) {
            throw new Error('incomplete video download')
        }
        return size
    } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        // Cancellation itself may never settle for a non-cooperative stream.
        if (!completed) reader?.cancel().catch(() => {})
        reader?.releaseLock()
    }
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
    const playlistText = async playlistUrl => {
        const requestSignal = withTimeout(signal)
        const response = await raceAbort(rawFetch(playlistUrl, { signal: requestSignal }), requestSignal)
        if (!response.ok) throw new Error(`http ${response.status}`)
        return raceAbort(response.text(), requestSignal)
    }
    let playlistUrl = url
    let text = await playlistText(playlistUrl)
    if (isMaster(text)) {
        const variant = pickVariant(parseMaster(text))
        if (!variant) throw new Error('no playable variant in stream playlist')
        playlistUrl = resolveUri(url, variant.uri)
        text = await playlistText(playlistUrl)
    }
    const { init, segments, maps } = parseMedia(text)
    if (!segments.length) throw new Error('stream playlist is empty')
    // The encryption method can change anywhere in a media playlist. Validate
    // the whole playlist before writing bytes so unsupported methods never
    // produce a seemingly successful but unplayable offline copy.
    const unsupported = segments.find(({ key }) => key && key.method !== 'AES-128')?.key
        || maps.find(({ key }) => key && key.method !== 'AES-128')?.key
    if (unsupported) throw new Error(`${unsupported.method} encrypted streams can't be downloaded`)

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
    let nextMap = 0
    const prefetchCtrl = new AbortController()
    const prefetchSignal = AbortSignal.any([signal, prefetchCtrl.signal])
    const pending = new Map()
    let nextFetch = 0
    const queue = index => {
        // Preserve the map boundary: fetch an initialization section before
        // requesting fragments that use it. Only four fragment buffers are held.
        const boundary = maps[nextMap]?.at ?? segments.length
        while (nextFetch < boundary && nextFetch - index < HLS_PREFETCH) {
            const part = segments[nextFetch]
            pending.set(nextFetch++, fetchBytes(resolveUri(playlistUrl, part.uri), prefetchSignal, part.byteRange)
                .then(bytes => ({ bytes }), error => ({ error })))
        }
    }
    try {
        for (let index = 0; index < segments.length; index++) {
            const segment = segments[index]
            if (signal.aborted) throw new Error('download cancelled')
            // Initialization sections belong immediately before the first media
            // segment that uses them; a playlist can change maps mid-stream.
            if (maps[nextMap]?.at === index) {
                const map = maps[nextMap++]
                let bytes = await fetchBytes(resolveUri(playlistUrl, map.uri), signal, map.byteRange)
                if (map.key) {
                    if (map.key.method !== 'AES-128') throw new Error(`${map.key.method} encrypted streams can't be downloaded`)
                    if (!map.key.iv) throw new Error('encrypted HLS initialization section requires an IV')
                    const key = await aesKey(map.key.uri, playlistUrl, signal, keyCache)
                    bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: segmentIv(map.key, 0) }, key, bytes))
                }
                await writer.write(bytes)
                size += bytes.byteLength
            }
            queue(index)
            const result = await pending.get(index)
            pending.delete(index)
            if (result.error) throw result.error
            if (signal.aborted) throw new Error('download cancelled')
            let bytes = result.bytes
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
    } finally {
        // A late fetch must never keep running after the job removes its file.
        prefetchCtrl.abort()
        await Promise.allSettled(pending.values())
    }
    return size
}

export async function downloadVideoEpisode(key, id, meta = {}) {
    const tag = `${key}:${id}`
    if (active.has(tag) || dlEntry('video', key, id)) return
    const ctrl = new AbortController()
    let finish
    const finished = new Promise(resolve => { finish = resolve })
    const progress = { done: 0, total: 0, bytes: 0, ctrl, finished }
    active.set(tag, progress)
    notify()
    let writer
    try {
        writer = await dlWriter(dlPath.video(key, id))
        const playback = await getVideoPlayback(key, id, { signal: ctrl.signal })
        const direct = playback.sources.filter(source => source.kind === 'direct')
        const file = direct.find(source => ['video/mp4', 'video/webm'].includes(source.type))
        const hls = direct.find(source => HLS_TYPES.includes(source.type))
        let size
        if (file) size = await downloadFile(absolute(videoAssetUrl(file.url)), writer, progress, ctrl.signal)
        else if (hls) size = await downloadHls(absolute(videoAssetUrl(hls.url)), writer, progress, ctrl.signal)
        else throw new Error('this provider has no downloadable stream')
        if (ctrl.signal.aborted) throw new Error('download cancelled')
        // A successful HTTP response can contain no media. Do not register a
        // file that the offline player will immediately reject as empty.
        if (!size) throw new Error('empty video download')
        await writer.close()
        if (ctrl.signal.aborted) throw new Error('download cancelled')
        dlRegister({ kind: 'video', key, id, title: meta.title, label: meta.label, mediaKind: meta.mediaKind, mime: file?.type || 'video/mp4', size })
    } catch (error) {
        await writer?.abort().catch(() => {})
        throw error
    } finally {
        active.delete(tag)
        finish()
        notify()
    }
}

export function cancelVideoDownload(key, id) {
    active.get(`${key}:${id}`)?.ctrl.abort()
}

export async function deleteVideoDownload(key, id) {
    const pending = videoDlActive(key, id)?.finished
    cancelVideoDownload(key, id)
    if (pending) await pending
    await dlUnregister('video', key, id, dlPath.video(key, id))
}

export async function loadDownloadedVideoUrl(key, id) {
    const entry = dlEntry('video', key, id)
    if (!entry) return null
    const blob = await dlRead(dlPath.video(key, id))
    if (!blob || !blob.size) return null
    // The persistent path predates WebM support and ends in .mp4. OPFS infers
    // File.type from that suffix, so preserve the actual downloaded format here.
    // Older registry entries have no mime field and retain their prior MP4 behavior.
    return URL.createObjectURL(new Blob([blob], { type: entry.mime === 'video/webm' ? 'video/webm' : 'video/mp4' }))
}
