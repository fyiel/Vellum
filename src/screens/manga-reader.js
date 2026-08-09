import { getMangaChapter, getMangaChapters, getMangaSeries, mangaPageUrl, parseMangaKey } from '../lib/manga-api.js'
import { go, parseHash } from '../lib/router.js'
import { posGet, posSet, readSet, saveRead, touchLibrary } from '../lib/store.js'
import { $, esc } from '../lib/dom.js'

const reader = $('#mreader')
const pages = $('#mr-pages')
const drawer = $('#mdrawer')
const drawerBackdrop = $('#mdrawer-backdrop')

const state = {
    active: false,
    key: '',
    id: '',
    gen: 0,
    ctrl: null,
    series: null,
    chapters: [],
    chapter: null,
    content: null,
    page: 0,
    hidden: false,
}

const route = (key, id) => `#/manga/read/${encodeURIComponent(key)}/${encodeURIComponent(id)}`
const seriesRoute = key => `#/manga/series/${encodeURIComponent(key)}`
const chapterLabel = chapter => chapter?.number == null ? (chapter?.title || 'Special') : `Ch. ${chapter.number}`
const SOURCE = { mf: 'MangaFire', mh: 'MangaHub' }
const stillHere = (key, id, gen) => {
    const current = parseHash()
    return state.active && state.gen === gen && current.name === 'manga-read' && current.key === key && current.id === id
}

const ordered = () => [...state.chapters].sort((a, b) => {
    if (a.number == null && b.number == null) return a.id.localeCompare(b.id)
    if (a.number == null) return 1
    if (b.number == null) return -1
    return a.number - b.number || a.id.localeCompare(b.id)
})

function setChrome(hidden) {
    state.hidden = hidden
    reader.classList.toggle('hide-chrome', hidden)
}

function setPage(index) {
    if (!state.content?.pages.length) return
    const next = Math.min(state.content.pages.length - 1, Math.max(0, index))
    state.page = next
    $('#mr-pos').textContent = `Page ${next + 1} / ${state.content.pages.length}`
    $('#mr-progress').style.width = `${((next + 1) / state.content.pages.length * 100).toFixed(2)}%`
}

function saveProgress() {
    if (!state.active || !state.id) return
    posSet(state.key, { id: state.id, page: state.page, at: Date.now() })
    updateLibrary()
}

function updateLibrary() {
    if (!state.series || !state.chapter || !state.content) return
    const provider = parseMangaKey(state.key)?.provider
    touchLibrary({
        slug: state.key,
        key: state.key,
        kind: 'manga',
        title: state.series.title,
        cover: state.series.cover,
        author: state.series.authors?.[0] || state.series.artists?.[0],
        source: SOURCE[provider] || 'Manga',
        format: state.series.format,
        total: state.chapters.length,
        chapterIds: state.chapters.map(chapter => chapter.id),
        readCount: readSet(state.key).size,
        lastId: state.id,
        lastLabel: chapterLabel(state.chapter),
        lastPage: state.page + 1,
        pageCount: state.content.pages.length,
    })
}

function currentPage() {
    const center = innerHeight * .5
    let best = 0
    let distance = Infinity
    pages.querySelectorAll('.manga-page').forEach((page, index) => {
        const rect = page.getBoundingClientRect()
        const point = rect.top <= center && rect.bottom >= center ? center : Math.min(Math.abs(rect.top - center), Math.abs(rect.bottom - center))
        const nextDistance = point === center ? 0 : point
        if (nextDistance < distance) { distance = nextDistance; best = index }
    })
    return best
}

function renderSteps() {
    const chapters = ordered()
    const index = chapters.findIndex(chapter => chapter.id === state.id)
    const previous = chapters[index - 1]
    const next = chapters[index + 1]
    $('#mr-step').innerHTML = `${previous ? `<a href="${route(state.key, previous.id)}"><span>Previous</span>${esc(chapterLabel(previous))}</a>` : '<span></span>'}
      ${next ? `<a href="${route(state.key, next.id)}"><span>Next</span>${esc(chapterLabel(next))}</a>` : '<span></span>'}`
}

function renderPages(content) {
    window.scrollTo(0, 0)
    pages.innerHTML = content.pages.map((page, index) => `<figure class="manga-page" data-page="${index}">
      <img src="${esc(mangaPageUrl(page))}" ${page.width ? `width="${esc(page.width)}"` : ''} ${page.height ? `height="${esc(page.height)}"` : ''} ${index < 2 ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" alt="Page ${index + 1}">
      <figcaption><span>Page ${index + 1} couldn’t load</span><button data-page-retry="${index}">Retry</button></figcaption>
    </figure>`).join('')
    renderSteps()
    setPage(0)

    const saved = posGet(state.key)
    const target = saved?.id === state.id ? Math.min(content.pages.length - 1, Math.max(0, Number(saved.page) || 0)) : 0
    const targetImage = pages.querySelectorAll('img')[target]
    const restore = () => {
        if (!state.active || target === 0) return
        pages.querySelector(`[data-page="${target}"]`)?.scrollIntoView({ block: 'start' })
        setPage(target)
    }
    if (targetImage?.complete) requestAnimationFrame(restore)
    else targetImage?.addEventListener('load', restore, { once: true })
}

function showError(message) {
    pages.innerHTML = `<div class="mreader-empty">${esc(message)}<button id="mr-retry">Try again</button></div>`
    $('#mr-step').innerHTML = ''
    $('#mr-retry').onclick = () => showMangaReader(state.key, state.id)
}

function renderDrawer() {
    const query = $('#mdw-q').value.trim().toLowerCase()
    const read = readSet(state.key)
    const rows = state.chapters.filter(chapter => !query || `${chapterLabel(chapter)} ${chapter.title || ''}`.toLowerCase().includes(query))
    $('#mdrawer-list').innerHTML = rows.length ? rows.map(chapter => `<a class="chap${read.has(chapter.id) ? ' read' : ''}${chapter.id === state.id ? ' current' : ''}" href="${route(state.key, chapter.id)}">
      <span class="n">${esc(chapterLabel(chapter))}</span><span class="t">${esc(chapter.title || '')}</span><span class="dot"></span></a>`).join('')
        : '<div class="empty">No matching chapters</div>'
}

function openDrawer() {
    if (!state.chapters.length) return
    $('#mdw-q').value = ''
    renderDrawer()
    drawer.classList.add('open')
    drawerBackdrop.classList.add('open')
    $('#mdrawer-list .current')?.scrollIntoView({ block: 'center' })
}

function closeDrawer() {
    drawer.classList.remove('open')
    drawerBackdrop.classList.remove('open')
}

let wired = false
let ticking = false
let idleTimer = null
function wire() {
    if (wired) return
    wired = true
    $('#mr-back').onclick = () => go(seriesRoute(state.key))
    $('#mr-list').onclick = openDrawer
    drawerBackdrop.onclick = closeDrawer
    $('#mdrawer-list').addEventListener('click', event => { if (event.target.closest('a')) closeDrawer() })
    $('#mdw-q').addEventListener('input', renderDrawer)
    pages.addEventListener('error', event => {
        if (event.target.tagName === 'IMG') event.target.closest('.manga-page')?.classList.add('failed')
    }, true)
    pages.addEventListener('click', event => {
        const retry = event.target.closest('[data-page-retry]')
        if (retry) {
            const figure = retry.closest('.manga-page')
            const image = figure.querySelector('img')
            figure.classList.remove('failed')
            const url = new URL(image.src)
            url.searchParams.set('_retry', Date.now())
            image.src = url.href
            return
        }
        if (!event.target.closest('button')) setChrome(!state.hidden)
    })
    window.addEventListener('scroll', () => {
        if (!state.active || ticking) return
        ticking = true
        requestAnimationFrame(() => {
            if (state.active) {
                if (!state.hidden && scrollY > 40) setChrome(true)
                setPage(currentPage())
            }
            ticking = false
        })
        clearTimeout(idleTimer)
        idleTimer = setTimeout(saveProgress, 250)
    }, { passive: true })
    window.addEventListener('keydown', event => {
        if (!state.active || event.target.closest('input')) return
        const chapters = ordered()
        const index = chapters.findIndex(chapter => chapter.id === state.id)
        if (event.key === 'ArrowLeft' && chapters[index - 1]) go(route(state.key, chapters[index - 1].id))
        if (event.key === 'ArrowRight' && chapters[index + 1]) go(route(state.key, chapters[index + 1].id))
    })
    window.addEventListener('pagehide', saveProgress)
}

export async function showMangaReader(key, id) {
    wire()
    saveProgress()
    state.ctrl?.abort()
    const ctrl = new AbortController()
    const gen = ++state.gen
    Object.assign(state, { active: true, key, id, ctrl, series: null, chapters: [], chapter: null, content: null, page: 0 })
    reader.classList.add('active')
    document.documentElement.classList.add('manga-reading')
    document.body.classList.add('manga-reading')
    document.body.style.background = '#070707'
    setChrome(false)
    closeDrawer()
    $('#mr-title').textContent = 'Loading chapter…'
    $('#mr-pos').textContent = ''
    $('#mr-progress').style.width = '0'
    $('#mr-step').innerHTML = ''
    pages.innerHTML = '<div class="spinner"></div>'

    try {
        const [series, chapterData, content] = await Promise.all([
            getMangaSeries(key, { signal: ctrl.signal }),
            getMangaChapters(key, { signal: ctrl.signal }),
            getMangaChapter(key, id, { signal: ctrl.signal }),
        ])
        if (!stillHere(key, id, gen)) return
        const chapter = chapterData.chapters.find(item => item.id === id)
        if (!chapter) throw new Error('chapter is no longer available')
        Object.assign(state, { series, chapters: chapterData.chapters, chapter, content })
        $('#mr-title').textContent = `${series.title} · ${chapterLabel(chapter)}`
        renderPages(content)
        const read = readSet(key)
        if (!read.has(id)) { read.add(id); saveRead(key, read) }
        posSet(key, { id, page: posGet(key)?.id === id ? posGet(key).page || 0 : 0, at: Date.now() })
        updateLibrary()
    } catch (error) {
        if (stillHere(key, id, gen)) showError(error.name === 'AbortError' ? 'Chapter request stopped' : error.message || 'Couldn’t load this chapter')
    }
}

export function closeMangaReader() {
    if (!state.active) return
    saveProgress()
    state.active = false
    state.ctrl?.abort()
    state.ctrl = null
    state.gen++
    clearTimeout(idleTimer)
    closeDrawer()
    reader.classList.remove('active', 'hide-chrome')
    document.documentElement.classList.remove('manga-reading')
    document.body.classList.remove('manga-reading')
    document.body.style.background = ''
}
