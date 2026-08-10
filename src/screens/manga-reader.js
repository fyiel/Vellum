import { getMangaChapter, getMangaChapters, getMangaSeries, mangaErrorMessage, mangaPageUrl, orderMangaChapters, parseMangaKey } from '../lib/manga-api.js'
import { go, parseHash } from '../lib/router.js'
import { posGet, posSet, readSet, saveRead, touchLibrary } from '../lib/store.js'
import { $, esc } from '../lib/dom.js'

const reader = $('#mreader')
const pages = $('#mr-pages')
const drawer = $('#mdrawer')
const drawerBackdrop = $('#mdrawer-backdrop')
const chrome = reader.querySelectorAll('.mreader-chrome')
const otherSheets = ['#drawer', '#drawer-backdrop', '#sheet', '#sheet-backdrop'].map(selector => $(selector))
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
const DRAWER_BATCH = 400

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
    loadObserver: null,
    pageObserver: null,
    nextPrefetched: false,
    streaming: false,
    pageBase: 0,
    pageSeq: 0,
    firstImageMeasured: false,
    drawerFocus: null,
    drawerLimit: DRAWER_BATCH,
}

const route = (key, id) => `#/manga/read/${encodeURIComponent(key)}/${encodeURIComponent(id)}`
const seriesRoute = key => `#/manga/series/${encodeURIComponent(key)}`
const chapterLabel = chapter => chapter?.number == null ? (chapter?.title || 'Special') : `Ch. ${chapter.number}`
const SOURCE = { mf: 'MangaFire', mh: 'MangaHub' }
const stillHere = (key, id, gen) => {
    const current = parseHash()
    return state.active && state.gen === gen && current.name === 'manga-read' && current.key === key && current.id === id
}

const ordered = () => orderMangaChapters(state.chapters)

function adjacentChapter(offset) {
    const chapters = ordered()
    const index = chapters.findIndex(chapter => chapter.id === state.id)
    return chapters[index + offset]
}

function beginMeasure() {
    try {
        performance.clearMarks('vellum:manga-reader:start')
        performance.clearMeasures('vellum:manga-reader:metadata')
        performance.clearMeasures('vellum:manga-reader:first-image')
        performance.mark('vellum:manga-reader:start')
    } catch {}
}

function measure(name) {
    try { performance.measure(name, 'vellum:manga-reader:start') } catch {}
}

function setReaderState(value) {
    reader.dataset.state = value
    reader.setAttribute('aria-busy', String(value === 'loading'))
    pages.setAttribute('aria-busy', String(value === 'loading'))
}

function setChrome(hidden) {
    state.hidden = hidden
    reader.classList.toggle('hide-chrome', hidden)
    chrome.forEach(item => {
        item.inert = hidden
        item.setAttribute('aria-hidden', String(hidden))
    })
}

function pageElement(index) {
    return pages.querySelector(`[data-page="${state.pageBase + index}"]`)
}

function loadPage(index, bust = false) {
    const figure = pageElement(index)
    const image = figure?.querySelector('img')
    if (!image || (image.hasAttribute('src') && !bust)) return
    let src = image.dataset.src
    if (bust) {
        const url = new URL(src, location.href)
        url.searchParams.set('_retry', Date.now())
        src = url.href
    }
    figure.classList.remove('failed', 'loaded', 'dormant')
    figure.classList.add('loading')
    figure.setAttribute('aria-busy', 'true')
    image.src = src
}

function trimImages(center) {
    // figure data-page is global across streamed chapters, the trim window is chapter relative
    const anchor = state.pageBase + center
    pages.querySelectorAll('.manga-page').forEach(figure => {
        if (Math.abs(Number(figure.dataset.page) - anchor) <= 7) return
        const image = figure.querySelector('img')
        if (!image?.complete || !image.naturalWidth) return
        image.removeAttribute('src')
        figure.classList.remove('loaded', 'loading')
        figure.classList.add('dormant')
        figure.setAttribute('aria-busy', 'false')
    })
    trimChapters()
}

function trimChapters() {
    // hard DOM bound of ~2 chapters (current plus one behind), the oldest chapter
    // drops wholesale, no virtualization library, just slice it off the front
    while (pages.querySelectorAll('.mr-chapter-divider').length > 1) {
        const cutoff = pages.querySelector('.mr-chapter-divider')
        const height = document.documentElement.scrollHeight
        for (let node = cutoff.previousSibling; node;) {
            const prev = node.previousSibling
            node.remove()
            node = prev
        }
        cutoff.remove()
        window.scrollTo(0, Math.max(0, scrollY - (height - document.documentElement.scrollHeight)))
    }
}

function prefetchNextChapter() {
    if (state.nextPrefetched || navigator.connection?.saveData) return
    const next = adjacentChapter(1)
    if (!next) return
    state.nextPrefetched = true
    const key = state.key
    getMangaChapter(key, next.id).then(content => {
        if (!state.active || state.key !== key || !content.pages[0]) return
        const image = new Image()
        image.decoding = 'async'
        image.src = mangaPageUrl(content.pages[0])
    }).catch(() => {})
}

async function maybeStreamNext() {
    if (!state.active || state.streaming) return
    const gen = state.gen
    const key = state.key
    const next = adjacentChapter(1)
    if (!next) return
    state.streaming = true
    try {
        // the fetch hits the prefetchNextChapter cache, or starts it when saveData skipped that
        const content = await getMangaChapter(key, next.id)
        if (!state.active || state.gen !== gen || !content?.pages.length) return
        // the finished chapter is marked read and parked at its end (setCurrent pattern, reader.js:427-446)
        const done = state.id
        const read = readSet(key)
        if (!read.has(done)) { read.add(done); saveRead(key, read) }
        posSet(key, { id: done, page: state.content.pages.length - 1, at: Date.now() })
        state.id = next.id
        state.chapter = next
        state.content = content
        state.page = 0
        state.pageBase = state.pageSeq
        state.pageSeq += content.pages.length
        const total = content.pages.length
        pages.insertAdjacentHTML('beforeend', `<div class="mr-chapter-divider" role="separator"><span>${esc(chapterLabel(next))}</span></div>${content.pages.map((page, index) => figureHtml(page, state.pageBase + index, total)).join('')}`)
        // the URL deliberately stays on the landing chapter, stillHere must keep matching
        $('#mr-title').textContent = `${state.series.title} · ${chapterLabel(next)}`
        observePages()
        setPage(0)
        updateLibrary()
    } catch {} finally {
        state.nextPrefetched = false
        if (state.gen === gen) state.streaming = false
    }
}

function setPage(index) {
    if (!state.content?.pages.length) return
    const next = Math.min(state.content.pages.length - 1, Math.max(0, index))
    state.page = next
    $('#mr-pos').textContent = `Page ${next + 1} / ${state.content.pages.length}`
    $('#mr-progress').style.width = `${((next + 1) / state.content.pages.length * 100).toFixed(2)}%`
    for (let i = Math.max(0, next - 2); i <= Math.min(state.content.pages.length - 1, next + 3); i++) loadPage(i)
    trimImages(next)
    if (next >= state.content.pages.length - 2) prefetchNextChapter()
    if (next >= state.content.pages.length - 1) maybeStreamNext()
}

function saveProgress() {
    if (!state.active || !state.id || !state.content) return
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

function jumpPage(offset) {
    const next = Math.min((state.content?.pages.length || 1) - 1, Math.max(0, state.page + offset))
    if (next === state.page) return
    loadPage(next)
    pageElement(next)?.scrollIntoView({ block: 'start', behavior: reducedMotion.matches ? 'auto' : 'smooth' })
    setPage(next)
}

function renderSteps() {
    const previous = adjacentChapter(-1)
    const next = adjacentChapter(1)
    $('#mr-step').innerHTML = `${previous ? `<a href="${route(state.key, previous.id)}" aria-label="Previous chapter, ${esc(chapterLabel(previous))}"><span>Previous</span>${esc(chapterLabel(previous))}</a>` : '<span></span>'}
      ${next ? `<a href="${route(state.key, next.id)}" aria-label="Next chapter, ${esc(chapterLabel(next))}"><span>Next</span>${esc(chapterLabel(next))}</a>` : '<span></span>'}`
}

function observePages() {
    state.loadObserver?.disconnect()
    state.pageObserver?.disconnect()
    // figures from streamed chapters are also observed, only the current chapter may drive pages
    const inChapter = index => index >= 0 && index < (state.content?.pages.length || 0)
    state.loadObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            const index = Number(entry.target.dataset.page) - state.pageBase
            if (inChapter(index)) loadPage(index)
        })
    }, { rootMargin: '150% 0px' })
    state.pageObserver = new IntersectionObserver(entries => {
        const visible = entries.filter(entry => entry.isIntersecting)
            .map(entry => ({ entry, index: Number(entry.target.dataset.page) - state.pageBase }))
            .filter(item => inChapter(item.index))
            .sort((a, b) => b.entry.intersectionRatio - a.entry.intersectionRatio)[0]
        if (visible) setPage(visible.index)
    }, { rootMargin: '-48% 0px -48% 0px', threshold: 0 })
    pages.querySelectorAll('.manga-page').forEach(figure => {
        state.loadObserver.observe(figure)
        state.pageObserver.observe(figure)
    })
}

const figureHtml = (page, pageIndex, total) => {
    const local = pageIndex - state.pageBase
    const ratio = page.width && page.height ? ` style="aspect-ratio:${esc(page.width)} / ${esc(page.height)}"` : ''
    const size = `${page.width ? ` width="${esc(page.width)}"` : ''}${page.height ? ` height="${esc(page.height)}"` : ''}`
    return `<figure class="manga-page" data-page="${pageIndex}" aria-busy="true"${ratio}>
      <img data-src="${esc(mangaPageUrl(page))}"${size} decoding="async" alt="Page ${local + 1} of ${total}">
      <figcaption><span>Page ${local + 1} couldn’t load</span><button type="button" data-page-retry="${local}">Retry page ${local + 1}</button></figcaption>
      <div class="manga-page-loading" aria-hidden="true"><span>Loading page ${local + 1}</span></div>
    </figure>`
}

function renderPages(content) {
    const total = content.pages.length
    state.pageBase = 0
    state.pageSeq = total
    pages.innerHTML = content.pages.map((page, index) => figureHtml(page, index, total)).join('')
    renderSteps()
    observePages()

    const saved = posGet(state.key)
    const target = saved?.id === state.id ? Math.min(total - 1, Math.max(0, Number(saved.page) || 0)) : 0
    loadPage(target)
    loadPage(Math.min(total - 1, target + 1))
    setPage(target)
    requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!state.active) return
        window.scrollTo(0, target ? pageElement(target)?.offsetTop || 0 : 0)
        reader.focus({ preventScroll: true })
    }))
}

function showError(message) {
    const offline = !navigator.onLine
    setReaderState(offline ? 'offline' : 'error')
    pages.innerHTML = `<div class="mreader-empty" role="alert">${esc(offline ? 'You’re offline. Reconnect to load this chapter.' : message)}<button id="mr-retry" type="button">Try again</button></div>`
    $('#mr-step').innerHTML = ''
    $('#mr-retry').onclick = () => showMangaReader(state.key, state.id)
}

function renderDrawer() {
    const query = $('#mdw-q').value.trim().toLowerCase()
    const read = readSet(state.key)
    const rows = state.chapters.filter(chapter => !query || `${chapterLabel(chapter)} ${chapter.title || ''}`.toLowerCase().includes(query))
    const shown = rows.slice(0, state.drawerLimit)
    $('#mdrawer-list').innerHTML = shown.length ? `${shown.map(chapter => `<a class="chap${read.has(chapter.id) ? ' read' : ''}${chapter.id === state.id ? ' current' : ''}" href="${route(state.key, chapter.id)}"${chapter.id === state.id ? ' aria-current="page"' : ''}>
      <span class="n">${esc(chapterLabel(chapter))}</span><span class="t">${esc(chapter.title || '')}</span><span class="dot"></span></a>`).join('')
      }${shown.length < rows.length ? `<button type="button" class="drawer-more" id="mdrawer-more">Show ${Math.min(DRAWER_BATCH, rows.length - shown.length)} more</button>` : ''}`
        : '<div class="empty" role="status">No matching chapters</div>'
}

function openDrawer() {
    if (!state.chapters.length) return
    state.drawerFocus = document.activeElement
    state.drawerLimit = DRAWER_BATCH
    $('#mdw-q').value = ''
    renderDrawer()
    drawer.classList.add('open')
    drawerBackdrop.classList.add('open')
    drawer.setAttribute('aria-hidden', 'false')
    drawerBackdrop.setAttribute('aria-hidden', 'false')
    $('#mr-list').setAttribute('aria-expanded', 'true')
    reader.inert = true
    $('#mdrawer-list .current')?.scrollIntoView({ block: 'center' })
    $('#mdw-q').focus()
}

function closeDrawer(restoreFocus = true) {
    const wasOpen = drawer.classList.contains('open')
    drawer.classList.remove('open')
    drawerBackdrop.classList.remove('open')
    drawer.setAttribute('aria-hidden', 'true')
    drawerBackdrop.setAttribute('aria-hidden', 'true')
    $('#mr-list').setAttribute('aria-expanded', 'false')
    reader.inert = false
    if (wasOpen && restoreFocus && state.active) state.drawerFocus?.focus({ preventScroll: true })
    state.drawerFocus = null
}

function trapDrawerFocus(event) {
    if (!drawer.classList.contains('open')) return false
    if (event.key === 'Escape') {
        event.preventDefault()
        closeDrawer()
        return true
    }
    if (event.key !== 'Tab') return false
    const focusable = [...drawer.querySelectorAll('input, a[href], button:not([disabled])')]
    if (!focusable.length) return false
    const first = focusable[0]
    const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    return true
}

let wired = false
let idleTimer = null
function wire() {
    if (wired) return
    wired = true
    $('#mr-back').onclick = () => go(seriesRoute(state.key))
    $('#mr-list').onclick = openDrawer
    drawerBackdrop.onclick = () => closeDrawer()
    $('#mdrawer-list').addEventListener('click', event => { if (event.target.closest('a')) closeDrawer(false) })
    $('#mdrawer-list').addEventListener('click', event => {
        if (!event.target.closest('#mdrawer-more')) return
        const before = $('#mdrawer-list').querySelectorAll('.chap').length
        state.drawerLimit += DRAWER_BATCH
        renderDrawer()
        $('#mdrawer-list').querySelectorAll('.chap')[before]?.focus({ preventScroll: true })
    })
    $('#mdw-q').addEventListener('input', () => { state.drawerLimit = DRAWER_BATCH; renderDrawer() })
    pages.addEventListener('load', event => {
        if (event.target.tagName !== 'IMG') return
        const figure = event.target.closest('.manga-page')
        figure?.classList.remove('loading', 'failed', 'dormant')
        figure?.classList.add('loaded')
        figure?.setAttribute('aria-busy', 'false')
        if (figure && !figure.style.aspectRatio && event.target.naturalWidth && event.target.naturalHeight) {
            figure.style.aspectRatio = `${event.target.naturalWidth} / ${event.target.naturalHeight}`
        }
        if (!state.firstImageMeasured) {
            state.firstImageMeasured = true
            measure('vellum:manga-reader:first-image')
        }
    }, true)
    pages.addEventListener('error', event => {
        if (event.target.tagName !== 'IMG') return
        const figure = event.target.closest('.manga-page')
        figure?.classList.remove('loading', 'loaded')
        figure?.classList.add('failed')
        figure?.setAttribute('aria-busy', 'false')
        const label = figure?.querySelector('figcaption span')
        if (label && !navigator.onLine) label.textContent = `Page ${Number(figure.dataset.page) + 1} is unavailable offline`
    }, true)
    pages.addEventListener('click', event => {
        const retry = event.target.closest('[data-page-retry]')
        if (retry) {
            loadPage(Number(retry.dataset.pageRetry), true)
            return
        }
        if (!event.target.closest('button, a')) setChrome(!state.hidden)
    })
    window.addEventListener('scroll', () => {
        if (!state.active) return
        if (!state.hidden && scrollY > 40 && !document.activeElement.closest('.mreader-chrome')) setChrome(true)
        clearTimeout(idleTimer)
        idleTimer = setTimeout(saveProgress, 200)
    }, { passive: true })
    window.addEventListener('keydown', event => {
        if (!state.active || trapDrawerFocus(event) || event.target.closest('input, textarea, select')) return
        if (event.key === 'Escape') { setChrome(false); return }
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const offset = event.key === 'ArrowLeft' ? -1 : 1
        if (event.shiftKey) {
            const chapter = adjacentChapter(offset)
            if (chapter) go(route(state.key, chapter.id))
        } else jumpPage(offset)
    })
    window.addEventListener('pagehide', saveProgress)
    document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress() })
}

export async function showMangaReader(key, id) {
    wire()
    saveProgress()
    state.ctrl?.abort()
    state.loadObserver?.disconnect()
    state.pageObserver?.disconnect()
    const ctrl = new AbortController()
    const gen = ++state.gen
    Object.assign(state, {
        active: true, key, id, ctrl, series: null, chapters: [], chapter: null, content: null,
        page: 0, nextPrefetched: false, streaming: false, firstImageMeasured: false,
    })
    beginMeasure()
    reader.classList.add('active')
    document.documentElement.classList.add('manga-reading')
    document.body.classList.add('manga-reading')
    document.body.style.background = '#070707'
    otherSheets.forEach(item => { item.inert = true })
    setReaderState('loading')
    setChrome(false)
    closeDrawer(false)
    window.scrollTo(0, 0)
    $('#mr-title').textContent = 'Loading chapter…'
    $('#mr-pos').textContent = ''
    $('#mr-progress').style.width = '0'
    $('#mr-step').innerHTML = ''
    pages.innerHTML = '<div class="mreader-loading" role="status"><div class="spinner" aria-hidden="true"></div><span>Loading chapter…</span></div>'

    try {
        const [series, chapterData, content] = await Promise.all([
            getMangaSeries(key, { signal: ctrl.signal }),
            getMangaChapters(key, { signal: ctrl.signal }),
            getMangaChapter(key, id, { signal: ctrl.signal }),
        ])
        if (!stillHere(key, id, gen)) return
        const chapter = chapterData.chapters.find(item => item.id === id)
        if (!chapter) throw new Error('Chapter is no longer available')
        Object.assign(state, { series, chapters: chapterData.chapters, chapter, content })
        $('#mr-title').textContent = `${series.title} · ${chapterLabel(chapter)}`
        renderPages(content)
        setReaderState('ready')
        measure('vellum:manga-reader:metadata')
        const read = readSet(key)
        if (!read.has(id)) { read.add(id); saveRead(key, read) }
        const saved = posGet(key)
        posSet(key, { id, page: saved?.id === id ? saved.page || 0 : 0, at: Date.now() })
        updateLibrary()
    } catch (error) {
        if (stillHere(key, id, gen)) showError(error.name === 'AbortError' ? 'Chapter request stopped' : mangaErrorMessage(error, 'Couldn’t load this chapter'))
    }
}

export function closeMangaReader() {
    if (!state.active) return
    saveProgress()
    state.active = false
    state.ctrl?.abort()
    state.ctrl = null
    state.gen++
    state.loadObserver?.disconnect()
    state.pageObserver?.disconnect()
    state.loadObserver = null
    state.pageObserver = null
    clearTimeout(idleTimer)
    closeDrawer(false)
    reader.classList.remove('active', 'hide-chrome')
    reader.inert = false
    otherSheets.forEach(item => { item.inert = false })
    setReaderState('idle')
    pages.replaceChildren()
    $('#mr-step').replaceChildren()
    $('#mdrawer-list').replaceChildren()
    document.documentElement.classList.remove('manga-reading')
    document.body.classList.remove('manga-reading')
    document.body.style.background = ''
}
