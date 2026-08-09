import { library, loadLibSort, saveLibSort } from '../lib/store.js'
import { buildFeed, unreadTotal } from '../lib/updates.js'
import { go, hashSlug } from '../lib/router.js'
import { coverImg } from '../lib/cover.js'
import { $, $$, esc } from '../lib/dom.js'
import { relTime } from '../lib/time.js'

const CONT_MAX = 4

let ui = loadLibSort()
let filterQ = ''
let wired = false
const newCounts = new Map()

const isManga = e => e.kind === 'manga'
const read = e => e.readCount || 0
const total = e => e.total || 0
const pctOf = e => total(e) ? Math.min(100, Math.round((read(e) / total(e)) * 100)) : 0
const started = e => read(e) > 0 || e.lastN != null || e.lastId != null
const done = e => total(e) > 0 && read(e) >= total(e) && (!isManga(e) || !e.pageCount || e.lastPage >= e.pageCount)
const resumeN = e => (e.lastN != null ? e.lastN : 1)
const formatName = value => value ? value[0].toUpperCase() + value.slice(1) : ''
const mangaMeta = e => [formatName(e.format), e.source].filter(Boolean).join(' · ')
const lastRead = e => isManga(e)
    ? [e.lastLabel || 'Chapter', e.pageCount ? `page ${e.lastPage || 1} of ${e.pageCount}` : ''].filter(Boolean).join(' · ')
    : `${read(e)} / ${total(e)}`

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
    return `<div class="ctile" data-slug="${esc(e.slug)}" data-kind="${isManga(e) ? 'manga' : 'novel'}" data-n="${esc(resumeN(e))}" ${e.lastId ? `data-id="${esc(e.lastId)}"` : ''}>
      <div class="cv">${cover(e, 'COV')}</div>
      <div class="cbd">
        <div class="ti">${esc(e.title)}</div>
        ${isManga(e) ? `<div class="cm">${esc(mangaMeta(e))}</div>` : ''}
        <div class="mt"><span class="last-read">${esc(lastRead(e))}</span><span class="bar"><span style="width:${pct}%"></span></span>${pct}%</div>
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
    const meta = isManga(e) ? mangaMeta(e) : e.author || ''
    return `<div class="trow" data-slug="${esc(e.slug)}" data-kind="${isManga(e) ? 'manga' : 'novel'}" data-n="${esc(resumeN(e))}">
      <span class="cv">${cover(e, '')}</span>
      <div class="tt"><div class="n">${esc(e.title)}</div><div class="au">${esc(meta)}</div>${isManga(e) && e.lastLabel ? `<div class="last">Last read ${esc(lastRead(e))}</div>` : ''}</div>
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
        rows = rows.filter(e => [e.title, e.author, e.format, e.source].some(value => (value || '').toLowerCase().includes(f)))
    }
    rows = sortEntries(rows)

    const contLab = $('#cont-lab'), cont = $('#continue')
    const showCont = continueItems.length > 0
    contLab.style.display = showCont ? '' : 'none'
    cont.style.display = showCont ? '' : 'none'
    cont.innerHTML = showCont ? continueItems.map(contTile).join('') : ''

    const table = $('#libtable')
    if (!all.length) table.innerHTML = `<div class="void">nothing in your library yet. find something to read and it shows up here</div>`
    else if (!rows.length && filterQ) table.innerHTML = `<div class="void">no matches</div>`
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
    const { feed } = await buildFeed()
    newCounts.clear()
    for (const u of feed) if (!u.read && u.newCount > 0) newCounts.set(u.slug, u.newCount)
    $('#count-updates').textContent = unreadTotal(feed) ? String(unreadTotal(feed)) : ''
    render()
}

function openEntry(el) {
    const slug = el.dataset.slug
    if (!slug) return
    go(el.dataset.kind === 'manga' ? `#/manga/series/${encodeURIComponent(slug)}` : `#/series/${encodeURIComponent(slug)}`)
}

function continueEntry(el) {
    const slug = el.dataset.slug
    const id = el.dataset.id
    const n = el.dataset.n
    if (slug && el.dataset.kind === 'manga' && id) go(`#/manga/read/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`)
    else if (slug && n) go(`#/read/${hashSlug(slug)}/${n}`)
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

    $('#continue').addEventListener('click', e => { const t = e.target.closest('.ctile'); if (t) continueEntry(t) })
    $('#libtable').addEventListener('click', e => { const r = e.target.closest('.trow'); if (r) openEntry(r) })

    paintSort()
}

export function showLibrary() {
    wire()
    render()
    checkUpdates()
}
