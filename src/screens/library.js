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
const newCounts = new Map()

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

function renderDownloads() {
    const entries = dlEntries().filter(matchesSearch)
    $('#dl-lab').hidden = !entries.length
    $('#dl-size').textContent = entries.length ? `· ${fmtSize(dlTotalSize())}` : ''
    $('#dltable').innerHTML = entries.map(dlRow).join('')
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

function deleteDownload(el) {
    const { kind, key, id } = el.dataset
    if (!confirm(`Delete this downloaded ${DL_KIND_LABEL[kind]?.toLowerCase() || 'item'}?`)) return
    if (kind === 'manga') deleteMangaDownload(key, id)
    else if (kind === 'video') deleteVideoDownload(key, id)
    else deleteNovelDownload(key, id)
}

function render() {
    const all = library()
    $('#count-library').textContent = all.length ? String(all.length) : ''

    const rows = all.filter(matchesSearch).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    const inProg = rows.filter(e => started(e) && !done(e))
    const continueItems = inProg.slice(0, CONT_MAX)

    const contLab = $('#cont-lab'), cont = $('#continue')
    const showCont = continueItems.length > 0
    const scrollLeft = cont.scrollLeft
    contLab.hidden = !showCont
    cont.hidden = !showCont
    $('#cont-count').textContent = String(continueItems.length)
    cont.innerHTML = showCont ? continueItems.map(contTile).join('') : ''
    cont.scrollLeft = scrollLeft
    $('#lib-count').textContent = String(rows.length)
    $('#lib-lab').hidden = !all.length
    $('#lib-clear').hidden = !filterQ
    $('#lib-status').textContent = `${rows.length} ${rows.length === 1 ? 'title' : 'titles'}${filterQ ? ` matching ${filterQ}` : ''}`

    const table = $('#libtable')
    if (!all.length) table.innerHTML = '<div class="library-empty"><h2>Your next story starts here</h2><p>Nothing in your library yet. Follow something to read or watch and it shows up here.</p><div class="library-empty-actions"><a href="#/discover">Find a novel</a><a href="#/manga">Browse manga</a><a href="#/watch">Find something to watch</a></div></div>'
    else if (!rows.length) table.innerHTML = `<div class="library-empty"><h2>No matches</h2><p>No titles match “${esc(filterQ)}”. Try another title, author, or source.</p><button type="button" id="lib-reset">Clear search</button></div>`
    else table.innerHTML = rows.map(row).join('')
}

async function checkUpdates() {
    const { feed } = await buildFeed()
    newCounts.clear()
    for (const u of feed) if (!u.read && u.newCount > 0) newCounts.set(u.slug, u.newCount)
    $('#count-updates').textContent = unreadTotal(feed) ? String(unreadTotal(feed)) : ''
    render()
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
    dlListen(renderDownloads)
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

export function showLibrary() {
    wire()
    render()
    renderDownloads()
    keepDownloadedCovers()
    checkUpdates()
}
