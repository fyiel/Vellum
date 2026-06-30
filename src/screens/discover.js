import { searchNovels, getSeries, discover, discoverTaxonomy } from '../lib/api.js'
import { go } from '../lib/router.js'

// the discover screen. a debounced search across every source renders a ranked list. the filter panel
// holds sort, a searchable genre and tag multi select, status, rating, length and source controls. the
// rows enrich themselves in the background with author, genre and rating pulled from the cached series

const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// the genre and tag vocabulary, loaded from the backend on first show. it returns the full novelupdates
// taxonomy as { genres, tags } and we flatten that into the token field option list of { v, k }. until it
// lands the dropdown stays empty
let OPTIONS = []
let taxoLoaded = false
let taxoLoading = false

async function loadTaxonomy() {
    if (taxoLoaded || taxoLoading) return
    taxoLoading = true
    try {
        const t = await discoverTaxonomy()
        OPTIONS = (t.genres || []).map(v => ({ v, k: 'genre' })).concat((t.tags || []).map(v => ({ v, k: 'tag' })))
        taxoLoaded = true
        const input = $('#toksearch')
        if (input && document.activeElement === input) input.dispatchEvent(new Event('input'))
    } catch (e) {} finally {
        taxoLoading = false
    }
}

let wired = false
let inited = false
let query = ''
let results = []
// active flips true once a search is in effect, a typed query or a filtered run. it drives the results
// versus trending split in render
let active = false
// trending is the no search landing, discover sorted by trending. fetched once and held so coming back is
// instant. trendLoaded guards the refetch, trendLoading paints the spinner, trendError the fallback
let trending = []
let trendLoaded = false
let trendLoading = false
let trendError = false
const LIMIT = 30
const dsort = { key: 'relevance', dir: 'desc' }
const tokens = new Set()

// length is the one extra filter we can derive locally, straight off the chapter count
const lengthBucket = ch => ch < 100 ? 'short' : ch < 300 ? 'medium' : ch < 800 ? 'long' : 'epic'

function currentFilters() {
    const seg = name => $(`.fseg[data-filter="${name}"] span.on`)?.dataset.v
    const sources = new Set($$('#dsource .chip.on:not([data-all])').map(c => c.dataset.src))
    return { length: seg('length') || 'any', sources }
}

const segVal = name => $(`.fseg[data-filter="${name}"] span.on`)?.dataset.v

// true when there is something for the backend to filter on, a token or a panel segment off its default.
// sort alone does not count, there is nothing to narrow without a query
function hasFilters() {
    return tokens.size > 0
        || (segVal('status') && segVal('status') !== 'all')
        || (segVal('minrating') && segVal('minrating') !== 'any')
        || (segVal('length') && segVal('length') !== 'any')
}

// split the selected tokens back into genres and tags by their kind, then fold the panel segments and sort
// into the payload discover wants. api.js drops the empty values so undefined and empty arrays fall away
function buildDiscoverParams() {
    const genres = [], tags = []
    for (const v of tokens) (OPTIONS.find(o => o.v === v)?.k === 'tag' ? tags : genres).push(v)
    const status = segVal('status'), minRating = segVal('minrating'), length = segVal('length')
    return {
        q: query || undefined,
        genres, tags,
        status: status && status !== 'all' ? status : undefined,
        minRating: minRating && minRating !== 'any' ? minRating : undefined,
        length: length && length !== 'any' ? length : undefined,
        sort: dsort.key,
        order: dsort.dir,
        page: 1,
        limit: LIMIT
    }
}

// relevance, rating and updated keep the backend order (or reverse it for ascending). the rest sort on
// a field the search payload actually carries
function sortResults(list) {
    const dir = dsort.dir === 'asc' ? 1 : -1
    const by = { chapters: r => r.chapters || 0, title: r => (r.title || '').toLowerCase(), newest: r => r.year || 0 }[dsort.key]
    const arr = list.slice()
    if (by) arr.sort((a, b) => { const va = by(a), vb = by(b); return va < vb ? -dir : va > vb ? dir : 0 })
    else if (dsort.dir === 'asc') arr.reverse()

    return arr
}

const metaInit = r => [r.sourceName, r.year].filter(Boolean).join(' · ')

function rowHtml(r, i) {
    const rank = i + 1
    const top = rank <= 3 ? ' top' : ''
    const cover = r.cover ? `<img src="${esc(r.cover)}" loading="lazy" alt="">` : ''
    return `<div class="rrow${top}" data-key="${esc(r.key)}">
      <span class="rk">${rank}</span>
      <span class="cv">${cover}</span>
      <div class="tt"><div class="n">${esc(r.title)}</div><div class="au">${esc(metaInit(r))}</div></div>
      <span class="rt"></span>
      <span class="chp">${r.chapters ? `${r.chapters} ch` : ''}</span>
      <span class="tr"></span>
    </div>`
}

// fill author, lead genre and rating from the cached series detail, top results only, no jank if it fails
function enrich(list) {
    list.slice(0, 10).forEach(r => {
        getSeries(r.key).then(s => {
            if (!s) return
            const el = $$('#dlist .rrow').find(x => x.dataset.key === r.key)
            if (!el) return
            const meta = [s.author, s.genres?.[0]].filter(Boolean).join(' · ')
            if (meta) el.querySelector('.au').textContent = meta
            if (s.rating) el.querySelector('.rt').innerHTML = `<span class="st">★</span>${s.rating.toFixed(1)}`
        }).catch(() => {})
    })
}

function render() {
    const wrap = $('#dlist')
    $('#dlab').innerHTML = active
        ? (query ? `Results <span class="ct">&middot; ${esc(query)}</span>` : 'Results <span class="ct">&middot; filtered</span>')
        : 'Trending now <span class="ct">&middot; this week</span>'

    if (!active) {
        if (!trendLoaded && !trendLoading && !trendError) { loadTrending(); return }
        if (trending.length) {
            $('#rescount').textContent = `${trending.length} result${trending.length === 1 ? '' : 's'}`
            wrap.innerHTML = trending.map(rowHtml).join('')
            enrich(trending)
            return
        }
        wrap.innerHTML = `<div class="void">${trendLoading ? 'loading&hellip;' : trendError ? 'could not reach trending right now' : 'nothing trending right now'}</div>`
        $('#rescount').textContent = ''
        return
    }

    const f = currentFilters()
    let list = results
    if (f.sources.size) list = list.filter(r => f.sources.has(r.source))
    if (f.length !== 'any') list = list.filter(r => lengthBucket(r.chapters || 0) === f.length)
    list = sortResults(list)

    $('#rescount').textContent = `${list.length} result${list.length === 1 ? '' : 's'}`
    if (!list.length) { wrap.innerHTML = `<div class="void">no results${query ? ` for ${esc(query)}` : ''}</div>`; return }

    wrap.innerHTML = list.map(rowHtml).join('')
    enrich(list)
}

// the no search landing. discover sorted by trending fills the same ranked list, fetched once and held so
// revisiting is instant. the guards keep it from refetching on every render
async function loadTrending() {
    if (active || trendLoaded || trendLoading) return

    trendLoading = true
    trendError = false
    render()
    try {
        const data = await discover({ sort: 'trending', limit: LIMIT })
        trending = data.results || []
        trendLoaded = true
    } catch {
        trendError = true
    } finally {
        trendLoading = false
    }

    if (!active) render()
}

// search routing. a typed query runs searchNovels, the merged novelupdates plus novelfire title search.
// tokens or panel filters with no text run discover, which the backend routes to novelupdates. text wins
// when both are present so the result stays predictable. nothing selected falls back to render's default
async function runSearch() {
    if (!query && !hasFilters()) { results = []; active = false; render(); return }

    active = true
    const wrap = $('#dlist')
    wrap.innerHTML = `<div class="void">searching&hellip;</div>`
    try {
        const data = query ? await searchNovels(query) : await discover(buildDiscoverParams())
        results = data.results || []
        render()
    } catch (e) {
        results = []
        wrap.innerHTML = `<div class="void">${esc(e.message)}</div>`
        $('#rescount').textContent = ''
    }
}

function paintSort() {
    $$('#dsort span[data-sort]').forEach(s => s.classList.toggle('on', s.dataset.sort === dsort.key))
    $('#ddir').textContent = dsort.dir === 'asc' ? '▲' : '▼'
}

// the badge counts selected tokens, specific source chips and any segment off its default first option
function updateCount() {
    let n = tokens.size + $$('#dsource .chip.on:not([data-all])').length
    $$('.fseg').forEach(seg => {
        const opts = [...seg.querySelectorAll('span')]
        if (opts.findIndex(o => o.classList.contains('on')) > 0) n++
    })
    const c = $('#fcount')
    c.textContent = n
    c.style.display = n ? '' : 'none'
}

function renderTokens() {
    const field = $('#tokfield'), input = $('#toksearch')
    field.querySelectorAll('.tok').forEach(t => t.remove())
    for (const v of tokens) {
        const el = document.createElement('span')
        el.className = 'tok'
        el.appendChild(document.createTextNode(v))
        const x = document.createElement('span')
        x.className = 'x'
        x.textContent = '×'
        x.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); tokens.delete(v); renderTokens(); updateCount() })
        el.appendChild(x)
        field.insertBefore(el, input)
    }
}

function wireTokens() {
    const field = $('#tokfield'), input = $('#toksearch'), drop = $('#tokdrop')

    const renderDrop = () => {
        const q = input.value.trim().toLowerCase()
        const matches = OPTIONS.filter(o => !tokens.has(o.v) && o.v.toLowerCase().includes(q)).slice(0, 16)
        drop.innerHTML = ''
        if (!matches.length) { drop.classList.remove('open'); return }
        for (const o of matches) {
            const r = document.createElement('div')
            r.className = 'topt'
            r.appendChild(document.createTextNode(o.v))
            const kind = document.createElement('span')
            kind.className = 'kind'
            kind.textContent = o.k
            r.appendChild(kind)
            r.addEventListener('mousedown', e => { e.preventDefault(); tokens.add(o.v); input.value = ''; renderTokens(); renderDrop(); updateCount(); input.focus() })
            drop.appendChild(r)
        }
        drop.classList.add('open')
    }

    input.addEventListener('input', renderDrop)
    input.addEventListener('focus', renderDrop)
    input.addEventListener('blur', () => setTimeout(() => drop.classList.remove('open'), 140))
    field.addEventListener('mousedown', e => { if (e.target === field) input.focus() })
}

function resetAll() {
    tokens.clear()
    renderTokens()
    $('#tokdrop').classList.remove('open')
    $$('.fseg').forEach(seg => [...seg.querySelectorAll('span')].forEach((o, i) => o.classList.toggle('on', i === 0)))
    const chips = $('#dsource')
    chips.querySelectorAll('.chip').forEach(x => x.classList.remove('on'))
    chips.querySelector('[data-all]').classList.add('on')
    dsort.key = 'relevance'
    dsort.dir = 'desc'
    // reset only touches the filters, a typed query still stands. so we stay active when text remains
    active = !!query
    paintSort()
    updateCount()
    render()
}

function wire() {
    if (wired) return
    wired = true

    let t
    $('#dsearch').addEventListener('input', e => {
        clearTimeout(t)
        const v = e.target.value.trim()
        t = setTimeout(() => { query = v; runSearch() }, 280)
    })

    const btn = $('#ftoggle'), panel = $('#fpanel')
    btn.addEventListener('click', () => {
        const open = !btn.classList.contains('open')
        btn.classList.toggle('open', open)
        panel.classList.toggle('open', open)
    })

    $('#dsort').addEventListener('click', e => {
        if (e.target.closest('.dir')) { dsort.dir = dsort.dir === 'asc' ? 'desc' : 'asc'; paintSort(); render(); return }
        const s = e.target.closest('span[data-sort]')
        if (!s) return
        if (s.dataset.sort === dsort.key) dsort.dir = dsort.dir === 'asc' ? 'desc' : 'asc'
        else { dsort.key = s.dataset.sort; dsort.dir = 'desc' }
        paintSort()
        render()
    })

    $$('.fseg').forEach(seg => seg.addEventListener('click', e => {
        const s = e.target.closest('span[data-v]')
        if (!s) return
        seg.querySelectorAll('span').forEach(o => o.classList.toggle('on', o === s))
        updateCount()
        render()
    }))

    const chips = $('#dsource')
    chips.addEventListener('click', e => {
        const c = e.target.closest('.chip')
        if (!c) return
        if (c.dataset.all !== undefined) {
            chips.querySelectorAll('.chip').forEach(x => x.classList.remove('on'))
            c.classList.add('on')
        } else {
            c.classList.toggle('on')
            const all = chips.querySelector('[data-all]')
            all.classList.remove('on')
            if (!chips.querySelector('.chip.on')) all.classList.add('on')
        }
        updateCount()
        render()
    })

    wireTokens()
    $('#freset').addEventListener('click', resetAll)
    $('#dlist').addEventListener('click', e => {
        const r = e.target.closest('.rrow')
        if (r) go(`#/series/${encodeURIComponent(r.dataset.key)}`)
    })

    paintSort()
    updateCount()
}

// entry point, called whenever the discover route is shown. the shell handles the feel. a genre or tag
// chip on the series screen can hand off a term here, which lands as a fresh search
export function showDiscover() {
    wire()
    loadTaxonomy()

    const seed = sessionStorage.getItem('vellum:discoverSeed')
    if (seed) {
        sessionStorage.removeItem('vellum:discoverSeed')
        $('#dsearch').value = seed
        query = seed
        inited = true
        runSearch()
        return
    }

    if (!inited) { inited = true; render() }
    loadTrending()
}
