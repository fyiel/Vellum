/*
KissKH subtitle tracks: cue text lines are AES-128-CBC-encrypted base64 blobs inside an SRT
container. The kisskh.co SPA decrypts them in the browser (scripts.js a1/a2/a3, dispatched on
the file extension; a2's iv is mutated at bundle bootstrap — the value here is the real one).
The sub CDN ASN-blocks the API host (Cloudflare 1005) but allows client egress, so the fetch
and the decrypt both happen here, producing a same-origin blob: URL for the <track> element.
*/
const KEYS = {
    txt: ['8056483646328763', '6852612370185273'],
    txt1: ['AmSmZVcH93UQUezi', 'ReBKWW8cqdjPEnF6'],
}
const FALLBACK = ['sWODXX04QRTkHdlZ', '8pwhapJeC4hrS9hO']
const TIMING = /^\d{1,2}:\d{2}:\d{2},\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2},\d{1,3}/
const utf8 = new TextEncoder()
const text = new TextDecoder()
const b64 = line => Uint8Array.from(atob(line.padEnd(Math.ceil(line.length / 4) * 4, '=')), c => c.charCodeAt(0))

export async function kissSubToVtt(body, url, subtle = globalThis.crypto?.subtle) {
    if (!subtle) return ''
    const ext = url.split('.').pop()?.split(/[#?]/)[0].toLowerCase() || ''
    const [key, iv] = KEYS[ext] || FALLBACK
    const aesKey = await subtle.importKey('raw', utf8.encode(key), { name: 'AES-CBC' }, false, ['decrypt'])
    const decrypt = async line => {
        try { return text.decode(await subtle.decrypt({ name: 'AES-CBC', iv: utf8.encode(iv) }, aesKey, b64(line))) } catch { return null }
    }
    const out = ['WEBVTT', '']
    for (const block of body.replace(/\r/g, '').split(/\n{2,}/)) {
        const lines = block.split('\n')
        const at = lines.findIndex(line => TIMING.test(line.trim()))
        if (at < 0) continue
        const timing = lines[at].trim().replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, (_, t, ms) => `${t}.${ms.padEnd(3, '0')}`)
        const cues = (await Promise.all(lines.slice(at + 1).map(line => decrypt(line.trim())))).filter(Boolean)
        if (!cues.length) continue
        out.push(timing, ...cues, '')
    }
    return out.join('\n')
}

// fetch an encrypted track and mint a blob: URL usable as a <track> src; null on any failure
export async function encryptedTrackUrl(url, fetchImpl = fetch) {
    const response = await fetchImpl(url)
    if (!response.ok) return null
    const vtt = await kissSubToVtt(await response.text(), url)
    return vtt.includes('-->') ? URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })) : null
}
