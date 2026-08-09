import { discoverKDrama, kDramaErrorMessage, kDramaProviderName, kDramaResponseNotice, searchKDrama } from '../lib/kdrama-api.js'
import { coverImg } from '../lib/cover.js'
import { $, $$, esc } from '../lib/dom.js'

const LIMIT = 30
let wired = false
let inited = false
let query = ''
let source = 'all'
let page = 0
let hasMore = true
let loading = false
let rows = []
let gen = 0
let timer = null
let ctrl = null
let notice = ''
let pageError = false

const card = (item, index) => {
    const provider = kDramaProviderName(item.key.split(':')[0])
    const meta = [item.year, item.status].filter(value => value != null).join(' · ')
    return `<a class="kdrama-card" href="#/kdrama/series/${encodeURIComponent(item.key)}" aria-label="${esc(`${item.title}${item.year ? `, ${item.year}` : ''} from ${provider}`)}">
      <div class="kdrama-cover"><span class="kdrama-cover-empty">No poster</span>${coverImg(item.cover, item.title, { useResolver: false, eager: index < 4 })}</div>
      <div class="kdrama-copy"><h2>${esc(item.title)}</h2><div class="kdrama-meta"><span>${esc(provider)}</span>${meta ? `<span>${esc(meta)}</span>` : ''}</div></div>
    </a>`
}

const skeletons = () => Array.from({ length: 10 }, () => '<div class="kdrama-card kdrama-skeleton" aria-hidden="true"><div class="kdrama-cover"></div><div class="kdrama-copy"><i></i><i></i></div></div>').join('')

function setControls() {
    $$('#ksource [data-source]').forEach(item => {
        const on = item.dataset.source === source
        item.classList.toggle('on', on)
        item.setAttribute('aria-pressed', String(on))
    })
    $('#klab').textContent = query ? `Results · ${query}` : 'Recently added'
}

function paint() {
    const status = notice ? `<div class="kdrama-notice">${esc(notice)}</div>` : ''
    $('#klist').innerHTML = rows.length
        ? status + rows.map(card).join('')
        : `<div class="kdrama-empty">${status || (query ? `No matches for “${esc(query)}”` : 'No K-dramas available right now')}${notice ? '<button id="kretry" type="button">Try again</button>' : ''}</div>`
    $('#klist').setAttribute('aria-busy', String(loading))
    if ($('#kretry')) $('#kretry').onclick = start
    const more = $('#kmore')
    more.hidden = !rows.length || !hasMore
    more.disabled = loading
    more.textContent = loading ? 'Loading…' : pageError ? 'Try again' : 'Load more'
}

async function fetchPage(nextPage, fresh, mine, signal) {
    const request = { query, source }
    const options = { source: request.source, page: nextPage, limit: LIMIT, signal }
    const data = request.query ? await searchKDrama(request.query, options) : await discoverKDrama(options)
    if (mine !== gen) return
    if (!fresh && data.partial && !data.results.length) {
        throw new Error(kDramaResponseNotice(data, request.source) || 'Couldn’t load the next page.')
    }
    const seen = new Set(fresh ? [] : rows.map(item => item.key))
    const incoming = data.results.filter(item => !seen.has(item.key))
    rows = fresh ? incoming : rows.concat(incoming)
    page = nextPage
    hasMore = Boolean(data.hasMore)
    notice = kDramaResponseNotice(data, request.source)
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
    setControls()
    $('#klist').setAttribute('aria-busy', 'true')
    $('#klist').innerHTML = skeletons()
    $('#kmore').hidden = true
    try {
        await fetchPage(1, true, mine, ctrl.signal)
        if (mine === gen) paint()
    } catch (error) {
        if (mine === gen && error.name !== 'AbortError') {
            const fallback = navigator.onLine ? 'Couldn’t reach the K-drama shelves.' : 'You’re offline. Reconnect to load K-dramas.'
            $('#klist').innerHTML = `<div class="kdrama-empty kdrama-error" role="status">${esc(kDramaErrorMessage(error, fallback))}<button id="kretry" type="button">Try again</button></div>`
            $('#kretry').onclick = start
        }
    } finally {
        if (mine === gen) {
            loading = false
            $('#klist').setAttribute('aria-busy', 'false')
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
    try { await fetchPage(page + 1, false, mine, ctrl.signal) }
    catch (error) {
        if (mine === gen && error.name !== 'AbortError') {
            notice = kDramaErrorMessage(error, 'Couldn’t load the next page.')
            pageError = true
        }
    } finally {
        if (mine === gen) { loading = false; paint() }
    }
}

function wire() {
    if (wired) return
    wired = true
    $('#ksearch').addEventListener('input', event => {
        clearTimeout(timer)
        const value = event.target.value.trim()
        timer = setTimeout(() => { query = value; start() }, 280)
    })
    $('#ksource').addEventListener('click', event => {
        const item = event.target.closest('[data-source]')
        if (!item || item.dataset.source === source) return
        source = item.dataset.source
        start()
    })
    $('#kmore').addEventListener('click', more)
}

export function showKDrama() {
    wire()
    clearTimeout(timer)
    if (!inited) { inited = true; start() }
    else setControls()
}
