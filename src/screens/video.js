import { discoverVideo } from '../lib/video-api.js'
import { library } from '../lib/store.js'
import { coverImg } from '../lib/cover.js'
import { $, $$, esc } from '../lib/dom.js'
import { videoProviderLabel, dramaLabel } from './video-series.js'

const LIMIT = 30
const isVideo = entry => entry.kind === 'anime' || entry.kind === 'drama'
const kindName = kind => kind === 'drama' ? 'Drama' : 'Anime'
const itemLabel = item => item.kind === 'drama' ? dramaLabel(item.country) : 'Anime'
const route = key => `#/watch/series/${encodeURIComponent(key)}`
const playRoute = entry => `#/watch/play/${encodeURIComponent(entry.slug)}/${encodeURIComponent(entry.lastId)}`
const time = seconds => {
    const value = Math.max(0, Number(seconds) || 0)
    return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`
}

let wired = false
let inited = false
let query = ''
let kind = 'all'
let page = 0
let rows = []
let hasMore = true
let notice = ''
let loading = false
let moreFailed = false
let gen = 0
let ctrl = null
let timer = null
let provisional = false

const poster = (item, eager = false) => coverImg(item.poster, item.title, { useResolver: false, eager })
const card = (item, index) => `<a class="watch-card" href="${route(item.key)}" aria-label="${esc(`${item.title}, ${itemLabel(item)}`)}">
  <div class="watch-poster">${poster(item, index < 4) || '<span class="watch-poster-empty">No poster</span>'}${item.year ? `<span class="watch-year">${esc(item.year)}</span>` : ''}</div>
  <div class="watch-card-copy"><h2>${esc(item.title)}</h2><div class="watch-meta"><span>${esc(itemLabel(item))}</span>${item.status ? `<span>${esc(item.status)}</span>` : ''}</div></div>
</a>`

const skeletons = () => Array.from({ length: 8 }, () => '<div class="watch-card watch-skeleton" aria-hidden="true"><div class="watch-poster"></div><div class="watch-card-copy"><i></i><i></i></div></div>').join('')

function paintControls() {
    $$('#vkind [data-kind]').forEach(button => {
        const on = button.dataset.kind === kind
        button.classList.toggle('on', on)
        button.setAttribute('aria-pressed', String(on))
    })
    $('#vlab').textContent = query ? `Results · ${query}` : kind === 'all' ? 'Recently added' : kindName(kind)
}

function paintContinue() {
    const items = library().filter(entry => isVideo(entry) && entry.lastId && Number(entry.lastDuration) > 0 && Number(entry.lastPosition) < Number(entry.lastDuration) * .9)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 4)
    $('#vcontinue').hidden = !items.length
    $('#vcontinue-list').innerHTML = items.map(entry => {
        const pct = Math.min(100, Math.round((Number(entry.lastPosition) || 0) / Math.max(1, Number(entry.lastDuration)) * 100))
        return `<a class="watch-continue-card" href="${playRoute(entry)}"><span class="watch-continue-poster">${poster({ poster: entry.cover, title: entry.title })}</span><span class="watch-continue-copy"><b>${esc(entry.title)}</b><span>${esc(entry.lastLabel || 'Episode')} · ${time(entry.lastPosition)} / ${time(entry.lastDuration)}</span><i><i style="width:${pct}%"></i></i></span></a>`
    }).join('')
}

function paint() {
    const status = notice ? `<div class="watch-notice" role="status">${esc(notice)}</div>` : ''
    $('#vlist').innerHTML = rows.length ? status + rows.map(card).join('')
        : `<div class="watch-empty">${query ? `No matches for “${esc(query)}”` : `No ${kind === 'all' ? 'anime or drama' : kindName(kind)} available right now`}</div>`
    $('#vlist').setAttribute('aria-busy', String(loading))
    $('#vstatus').textContent = rows.length ? `Loaded ${rows.length}${hasMore ? ' so far' : ''}` : ''
    const more = $('#vmore')
    more.hidden = provisional || !rows.length || !hasMore
    more.disabled = loading
    more.textContent = loading ? 'Loading…' : moreFailed ? 'Try again' : 'Load more'
}

const providerNotice = data => {
    const providers = [...new Set((data.errors || []).map(error => videoProviderLabel(error?.provider)).filter(Boolean))]
    return data.partial && providers.length
        ? `${providers.join(' and ')} ${providers.length > 1 ? 'are' : 'is'} temporarily unavailable; others still show`
        : ''
}

async function fetchPage(next, fresh, mine, progress) {
    const request = { q: query, kind }
    // when a stale page-1 feed was served instantly, this fires once the background
    // SWR refresh lands so the grid repaints with the fresh rows (same contract as
    // the manga shelf's onFresh)
    const onFresh = data => {
        if (mine !== gen) return
        if (request.q !== query || request.kind !== kind) return
        if (page !== next) return
        rows = query ? data.results.filter(item => item.title.toLowerCase().includes(query.toLowerCase())) : data.results
        hasMore = Boolean(data.hasMore)
        notice = providerNotice(data)
        paint()
    }
    const data = await discoverVideo({ q: query, kind, page: next, limit: LIMIT, signal: ctrl?.signal, onProgress: progress, onFresh: fresh ? onFresh : undefined })
    if (mine !== gen) return
    const seen = new Set(fresh ? [] : rows.map(item => item.key))
    const incoming = data.results.filter(item => !seen.has(item.key))
    const matched = query ? incoming.filter(item => item.title.toLowerCase().includes(query.toLowerCase())) : incoming
    rows = fresh ? matched : rows.concat(matched)
    if (fresh) {
        notice = providerNotice(data)
    }
    page = next
    hasMore = Boolean(data.hasMore) && (query ? incoming.length > 0 : matched.length > 0)
}

async function start() {
    ctrl?.abort()
    ctrl = new AbortController()
    const mine = ++gen
    rows = []
    notice = ''
    page = 0
    hasMore = true
    loading = true
    moreFailed = false
    provisional = true
    paintControls()
    paintContinue()
    $('#vlist').setAttribute('aria-busy', 'true')
    $('#vlist').innerHTML = skeletons()
    $('#vmore').hidden = true
    // each leg of the feed paints the moment its rows land; the final merged paint
    // follows when both have resolved (or one has failed) and stays authoritative
    const onProgress = progress => {
        if (mine !== gen || !provisional) return
        rows = query ? progress.results.filter(item => item.title.toLowerCase().includes(query.toLowerCase())) : progress.results
        hasMore = Boolean(progress.hasMore)
        paint()
    }
    try {
        await fetchPage(1, true, mine, onProgress)
        if (mine === gen) { provisional = false; paint() }
    } catch (error) {
        if (mine !== gen || error.name === 'AbortError') return
        const message = !navigator.onLine ? 'You’re offline. Reconnect to browse video.'
            : error.status === 404 ? 'Video providers aren’t connected in this build yet.'
                : 'Couldn’t reach the video shelves.'
        $('#vlist').innerHTML = `<div class="watch-empty watch-error" role="status">${message}<button id="vretry" type="button">Try again</button></div>`
        $('#vretry').onclick = start
    } finally {
        if (mine === gen) {
            provisional = false
            loading = false
            $('#vlist').setAttribute('aria-busy', 'false')
            if (rows.length) paint()
        }
    }
}

async function more() {
    if (loading || !hasMore) return
    const mine = gen
    loading = true
    moreFailed = false
    paint()
    try { await fetchPage(page + 1, false, mine) }
    catch { if (mine === gen) moreFailed = true }
    finally { if (mine === gen) { loading = false; paint() } }
}

// poster hosts are cold on a first visit (~5MB per grid); preconnecting while the
// skeletons show shaves the image waterfall without blocking the card paint
const IMAGE_HOSTS = ['https://s4.anilist.co', 'https://dramacooli.buzz']
const hinted = new Set()
function hintImageHosts() {
    for (const href of IMAGE_HOSTS) {
        if (hinted.has(href)) continue
        hinted.add(href)
        const link = document.createElement('link')
        link.rel = 'preconnect'
        link.href = href
        document.head.appendChild(link)
    }
}

function wire() {
    if (wired) return
    wired = true
    $('#vsearch').addEventListener('input', event => {
        clearTimeout(timer)
        const value = event.target.value.trim()
        timer = setTimeout(() => { query = value; start() }, 280)
    })
    $('#vkind').addEventListener('click', event => {
        const button = event.target.closest('[data-kind]')
        if (!button || button.dataset.kind === kind) return
        kind = button.dataset.kind
        start()
    })
    $('#vmore').addEventListener('click', more)
    // bottom sentinel drives the same more() as the button, which stays as the
    // keyboard and Try again fallback; the sentinel itself never auto retries
    const moreObserver = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return
        if (!hasMore || loading || moreFailed) return
        more()
    }, { rootMargin: '800px 0px' })
    moreObserver.observe($('#vmore-sentinel'))
    window.addEventListener('online', () => { if (!$('#view-watch').hidden && !rows.length) start() })
}

export function showVideo() {
    wire()
    hintImageHosts()
    clearTimeout(timer)
    paintContinue()
    if (!inited) { inited = true; start() }
    else paintControls()
}
