import { searchNovels, getSeries, seriesKey } from '../lib/api.js'
import { go, hashSlug } from '../lib/router.js'
import { library, touchLibrary, dropLibrary, readSet, saveRead, loadUpdLedger } from '../lib/store.js'
import { setRead } from '../lib/updates.js'
import { $, $$, esc } from '../lib/dom.js'

const SEARCH_MIN = 2
const SEARCH_MAX = 8
const DEBOUNCE = 280

const backdrop = $('#palette-backdrop')
const panel = $('#palette')
const input = $('#p-q')
const listEl = $('#p-list')
const railEl = $('#p-rail')

// coarse pointers get no autofocus: the keyboard would pop over the palette
const coarse = window.matchMedia?.('(pointer: coarse)').matches

const followed = slug => library().some(e => e.slug === slug)
const pctOf = e => e.total ? Math.min(100, Math.round(((e.readCount || 0) / e.total) * 100)) : 0
const railButtons = () => $$('button', railEl).filter(b => !b.disabled)

let open = false
let lastFocus = null
let query = ''
let mode = 'idle' // idle | search
let searchDone = false
let searchRows = []
let groups = []
let rows = []
let sel = -1
let searchTimer = null
let searchGen = 0

function buildGroups() {
    const led = loadUpdLedger()
    let unreadTotal = 0
    const newNums = new Map()
    for (const [slug, l] of Object.entries(led)) {
        if (!l.read && l.newNums?.length) {
            newNums.set(slug, l.newNums.length)
            unreadTotal += l.newNums.length
        }
    }

    const libRows = [...library()]
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .map(e => ({
            kind: 'lib',
            slug: e.slug,
            title: e.title || e.slug,
            meta: [e.author, e.total ? `${pctOf(e)}%` : ''].filter(Boolean).join(' · '),
            cover: e.cover,
            author: e.author,
            total: e.total || 0,
            readCount: e.readCount || 0,
            lastN: e.lastN,
            unread: newNums.get(e.slug) || 0,
        }))

    const acts = [
        { kind: 'act', id: 'library', title: 'Library', meta: 'go to your shelf', hash: '#/' },
        { kind: 'act', id: 'discover', title: 'Discover', meta: 'browse every source', hash: '#/discover' },
        { kind: 'act', id: 'updates', title: 'Updates', meta: 'new chapters for followed series', hash: '#/updates', badge: unreadTotal ? `+${unreadTotal} new` : '' },
    ]
    if (unreadTotal > 0) acts.push({ kind: 'act', id: 'markall', title: 'Mark all read', meta: `+${unreadTotal} new chapters` })

    return [
        { label: 'Library', rows: libRows },
        { label: 'Actions', rows: acts },
    ]
}

function rowHtml(r, i) {
    const badge = r.kind === 'lib'
        ? (r.unread > 0 ? `+${esc(r.unread)} new` : '')
        : (r.badge || '')
    return `<div class="prow${i === sel ? ' sel' : ''}" data-i="${i}">
      <div class="pt"><div class="n">${esc(r.title)}</div><div class="m">${esc(r.meta)}</div></div>
      ${badge ? `<span class="new">${badge}</span>` : ''}
    </div>`
}

function renderList() {
    let html = ''
    let i = 0
    for (const g of groups) {
        html += `<div class="plab">${esc(g.label)}</div>`
        if (!g.rows.length) {
            html += `<div class="pvoid">${esc(g.void || 'nothing here')}</div>`
            continue
        }
        for (const r of g.rows) html += rowHtml(r, i++)
    }
    listEl.innerHTML = html
}

function renderRail() {
    const r = rows[sel]
    if (!r || r.kind === 'act') {
        railEl.innerHTML = ''
        return
    }
    const lib = r.kind === 'lib'
    const slug = lib ? r.slug : (r.slug || r.key)
    const total = lib ? r.total : (r.chapters || 0)

    const verbs = []
    verbs.push(lib && r.lastN != null
        ? { act: 'open', label: 'Continue', cls: 'primary' }
        : { act: 'open', label: 'Open', cls: 'primary' })
    verbs.push(followed(slug)
        ? { act: 'follow', label: 'Following', cls: 'on' }
        : { act: 'follow', label: 'Follow' })
    if (total > 0) {
        verbs.push(readSet(slug).size >= total
            ? { act: 'mark', label: 'Mark unread', val: 'unread' }
            : { act: 'mark', label: 'Mark read', val: 'read' })
    } else {
        verbs.push({ act: 'mark', label: 'Mark read', disabled: true })
    }

    railEl.innerHTML = `<div class="plab">Actions</div>` +
        verbs.map(v => `<button class="pverb ${v.cls || ''}" data-act="${v.act}" data-val="${v.val || ''}"${v.disabled ? ' disabled' : ''}>${esc(v.label)}</button>`).join('')
}

function render() {
    groups = mode === 'search'
        ? [{ label: 'Search', rows: searchRows, void: searchDone ? `no matches for “${query}”` : 'searching…' }]
        : buildGroups()
    rows = []
    for (const g of groups) for (const r of g.rows) rows.push(r)
    if (rows.length) {
        if (sel < 0 || sel >= rows.length) sel = 0
    } else {
        sel = -1
    }
    renderList()
    listEl.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' })
    renderRail()
}

function move(d) {
    if (!rows.length) return
    const n = rows.length
    sel = sel < 0 ? (d > 0 ? 0 : n - 1) : (sel + d + n) % n
    render()
    const r = rows[sel]
    if (r?.kind === 'search' && !r.resolved) resolveRemote(r)
}

// remote rows resolve their canonical slug lazily, the rail verbs depend on it
function resolveRemote(row) {
    row.resolved = true // one attempt per row
    getSeries(seriesKey(row.key)).then(s => {
        if (rows[sel] !== row || !s) return
        row.slug = s.nfSlug || row.key
        row.author = s.author || row.author
        row.meta = [row.author, s.sourceName, s.year, row.chapters ? `${row.chapters} ch` : ''].filter(Boolean).join(' · ')
        render()
    }).catch(() => {})
}

function commit() {
    const r = rows[sel]
    if (!r) return
    if (r.kind === 'act') {
        if (r.id === 'markall') {
            markAllRead()
            return
        }
        closePalette()
        go(r.hash)
        return
    }
    closePalette()
    if (r.kind === 'lib' && r.lastN != null) go(`#/read/${hashSlug(r.slug)}/${r.lastN}`)
    else go(`#/series/${encodeURIComponent(r.kind === 'lib' ? r.slug : r.key)}`)
}

function runVerb(act, val) {
    const r = rows[sel]
    if (!r || r.kind === 'act') return
    const slug = r.kind === 'lib' ? r.slug : (r.slug || r.key)
    if (act === 'open') {
        closePalette()
        if (r.kind === 'lib' && r.lastN != null) go(`#/read/${hashSlug(r.slug)}/${r.lastN}`)
        else go(`#/series/${encodeURIComponent(r.kind === 'lib' ? r.slug : r.key)}`)
        return
    }
    if (act === 'follow') {
        if (followed(slug)) dropLibrary(slug)
        else touchLibrary({
            slug,
            title: r.title,
            cover: r.cover,
            author: r.author,
            total: r.kind === 'lib' ? r.total : (r.chapters || null),
        })
        render()
        return
    }
    if (act === 'mark') {
        const total = r.kind === 'lib' ? r.total : (r.chapters || 0)
        markRow(slug, total, val === 'read')
    }
}

function markRow(slug, total, read) {
    if (read) {
        const set = new Set()
        for (let n = 1; n <= total; n++) set.add(n)
        saveRead(slug, set)
        touchLibrary({ slug, readCount: total })
        // ack any pending update alert so the badge clears with the read state
        setRead(slug, true, total)
    } else {
        saveRead(slug, new Set())
        touchLibrary({ slug, readCount: 0 })
    }
    render()
}

function markAllRead() {
    const led = loadUpdLedger()
    for (const [slug, l] of Object.entries(led)) {
        if (!l.read && l.newNums?.length) setRead(slug, true, l.latest ?? l.newNums[l.newNums.length - 1])
    }
    render()
}

function cycleFocus(dir) {
    const els = [input, listEl, ...railButtons()]
    const i = els.indexOf(document.activeElement)
    let n = i < 0 ? (dir > 0 ? -1 : els.length) : i
    for (let k = 0; k < els.length; k++) {
        n = (n + dir + els.length) % els.length
        if (!els[n].disabled) break
    }
    els[n].focus()
}

// up/down/enter live on the palette's own fields, not on the window listener
function navKey(e) {
    if (e.isComposing || e.keyCode === 229) return
    e.stopPropagation() // modal: nothing behind the palette (the reader's arrow handler) may see these
    if (e.key === 'ArrowDown') {
        e.preventDefault()
        move(1)
        listEl.focus({ preventScroll: true })
    } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        move(-1)
        listEl.focus({ preventScroll: true })
    } else if (e.key === 'Enter') {
        e.preventDefault()
        commit()
    } else if (e.target === listEl && e.key === 'ArrowRight') {
        e.preventDefault()
        railButtons()[0]?.focus()
    } else if (e.target === listEl && e.key === 'ArrowLeft') {
        e.preventDefault()
        input.focus()
    }
}

function railKey(e) {
    if (e.isComposing || e.keyCode === 229) return
    e.stopPropagation() // modal: nothing behind the rail may see these keys either
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault()
        const bs = railButtons()
        if (!bs.length) return
        const i = bs.indexOf(document.activeElement)
        if (e.key === 'ArrowRight') bs[(i + 1) % bs.length].focus()
        else if (i > 0) bs[i - 1].focus()
        else listEl.focus()
    }
}

function onInput() {
    clearTimeout(searchTimer)
    query = input.value.trim()
    if (query.length < SEARCH_MIN) {
        mode = 'idle'
        searchGen++ // drop any in-flight search
        searchRows = []
        searchDone = false
        render()
        return
    }
    mode = 'search'
    searchDone = false
    searchRows = []
    render()
    searchTimer = setTimeout(() => runSearch(query), DEBOUNCE)
}

async function runSearch(q) {
    const gen = ++searchGen
    let results = []
    try {
        const d = await searchNovels(q)
        if (gen !== searchGen) return
        results = Array.isArray(d?.results) ? d.results.slice(0, SEARCH_MAX) : []
    } catch {
        if (gen !== searchGen) return
    }
    if (gen !== searchGen) return
    searchDone = true
    searchRows = results.map(r => ({
        kind: 'search',
        key: r.key,
        slug: null,
        title: r.title,
        meta: [r.author, r.sourceName, r.year, r.chapters ? `${r.chapters} ch` : ''].filter(Boolean).join(' · '),
        cover: r.cover,
        author: r.author,
        chapters: r.chapters || 0,
        resolved: false,
    }))
    render()
}

// the reader theme lives on #reader, copy its live values into the palette's own var set
function syncReaderVars() {
    for (const p of ['--pbg', '--prow', '--psel', '--prowh', '--ptext', '--phi', '--pdim', '--pline', '--pline2', '--pac']) {
        panel.style.removeProperty(p)
    }
    if (!document.body.classList.contains('reading')) return
    const R = document.querySelector('#reader')
    if (!R) return
    const cs = getComputedStyle(R)
    const t = cs.getPropertyValue('--rtext').trim()
    const bg = cs.getPropertyValue('--rbg').trim()
    const dim = cs.getPropertyValue('--rmuted').trim()
    const line = cs.getPropertyValue('--rline').trim()
    if (bg) {
        panel.style.setProperty('--pbg', bg)
        panel.style.setProperty('--prow', bg)
        panel.style.setProperty('--psel', `color-mix(in srgb, ${t} 12%, ${bg})`)
        panel.style.setProperty('--prowh', `color-mix(in srgb, ${t} 8%, ${bg})`)
    }
    if (t) {
        panel.style.setProperty('--ptext', t)
        panel.style.setProperty('--phi', t)
        panel.style.setProperty('--pac', t)
        panel.style.setProperty('--pline2', `color-mix(in srgb, ${t} 22%, transparent)`)
    }
    if (dim) panel.style.setProperty('--pdim', dim)
    if (line) panel.style.setProperty('--pline', line)
}

export function openPalette() {
    if (open) return
    open = true
    lastFocus = document.activeElement
    clearTimeout(searchTimer)
    searchGen++
    query = ''
    mode = 'idle'
    searchDone = false
    searchRows = []
    input.value = ''
    sel = -1
    syncReaderVars()
    render()
    backdrop.classList.add('open')
    panel.classList.add('open')
    if (coarse) listEl.focus({ preventScroll: true })
    else input.focus()
}

export function closePalette() {
    if (!open) return
    open = false
    clearTimeout(searchTimer)
    searchGen++
    backdrop.classList.remove('open')
    panel.classList.remove('open')
    const f = lastFocus
    lastFocus = null
    if (f?.isConnected && typeof f.focus === 'function') f.focus()
}

const toggle = () => open ? closePalette() : openPalette()

function onKey(e) {
    // composition keydowns carry dead state, never treat them as palette input
    if (e.isComposing || e.keyCode === 229) {
        if (open) e.stopPropagation()
        return
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        e.stopPropagation()
        if (!e.repeat) toggle()
        return
    }
    if (!open) return
    const inside = panel.contains(e.target)
    // keys from a stray focus outside the palette must never reach the reader's arrow handler
    if (!inside) e.stopPropagation()
    if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closePalette()
        return
    }
    if (e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        cycleFocus(e.shiftKey ? -1 : 1)
        return
    }
    // printable characters from the rail or anywhere else return to the input
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement !== input) {
        input.focus()
    }
}

input.addEventListener('keydown', navKey)
listEl.addEventListener('keydown', navKey)
railEl.addEventListener('keydown', railKey)
input.addEventListener('input', onInput)
listEl.addEventListener('click', e => {
    const r = e.target.closest('[data-i]')
    if (!r) return
    sel = Number(r.dataset.i)
    commit()
})
railEl.addEventListener('click', e => {
    const b = e.target.closest('button')
    if (b) runVerb(b.dataset.act, b.dataset.val)
})
backdrop.addEventListener('click', closePalette)
window.addEventListener('keydown', onKey, { capture: true })
// a navigation that happened outside the palette (browser back) must not leave it hanging
window.addEventListener('hashchange', () => { if (open) closePalette() })
