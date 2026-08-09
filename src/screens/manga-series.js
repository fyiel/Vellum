import { getMangaChapters, getMangaSeries, parseMangaKey, prefetchMangaChapter } from '../lib/manga-api.js'
import { go, parseHash } from '../lib/router.js'
import { dropLibrary, library, posGet, readSet, resetProgress, touchLibrary } from '../lib/store.js'
import { setSeriesCrumb } from './shell.js'
import { coverImg } from '../lib/cover.js'
import { $, esc } from '../lib/dom.js'

const SOURCE = { mf: 'MangaFire', mh: 'MangaHub' }
const ORIGIN_LABEL = { library: 'Library', manga: 'Manga', updates: 'Updates' }
const ORIGIN_ROUTE = { library: '#/', manga: '#/manga', updates: '#/updates' }
let request = 0
let current = null
let wired = false

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
    return `<div class="cover-lg">${coverImg(series.cover, series.title) || '<span class="g">Cover</span>'}</div>
      <div class="dtitle">${esc(series.title)}</div>
      ${meta ? `<div class="dmeta">${esc(meta)}</div>` : ''}
      ${genres ? `<div class="manga-tags">${genres}</div>` : ''}
      <div class="dactions"><button class="btn primary" id="manga-start" disabled>Loading chapters…</button><button class="btn${followed(series.key) ? ' on' : ''}" id="manga-follow">${followed(series.key) ? 'Following' : 'Follow'}</button><button class="btn manga-reset" id="manga-reset" ${posGet(series.key) || readSet(series.key).size ? '' : 'hidden'}>Reset progress</button></div>
      ${series.synopsis ? `<div class="seclab">Synopsis</div><div class="dsyn">${esc(series.synopsis)}</div>` : ''}
      <div class="dstats"><div class="drow"><span class="k">Source</span><span class="v">${esc(SOURCE[ref?.provider] || 'Manga')}</span></div><div class="drow"><span class="k">Format</span><span class="v">${esc(formatName(series.format))}</span></div></div>`
}

function chapterRows(chapters, activeId) {
    const read = readSet(current.key)
    return chapters.map(chapter => `<button class="mchrow${read.has(chapter.id) ? ' read' : ''}${chapter.id === activeId ? ' current' : ''}" data-id="${esc(chapter.id)}">
      <span class="mchn">${esc(chapterLabel(chapter))}</span><span class="mcht">${esc(chapterName(chapter))}</span><span class="mchlang">${esc(chapter.language || '')}</span><span class="mchdot"></span>
    </button>`).join('')
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
            current.first = current.chapters[current.chapters.length - 1] || current.chapters[0]
            $('#manga-start').textContent = 'Start reading'
            $('#manga-reset').hidden = true
            $('#mchapter-list')?.querySelectorAll('.mchrow').forEach(row => row.classList.remove('read', 'current'))
        }
    })
    $('#schapters').addEventListener('click', event => {
        const row = event.target.closest('.mchrow')
        if (row && current) go(chapterRoute(current.key, row.dataset.id))
    })
    $('#schapters').addEventListener('input', event => {
        if (event.target.id !== 'mchsearch') return
        const query = event.target.value.trim().toLowerCase()
        $('#mchapter-list').querySelectorAll('.mchrow').forEach(row => {
            row.hidden = Boolean(query) && !row.textContent.toLowerCase().includes(query)
        })
    })
}

export async function showMangaSeries(key, origin = 'manga') {
    wire()
    const mine = ++request
    current = null
    $('#view-series').classList.add('manga-detail')
    $('#sinfo').innerHTML = '<div class="void">Loading manga…</div>'
    $('#schapters').innerHTML = '<div class="void">Finding chapters…</div>'

    let series
    try { series = await getMangaSeries(key) }
    catch (error) {
        if (mine === request && currentRouteIs(key)) $('#sinfo').innerHTML = `<div class="void">${esc(error.message)}</div>`
        return
    }
    if (mine !== request || !currentRouteIs(key)) return
    setSeriesCrumb(ORIGIN_LABEL[origin] || 'Manga', series.title, () => go(ORIGIN_ROUTE[origin] || '#/manga'))
    current = { key, series, chapters: [], first: null }
    $('#sinfo').innerHTML = info(series)

    let chapterData
    try { chapterData = await getMangaChapters(key) }
    catch (error) {
        if (mine === request && currentRouteIs(key)) {
            $('#schapters').innerHTML = `<div class="void">${esc(error.message)}<button class="manga-inline-retry" id="mchapter-retry">Try again</button></div>`
            $('#mchapter-retry').onclick = () => showMangaSeries(key, origin)
        }
        return
    }
    if (mine !== request || !currentRouteIs(key)) return

    const chapters = chapterData.chapters
    const saved = posGet(key)?.id
    const first = saved ? chapters.find(chapter => chapter.id === saved) : chapters[chapters.length - 1]
    current = { key, series, chapters, first: first || chapters[0] }
    if (followed(key)) touchLibrary(entryFor(current))
    const start = $('#manga-start')
    start.disabled = false
    start.textContent = saved ? `Continue · ${chapterLabel(current.first)}` : 'Start reading'
    $('#schapters').innerHTML = `<div class="chtool"><div class="srch"><input id="mchsearch" inputmode="search" autocomplete="off" placeholder="Find a chapter…"></div></div>
      <div class="chhead">Chapter list <span class="ct">· ${chapters.length}</span></div>
      <div class="chscroll"><div id="mchapter-list">${chapterRows(chapters, saved)}</div></div>`
    prefetchMangaChapter(key, current.first.id)
}
