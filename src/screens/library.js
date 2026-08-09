import { library, loadLibSort, saveLibSort } from '../lib/store.js'
import { buildFeed, unreadTotal, enrichGenres } from '../lib/updates.js'
import { go } from '../lib/router.js'
import { coverImg } from '../lib/cover.js'
import { $, $$, esc } from '../lib/dom.js'
import { relTime } from '../lib/time.js'

const CONT_MAX = 4
// shelves are live genre views, the unshelved chip is a distinct bucket so no genre name can fake it
const UNSHELVED = Symbol('unshelved')

let ui = loadLibSort()
let filterQ = ''
let shelf = null
let wired = false
const newCounts = new Map()

const read = e => e.readCount || 0
const total = e => e.total || 0
const pctOf = e => total(e) ? Math.min(100, Math.round((read(e) / total(e)) * 100)) : 0
const started = e => read(e) > 0 || e.lastN != null
const done = e => total(e) > 0 && read(e) >= total(e)
const resumeN = e => (e.lastN != null ? e.lastN : 1)

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

const cover = (e, ph) => coverImg(e.cover, e.title) || (ph ? `<span>${ph}</span>` : '')

const contTile = e => {
    const pct = pctOf(e)
    return `<div class="ctile" data-slug="${esc(e.slug)}" data-n="${esc(resumeN(e))}">
      <div class="cv">${cover(e, 'COV')}</div>
      <div class="cbd">
        <div class="ti">${esc(e.title)}</div>
        <div class="mt">${esc(read(e))} / ${esc(total(e))}<span class="bar"><span style="width:${pct}%"></span></span>${pct}%</div>
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
    return `<div class="trow" data-slug="${esc(e.slug)}" data-n="${esc(resumeN(e))}">
      <span class="cv">${cover(e, '')}</span>
      <div class="tt"><div class="n">${esc(e.title)}</div><div class="au">${esc(e.author || '')}</div></div>
      <div class="pcell"><span class="bar"><span style="width:${pct}%"></span></span><span class="pct">${pct}%</span></div>
      <span class="chp">${esc(read(e))}/${esc(total(e))}</span>
      ${updCell(e)}
    </div>`
}

function groupByGenre(list) {
    const by = new Map()
    for (const e of list) {
        for (const g of Array.isArray(e.genres) ? e.genres : []) {
            const arr = by.get(g)
            if (arr) arr.push(e)
            else by.set(g, [e])
        }
    }
    return by
}

function render() {
    const all = library()
    $('#count-library').textContent = all.length ? String(all.length) : ''

    // shelves are derived membership views, a series with several genres sits on several shelves
    const byGenre = groupByGenre(all)
    const unshelved = all.filter(e => !(Array.isArray(e.genres) && e.genres.length))

    const bar = $('#shelfbar')
    const showBar = all.length > 0 && byGenre.size > 0
    bar.hidden = !showBar
    if (showBar) {
        const chips = [...byGenre.entries()]
            .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
            .map(([g, arr]) => `<span class="shelfchip${shelf === g ? ' on' : ''}" data-shelf="${esc(g)}" title="series counted per shelf"><span>${esc(g)}</span><span class="ct">${arr.length}</span></span>`)
        if (unshelved.length) chips.push(`<span class="shelfchip${shelf === UNSHELVED ? ' on' : ''}" data-unshelved title="series counted per shelf"><span>Unshelved</span><span class="ct">${unshelved.length}</span></span>`)
        $('#shelfchips').innerHTML = chips.join('')
    }

    // the active shelf may have emptied while away, fall back to All
    if (shelf === UNSHELVED ? !unshelved.length : shelf != null && !byGenre.has(shelf)) shelf = null

    const inProg = all.filter(e => started(e) && !done(e))
    const continueItems = [...inProg].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, CONT_MAX)
    const contSlugs = new Set(continueItems.map(e => e.slug))

    let rows = all.filter(e => !contSlugs.has(e.slug))
    if (shelf === UNSHELVED) rows = rows.filter(e => !(Array.isArray(e.genres) && e.genres.length))
    else if (shelf != null) rows = rows.filter(e => (e.genres || []).includes(shelf))
    const shelfRows = rows
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

    const hd = $('#shelfhd')
    if (shelf === UNSHELVED) { hd.hidden = false; hd.textContent = `Unshelved ${unshelved.length}` }
    else if (shelf != null) { hd.hidden = false; hd.textContent = `${shelf} ${byGenre.get(shelf).length}` }
    else hd.hidden = true

    const table = $('#libtable')
    if (!all.length) table.innerHTML = `<div class="void">nothing in your library yet. find something to read and it shows up here</div>`
    else if (shelf != null && !shelfRows.length) table.innerHTML = `<div class="void">all of it is on the continue rail</div>`
    else if (!rows.length) table.innerHTML = `<div class="void">no matches</div>`
    else table.innerHTML = rows.map(row).join('')
}

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
    go(`#/series/${encodeURIComponent(slug)}`)
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

    $('#shelfchips').addEventListener('click', e => {
        const chip = e.target.closest('.shelfchip')
        if (!chip) return
        const next = chip.dataset.unshelved != null ? UNSHELVED : chip.dataset.shelf
        shelf = shelf === next ? null : next
        render()
    })

    paintSort()
}

export function showLibrary() {
    wire()
    render()
    checkUpdates()
    // a warm background pass backfills genres, the follow write covers freshly followed series instantly
    enrichGenres().then(() => { if (!$('#view-library').hidden) render() })
}
