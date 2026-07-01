import { apiUrl } from './http.js'

const enc = encodeURIComponent
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const isNu = u => /novelupdates\.com/i.test(u || '')
const isTauri = () => !!window.__TAURI_INTERNALS__
const placeholder = u => !u || /noimagemid/i.test(u)
const resolver = title => apiUrl(`/read/api/cover?t=${enc(title)}`)

// on desktop a novelupdates cover goes through the nucover native proxy (it holds the cloudflare clearance
// and dodges corp), retryable via data-nu once the clearance is warm. everywhere else it cannot load, so we
// go straight to the baka then novelfire resolver. any cover falls back to that resolver on error
export function coverImg(url, title) {
    const fb = title ? resolver(title) : ''
    let src = placeholder(url) ? fb : url
    let nu = ''
    if (isNu(url) && !placeholder(url)) {
        if (isTauri()) { src = `nucover://cover/?u=${enc(url)}`; nu = ` data-nu="${esc(src)}"` }
        else src = fb
    }
    if (!src) return ''
    const cf = fb && fb !== src ? ` data-cf="${esc(fb)}"` : ''
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
