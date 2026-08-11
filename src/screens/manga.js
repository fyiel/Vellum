import { discoverManga, mangaErrorMessage, mangaProviderName, mangaResponseNotice, searchManga } from '../lib/manga-api.js'
import { coverImg } from '../lib/cover.js'
import { $, $$, esc } from '../lib/dom.js'

const LIMIT = 30
const PRUNE_AT = 150
const PRUNE_DROP = 60

let wired = false
let inited = false
let query = ''
let source = 'all'
let format = 'all'
let page = 0
let hasMore = true
let loading = false
let rows = []
let gen = 0
let searchTimer = null
let ctrl = null
let notice = ''
let pageError = false
let failed = false

const card = (item, index) => `<a class="manga-card" data-key="${esc(item.key)}" href="#/manga/series/${encodeURIComponent(item.key)}" aria-label="${esc(item.title)}, ${esc(item.format)} from ${esc(mangaProviderName(item.key.split(':')[0]))}">
  <div class="manga-cover">${coverImg(item.cover, item.title, { eager: index < 4 }) || '<span class="manga-cover-empty">No cover</span>'}</div>
  <div class="manga-card-copy">
    <h2>${esc(item.title)}</h2>
    <div class="manga-card-meta"><span>${esc(item.format)}</span><span>${esc(mangaProviderName(item.key.split(':')[0]))}</span></div>
  </div>
</a>`

const skeletons = () => Array.from({ length: 10 }, () => `<div class="manga-card manga-skeleton" aria-hidden="true">
  <div class="manga-cover"></div><div class="manga-card-copy"><i></i><i></i></div>
</div>`).join('')

function setControls() {
    $$('#msource [data-source]').forEach(item => {
        const on = item.dataset.source === source
        item.classList.toggle('on', on)
        item.setAttribute('aria-pressed', String(on))
    })
    $$('#mformat [data-format]').forEach(item => {
        const on = item.dataset.format === format
        item.classList.toggle('on', on)
        item.setAttribute('aria-pressed', String(on))
    })
    $('#mlab').textContent = query ? `Results · ${query}` : 'Recently updated'
}

function paint() {
    const status = notice ? `<div class="manga-notice">${esc(notice)}</div>` : ''
    $('#mlist').innerHTML = rows.length
        ? status + rows.map(card).join('')
        : `<div class="manga-empty">${status || (query ? `No matches for “${esc(query)}”` : 'No manga available right now')}</div>`
    $('#mlist').setAttribute('aria-busy', String(loading))
    const more = $('#mmore')
    more.hidden = !rows.length || !hasMore
    more.disabled = loading
    more.textContent = loading ? 'Loading…' : pageError ? 'Try again' : 'Load more'
}

async function fetchPage(nextPage, fresh, mine, signal) {
    const request = { query, source, format }
    const opts = { source: request.source, format: request.format, page: nextPage, limit: LIMIT, signal }
    // when a stale page-1 feed was served instantly, this fires once the
    // background SWR refresh lands so the grid repaints with the fresh rows
    const onFresh = data => {
        if (mine !== gen) return
        if (request.query !== query || request.source !== source || request.format !== format) return
        if (page !== nextPage) return
        rows = data.results
        hasMore = Boolean(data.hasMore)
        notice = mangaResponseNotice(data, request.source)
        pageError = false
        paint()
    }
    const data = request.query
        ? await searchManga(request.query, { ...opts, onFresh: fresh ? onFresh : undefined })
        : await discoverManga({ source: request.source, format: request.format, page: nextPage, limit: LIMIT }, { signal, onFresh: fresh ? onFresh : undefined })
    if (mine !== gen) return

    const seen = new Set(fresh ? [] : rows.map(item => item.key))
    const incoming = data.results.filter(item => !seen.has(item.key))
    rows = fresh ? incoming : rows.concat(incoming)
    page = nextPage
    hasMore = Boolean(data.hasMore)
    notice = mangaResponseNotice(data, request.source)
    pageError = false
}

async function start() {
    ctrl?.abort()
    ctrl = new AbortController()
    const mine = ++gen
    page = 0
    rows = []
    hasMore = true
    loading = true
    notice = ''
    pageError = false
    failed = false
    setControls()
    $('#mlist').setAttribute('aria-busy', 'true')
    $('#mlist').innerHTML = skeletons()
    $('#mmore').hidden = true
    try {
        await fetchPage(1, true, mine, ctrl.signal)
        if (mine === gen) paint()
    } catch (error) {
        if (mine === gen && error.name !== 'AbortError') {
            failed = true
            const fallback = navigator.onLine ? 'Couldn’t reach the manga shelves.' : 'You’re offline. Reconnect to load the manga shelves.'
            $('#mlist').innerHTML = `<div class="manga-empty manga-error" role="status">${esc(mangaErrorMessage(error, fallback))}<button id="mretry" type="button">Try again</button></div>`
            $('#mretry').onclick = start
        }
    } finally {
        if (mine === gen) {
            loading = false
            $('#mlist').setAttribute('aria-busy', 'false')
            if (rows.length) paint()
        }
    }
}

async function more() {
    if (loading || !hasMore) return
    const mine = gen
    loading = true
    pageError = false
    paint()
    try {
        await fetchPage(page + 1, false, mine, ctrl.signal)
    } catch (error) {
        if (mine === gen && error.name !== 'AbortError') {
            notice = mangaErrorMessage(error, 'Couldn’t load the next page.')
            pageError = true
        }
    } finally {
        if (mine === gen) {
            loading = false
            paint()
        }
    }
    if (mine === gen && !pageError) pruneGrid()
}

function pruneGrid() {
    if (rows.length <= PRUNE_AT) return
    // prunes in 60 card chunks, no virtualization library, the pinned card
    // keeps its screen position after the oldest cards drop (reader.js loadPrev pattern)
    const scroller = $('#mscroll')
    const pinned = $$('#mlist .manga-card').find(el => {
        const rect = el.getBoundingClientRect()
        return rect.bottom > 0 && rect.top < innerHeight
    })
    const key = pinned?.dataset.key
    const before = pinned?.offsetTop ?? null
    rows = rows.slice(PRUNE_DROP)
    paint()
    if (key) {
        const el = $$('#mlist .manga-card').find(card => card.dataset.key === key)
        if (el) scroller.scrollTop += el.offsetTop - (before ?? el.offsetTop)
    }
}

function wire() {
    if (wired) return
    wired = true

    $('#msearch').addEventListener('input', event => {
        clearTimeout(searchTimer)
        const value = event.target.value.trim()
        searchTimer = setTimeout(() => { query = value; start() }, 280)
    })
    $('#msource').addEventListener('click', event => {
        const item = event.target.closest('[data-source]')
        if (!item || item.dataset.source === source) return
        source = item.dataset.source
        start()
    })
    $('#mformat').addEventListener('click', event => {
        const item = event.target.closest('[data-format]')
        if (!item || item.dataset.format === format) return
        format = item.dataset.format
        start()
    })
    $('#mmore').addEventListener('click', more)
    // bottom sentinel drives the same more() as the button, which stays as the
    // keyboard and Try again fallback; the sentinel itself never auto retries
    const moreObserver = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return
        if (!hasMore || loading || pageError) return
        more()
    }, { rootMargin: '800px 0px' })
    moreObserver.observe($('#mmore-sentinel'))
    window.addEventListener('online', () => { if (failed && !$('#view-manga').hidden) start() })
}

export function showManga() {
    wire()
    clearTimeout(searchTimer)
    if (!inited) {
        inited = true
        start()
    } else setControls()
}
