import { library } from '../lib/store.js'
import { buildFeed, unreadTotal } from '../lib/updates.js'
import { dlEntries, dlListen, dlTotalSize } from '../lib/downloads.js'
import { deleteMangaDownload } from '../lib/dl-manga.js'
import { deleteNovelDownload } from '../lib/dl-novel.js'
import { deleteVideoDownload } from '../lib/dl-video.js'
import { hashSlug } from '../lib/router.js'
import { coverImg } from '../lib/cover.js'
import { storeCover } from '../lib/cover-cache.js'
import { $, esc } from '../lib/dom.js'
import { relTime } from '../lib/time.js'
import { isStandalone, preserveOfflineStorage } from '../lib/persistence.js'

const CONT_MAX = 4

let filterQ = ''
let wired = false
let renderedContinueHtml = null
const newCounts = new Map()
let updatesCtrl = null

const isManga = e => e.kind === 'manga'
const isVideo = e => e.kind === 'anime' || e.kind === 'drama'
const read = e => isVideo(e) ? (e.watchedCount || 0) : (e.readCount || 0)
const total = e => e.total || 0
// episode-progress bar: fully watched entries; the current episode's timestamp fraction is
// drawn as a separate overlay strip (epPct) so a long series still shows where you are in the episode
const pctOf = e => total(e) ? Math.min(100, Math.round((read(e) / total(e)) * 100)) : 0
const epPct = e => {
    if (!isVideo(e) || Number(e.lastDuration) <= 0) return 0
    return Math.min(100, Math.round((Number(e.lastPosition || 0) / Number(e.lastDuration)) * 100))
}
const started = e => read(e) > 0 || e.lastN != null || e.lastId != null
const done = e => total(e) > 0 && read(e) >= total(e) && (!isManga(e) || !e.pageCount || e.lastPage >= e.pageCount)
const resumeN = e => (e.lastN != null ? e.lastN : 1)
const formatName = value => value ? value[0].toUpperCase() + value.slice(1) : ''
const mangaMeta = e => [formatName(e.format), e.source].filter(Boolean).join(' · ')
const entryMeta = e => (isManga(e) || isVideo(e)) ? mangaMeta(e) : e.author || ''
const clock = seconds => `${Math.floor((Number(seconds) || 0) / 60)}:${String(Math.floor((Number(seconds) || 0) % 60)).padStart(2, '0')}`
const lastRead = e => isManga(e)
    ? [e.lastLabel || 'Chapter', e.pageCount ? `page ${e.lastPage || 1} of ${e.pageCount}` : ''].filter(Boolean).join(' · ')
    : isVideo(e) ? [e.lastLabel || 'Episode', e.lastDuration ? `${clock(e.lastPosition)} / ${clock(e.lastDuration)}` : 'selected'].join(' · ')
    : `Ch. ${resumeN(e)} · ${read(e)} / ${total(e)} read`

const seriesRoute = e => isManga(e) ? `#/manga/series/${encodeURIComponent(e.slug)}`
    : isVideo(e) ? `#/watch/series/${encodeURIComponent(e.slug)}` : `#/series/${encodeURIComponent(e.slug)}`
const resumeRoute = e => isManga(e) ? (e.lastId ? `#/manga/read/${encodeURIComponent(e.slug)}/${encodeURIComponent(e.lastId)}` : seriesRoute(e))
    : isVideo(e) ? (e.lastId ? `#/watch/play/${encodeURIComponent(e.slug)}/${encodeURIComponent(e.lastId)}` : seriesRoute(e))
        : `#/read/${hashSlug(e.slug)}/${resumeN(e)}`
const matchesSearch = e => !filterQ || [e.title, e.author, e.format, e.source, e.key].some(value => String(value || '').toLowerCase().includes(filterQ.toLowerCase()))
const progressBar = e => `<span class="bar" role="progressbar" aria-label="${esc(e.title)} progress" aria-valuenow="${pctOf(e)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pctOf(e)}%"></span>${epPct(e) ? `<span class="ep" style="width:${epPct(e)}%"></span>` : ''}</span>`

// the library is what you see with no network: its tiles carry the lookup key for a stored copy,
// and series you actually downloaded get one kept (see keepDownloadedCovers)
const cover = (e, ph) => coverImg(e.cover, e.title, { offline: true }) || (ph ? `<span>${ph}</span>` : '')

const contTile = e => {
    const pct = pctOf(e)
    return `<a class="ctile" href="${resumeRoute(e)}" data-slug="${esc(e.slug)}" data-kind="${esc(e.kind || 'novel')}" aria-label="${esc(`Resume ${e.title}, ${lastRead(e)}`)}">
      <div class="cv">${cover(e, 'COV')}</div>
      <div class="cbd">
        <div class="ti">${esc(e.title)}</div>
        <div class="last-read">${esc(lastRead(e))}</div>
        <div class="mt">${progressBar(e)}<span>${pct}%</span><span class="resume-hint">Resume →</span></div>
        ${(isManga(e) || isVideo(e)) ? `<div class="cm">${esc(entryMeta(e))}</div>` : ''}
      </div>
    </a>`
}

function updCell(e) {
    const nc = newCounts.get(e.slug) || 0
    if (nc > 0) return `<span class="upd"><span class="new">+${nc}</span></span>`
    if (done(e)) return `<span class="upd done">done</span>`
    return `<span class="upd">${esc(relTime(e.updatedAt))}</span>`
}

const row = e => {
    const pct = pctOf(e)
    const meta = entryMeta(e)
    const position = done(e) ? 'Finished' : started(e) ? lastRead(e) : 'Not started'
    return `<a class="trow${done(e) ? ' finished' : ''}" href="${seriesRoute(e)}" data-slug="${esc(e.slug)}" data-kind="${esc(e.kind || 'novel')}">
      <span class="cv">${cover(e, '')}</span>
      <div class="tt"><div class="n">${esc(e.title)}</div>${meta ? `<div class="au">${esc(meta)}</div>` : ''}<div class="last">${esc(position)}</div></div>
      <div class="pcell">${progressBar(e)}<span class="pct">${pct}%</span></div>
      <span class="chp">${esc(read(e))}/${esc(total(e))}</span>
      ${updCell(e)}
    </a>`
}

// Reuse followed-title rows across visits and filter changes. Replacing the entire
// table needlessly rebuilds hundreds of covers and drops keyboard focus even
// when a title's rendered content hasn't changed.
const libraryRowHtml = new WeakMap()

function renderLibraryRows(rows) {
    const table = $('#libtable')
    const html = rows.map(row)
    if (!table.firstElementChild?.classList.contains('trow')) {
        table.innerHTML = html.join('')
        let i = 0
        for (const el of table.children) libraryRowHtml.set(el, html[i++])
        return
    }

    const focused = table.contains(document.activeElement) ? document.activeElement : null
    let replacementFocus = null
    const oldRows = new Map()
    for (const el of table.children) {
        const key = el.dataset.slug
        if (!oldRows.has(key)) oldRows.set(key, [])
        oldRows.get(key).push(el)
    }
    const template = document.createElement('template')
    let cursor = table.firstElementChild
    rows.forEach((entry, i) => {
        let el = oldRows.get(entry.slug)?.shift()
        let replacingFocusedRow = false
        if (el && libraryRowHtml.get(el) !== html[i]) {
            replacingFocusedRow = el.contains(focused)
            if (el === cursor) cursor = el.nextElementSibling
            el.remove()
            el = null
        }
        if (!el) {
            template.innerHTML = html[i]
            el = template.content.firstElementChild
            libraryRowHtml.set(el, html[i])
            if (replacingFocusedRow) replacementFocus = el
        }
        if (el !== cursor) table.insertBefore(el, cursor)
        else cursor = cursor.nextElementSibling
    })
    for (const remaining of oldRows.values()) for (const el of remaining) el.remove()
    if (replacementFocus) replacementFocus.focus({ preventScroll: true })
    else if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true })
}

const fmtSize = bytes => {
    const n = Number(bytes) || 0
    return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`
}
const DL_KIND_LABEL = { manga: 'Manga', novel: 'Novel', video: 'Video' }
const downloadRoute = e => e.kind === 'manga' ? `#/manga/read/${encodeURIComponent(e.key)}/${encodeURIComponent(e.id)}`
    : e.kind === 'video' ? `#/watch/play/${encodeURIComponent(e.key)}/${encodeURIComponent(e.id)}` : `#/read/${hashSlug(e.key)}/${encodeURIComponent(e.id)}`
const dlRow = e => `<div class="dlrow" data-kind="${esc(e.kind)}" data-key="${esc(e.key)}" data-id="${esc(e.id)}">
  <a class="dl-open" href="${downloadRoute(e)}"><div class="tt"><div class="n">${esc(e.title || e.key)}</div><div class="au">${esc(DL_KIND_LABEL[e.kind] || e.kind)} · ${esc(e.label || '')}</div></div><span class="dlsize">${esc(fmtSize(e.size))}</span></a>
  <button type="button" class="dldel" title="Delete download" aria-label="${esc(`Delete download of ${e.title || e.key}, ${e.label || e.id}`)}">✕</button>
</div>`
const dlKey = e => JSON.stringify([e.kind, e.key, String(e.id)])
const dlSignature = e => JSON.stringify([e.title, e.label, e.size])
const dlRowSignatures = new WeakMap()

function updateDownloadRow(rowEl, entry, signature) {
    if (dlRowSignatures.get(rowEl) === signature) return
    rowEl.querySelector('.dl-open').setAttribute('href', downloadRoute(entry))
    rowEl.querySelector('.n').textContent = entry.title || entry.key
    rowEl.querySelector('.au').textContent = `${DL_KIND_LABEL[entry.kind] || entry.kind} · ${entry.label || ''}`
    rowEl.querySelector('.dlsize').textContent = fmtSize(entry.size)
    rowEl.querySelector('.dldel').setAttribute('aria-label', `Delete download of ${entry.title || entry.key}, ${entry.label || entry.id}`)
    dlRowSignatures.set(rowEl, signature)
}

function renderDownloadRows(entries) {
    const table = $('#dltable')
    if (!entries.length) { table.replaceChildren(); return }
    if (!table.firstElementChild) {
        // Build a cold list in one parse; batch downloads use the keyed path below.
        table.innerHTML = entries.map(dlRow).join('')
        let i = 0
        for (const rowEl of table.children) dlRowSignatures.set(rowEl, dlSignature(entries[i++]))
        return
    }
    const focused = table.contains(document.activeElement) ? document.activeElement : null
    const oldRows = new Map()
    for (const rowEl of table.children) {
        const key = dlKey(rowEl.dataset)
        if (!oldRows.has(key)) oldRows.set(key, [])
        oldRows.get(key).push(rowEl)
    }
    const template = document.createElement('template')
    let cursor = table.firstElementChild
    for (const entry of entries) {
        const key = dlKey(entry)
        const signature = dlSignature(entry)
        let rowEl = oldRows.get(key)?.shift()
        if (rowEl) updateDownloadRow(rowEl, entry, signature)
        else {
            template.innerHTML = dlRow(entry)
            rowEl = template.content.firstElementChild
            dlRowSignatures.set(rowEl, signature)
        }
        if (rowEl !== cursor) table.insertBefore(rowEl, cursor)
        else cursor = cursor.nextElementSibling
    }
    for (const rows of oldRows.values()) for (const rowEl of rows) rowEl.remove()
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true })
}

function renderDownloads() {
    const entries = dlEntries().filter(matchesSearch)
    $('#dl-lab').hidden = !entries.length
    $('#dl-size').textContent = entries.length ? `· ${fmtSize(dlTotalSize())}` : ''
    renderDownloadRows(entries)
    const note = $('#dl-storage')
    note.hidden = !entries.length || !!window.__TAURI_INTERNALS__
    if (!note.hidden) {
        note.textContent = ''
        void preserveOfflineStorage().then(protectedStorage => {
            note.textContent = protectedStorage ? 'Persistent storage enabled. Downloads have no expiry.'
                : !isStandalone() ? 'For more reliable offline storage on iPhone, add Vellum to your Home Screen, then download there.'
                : 'Downloads have no expiry, but this browser has not granted persistent storage.'
        })
    }
}

async function deleteDownload(el) {
    const { kind, key, id } = el.dataset
    if (!confirm(`Delete this downloaded ${DL_KIND_LABEL[kind]?.toLowerCase() || 'item'}?`)) return
    try {
        if (kind === 'manga') await deleteMangaDownload(key, id)
        else if (kind === 'video') await deleteVideoDownload(key, id)
        else await deleteNovelDownload(key, id)
    } catch (error) {
        alert(error.message || 'Could not delete this download. Please try again.')
    }
}

function render() {
    const all = library()
    $('#count-library').textContent = all.length ? String(all.length) : ''

    const rows = all.filter(matchesSearch).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    const inProg = rows.filter(e => started(e) && !done(e))
    const continueItems = inProg.slice(0, CONT_MAX)

    const contLab = $('#cont-lab'), cont = $('#continue')
    const showCont = continueItems.length > 0
    contLab.hidden = !showCont
    cont.hidden = !showCont
    $('#cont-count').textContent = String(continueItems.length)
    const nextContinueHtml = showCont ? continueItems.map(contTile).join('') : ''
    if (nextContinueHtml !== renderedContinueHtml) {
        const focusedSlug = cont.contains(document.activeElement) ? document.activeElement.closest('.ctile')?.dataset.slug : null
        const scrollLeft = cont.scrollLeft
        cont.innerHTML = nextContinueHtml
        cont.scrollLeft = scrollLeft
        renderedContinueHtml = nextContinueHtml
        if (focusedSlug) [...cont.children].find(el => el.dataset.slug === focusedSlug)?.focus({ preventScroll: true })
    }
    $('#lib-count').textContent = String(rows.length)
    $('#lib-lab').hidden = !all.length
    $('#lib-clear').hidden = !filterQ
    $('#lib-status').textContent = `${rows.length} ${rows.length === 1 ? 'title' : 'titles'}${filterQ ? ` matching ${filterQ}` : ''}`

    const table = $('#libtable')
    if (!all.length) table.innerHTML = '<div class="library-empty"><h2>Your next story starts here</h2><p>Nothing in your library yet. Follow something to read or watch and it shows up here.</p><div class="library-empty-actions"><a href="#/discover">Find a novel</a><a href="#/manga">Browse manga</a><a href="#/watch">Find something to watch</a></div></div>'
    else if (!rows.length) table.innerHTML = `<div class="library-empty"><h2>No matches</h2><p>No titles match “${esc(filterQ)}”. Try another title, author, or source.</p><button type="button" id="lib-reset">Clear search</button></div>`
    else renderLibraryRows(rows)
}

async function checkUpdates(signal) {
    try {
        const { feed } = await buildFeed({ signal })
        if (signal.aborted) return
        const previous = new Map(newCounts)
        newCounts.clear()
        for (const u of feed) if (!u.read && u.newCount > 0) newCounts.set(u.slug, u.newCount)
        const unread = unreadTotal(feed)
        $('#count-updates').textContent = unread ? String(unread) : ''

        // The check only changes alert cells. Rebuilding the whole library
        // discards focused links and replaces otherwise identical rows.
        if (previous.size === newCounts.size && [...previous].every(([slug, count]) => newCounts.get(slug) === count)) return
        const entries = new Map(library().map(entry => [entry.slug, entry]))
        for (const rowEl of $('#libtable').querySelectorAll('.trow')) {
            const slug = rowEl.dataset.slug
            if ((previous.get(slug) || 0) === (newCounts.get(slug) || 0)) continue
            const entry = entries.get(slug)
            if (!entry) continue
            const badge = rowEl.querySelector('.upd')
            const before = badge.outerHTML
            const after = updCell(entry)
            badge.outerHTML = after
            // Keep the row's cached HTML in sync with this targeted mutation.
            // If it was changed elsewhere, let the next render replace it.
            const cached = libraryRowHtml.get(rowEl)
            if (cached?.includes(before)) libraryRowHtml.set(rowEl, cached.replace(before, after))
            else libraryRowHtml.delete(rowEl)
        }
    } catch (error) {
        if (!signal.aborted) console.error('Library update check failed', error)
    }
}

function wire() {
    if (wired) return
    wired = true

    let t
    $('#filter').addEventListener('input', e => {
        clearTimeout(t)
        const v = e.target.value.trim()
        t = setTimeout(() => { filterQ = v; $('#continue').scrollLeft = 0; render(); renderDownloads() }, 150)
    })

    const reset = () => {
        clearTimeout(t)
        filterQ = ''
        $('#filter').value = ''
        render()
        renderDownloads()
        $('#filter').focus()
    }
    $('#lib-clear').addEventListener('click', reset)
    $('#libtable').addEventListener('click', e => {
        if (!e.target.closest('#lib-reset')) return
        reset()
    })
    $('#dltable').addEventListener('click', e => {
        const del = e.target.closest('.dldel')
        if (del) deleteDownload(del.closest('.dlrow'))
    })
    // Downloads completed on other screens are listed when the library opens.
    dlListen(() => { if (!$('#view-library').hidden) renderDownloads() })
    // Storage events fire only in other tabs. Keep an open Library in sync when
    // a title is followed, unfollowed, or all site data is cleared elsewhere.
    window.addEventListener('storage', event => {
        if ((event.key === 'vellum:lib' || event.key === null) && !$('#view-library').hidden) render()
    })
}

// A series you downloaded is one you expect to open with no network, so keep its cover. This is
// driven by the download registry rather than the grid: one resolver call per downloaded series
// instead of one per tile, and the store itself de-dupes and bounds the copies.
function keepDownloadedCovers() {
    const downloaded = new Set(dlEntries().map(entry => entry.title).filter(Boolean))
    if (!downloaded.size) return
    for (const entry of library()) {
        if (entry.cover && downloaded.has(entry.title)) void storeCover(entry.cover, entry.title)
    }
}

export function cancelLibraryUpdates() {
    updatesCtrl?.abort()
    updatesCtrl = null
}

export function showLibrary() {
    cancelLibraryUpdates()
    const ctrl = new AbortController()
    updatesCtrl = ctrl
    wire()
    render()
    renderDownloads()
    keepDownloadedCovers()
    void checkUpdates(ctrl.signal).finally(() => {
        if (updatesCtrl === ctrl) updatesCtrl = null
    })
}
