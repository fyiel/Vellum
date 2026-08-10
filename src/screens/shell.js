import { go } from '../lib/router.js'
import { loadFeel } from '../lib/store.js'
import { $, $$ } from '../lib/dom.js'

const SCHEME_CLASS = { Graphite: '', Ink: 's-ink', Paper: 's-paper', Phosphor: 's-phosphor', Ember: 's-ember' }
const NAV_ROUTE = { library: '#/', discover: '#/discover', manga: '#/manga', watch: '#/watch', updates: '#/updates' }
let wired = false

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

export const setCrumb = text => {
    const c = $('.crumb')
    if (!c) return
    c.className = 'crumb'
    c.innerHTML = '<b id="crumb"></b>'
    c.firstElementChild.textContent = text
}

export function setSeriesCrumb(origin, title, onBack) {
    const c = $('.crumb')
    if (!c) return
    c.className = 'crumb crumb-series'
    c.innerHTML = '<button class="back" type="button" aria-label="Back">‹</button><span class="orig"></span><span class="sl">/</span><b id="crumb"></b>'
    c.querySelector('.orig').textContent = origin
    c.querySelector('#crumb').textContent = title
    c.querySelector('.back').addEventListener('click', onBack)
}

export const setActiveNav = name => $$('.ni').forEach(n => {
    const active = n.dataset.nav === name
    n.classList.toggle('on', active)
    if (active) n.setAttribute('aria-current', 'page')
    else n.removeAttribute('aria-current')
})

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

export function mountShell() {
    applyFeel()
    if (wired) return
    wired = true

    const den = $('#den')
    // mobile: collapse the top bar on scroll-down, reveal on scroll-up or near the top (CSS-gated to touch)
    if (matchMedia('(max-width: 640px) and (pointer: coarse)').matches) {
        let last = 0, hidden = false
        document.addEventListener('scroll', event => {
            const target = event.target
            if (!(target instanceof Element) || !den.contains(target)) return
            if (target.scrollHeight <= target.clientHeight + 1) return
            const y = target.scrollTop
            const dir = y > last + 2 ? 1 : y < last - 2 ? -1 : 0
            last = y
            if (y < 12 || dir < 0) {
                if (hidden) { hidden = false; den.classList.remove('bar-collapsed') }
            } else if (dir > 0 && y > 64 && !hidden) {
                hidden = true; den.classList.add('bar-collapsed')
            }
        }, { passive: true, capture: true })
    }

    const mac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '')
    const sq = $('.sq')
    if (sq && !mac) sq.style.display = 'none'

    $$('.sq .s').forEach(b => b.addEventListener('click', () => winAction(b.dataset.win)))
    $$('.ni').forEach(n => n.addEventListener('click', () => { const r = NAV_ROUTE[n.dataset.nav]; if (r) go(r) }))
}
