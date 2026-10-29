import { getMangaChapter, getMangaChapters, getMangaSeries, mangaErrorMessage, mangaPageUrl, orderMangaChapters, parseMangaKey } from '../lib/manga-api.js'
import { loadDownloadedMangaChapter } from '../lib/dl-manga.js'
import { go, parseHash } from '../lib/router.js'
import { library, loadMangaReaderSettings, posGet, posSet, readSet, saveMangaReaderSettings, saveRead, touchLibrary } from '../lib/store.js'
import { $, esc } from '../lib/dom.js'
import { mangaImageBounds } from '../lib/manga-image.js'

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
    mode: 'scroll',
    direction: 'ltr',
    crop: true,
    enterFromEnd: null,
    hidden: false,
    loadObserver: null,
    pageObserver: null,
    nextPrefetched: false,
    streaming: false,
    scrolled: false,
    pagePrimed: false,
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
    $('#mr-mode').disabled = value !== 'ready'
    $('#mr-crop').disabled = value !== 'ready'
}

function setChrome(hidden) {
    state.hidden = hidden
    reader.classList.toggle('hide-chrome', hidden)
    chrome.forEach(item => {
        item.inert = hidden
        item.setAttribute('aria-hidden', String(hidden))
    })
    $('#mr-step').inert = state.mode === 'paged' && hidden
    $('#mr-step').setAttribute('aria-hidden', String(state.mode === 'paged' && hidden))
}

function applySettings() {
    reader.dataset.mode = state.mode
    reader.dataset.direction = state.direction
    $('#mr-mode').value = state.mode
    $('#mr-direction').value = state.direction
    $('#mr-direction').hidden = state.mode !== 'paged'
    $('#mr-crop').hidden = state.mode !== 'paged'
    $('#mr-crop').setAttribute('aria-pressed', String(state.crop))
    $('#mr-prev').hidden = state.mode !== 'paged'
    $('#mr-next').hidden = state.mode !== 'paged'
    $('#mr-prev').textContent = state.direction === 'rtl' ? '›' : '‹'
    $('#mr-next').textContent = state.direction === 'rtl' ? '‹' : '›'
    setChrome(false)
}

function changeSettings() {
    if (!state.content) return
    saveProgress()
    state.gen++
    state.mode = $('#mr-mode').value
    state.direction = $('#mr-direction').value
    saveMangaReaderSettings(state.key, { mode: state.mode, direction: state.direction, crop: state.crop })
    state.streaming = false
    applySettings()
    renderPages(state.content)
}

function pageElement(index) {
    return pages.querySelector(`[data-page="${state.pageBase + index}"]`)
}

function fitCurrentPage() {
    if (!state.active || state.mode !== 'paged') return
    const figure = pageElement(state.page)
    const image = figure?.querySelector('img')
    if (!image?.naturalWidth || !figure.clientWidth || !figure.clientHeight) return
    const crop = state.crop ? mangaImageBounds(image) : { x: 0, y: 0, width: 1, height: 1 }
    const width = image.naturalWidth * crop.width
    const height = image.naturalHeight * crop.height
    const scale = Math.min(figure.clientWidth / width, figure.clientHeight / height)
    const frame = image.parentElement
    frame.style.width = `${width * scale}px`
    frame.style.height = `${height * scale}px`
    image.style.width = `${image.naturalWidth * scale}px`
    image.style.height = `${image.naturalHeight * scale}px`
    image.style.left = `${-image.naturalWidth * crop.x * scale}px`
    image.style.top = `${-image.naturalHeight * crop.y * scale}px`
    figure.dataset.cropped = String(crop.width < 1 || crop.height < 1)
}

function updatePageLayout() {
    if (!state.active || state.mode !== 'paged') return
    reader.style.setProperty('--mr-top-height', `${reader.querySelector('.mreader-top').offsetHeight}px`)
    reader.style.setProperty('--mr-bottom-height', `${reader.querySelector('.mreader-bottom').offsetHeight}px`)
    reader.style.setProperty('--mr-step-height', `${$('#mr-step').offsetHeight}px`)
    fitCurrentPage()
}

function loadFigure(figure, bust = false) {
    const image = figure?.querySelector('img')
    if (!image) return
    image.fetchPriority = Number(figure.dataset.page) === state.pageBase + state.page ? 'high' : 'low'
    if (image.hasAttribute('src') && !bust) return
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

function loadPage(index, bust = false) {
    let figure = pageElement(index)
    const page = state.content?.pages[index]
    if (!figure && state.mode === 'paged' && page) {
        pages.insertAdjacentHTML('beforeend', figureHtml(page, index, state.content.pages.length))
        figure = pageElement(index)
        figure.hidden = index !== state.page
    }
    loadFigure(figure, bust)
}

function preloadPages() {
    if (!state.content || navigator.connection?.saveData) return
    for (let i = Math.max(0, state.page - 2); i <= Math.min(state.content.pages.length - 1, state.page + 3); i++) loadPage(i)
    if (state.page >= state.content.pages.length - 2) prefetchNextChapter()
}

function trimImages(center) {
    // figure data-page is global across streamed chapters, the trim window is chapter relative
    const anchor = state.pageBase + center
    pages.querySelectorAll('.manga-page').forEach(figure => {
        if (Math.abs(Number(figure.dataset.page) - anchor) <= 7) return
        const image = figure.querySelector('img')
        if (state.mode === 'paged') {
            image?.removeAttribute('src')
            figure.remove()
            return
        }
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
        // never cut a chapter the reader is inside or within one viewport of (trimTop, reader.js:414)
        if (cutoff.offsetTop + cutoff.offsetHeight > scrollY - innerHeight) break
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
    if (!state.active || state.mode !== 'scroll' || state.streaming) return
    const gen = state.gen
    const key = state.key
    const next = adjacentChapter(1)
    if (!next) return
    state.streaming = true
    try {
        // the fetch hits the prefetchNextChapter cache, or starts it when saveData skipped that
        const content = await getMangaChapter(key, next.id)
        if (!state.active || state.mode !== 'scroll' || state.gen !== gen || !content?.pages.length) return
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
        // replace the URL with the streamed chapter so a refresh resumes it, stillHere
        // keeps matching because it checks the current hash, id and generation
        history.replaceState(null, '', route(state.key, next.id))
        posSet(state.key, { id: state.id, page: state.page, at: Date.now() })
        $('#mr-title').textContent = `${state.series.title} · ${chapterLabel(next)}`
        renderSteps()
        observePages()
        setPage(0)
        updateLibrary()
    } catch {} finally {
        state.nextPrefetched = false
        if (state.gen === gen) state.streaming = false
    }
}

function setPage(index, fromScroll = false) {
    if (!state.content?.pages.length) return
    const next = Math.min(state.content.pages.length - 1, Math.max(0, index))
    state.page = next
    $('#mr-pos').textContent = `Page ${next + 1} / ${state.content.pages.length}`
    $('#mr-progress').style.width = `${((next + 1) / state.content.pages.length * 100).toFixed(2)}%`
    if (state.mode === 'paged') {
        pages.querySelectorAll('.manga-page').forEach(figure => {
            figure.hidden = Number(figure.dataset.page) !== next
            figure.querySelector('img').fetchPriority = figure.hidden ? 'low' : 'high'
        })
        $('#mr-prev').disabled = next === 0 && !adjacentChapter(-1)
        $('#mr-next').disabled = next === state.content.pages.length - 1 && !adjacentChapter(1)
    }
    loadPage(next)
    if (state.mode !== 'paged' || pageElement(next)?.classList.contains('loaded')) preloadPages()
    trimImages(next)
    fitCurrentPage()
    // streaming needs real scroll-to-the-last-page evidence, an open (or restored)
    // chapter must never auto-stream
    if (state.mode === 'scroll' && next >= state.content.pages.length - 1 && (fromScroll || state.scrolled)) maybeStreamNext()
    if (state.mode === 'paged') saveProgress()
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
    if (!state.content) return
    const last = (state.content?.pages.length || 1) - 1
    if (state.mode === 'paged') {
        if ((offset > 0 && state.page === last) || (offset < 0 && state.page === 0)) {
            const chapter = adjacentChapter(offset)
            if (chapter) {
                state.enterFromEnd = offset < 0 ? chapter.id : null
                go(route(state.key, chapter.id))
            }
        } else setPage(state.page + offset)
        return
    }
    if (offset > 0 && state.page >= last) {
        maybeStreamNext()
        return
    }
    if (offset < 0 && state.page <= 0) return
    const next = Math.min(last, Math.max(0, state.page + offset))
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
    state.scrolled = false
    state.pagePrimed = false
    if (state.mode === 'paged') return
    // figures from streamed chapters are observed too and stay loadable when scrolled
    // back into, but only the current chapter may drive pagination
    const inChapter = index => index >= 0 && index < (state.content?.pages.length || 0)
    state.loadObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (entry.isIntersecting) loadFigure(entry.target)
        })
    }, { rootMargin: '150% 0px' })
    state.pageObserver = new IntersectionObserver(entries => {
        const primed = state.pagePrimed
        state.pagePrimed = true
        const visible = entries.filter(entry => entry.isIntersecting)
            .map(entry => ({ entry, index: Number(entry.target.dataset.page) - state.pageBase }))
            .filter(item => inChapter(item.index))
            .sort((a, b) => b.entry.intersectionRatio - a.entry.intersectionRatio)[0]
        if (visible) setPage(visible.index, primed)
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
      <div class="manga-page-image"><img data-src="${esc(mangaPageUrl(page))}"${size} crossorigin="anonymous" decoding="auto" alt="Page ${local + 1} of ${total}"></div>
      <figcaption><span>Page ${local + 1} couldn’t load</span><button type="button" data-page-retry="${local}">Retry page ${local + 1}</button></figcaption>
      <div class="manga-page-loading" aria-hidden="true"><span>Loading page ${local + 1}</span></div>
    </figure>`
}

function renderPages(content, targetPage) {
    const total = content.pages.length
    state.pageBase = 0
    state.pageSeq = total
    pages.innerHTML = state.mode === 'paged' ? '' : content.pages.map((page, index) => figureHtml(page, index, total)).join('')
    renderSteps()
    observePages()

    const saved = posGet(state.key)
    const target = targetPage ?? (saved?.id === state.id ? Math.min(total - 1, Math.max(0, Number(saved.page) || 0)) : 0)
    setPage(target)
    const gen = state.gen
    requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!state.active || state.gen !== gen) return
        if (state.mode === 'paged') window.scrollTo(0, 0)
        else {
            const figure = pageElement(target)
            window.scrollTo(0, target && figure ? figure.offsetTop - Math.max(0, (innerHeight - figure.offsetHeight) / 2) : 0)
        }
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
    $('#mr-mode').onchange = changeSettings
    $('#mr-direction').onchange = changeSettings
    $('#mr-crop').onclick = () => {
        state.crop = !state.crop
        saveMangaReaderSettings(state.key, { mode: state.mode, direction: state.direction, crop: state.crop })
        $('#mr-crop').setAttribute('aria-pressed', String(state.crop))
        fitCurrentPage()
    }
    const layoutObserver = new ResizeObserver(updatePageLayout)
    for (const element of [pages, ...chrome, $('#mr-step')]) layoutObserver.observe(element)
    $('#mr-prev').onclick = () => jumpPage(-1)
    $('#mr-next').onclick = () => jumpPage(1)
    const fullscreenBtn = $('#mr-fullscreen')
    if (fullscreenBtn && document.fullscreenEnabled) {
        fullscreenBtn.hidden = false
        fullscreenBtn.onclick = async () => {
            try {
                if (document.fullscreenElement) await document.exitFullscreen?.()
                else await document.documentElement.requestFullscreen?.()
            } catch {}
        }
    }
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
            // unknown-dims figures grow from the estimate to the real ratio here; compensate
            // above the viewport so the page under the reader doesn't drift (reader.js:86-98)
            const before = figure.getBoundingClientRect()
            figure.style.aspectRatio = `${event.target.naturalWidth} / ${event.target.naturalHeight}`
            const grown = figure.getBoundingClientRect().height - before.height
            if (state.mode === 'scroll' && grown && before.top < 0) window.scrollBy(0, grown)
        }
        if (figure === pageElement(state.page) && !state.firstImageMeasured) {
            state.firstImageMeasured = true
            measure('vellum:manga-reader:first-image')
        }
        if (figure === pageElement(state.page)) {
            fitCurrentPage()
            preloadPages()
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
        if (event.target.closest('button, a')) return
        if (state.mode === 'paged') {
            const rect = pages.getBoundingClientRect()
            const x = (event.clientX - rect.left) / rect.width
            if (x < .3 || x > .7) {
                jumpPage((x < .3 ? -1 : 1) * (state.direction === 'rtl' ? -1 : 1))
                return
            }
        }
        setChrome(!state.hidden)
    })
    let touch = null
    pages.addEventListener('touchstart', event => {
        touch = state.mode === 'paged' && event.touches.length === 1 && !event.target.closest('button, a')
            ? event.touches[0] : null
    }, { passive: true })
    pages.addEventListener('touchcancel', () => { touch = null }, { passive: true })
    pages.addEventListener('touchend', event => {
        const start = touch
        touch = null
        if (!start || state.mode !== 'paged' || event.touches.length) return
        const end = [...event.changedTouches].find(item => item.identifier === start.identifier)
        if (!end) return
        const dx = end.clientX - start.clientX
        const dy = end.clientY - start.clientY
        if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return
        event.preventDefault()
        jumpPage((dx < 0 ? 1 : -1) * (state.direction === 'rtl' ? -1 : 1))
    }, { passive: false })
    window.addEventListener('scroll', () => {
        if (!state.active || state.mode === 'paged') return
        state.scrolled = true
        if (!state.hidden && scrollY > 40 && !document.activeElement.closest('.mreader-chrome')) setChrome(true)
        clearTimeout(idleTimer)
        idleTimer = setTimeout(saveProgress, 200)
    }, { passive: true })
    window.addEventListener('keydown', event => {
        if (!state.active || trapDrawerFocus(event) || drawer.classList.contains('open') || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input, textarea, select')) return
        if (event.key === 'Escape') { setChrome(false); return }
        if (state.mode === 'paged') {
            if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault()
                setPage(event.key === 'Home' ? 0 : state.content?.pages.length - 1)
                return
            }
            if (event.key === 'PageUp' || event.key === 'PageDown') {
                event.preventDefault()
                jumpPage(event.key === 'PageUp' ? -1 : 1)
                return
            }
        }
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const offset = (event.key === 'ArrowLeft' ? -1 : 1) * (state.mode === 'paged' && state.direction === 'rtl' ? -1 : 1)
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
    const fromEnd = state.key === key && state.enterFromEnd === id
    state.enterFromEnd = null
    saveProgress()
    for (const page of state.content?.pages || []) {
        if (typeof page?.url === 'string' && page.url.startsWith('blob:')) URL.revokeObjectURL(page.url)
    }
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
    delete reader.dataset.mode
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

    let local = null
    try {
        // a downloaded chapter reads from disk even online — it is the offline copy
        local = await loadDownloadedMangaChapter(key, id).catch(() => null)
        const [series, chapterData, content] = await Promise.all([
            getMangaSeries(key, { signal: ctrl.signal }),
            getMangaChapters(key, { signal: ctrl.signal }),
            local ? Promise.resolve(local.content) : getMangaChapter(key, id, { signal: ctrl.signal }),
        ])
        if (!stillHere(key, id, gen)) return
        const chapter = chapterData.chapters.find(item => item.id === id)
        if (!chapter) throw new Error('Chapter is no longer available')
        Object.assign(state, { series, chapters: chapterData.chapters, chapter, content })
        Object.assign(state, loadMangaReaderSettings(key, series.format))
        applySettings()
        $('#mr-title').textContent = `${series.title} · ${chapterLabel(chapter)}`
        renderPages(content, fromEnd ? content.pages.length - 1 : undefined)
        setReaderState('ready')
        measure('vellum:manga-reader:metadata')
        const read = readSet(key)
        if (!read.has(id)) { read.add(id); saveRead(key, read) }
        const saved = posGet(key)
        posSet(key, { id, page: saved?.id === id ? saved.page || 0 : 0, at: Date.now() })
        updateLibrary()
    } catch (error) {
        if (!stillHere(key, id, gen)) return
        // network or provider failure: fall back to the downloaded copy when one exists
        local ??= await loadDownloadedMangaChapter(key, id).catch(() => null)
        if (local && stillHere(key, id, gen)) {
            Object.assign(state, {
                series: { title: local.entry.title, format: local.entry.format || library().find(entry => entry.slug === key)?.format },
                chapters: [],
                chapter: local.content.chapter,
                content: local.content,
            })
            Object.assign(state, loadMangaReaderSettings(key, state.series.format))
            applySettings()
            $('#mr-title').textContent = `${local.entry.title} · ${chapterLabel(local.content.chapter)}`
            renderPages(local.content, fromEnd ? local.content.pages.length - 1 : undefined)
            setReaderState('ready')
            return
        }
        showError(error.name === 'AbortError' ? 'Chapter request stopped' : mangaErrorMessage(error, 'Couldn’t load this chapter'))
    }
}

export function closeMangaReader() {
    if (!state.active) return
    saveProgress()
    // downloaded chapters hand out object URLs; hand them back
    for (const page of state.content?.pages || []) {
        if (typeof page?.url === 'string' && page.url.startsWith('blob:')) URL.revokeObjectURL(page.url)
    }
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
