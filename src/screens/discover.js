import { searchNovels, getSeries, discover, discoverTaxonomy } from '../lib/api.js'
import { go } from '../lib/router.js'
import { coverImg } from '../lib/cover.js'

const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

let OPTIONS = []
let taxoLoaded = false
let taxoLoading = false

async function loadTaxonomy() {
    if (taxoLoaded || taxoLoading) return
    taxoLoading = true
    try {
        const t = await discoverTaxonomy()
        OPTIONS = (t.genres || []).map(g => ({ v: g.value ?? g, k: 'genre' })).concat((t.tags || []).map(g => ({ v: g.value ?? g, k: 'tag' })))
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
let active = false

let items = []
let page = 0
let loadingMore = false
let done = false
let enrichedFirst = false
let feedError = false

const LIMIT = 30
const ENRICH_MAX = 10
const dsort = { key: 'relevance', dir: 'desc' }
const tokens = new Set()

const lengthBucket = ch => ch < 100 ? 'short' : ch < 300 ? 'medium' : ch < 800 ? 'long' : 'epic'

function currentFilters() {
    const seg = name => $(`.fseg[data-filter="${name}"] span.on`)?.dataset.v
    const sources = new Set($$('#dsource .chip.on:not([data-all])').map(c => c.dataset.src))
    return { length: seg('length') || 'any', sources }
}

const segVal = name => $(`.fseg[data-filter="${name}"] span.on`)?.dataset.v

function hasFilters() {
    return tokens.size > 0
        || (segVal('status') && segVal('status') !== 'all')
        || (segVal('minrating') && segVal('minrating') !== 'any')
        || (segVal('length') && segVal('length') !== 'any')
}

function buildDiscoverParams(p) {
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
        page: p,
        limit: LIMIT
    }
}

function filterPage(list) {
    const f = currentFilters()
    let out = list
    if (f.sources.size) out = out.filter(r => f.sources.has(r.source))
    if (f.length !== 'any') out = out.filter(r => lengthBucket(r.chapters || 0) === f.length)
    return out
}

const SRC = { novelfire: 'Novelfire', mangabaka: 'MangaBaka', dm: 'Dreamy', dawn: 'Dawn' }
const metaInit = r => [SRC[r.sources?.[0]] || r.sourceName, r.year].filter(Boolean).join(' · ')
const stars = r => r.rating ? `<span class="st">★</span>${Number(r.rating).toFixed(1)}` : ''

function rowHtml(r, i) {
    const rank = i + 1
    const top = rank <= 3 ? ' top' : ''
    const cover = coverImg(r.cover, r.title)
    return `<div class="rrow${top}" data-key="${esc(r.key)}">
      <span class="rk">${rank}</span>
      <span class="cv">${cover}</span>
      <div class="tt"><div class="n">${esc(r.title)}</div><div class="au">${esc(metaInit(r))}</div></div>
      <span class="rt">${stars(r)}</span>
      <span class="chp">${r.chapters ? `${r.chapters} ch` : ''}</span>
      <span class="tr"></span>
    </div>`
}

function enrich(list) {
    list.slice(0, ENRICH_MAX).forEach(r => {
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

function setLabel() {
    $('#dlab').innerHTML = active
        ? (query ? `Results <span class="ct">&middot; ${esc(query)}</span>` : 'Results <span class="ct">&middot; filtered</span>')
        : 'Trending now <span class="ct">&middot; this month</span>'
}

function setCount() {
    $('#rescount').textContent = items.length
        ? `${items.length}${done ? '' : '+'} result${items.length === 1 ? '' : 's'}`
        : ''
}

function voidMsg() {
    if (feedError) return active ? 'could not reach the sources right now' : 'could not reach trending right now'
    if (query) return `no results for ${esc(query)}`
    if (active) return 'no results'
    return 'nothing trending right now'
}

function feedFetch(p) {
    if (query) return p === 1 ? searchNovels(query) : Promise.resolve({ results: [] })
    if (active) return discover(buildDiscoverParams(p))
    return discover({ sort: 'trending', page: p, limit: LIMIT })
}

const scroller = () => $('#view-discover .scroll')

async function startFeed() {
    active = !!(query || hasFilters())
    page = 0
    items = []
    done = false
    loadingMore = false
    enrichedFirst = false
    feedError = false
    setLabel()
    const sc = scroller()
    if (sc) sc.scrollTop = 0
    $('#dlist').innerHTML = `<div class="void">${active ? 'searching' : 'loading'}&hellip;</div>`
    $('#rescount').textContent = ''
    await loadMore(true)
}

async function loadMore(fresh = false) {
    if (loadingMore || done) return
    loadingMore = true

    const p = page + 1
    let data
    try {
        data = await feedFetch(p)
    } catch (e) {
        loadingMore = false
        if (fresh) { feedError = true; $('#dlist').innerHTML = `<div class="void">${voidMsg()}</div>`; $('#rescount').textContent = '' }
        return
    }

    page = p
    const raw = data.results || []
    const batch = filterPage(raw)
    if (raw.length < LIMIT) done = true

    const wrap = $('#dlist')
    const startIdx = items.length
    items.push(...batch)

    if (fresh) {
        wrap.innerHTML = items.length ? items.map((r, i) => rowHtml(r, i)).join('') : `<div class="void">${voidMsg()}</div>`
    } else if (batch.length) {
        wrap.insertAdjacentHTML('beforeend', batch.map((r, i) => rowHtml(r, startIdx + i)).join(''))
    }

    setCount()
    if (!enrichedFirst && items.length) { enrichedFirst = true; enrich(items) }

    loadingMore = false
    fillViewport()
}

function fillViewport() {
    if (done || loadingMore) return
    const sc = scroller()
    if (sc && sc.scrollHeight <= sc.clientHeight + 40) loadMore()
}

async function runSearch() {
    if (!query && !hasFilters()) { active = false; await startFeed(); return }
    await startFeed()
}

function paintSort() {
    $$('#dsort span[data-sort]').forEach(s => s.classList.toggle('on', s.dataset.sort === dsort.key))
    $('#ddir').textContent = dsort.dir === 'asc' ? '▲' : '▼'
}

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
    paintSort()
    updateCount()
    startFeed()
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
        if (e.target.closest('.dir')) { dsort.dir = dsort.dir === 'asc' ? 'desc' : 'asc'; paintSort(); startFeed(); return }
        const s = e.target.closest('span[data-sort]')
        if (!s) return
        if (s.dataset.sort === dsort.key) dsort.dir = dsort.dir === 'asc' ? 'desc' : 'asc'
        else { dsort.key = s.dataset.sort; dsort.dir = 'desc' }
        paintSort()
        startFeed()
    })

    $$('.fseg').forEach(seg => seg.addEventListener('click', e => {
        const s = e.target.closest('span[data-v]')
        if (!s) return
        seg.querySelectorAll('span').forEach(o => o.classList.toggle('on', o === s))
        updateCount()
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
    })

    wireTokens()
    $('#fapply').addEventListener('click', runSearch)
    $('#freset').addEventListener('click', resetAll)
    $('#dlist').addEventListener('click', e => {
        const r = e.target.closest('.rrow')
        if (r) go(`#/series/${encodeURIComponent(r.dataset.key)}`)
    })

    scroller()?.addEventListener('scroll', () => {
        const sc = scroller()
        if (!sc || loadingMore || done) return
        if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 600) loadMore()
    }, { passive: true })

    paintSort()
    updateCount()
}

export function showDiscover() {
    wire()
    loadTaxonomy()

    const seed = sessionStorage.getItem('vellum:discoverSeed')
    if (seed) {
        sessionStorage.removeItem('vellum:discoverSeed')
        $('#dsearch').value = seed
        query = seed
        inited = true
        startFeed()
        return
    }

    if (!inited) { inited = true; startFeed() }
}
