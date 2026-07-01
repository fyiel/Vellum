import { apiUrl } from './http.js'

const enc = encodeURIComponent
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const isNu = u => /novelupdates\.com/i.test(u || '')
const placeholder = u => !u || /noimagemid/i.test(u)
const resolver = title => apiUrl(`/read/api/cover?t=${enc(title)}`)

// try the native cover first (novelupdates loads once the desktop webview holds a clearance), fall back to
// the baka then novelfire resolver on failure. nu covers carry their url in data-nu so they can retry once
// the clearance is warm
export function coverImg(url, title) {
    const fb = title ? resolver(title) : ''
    const src = placeholder(url) ? fb : url
    if (!src) return ''
    const cf = fb && fb !== src ? ` data-cf="${esc(fb)}"` : ''
    const nu = isNu(url) && !placeholder(url) ? ` data-nu="${esc(url)}"` : ''
    return `<img src="${esc(src)}"${cf}${nu} loading="lazy" alt="">`
}

let installed = false
export function installCoverFallback() {
    if (installed) return
    installed = true
    document.addEventListener('error', e => {
        const img = e.target
        if (img?.tagName !== 'IMG' || !(img.dataset.cf || img.dataset.nu)) return
        // one hop to the resolver, then give up quietly so a broken icon never shows over the placeholder
        if (img.dataset.cf && !img.dataset.cfDone) { img.dataset.cfDone = '1'; img.src = img.dataset.cf; return }
        img.style.display = 'none'
    }, true)
}
