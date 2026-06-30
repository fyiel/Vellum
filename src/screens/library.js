import { library, loadLibSort, saveLibSort } from '../lib/store.js'
import { buildFeed, unreadTotal } from '../lib/updates.js'
import { go, hashSlug } from '../lib/router.js'

// the desktop library page. renders the continue strip and the sortable, filterable library table from
// whatever sits in localStorage, then quietly checks each title for new chapters in the background

const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const CONT_MAX = 4                 // most recent in progress titles surfaced in the continue strip

let ui = loadLibSort()
let filterQ = ''
let wired = false
const newCounts = new Map()        // slug to count of unread new chapters, filled by the updates pass

// derived view of a library entry
const read = e => e.readCount || 0
const total = e => e.total || 0
const pctOf = e => total(e) ? Math.min(100, Math.round((read(e) / total(e)) * 100)) : 0
const started = e => read(e) > 0 || e.lastN != null
const done = e => total(e) > 0 && read(e) >= total(e)
const resumeN = e => (e.lastN != null ? e.lastN : 1)

function relTime(ts) {
    if (!ts) return ''
    const s = (Date.now() - ts) / 1000
    if (s < 60) return 'now'
    const m = s / 60
    if (m < 60) return `${Math.floor(m)}m`
    const h = m / 60
    if (h < 24) return `${Math.floor(h)}h`
    const d = h / 24
    if (d < 7) return `${Math.floor(d)}d`
    const w = d / 7
    if (w < 5) return `${Math.floor(w)}w`
    const mo = d / 30
    return mo < 12 ? `${Math.floor(mo)}mo` : `${Math.floor(d / 365)}y`
}

function sortEntries(list) {
    const sign = ui.sortDir === 'asc' ? 1 : -1
    const val = e => {
        if (ui.sortKey === 'title') return (e.title || '').toLowerCase()
        if (ui.sortKey === 'progress') return total(e) ? read(e) / total(e) : 0
        if (ui.sortKey === 'unread') return Math.max(0, total(e) - read(e))
        return e.updatedAt || 0
    }
    return [...list].sort((a, b) => {
        const va = val(a), vb = val(b)
        return va < vb ? -sign : va > vb ? sign : 0
    })
}

const cover = (url, ph) =>
    url ? `<img src="${esc(url)}" alt="" loading="lazy">` : (ph ? `<span>${ph}</span>` : '')

const contTile = e => {
    const pct = pctOf(e)
    return `<div class="ctile" data-slug="${esc(e.slug)}" data-n="${resumeN(e)}">
      <div class="cv">${cover(e.cover, 'COV')}</div>
      <div class="cbd">
        <div class="ti">${esc(e.title)}</div>
        <div class="mt">${read(e)} / ${total(e)}<span class="bar"><span style="width:${pct}%"></span></span>${pct}%</div>
      </div>
    </div>`
}

function updCell(e) {
    const nc = newCounts.get(e.slug) || 0
    if (nc > 0) return `<span class="upd"><span class="new">+${nc}</span></span>`
    if (done(e)) return `<span class="upd done">done</span>`
    return `<span class="upd">${esc(relTime(e.updatedAt))}</span>`
}

const row = e => {
    const pct = pctOf(e)
    return `<div class="trow" data-slug="${esc(e.slug)}" data-n="${resumeN(e)}">
      <span class="cv">${cover(e.cover, '')}</span>
      <div class="tt"><div class="n">${esc(e.title)}</div><div class="au">${esc(e.author || '')}</div></div>
      <div class="pcell"><span class="bar"><span style="width:${pct}%"></span></span><span class="pct">${pct}%</span></div>
      <span class="chp">${read(e)}/${total(e)}</span>
      ${updCell(e)}
    </div>`
}

function render() {
    const all = library()
    $('#count-library').textContent = all.length ? String(all.length) : ''

    const inProg = all.filter(e => started(e) && !done(e))
    const continueItems = [...inProg].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, CONT_MAX)
    const contSlugs = new Set(continueItems.map(e => e.slug))

    let rows = all.filter(e => !contSlugs.has(e.slug))
    if (filterQ) {
        const f = filterQ.toLowerCase()
        rows = rows.filter(e => (e.title || '').toLowerCase().includes(f) || (e.author || '').toLowerCase().includes(f))
    }
    rows = sortEntries(rows)

    const contLab = $('#cont-lab'), cont = $('#continue')
    const showCont = continueItems.length > 0
    contLab.style.display = showCont ? '' : 'none'
    cont.style.display = showCont ? '' : 'none'
    cont.innerHTML = showCont ? continueItems.map(contTile).join('') : ''

    const table = $('#libtable')
    if (!all.length) table.innerHTML = `<div class="void">nothing in your library yet. find something to read and it shows up here</div>`
    else if (!rows.length) table.innerHTML = `<div class="void">no matches</div>`
    else table.innerHTML = rows.map(row).join('')
}

// paint the active sort cell and the direction glyph from current state
function paintSort() {
    $$('#seg span[data-sort]').forEach(s => s.classList.toggle('on', s.dataset.sort === ui.sortKey))
    $('#dir').textContent = ui.sortDir === 'asc' ? '▲' : '▼'
}

function setSort(key) {
    if (key === ui.sortKey) ui.sortDir = ui.sortDir === 'asc' ? 'desc' : 'asc'
    else { ui.sortKey = key; ui.sortDir = 'desc' }
    saveLibSort(ui)
    paintSort()
    render()
}

// check every library title for chapters past what was known when last read. cached and stale while
// revalidate so this is cheap on repeat visits, and it updates the row and the sidebar count in place
async function checkUpdates() {
    const feed = await buildFeed()
    newCounts.clear()
    for (const u of feed) if (!u.read && u.newCount > 0) newCounts.set(u.slug, u.newCount)
    $('#count-updates').textContent = unreadTotal(feed) ? String(unreadTotal(feed)) : ''
    render()
}

function openEntry(el) {
    const slug = el.dataset.slug
    if (!slug) return
    go(`#/read/${hashSlug(slug)}/${el.dataset.n || 1}`)
}

function wire() {
    if (wired) return
    wired = true

    $('#seg').addEventListener('click', e => {
        const dir = e.target.closest('.dir')
        if (dir) { ui.sortDir = ui.sortDir === 'asc' ? 'desc' : 'asc'; saveLibSort(ui); paintSort(); render(); return }
        const s = e.target.closest('span[data-sort]')
        if (s) setSort(s.dataset.sort)
    })

    let t
    $('#filter').addEventListener('input', e => {
        clearTimeout(t)
        const v = e.target.value.trim()
        t = setTimeout(() => { filterQ = v; render() }, 200)
    })

    $('#continue').addEventListener('click', e => { const t = e.target.closest('.ctile'); if (t) openEntry(t) })
    $('#libtable').addEventListener('click', e => { const r = e.target.closest('.trow'); if (r) openEntry(r) })

    paintSort()
}

// entry point, called whenever the library route is shown. the shell handles the feel
export function showLibrary() {
    wire()
    render()
    checkUpdates()
}
