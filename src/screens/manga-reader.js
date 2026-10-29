import { getMangaChapter, getMangaChapters, getMangaSeries, mangaErrorMessage, mangaPageUrl, orderMangaChapters, parseMangaKey } from '../lib/manga-api.js'
import { loadDownloadedMangaChapter } from '../lib/dl-manga.js'
import { go, parseHash } from '../lib/router.js'
import { library, loadMangaReaderSettings, posGet, posSet, readSet, saveMangaReaderSettings, saveRead, touchLibrary } from '../lib/store.js'
import { $, esc } from '../lib/dom.js'
import { mangaImageBounds } from '../lib/manga-image.js'
import { bindMangaImageZoom } from '../lib/manga-zoom.js'

const reader = $('#mreader')
const pages = $('#mr-pages')
const drawer = $('#mdrawer')
const drawerBackdrop = $('#mdrawer-backdrop')
const chrome = reader.querySelectorAll('.mreader-chrome')
const otherSheets = ['#drawer', '#drawer-backdrop', '#sheet', '#sheet-backdrop'].map(selector => $(selector))
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
const DRAWER_BATCH = 400
const chapterPreloads = new Map()
let imageZoom = null

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
    enterAt: null,
    hidden: false,
    loadObserver: null,
    pageObserver: null,
    streaming: false,
    streamJump: false,
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
    if (index < 0) return
    let next = index + offset
    while (chapters[index].number != null && chapters[next]?.number === chapters[index].number) next += offset
    return chapters[next]
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
    state.streamJump = false
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
    imageZoom?.refresh()
}

function updatePageLayout() {
    if (!state.active || state.mode !== 'paged') return
    reader.style.setProperty('--mr-top-height', `${reader.querySelector('.mreader-top').offsetHeight}px`)
    reader.style.setProperty('--mr-bottom-height', `${reader.querySelector('.mreader-bottom').offsetHeight}px`)
    reader.style.setProperty('--mr-step-height', `${$('#mr-step').offsetHeight}px`)
    fitCurrentPage()
}

function loadFigure(figure, bust = false) {
    let image = figure?.querySelector('img')
    if (!image) return
    image.fetchPriority = Number(figure.dataset.page) === state.pageBase + state.page ? 'high' : 'low'
    if (image.hasAttribute('src') && !bust) return
    let src = image.dataset.src
    if (!bust) {
        const preload = chapterPreloads.get(state.id)
        const warmed = preload?.images.get(src)
        if (warmed) {
            preload.images.delete(src)
            if (!warmed.complete || warmed.naturalWidth) {
                warmed.alt = image.alt
                warmed.dataset.src = src
                warmed.fetchPriority = image.fetchPriority
                image.replaceWith(warmed)
                image = warmed
            }
        }
    }
    if (bust) {
        const url = new URL(src, location.href)
        url.searchParams.set('_retry', Date.now())
        src = url.href
    }
    figure.classList.remove('failed', 'loaded', 'dormant')
    figure.classList.add('loading')
    figure.setAttribute('aria-busy', 'true')
    if (!image.hasAttribute('src') || bust) image.src = src
    if (image.complete && image.naturalWidth) imageLoaded(image)
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
    for (let i = state.page + 1; i <= Math.min(state.content.pages.length - 1, state.page + 5); i++) loadPage(i)
    for (let i = state.page - 1; i >= Math.max(0, state.page - 2); i--) loadPage(i)
    const rect = state.mode === 'scroll' ? pageElement(state.page)?.getBoundingClientRect() : null
    if (state.mode === 'paged' || (rect?.top < innerHeight * .52 && rect.bottom > innerHeight * .48)) prefetchChapter(1, state.page >= state.content.pages.length - 6)
    if (state.mode === 'paged' && state.page < 3) prefetchChapter(-1, true)
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

function clearChapterPreloads(keep = []) {
    for (const [id, preload] of chapterPreloads) {
        if (keep.includes(id)) continue
        preload.ctrl.abort()
        for (const image of preload.images.values()) image.removeAttribute('src')
        chapterPreloads.delete(id)
    }
}

function prefetchChapter(offset, warmImages) {
    if (navigator.connection?.saveData) return
    const chapter = adjacentChapter(offset)
    if (!chapter) return
    clearChapterPreloads([state.id, adjacentChapter(-1)?.id, adjacentChapter(1)?.id])
    const key = state.key
    let preload = chapterPreloads.get(chapter.id)
    if (state.streaming && offset > 0 && !preload) return
    if (!preload) {
        const ctrl = new AbortController()
        preload = { ctrl, images: new Map(), warming: 0, content: getMangaChapter(key, chapter.id, { signal: ctrl.signal }) }
        chapterPreloads.set(chapter.id, preload)
        preload.content.catch(() => {
            if (chapterPreloads.get(chapter.id) === preload) chapterPreloads.delete(chapter.id)
        })
    }
    if (!warmImages || preload.warming === offset) return
    preload.warming = offset
    for (const image of preload.images.values()) image.removeAttribute('src')
    preload.images.clear()
    preload.content.then(content => {
        if (!state.active || state.key !== key || chapterPreloads.get(chapter.id) !== preload || preload.warming !== offset || state.id === chapter.id) return
        const warmPages = offset > 0 ? content.pages.slice(0, 3) : content.pages.slice(-3)
        for (const page of warmPages) {
            const src = mangaPageUrl(page)
            const image = new Image()
            image.crossOrigin = 'anonymous'
            image.decoding = 'auto'
            image.fetchPriority = 'low'
            if (page.width) image.width = page.width
            if (page.height) image.height = page.height
            preload.images.set(src, image)
            image.src = src
        }
    }).catch(() => {})
}

async function readerChapter(key, id, signal) {
    const preload = chapterPreloads.get(id)
    if (preload) {
        try { return await preload.content }
        catch (error) { if (signal?.aborted) throw error }
    }
    return getMangaChapter(key, id, { signal })
}

async function maybeStreamNext(advance = false) {
    if (!state.active || state.mode !== 'scroll' || imageZoom?.active) return
    if (advance) state.streamJump = true
    if (state.streaming) return
    const gen = state.gen
    const key = state.key
    const next = adjacentChapter(1)
    if (!next) { state.streamJump = false; return }
    if (!advance && (!state.scrolled || pageElement(state.content.pages.length - 1)?.getBoundingClientRect().bottom > innerHeight * 1.5)) return
    state.streaming = true
    try {
        const content = await readerChapter(key, next.id, state.ctrl.signal)
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
        if (state.streamJump) pageElement(0)?.scrollIntoView({ block: 'start' })
        updateLibrary()
    } catch {} finally {
        if (state.gen === gen) {
            state.streaming = false
            state.streamJump = false
        }
    }
}

function setPage(index, fromScroll = false) {
    if (!state.content?.pages.length) return
    if (fromScroll && imageZoom?.active) return
    const next = Math.min(state.content.pages.length - 1, Math.max(0, index))
    if (next !== state.page && state.mode === 'paged') imageZoom?.reset()
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
    if (state.mode === 'scroll' && next >= state.content.pages.length - 1 && (fromScroll || state.scrolled)) maybeStreamNext()
    if (state.mode === 'paged') saveProgress()
}

function imageLoaded(image) {
    const figure = image.closest('.manga-page')
    figure?.classList.remove('loading', 'failed', 'dormant')
    figure?.classList.add('loaded')
    figure?.setAttribute('aria-busy', 'false')
    if (figure && !figure.style.aspectRatio && image.naturalWidth && image.naturalHeight) {
        const before = figure.getBoundingClientRect()
        figure.style.aspectRatio = `${image.naturalWidth} / ${image.naturalHeight}`
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
                state.enterAt = { id: chapter.id, last: offset < 0 }
                go(route(state.key, chapter.id))
            }
        } else setPage(state.page + offset)
        return
    }
    if (offset > 0 && state.page >= last) {
        maybeStreamNext(true)
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
    imageZoom?.reset()
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
        imageZoom.reset()
        state.crop = !state.crop
        saveMangaReaderSettings(state.key, { mode: state.mode, direction: state.direction, crop: state.crop })
        $('#mr-crop').setAttribute('aria-pressed', String(state.crop))
        fitCurrentPage()
    }
    imageZoom = bindMangaImageZoom(pages, {
        isPaged: () => state.mode === 'paged',
        onSwipe: offset => jumpPage(offset * (state.direction === 'rtl' ? -1 : 1)),
        onZoom: zoomed => { $('#mr-zoom-reset').hidden = !zoomed },
    })
    $('#mr-zoom-reset').onclick = () => imageZoom.reset()
    const layoutObserver = new ResizeObserver(() => { updatePageLayout(); imageZoom.refresh() })
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
        if (event.target.tagName === 'IMG') imageLoaded(event.target)
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
    window.addEventListener('scroll', () => {
        if (!state.active || state.mode === 'paged' || imageZoom.active) return
        state.scrolled = true
        maybeStreamNext()
        if (!state.hidden && scrollY > 40 && !document.activeElement.closest('.mreader-chrome')) setChrome(true)
        clearTimeout(idleTimer)
        idleTimer = setTimeout(saveProgress, 200)
    }, { passive: true })
    window.addEventListener('keydown', event => {
        if (!state.active || trapDrawerFocus(event) || drawer.classList.contains('open') || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input, textarea, select')) return
        if (event.key === 'Escape') { imageZoom.reset(); setChrome(false); return }
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
    clearChapterPreloads(state.key === key ? [id] : [])
    const entry = state.key === key && state.enterAt?.id === id ? state.enterAt : null
    state.enterAt = null
    imageZoom.reset()
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
        page: 0, streaming: false, streamJump: false, firstImageMeasured: false,
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
            local ? Promise.resolve(local.content) : readerChapter(key, id, ctrl.signal),
        ])
        if (!stillHere(key, id, gen)) return
        const chapter = chapterData.chapters.find(item => item.id === id)
        if (!chapter) throw new Error('Chapter is no longer available')
        Object.assign(state, { series, chapters: chapterData.chapters, chapter, content })
        Object.assign(state, loadMangaReaderSettings(key, series.format))
        applySettings()
        $('#mr-title').textContent = `${series.title} · ${chapterLabel(chapter)}`
        renderPages(content, entry ? (entry.last ? content.pages.length - 1 : 0) : undefined)
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
            renderPages(local.content, entry ? (entry.last ? local.content.pages.length - 1 : 0) : undefined)
            setReaderState('ready')
            return
        }
        showError(error.name === 'AbortError' ? 'Chapter request stopped' : mangaErrorMessage(error, 'Couldn’t load this chapter'))
    }
}

export function closeMangaReader() {
    if (!state.active) return
    clearChapterPreloads()
    imageZoom.reset()
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
