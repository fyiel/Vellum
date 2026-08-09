import { discoverManga, searchManga } from '../lib/manga-api.js'
import { go } from '../lib/router.js'
import { coverImg } from '../lib/cover.js'
import { $, $$, esc } from '../lib/dom.js'

const SOURCE = { mf: 'MangaFire', mh: 'MangaHub' }
const LIMIT = 30

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

const card = item => `<article class="manga-card" data-key="${esc(item.key)}">
  <div class="manga-cover">${coverImg(item.cover, item.title) || '<span class="manga-cover-empty">No cover</span>'}</div>
  <div class="manga-card-copy">
    <h2>${esc(item.title)}</h2>
    <div class="manga-card-meta"><span>${esc(item.format)}</span><span>${esc(SOURCE[item.key.split(':')[0]] || 'Manga')}</span></div>
  </div>
</article>`

const skeletons = () => Array.from({ length: 10 }, () => `<div class="manga-card manga-skeleton" aria-hidden="true">
  <div class="manga-cover"></div><div class="manga-card-copy"><i></i><i></i></div>
</div>`).join('')

function setControls() {
    $$('#msource [data-source]').forEach(item => item.classList.toggle('on', item.dataset.source === source))
    $$('#mformat [data-format]').forEach(item => item.classList.toggle('on', item.dataset.format === format))
    $('#mlab').textContent = query ? `Results · ${query}` : 'Recently updated'
}

function paint() {
    $('#mlist').innerHTML = rows.length
        ? rows.map(card).join('')
        : `<div class="manga-empty">${query ? `No matches for “${esc(query)}”` : 'No manga available right now'}</div>`
    const more = $('#mmore')
    more.hidden = !rows.length || !hasMore
    more.disabled = loading
    more.textContent = loading ? 'Loading…' : 'Load more'
}

async function fetchPage(nextPage, fresh, mine) {
    const opts = { source, format, page: nextPage, limit: LIMIT }
    const data = query
        ? await searchManga(query, opts)
        : await discoverManga({ ...opts, format: format === 'all' ? undefined : format })
    if (mine !== gen) return

    const seen = new Set(fresh ? [] : rows.map(item => item.key))
    const incoming = data.results.filter(item => !seen.has(item.key) && (format === 'all' || item.format === format))
    rows = fresh ? incoming : rows.concat(incoming)
    page = nextPage
    hasMore = Boolean(data.hasMore) && incoming.length > 0
}

async function start() {
    const mine = ++gen
    page = 0
    rows = []
    hasMore = true
    loading = true
    setControls()
    $('#mlist').innerHTML = skeletons()
    $('#mmore').hidden = true
    try {
        await fetchPage(1, true, mine)
        if (mine === gen) paint()
    } catch {
        if (mine === gen) {
            $('#mlist').innerHTML = '<div class="manga-empty">Couldn’t reach the manga shelves.<button id="mretry">Try again</button></div>'
            $('#mretry').onclick = start
        }
    } finally {
        if (mine === gen) {
            loading = false
            if (rows.length) paint()
        }
    }
}

async function more() {
    if (loading || !hasMore) return
    const mine = gen
    loading = true
    paint()
    try {
        await fetchPage(page + 1, false, mine)
    } catch {
        if (mine === gen) $('#mmore').textContent = 'Try again'
    } finally {
        if (mine === gen) {
            loading = false
            paint()
        }
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
    $('#mlist').addEventListener('click', event => {
        const item = event.target.closest('.manga-card[data-key]')
        if (item) go(`#/manga/series/${encodeURIComponent(item.dataset.key)}`)
    })
    $('#mmore').addEventListener('click', more)
}

export function showManga() {
    wire()
    clearTimeout(searchTimer)
    if (!inited) {
        inited = true
        start()
    } else setControls()
}
