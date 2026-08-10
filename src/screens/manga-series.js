import { getMangaChapters, getMangaSeries, mangaErrorMessage, mangaProviderName, orderMangaChapters, parseMangaKey, prefetchMangaChapter } from '../lib/manga-api.js'
import { go, parseHash } from '../lib/router.js'
import { dropLibrary, library, posGet, readSet, resetProgress, touchLibrary } from '../lib/store.js'
import { setSeriesCrumb } from './shell.js'
import { coverImg } from '../lib/cover.js'
import { $, esc } from '../lib/dom.js'

const SOURCE = { mf: 'MangaFire', mh: 'MangaHub' }
const ORIGIN_LABEL = { library: 'Library', manga: 'Manga', updates: 'Updates' }
const ORIGIN_ROUTE = { library: '#/', manga: '#/manga', updates: '#/updates' }
const CHAPTER_BATCH = 250
const REVEAL_RADIUS = 800
let request = 0
let current = null
let wired = false
let chapterQuery = ''
let chapterLimit = CHAPTER_BATCH

const chapterLabel = chapter => chapter.number == null ? (chapter.title || 'Special') : `Ch. ${chapter.number}`
const formatName = value => value ? value[0].toUpperCase() + value.slice(1) : ''
const chapterName = chapter => chapter.title && chapter.title !== chapterLabel(chapter) ? chapter.title : ''
const chapterRoute = (key, id) => `#/manga/read/${encodeURIComponent(key)}/${encodeURIComponent(id)}`
const currentRouteIs = key => {
    const route = parseHash()
    return route.name === 'manga-series' && route.key === key
}

const followed = key => library().some(entry => entry.slug === key)
const entryFor = ({ key, series, chapters }) => {
    const provider = parseMangaKey(key)?.provider
    return {
        slug: key,
        key,
        kind: 'manga',
        title: series.title,
        cover: series.cover,
        author: series.authors?.[0] || series.artists?.[0],
        source: SOURCE[provider] || 'Manga',
        format: series.format,
        total: chapters.length || undefined,
        chapterIds: chapters.length ? chapters.map(chapter => chapter.id) : undefined,
        readCount: readSet(key).size,
    }
}

function info(series) {
    const ref = parseMangaKey(series.key)
    const people = [...(series.authors || []), ...(series.artists || [])].filter(Boolean)
    const meta = [formatName(series.format), series.status, people[0]].filter(Boolean).join(' · ')
    const genres = (series.genres || []).map(item => `<span class="manga-tag">${esc(item)}</span>`).join('')
    return `<div class="cover-lg"><span class="g">Cover</span>${coverImg(series.cover, series.title, false)}</div>
      <div class="dtitle">${esc(series.title)}</div>
      ${meta ? `<div class="dmeta">${esc(meta)}</div>` : ''}
      ${genres ? `<div class="manga-tags">${genres}</div>` : ''}
      <div class="dactions"><button class="btn primary" id="manga-start" disabled>Loading chapters…</button><button class="btn${followed(series.key) ? ' on' : ''}" id="manga-follow">${followed(series.key) ? 'Following' : 'Follow'}</button><button class="btn manga-reset" id="manga-reset" ${posGet(series.key) || readSet(series.key).size ? '' : 'hidden'}>Reset progress</button></div>
      ${series.synopsis ? `<div class="seclab">Synopsis</div><div class="dsyn">${esc(series.synopsis)}</div>` : ''}
      <div class="dstats"><div class="drow"><span class="k">Source</span><span class="v">${esc(mangaProviderName(ref?.provider))}</span></div><div class="drow"><span class="k">Format</span><span class="v">${esc(formatName(series.format))}</span></div></div>`
}

function chapterRows(chapters, activeId) {
    const read = readSet(current.key)
    return chapters.map(chapter => `<button type="button" class="mchrow${read.has(chapter.id) ? ' read' : ''}${chapter.id === activeId ? ' current' : ''}" data-id="${esc(chapter.id)}"${chapter.id === activeId ? ' aria-current="page"' : ''} aria-label="${esc(`${chapterLabel(chapter)}${chapterName(chapter) ? `, ${chapterName(chapter)}` : ''}${chapter.language ? `, ${chapter.language}` : ''}`)}">
      <span class="mchn">${esc(chapterLabel(chapter))}</span><span class="mcht">${esc(chapterName(chapter))}</span><span class="mchlang">${esc(chapter.language || '')}</span><span class="mchdot"></span>
    </button>`).join('')
}

const filteredChapters = () => {
    if (!current) return []
    const query = chapterQuery.toLowerCase()
    return current.chapters.filter(chapter => !query || `${chapterLabel(chapter)} ${chapter.title || ''}`.toLowerCase().includes(query))
}

function renderChapterList() {
    if (!current) return
    const filtered = filteredChapters()
    const shown = filtered.slice(0, chapterLimit)
    $('#mchapter-list').innerHTML = shown.length
        ? `${chapterRows(shown, current.saved)}${shown.length < filtered.length ? `<button type="button" class="manga-chapter-more" id="mchapter-more">Show ${Math.min(CHAPTER_BATCH, filtered.length - shown.length)} more <span>${shown.length} of ${filtered.length}</span></button>` : ''}`
        : '<div class="manga-chapter-empty" role="status">No matching chapters</div>'
    const status = $('#mchapter-status')
    if (status) status.textContent = shown.length ? `Showing ${shown.length} of ${filtered.length} chapters` : ''
}

function revealMore() {
    const filtered = filteredChapters()
    if (chapterLimit >= filtered.length) return
    chapterLimit += CHAPTER_BATCH
    renderChapterList()
}

function wire() {
    if (wired) return
    wired = true
    $('#sinfo').addEventListener('click', event => {
        if (event.target.closest('#manga-start') && current?.first) go(chapterRoute(current.key, current.first.id))
        if (event.target.closest('#manga-follow') && current) {
            const button = $('#manga-follow')
            if (followed(current.key)) {
                dropLibrary(current.key)
                button.classList.remove('on')
                button.textContent = 'Follow'
            } else {
                touchLibrary(entryFor(current))
                button.classList.add('on')
                button.textContent = 'Following'
            }
        }
        if (event.target.closest('#manga-reset') && current && confirm(`Reset reading progress for ${current.series.title}?`)) {
            resetProgress(current.key)
            current.first = orderMangaChapters(current.chapters)[0] || current.chapters[0]
            $('#manga-start').textContent = 'Start reading'
            $('#manga-reset').hidden = true
            $('#mchapter-list')?.querySelectorAll('.mchrow').forEach(row => row.classList.remove('read', 'current'))
        }
    })
    $('#schapters').addEventListener('click', event => {
        if (event.target.closest('#mchapter-more')) {
            const before = $('#mchapter-list').querySelectorAll('.mchrow').length
            chapterLimit += CHAPTER_BATCH
            renderChapterList()
            $('#mchapter-list').querySelectorAll('.mchrow')[before]?.focus({ preventScroll: true })
            return
        }
        const row = event.target.closest('.mchrow')
        if (row && current) go(chapterRoute(current.key, row.dataset.id))
    })
    $('#schapters').addEventListener('input', event => {
        if (event.target.id !== 'mchsearch') return
        chapterQuery = event.target.value.trim()
        chapterLimit = CHAPTER_BATCH
        renderChapterList()
    })
    // #schapters itself never scrolls (the view scrolls on mobile, .chscroll on desktop),
    // capture on the static view shell catches the real scroller either way
    $('#view-series').addEventListener('scroll', event => {
        const scroller = event.target
        if (!(scroller instanceof Element)) return
        if (scroller !== $('#view-series') && !$('#view-series').contains(scroller)) return
        if (scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - REVEAL_RADIUS) revealMore()
    }, { passive: true, capture: true })
}

export async function showMangaSeries(key, origin = 'manga') {
    wire()
    const mine = ++request
    current = null
    chapterQuery = ''
    chapterLimit = CHAPTER_BATCH
    $('#view-series').classList.add('manga-detail')
    $('#sinfo').setAttribute('aria-busy', 'true')
    $('#schapters').setAttribute('aria-busy', 'true')
    $('#sinfo').innerHTML = '<div class="void" role="status">Loading manga…</div>'
    $('#schapters').innerHTML = '<div class="void" role="status">Finding chapters…</div>'

    const chapterRequest = getMangaChapters(key)
    chapterRequest.catch(() => {})
    let series
    try { series = await getMangaSeries(key) }
    catch (error) {
        if (mine === request && currentRouteIs(key)) {
            const message = navigator.onLine ? mangaErrorMessage(error, 'Manga unavailable') : 'You’re offline. Reconnect to load this manga.'
            $('#sinfo').innerHTML = `<div class="void" role="status">${esc(message)}<button class="manga-inline-retry" id="mseries-retry" type="button">Try again</button></div>`
            $('#mseries-retry').onclick = () => showMangaSeries(key, origin)
            $('#sinfo').setAttribute('aria-busy', 'false')
        }
        return
    }
    if (mine !== request || !currentRouteIs(key)) return
    setSeriesCrumb(ORIGIN_LABEL[origin] || 'Manga', series.title, () => go(ORIGIN_ROUTE[origin] || '#/manga'))
    current = { key, series, chapters: [], first: null }
    $('#sinfo').innerHTML = info(series)
    $('#sinfo').setAttribute('aria-busy', 'false')

    let chapterData
    try { chapterData = await chapterRequest }
    catch (error) {
        if (mine === request && currentRouteIs(key)) {
            const message = navigator.onLine ? mangaErrorMessage(error, 'Chapter list unavailable') : 'You’re offline. Reconnect to load the chapter list.'
            $('#schapters').innerHTML = `<div class="void" role="status">${esc(message)}<button class="manga-inline-retry" id="mchapter-retry" type="button">Try again</button></div>`
            $('#mchapter-retry').onclick = () => showMangaSeries(key, origin)
            $('#schapters').setAttribute('aria-busy', 'false')
        }
        return
    }
    if (mine !== request || !currentRouteIs(key)) return

    const chapters = chapterData.chapters
    const saved = posGet(key)?.id
    const first = saved ? chapters.find(chapter => chapter.id === saved) : orderMangaChapters(chapters)[0]
    current = { key, series, chapters, first: first || chapters[0], saved }
    if (followed(key)) touchLibrary(entryFor(current))
    const start = $('#manga-start')
    start.disabled = false
    start.textContent = saved ? `Continue · ${chapterLabel(current.first)}` : 'Start reading'
    $('#schapters').innerHTML = `<div class="chtool"><div class="srch"><input id="mchsearch" inputmode="search" autocomplete="off" aria-label="Find a chapter" placeholder="Find a chapter…"></div></div>
      <div class="chhead">Chapter list <span class="ct">· ${chapters.length}</span></div>
      <div class="chscroll"><div id="mchapter-list"></div><div class="sronly" id="mchapter-status" role="status"></div></div>`
    renderChapterList()
    $('#schapters').setAttribute('aria-busy', 'false')
    prefetchMangaChapter(key, current.first.id)
}
