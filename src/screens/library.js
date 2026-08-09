import { library, loadLibSort, saveLibSort } from '../lib/store.js'
import { buildFeed, unreadTotal } from '../lib/updates.js'
import { go } from '../lib/router.js'
import { coverImg } from '../lib/cover.js'
import { mountLocalCovers } from '../lib/localbooks.js'
import { $, $$, esc } from '../lib/dom.js'
import { relTime } from '../lib/time.js'

const CONT_MAX = 4

let ui = loadLibSort()
let filterQ = ''
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

const cover = (e, ph) => e.kind === 'local'
  ? `<span class="lcov" data-localcover="${esc(e.slug)}"></span>`
  : coverImg(e.cover, e.title) || (ph ? `<span>${ph}</span>` : '')

const localTag = (e) => e.kind === 'local' ? '<span class="localtag">local</span>' : ''

const contTile = e => {
    const pct = pctOf(e)
    return `<div class="ctile" data-slug="${esc(e.slug)}" data-n="${esc(resumeN(e))}">
      <div class="cv">${cover(e, 'COV')}</div>
      <div class="cbd">
        <div class="ti">${esc(e.title)}</div>
        <div class="mt">${localTag(e)}${esc(read(e))} / ${esc(total(e))}<span class="bar"><span style="width:${pct}%"></span></span>${pct}%</div>
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
      <div class="tt"><div class="n">${esc(e.title)}</div><div class="au">${esc(e.author || '')}${localTag(e)}</div></div>
      <div class="pcell"><span class="bar"><span style="width:${pct}%"></span></span><span class="pct">${pct}%</span></div>
      <span class="chp">${esc(read(e))}/${esc(total(e))}</span>
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

    mountLocalCovers($('#view-library'))
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

async function wire() {
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

    // local epub import: the parser is heavy, load it only when first used
    const { installImportDrops } = await import('./importer.js')
    installImportDrops()
    $('#import-btn').addEventListener('click', async () => {
        const { openImport } = await import('./importer.js')
        openImport()
    })

    paintSort()
}

export async function showLibrary() {
    await wire()
    render()
    checkUpdates()
}
