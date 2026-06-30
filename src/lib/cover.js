import { apiUrl } from './http.js'

const enc = encodeURIComponent
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const placeholder = u => !u || /noimagemid/i.test(u)
const resolver = title => apiUrl(`/read/api/cover?t=${enc(title)}`)

export function coverImg(url, title) {
    const fb = title ? resolver(title) : ''
    const src = placeholder(url) ? fb : url
    if (!src) return ''
    const cf = fb && fb !== src ? ` data-cf="${esc(fb)}"` : ''
    return `<img src="${esc(src)}"${cf} loading="lazy" alt="">`
}

let installed = false
export function installCoverFallback() {
    if (installed) return
    installed = true
    document.addEventListener('error', e => {
        const img = e.target
        if (img?.tagName !== 'IMG' || !img.dataset.cf || img.dataset.cfDone) return
        img.dataset.cfDone = '1'
        img.src = img.dataset.cf
    }, true)
}
