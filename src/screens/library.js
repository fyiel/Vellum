import { library, loadLibSort, saveLibSort, loadCollections, saveCollections, newCollectionId, collectionNameTaken } from '../lib/store.js'
import { buildFeed, unreadTotal } from '../lib/updates.js'
import { go } from '../lib/router.js'
import { coverImg } from '../lib/cover.js'
import { $, $$, esc } from '../lib/dom.js'
import { relTime } from '../lib/time.js'
import { openShelfPicker } from '../lib/shelves.js'

const CONT_MAX = 4
const NAME_MAX = 40

let ui = loadLibSort()
let filterQ = ''
let wired = false
let activeShelf = null
let ren = null // { input, span } while a shelf rename input is open
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
      <button class="shelfadd" data-slug="${esc(e.slug)}" title="Add to shelves">+</button>
    </div>`
}

const shelfMsg = text => {
    const m = $('#shelfmsg')
    if (m) m.textContent = text || ''
}

function render() {
    const all = library()
    $('#count-library').textContent = all.length ? String(all.length) : ''

    const contLab = $('#cont-lab'), cont = $('#continue'), head = $('#shelfhead')
    const table = $('#libtable')

    // shelf view: the continue rail is an All-view feature, hide it here
    const sh = activeShelf ? loadCollections()[activeShelf] : null
    if (sh) {
        contLab.style.display = 'none'
        cont.style.display = 'none'

        const live = new Set(sh.slugs)
        const members = all.filter(e => live.has(e.slug))
        const stale = sh.slugs.length - members.length

        let rows = members
        if (filterQ) {
            const f = filterQ.toLowerCase()
            rows = rows.filter(e => (e.title || '').toLowerCase().includes(f) || (e.author || '').toLowerCase().includes(f))
        }
        rows = sortEntries(rows)

        head.hidden = false
        // a rename input may currently sit in place of the name span, leave it alone
        const nameEl = $('#shelfname'), countEl = $('#shelfcount')
        if (nameEl) nameEl.textContent = sh.name
        if (countEl) countEl.textContent = `${members.length} series`

        let body
        if (!members.length) {
            body = stale > 0
                ? `<div class="void">every series in this shelf is no longer in your library</div>`
                : filterQ
                    ? `<div class="void">no matches</div>`
                    : `<div class="void">this shelf is empty. add series from a series page or with &ldquo;+&rdquo; on a library row</div>`
        } else if (!rows.length) {
            body = `<div class="void">no matches</div>`
        } else {
            body = rows.map(row).join('')
        }
        // eviction never removes membership, surface the difference with a one-tap clean up
        if (stale > 0) body += `<div class="recon" title="Remove them from this shelf">${stale} series no longer in your library &middot; review</div>`
        table.innerHTML = body
        return
    }

    head.hidden = true

    const inProg = all.filter(e => started(e) && !done(e))
    const continueItems = [...inProg].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, CONT_MAX)
    const contSlugs = new Set(continueItems.map(e => e.slug))

    let rows = all.filter(e => !contSlugs.has(e.slug))
    if (filterQ) {
        const f = filterQ.toLowerCase()
        rows = rows.filter(e => (e.title || '').toLowerCase().includes(f) || (e.author || '').toLowerCase().includes(f))
    }
    rows = sortEntries(rows)

    const showCont = continueItems.length > 0
    contLab.style.display = showCont ? '' : 'none'
    cont.style.display = showCont ? '' : 'none'
    cont.innerHTML = showCont ? continueItems.map(contTile).join('') : ''

    if (!all.length) table.innerHTML = `<div class="void">nothing in your library yet. find something to read and it shows up here</div>`
    else if (!rows.length) table.innerHTML = `<div class="void">no matches</div>`
    else table.innerHTML = rows.map(row).join('')
}

// chip counts are live intersections with the library, not raw membership
function paintChips() {
    const all = library()
    const live = new Set(all.map(e => e.slug))
    const strip = $('#shelfstrip')
    let html = `<span class="chip${activeShelf ? '' : ' on'}" data-shelf="">All<span class="sc">${all.length}</span></span>`
    for (const [id, c] of Object.entries(loadCollections())) {
        const n = c.slugs.filter(s => live.has(s)).length
        html += `<span class="chip${activeShelf === id ? ' on' : ''}" data-shelf="${esc(id)}">${esc(c.name)}<span class="sc">${n}</span></span>`
    }
    html += `<span class="chip new" id="newshelf">+ New shelf</span>`
    strip.innerHTML = html
}

function startNewShelf() {
    const pill = $('#newshelf')
    if (!pill) return
    const input = document.createElement('input')
    input.className = 'shelfinput'
    input.placeholder = 'Shelf name'
    input.maxLength = NAME_MAX
    pill.replaceWith(input)
    input.focus()
    let done = false

    const commit = () => {
        if (done) return
        const name = input.value.trim()
        if (!name) {
            done = true
            paintChips()
            return
        }
        if (collectionNameTaken(name)) {
            input.classList.add('bad')
            shelfMsg('a shelf with that name already exists')
            input.focus()
            return
        }
        done = true
        const id = newCollectionId()
        const colls = loadCollections()
        colls[id] = { name, slugs: [] }
        saveCollections(colls)
        paintChips()
        go(`#/shelf/${encodeURIComponent(id)}`)
    }

    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault()
            commit()
        }
        else if (e.key === 'Escape') {
            done = true
            paintChips()
        }
    })
    input.addEventListener('input', () => {
        input.classList.remove('bad')
        shelfMsg('')
    })
    input.addEventListener('blur', commit)
}

const closeRename = () => {
    if (ren) {
        ren.input.replaceWith(ren.span)
        ren = null
    }
}

function startRename() {
    const nameEl = $('#shelfname')
    if (!nameEl || ren) return
    const sh = activeShelf ? loadCollections()[activeShelf] : null
    if (!sh) return

    const input = document.createElement('input')
    input.className = 'shelfinput'
    input.value = sh.name
    input.maxLength = NAME_MAX
    nameEl.replaceWith(input)
    ren = { input, span: nameEl }
    input.focus()
    input.select()

    const commit = () => {
        if (!ren) return
        const name = input.value.trim()
        if (!name) {
            closeRename()
            render()
            return
        }
        if (collectionNameTaken(name, activeShelf)) {
            input.classList.add('bad')
            shelfMsg('a shelf with that name already exists')
            input.focus()
            return
        }
        const colls = loadCollections()
        colls[activeShelf].name = name
        saveCollections(colls)
        closeRename()
        render()
        paintChips()
    }

    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault()
            commit()
        }
        else if (e.key === 'Escape') {
            closeRename()
            render()
        }
    })
    input.addEventListener('input', () => {
        input.classList.remove('bad')
        shelfMsg('')
    })
    input.addEventListener('blur', commit)
}

function deleteShelf() {
    closeRename()
    const colls = loadCollections()
    if (!colls[activeShelf]) return
    delete colls[activeShelf]
    saveCollections(colls)
    go('#/')
}

// one-tap reconcile: drop the stale memberships the shelf can no longer show
function pruneStale() {
    const colls = loadCollections()
    const sh = colls[activeShelf]
    if (!sh) return
    const live = new Set(library().map(e => e.slug))
    sh.slugs = sh.slugs.filter(s => live.has(s))
    saveCollections(colls)
    render()
    paintChips()
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
    $('#libtable').addEventListener('click', e => {
        const add = e.target.closest('.shelfadd')
        if (add) {
            e.stopPropagation()
            openShelfPicker(add.dataset.slug, add)
            return
        }
        if (e.target.closest('.recon')) return pruneStale()
        const r = e.target.closest('.trow')
        if (r) openEntry(r)
    })

    $('#shelfstrip').addEventListener('click', e => {
        const chip = e.target.closest('.chip[data-shelf]')
        if (chip) {
            go(chip.dataset.shelf ? `#/shelf/${encodeURIComponent(chip.dataset.shelf)}` : '#/')
            return
        }
        if (e.target.closest('#newshelf')) startNewShelf()
    })

    $('#shelfhead').addEventListener('click', e => {
        if (e.target.closest('#shelfrename')) return startRename()
        if (e.target.closest('#shelfdel')) return deleteShelf()
    })

    // membership changed from the picker (library rows or the series page), repaint live views
    window.addEventListener('vellum:shelves', () => {
        render()
        paintChips()
    })

    paintSort()
}

export function showLibrary(shelfId = null) {
    wire()
    closeRename()
    activeShelf = shelfId && loadCollections()[shelfId] ? shelfId : null
    shelfMsg('')
    render()
    paintChips()
    checkUpdates()
}
