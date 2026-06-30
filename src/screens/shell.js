import { go } from '../lib/router.js'
import { loadFeel } from '../lib/store.js'

// the shared shell every browse screen sits in. title bar, sidebar, the feel controls and the window
// controls all live here once. each screen just swaps its own view into the main column

const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]

const SCHEME_CLASS = { Graphite: '', Ink: 's-ink', Paper: 's-paper', Phosphor: 's-phosphor', Ember: 's-ember' }
const NAV_ROUTE = { library: '#/', discover: '#/discover', updates: '#/updates' }
let wired = false

// scheme and density are classes on the den root. read the resolved bg back out so the window chrome
// matches the active theme without hardcoding any colour here
export function applyFeel() {
    const den = $('#den')
    const f = loadFeel()
    den.classList.remove('s-ink', 's-paper', 's-phosphor', 's-ember', 'd-compact', 'd-dense')
    const sc = SCHEME_CLASS[f.scheme] || ''
    if (sc) den.classList.add(sc)
    if (f.density === 'compact') den.classList.add('d-compact')
    if (f.density === 'dense') den.classList.add('d-dense')

    const bg = getComputedStyle(den).getPropertyValue('--bg').trim()
    if (bg) {
        document.documentElement.style.background = bg
        const meta = $('meta[name=theme-color]')
        if (meta) meta.content = bg
    }
}

// rebuild the whole crumb so a series breadcrumb is wiped clean when a browse screen takes over again
export const setCrumb = text => {
    const c = $('.crumb')
    if (!c) return
    c.className = 'crumb'
    c.innerHTML = '<b id="crumb"></b>'
    c.firstElementChild.textContent = text
}

// the series screen owns a richer crumb, a back chevron then origin, a separator and the series title
export function setSeriesCrumb(origin, title, onBack) {
    const c = $('.crumb')
    if (!c) return
    c.className = 'crumb crumb-series'
    c.innerHTML = '<span class="back" title="Back">‹</span><span class="orig"></span><span class="sl">/</span><b id="crumb"></b>'
    c.querySelector('.orig').textContent = origin
    c.querySelector('#crumb').textContent = title
    c.querySelector('.back').addEventListener('click', onBack)
}

export const setActiveNav = name => $$('.ni').forEach(n => n.classList.toggle('on', n.dataset.nav === name))

async function winAction(action) {
    if (!window.__TAURI_INTERNALS__) return
    try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const w = getCurrentWindow()
        if (action === 'close') w.close()
        if (action === 'min') w.minimize()
        if (action === 'zoom') w.toggleMaximize()
    } catch {}
}

// applies the feel every route and wires the chrome once
export function mountShell() {
    applyFeel()
    if (wired) return
    wired = true

    $$('.sq .s').forEach(b => b.addEventListener('click', () => winAction(b.dataset.win)))
    $$('.ni').forEach(n => n.addEventListener('click', () => { const r = NAV_ROUTE[n.dataset.nav]; if (r) go(r) }))
}
