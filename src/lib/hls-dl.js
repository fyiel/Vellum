// minimal HLS playlist parsing for the episode downloader. Pure functions, no DOM/fetch,
// so the node test runner can exercise them directly.

export function parseAttrs(value) {
    const out = {}
    for (const match of String(value).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
        out[match[1]] = match[2].replace(/^"|"$/g, '')
    }
    return out
}

export const isMaster = text => text.includes('#EXT-X-STREAM-INF')

export function parseMaster(text) {
    const lines = String(text).split(/\r?\n/)
    const variants = []
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index].trim()
        if (!line.startsWith('#EXT-X-STREAM-INF:')) continue
        const attrs = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length))
        const uri = (lines[index + 1] || '').trim()
        if (uri && !uri.startsWith('#')) variants.push({ bandwidth: Number(attrs.BANDWIDTH) || 0, uri })
    }
    return variants
}

export const pickVariant = variants =>
    variants.reduce((best, variant) => (variant.bandwidth > (best?.bandwidth ?? -1) ? variant : best), null)

export function parseMedia(text) {
    const lines = String(text).split(/\r?\n/)
    const segments = []
    const maps = []
    let init = null
    let initKey = null
    let key = null
    let sequence = 0
    for (const raw of lines) {
        const line = raw.trim()
        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length)) || 0
        else if (line.startsWith('#EXT-X-MAP:')) {
            const attrs = parseAttrs(line.slice('#EXT-X-MAP:'.length))
            if (attrs.URI) {
                init = attrs.URI
                initKey = key ? { ...key } : null
                const map = { at: segments.length, uri: init, key: initKey }
                // A later map declaration supersedes an earlier one when no
                // media segment has appeared between them.
                if (maps.at(-1)?.at === map.at) maps[maps.length - 1] = map
                else maps.push(map)
            }
        } else if (line.startsWith('#EXT-X-KEY:')) {
            const attrs = parseAttrs(line.slice('#EXT-X-KEY:'.length))
            key = !attrs.METHOD || attrs.METHOD === 'NONE' ? null : { method: attrs.METHOD, uri: attrs.URI, iv: attrs.IV || null }
        } else if (line && !line.startsWith('#')) {
            segments.push({ uri: line, key: key ? { ...key } : null, sequence: sequence + segments.length })
        }
    }
    return { init, initKey, segments, maps }
}

export const resolveUri = (base, uri) => new URL(uri, base).href

// EXT-X-KEY without an IV attribute uses the segment's media sequence as a 128-bit big-endian IV
export function segmentIv(key, sequence) {
    if (key.iv) {
        const value = key.iv.replace(/^0x/i, '')
        if (!/^[0-9a-f]{1,32}$/i.test(value)) throw new Error('invalid AES-128 initialization vector')
        // HLS hexadecimal sequences are integers; short IVs are left-padded to 128 bits.
        const hex = value.padStart(32, '0')
        const bytes = new Uint8Array(16)
        for (let index = 0; index < 16; index++) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2) || '0', 16)
        return bytes
    }
    const bytes = new Uint8Array(16)
    let value = sequence
    for (let index = 15; index >= 0 && value > 0; index--) { bytes[index] = value & 0xff; value = Math.floor(value / 256) }
    return bytes
}

export const looksFragmentedMp4 = (init, firstSegmentUri) =>
    Boolean(init) || /\.(m4s|mp4|cmfv|cmfa)(\?|#|$)/i.test(firstSegmentUri || '')
