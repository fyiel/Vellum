import { library, loadCollections, saveCollections } from './store.js'
import { esc } from './dom.js'

let el = null
let wired = false

const close = () => { if (el) el.hidden = true }

function ensureEl() {
    if (el) return el
    el = document.createElement('div')
    el.className = 'spop'
    el.hidden = true
    document.body.appendChild(el)
    return el
}

function wire() {
    if (wired) return
    wired = true

    document.addEventListener('mousedown', e => {
        if (el && !el.hidden && !el.contains(e.target)) close()
    }, true)
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close() })
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('hashchange', close)

    const pop = ensureEl()
    pop.addEventListener('change', e => {
        const box = e.target.closest('input[data-shelf]')
        if (!box) return
        const slug = pop.dataset.slug
        if (!slug) return
        const colls = loadCollections()
        const c = colls[box.dataset.shelf]
        if (!c) return
        if (box.checked) { if (!c.slugs.includes(slug)) c.slugs.push(slug) }
        else c.slugs = c.slugs.filter(s => s !== slug)
        saveCollections(colls)
        window.dispatchEvent(new CustomEvent('vellum:shelves'))
    })
}

// count of shelves holding a slug, live against the current collections
export const shelfCountFor = slug => {
    if (!slug) return 0
    return Object.values(loadCollections()).filter(c => c.slugs.includes(slug)).length
}

export function openShelfPicker(slug, anchor) {
    wire()
    const pop = ensureEl()
    const entries = Object.entries(loadCollections())
    const list = entries.length
        ? entries.map(([id, c]) => {
            const on = c.slugs.includes(slug)
            return `<label class="sprow"><input type="checkbox" data-shelf="${esc(id)}"${on ? ' checked' : ''}><span>${esc(c.name)}</span></label>`
        }).join('')
        : `<div class="spempty">no shelves yet — create one with “+ New shelf” above the library</div>`
    pop.innerHTML = `<div class="sphd">Shelves</div>${list}`
    pop.dataset.slug = slug
    pop.hidden = false

    const r = anchor.getBoundingClientRect()
    const pr = pop.getBoundingClientRect()
    let top = r.bottom + 6
    if (top + pr.height > innerHeight - 8) top = Math.max(8, r.top - pr.height - 6)
    const left = Math.max(8, Math.min(r.left, innerWidth - pr.width - 8))
    pop.style.top = `${top}px`
    pop.style.left = `${left}px`
}
