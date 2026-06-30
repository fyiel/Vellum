import { getSeries, getChapters, prefetchChapter } from '../lib/api.js'
import { go, back, hashSlug } from '../lib/router.js'
import { library, touchLibrary, dropLibrary, readSet, posGet } from '../lib/store.js'
import { setSeriesCrumb } from './shell.js'

// the series detail screen. a fixed info column and a fluid chapter column, both scrolling on their own.
// it reads the series key off the route, pulls getSeries and getChapters, paints the design and wires
// every interaction. synopsis expand, tag cloud, chapter search and order, follow, source picker, copy

const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const ORIGIN_LABEL = { library: 'Library', discover: 'Discover', updates: 'Updates' }

let wired = false
let cur = null            // { key, slug, series, chapters, count }
let req = 0               // guards against a slow fetch painting over a newer navigation

// follow lives in the shared library store, keyed by the same slug the reader and updates use
const followed = slug => library().some(e => e.slug === slug)

// the chapter list shows highest numbers at the top and chapter one at the bottom
const byDesc = (a, b) => b.n - a.n

// source data only rides along on the aggregator keys, so normalise loosely and degrade to one name
const srcName = x => typeof x === 'string' ? x : (x.name || x.sourceName || x.source || '')
const srcCount = x => typeof x === 'string' ? null : (x.chapterCount ?? x.chapters ?? x.count ?? null)
const srcOff = x => typeof x === 'string' ? false : !(x.available ?? x.readable ?? true)

// info column

function ratingHtml(s) {
    if (typeof s.rating !== 'number') return ''
    const sub = s.ratingsCount ? `<span class="sub">${esc(s.ratingsCount)} ratings</span>` : ''
    const trend = s.trending ? `<span class="trend">#${esc(s.trending)} trending</span>` : ''
    return `<div class="drating"><span class="st">&#9733;</span>${s.rating.toFixed(1)}${sub}${trend}</div>`
}

function taxHtml(label, items, cloud) {
    if (!items?.length) return ''
    const chips = items.map(t => `<span class="gchip${cloud ? '' : ' genre'}">${esc(t)}</span>`).join('')
    if (!cloud) return `<div class="taxblock"><div class="taxhd"><span class="seclab">${label}</span></div><div class="dgenres">${chips}</div></div>`

    return `<div class="taxblock"><div class="taxhd"><span class="seclab">${label}</span><span class="ct">${items.length}</span><span class="all" id="tagall">Show all</span></div><div class="cloud clamp" id="tagcloud">${chips}</div></div>`
}

function synopsisHtml(s) {
    if (!s.description) return ''
    // the clamped box needs a block parent so the line clamp survives the info column flex layout
    return `<div class="seclab">Synopsis</div><div class="synhost"><div class="dsyn clamp" id="syn">${esc(s.description)}</div></div><div class="dmore" id="synmore" style="display:none">Show more</div>`
}

// the source row is a flyout when two or more sources can be chosen, otherwise a plain copyable name
function sourceRowHtml(s) {
    const sources = Array.isArray(s.sources) ? s.sources : []
    const name = s.sourceName || (sources[0] && srcName(sources[0])) || 'Unknown'
    const selectable = sources.filter(x => !srcOff(x))

    if (selectable.length < 2) {
        return `<div class="drow"><span class="k">Source</span><span class="srcwrap" id="srcwrap"><span class="srcname copyable" id="srcname" title="Click to copy">${esc(name)}</span></span></div>`
    }

    const opts = sources.map(x => {
        const nm = srcName(x)
        const isCur = nm === name
        if (srcOff(x)) return `<span class="srcopt off" data-src="${esc(nm)}"><span class="dot"></span><span class="snm">${esc(nm)}</span><span class="smeta">offline</span></span>`
        const tail = isCur ? `<span class="ck">&#10003;</span>` : `<span class="smeta">${srcCount(x) != null ? `${esc(srcCount(x))} ch` : 'available'}</span>`
        return `<span class="srcopt${isCur ? ' cur' : ''}" data-src="${esc(nm)}"><span class="dot"></span><span class="snm">${esc(nm)}</span>${tail}</span>`
    }).join('')

    return `<div class="drow"><span class="k">Source</span><span class="srcwrap" id="srcwrap">
      <span class="srcname copyable" id="srcname" title="Click to copy">${esc(name)}</span>
      <span class="swbtn" id="srcpick" title="Change source"><span class="swico">&#8644;</span></span>
      <span class="srcmenu" id="srcmenu"><span class="smhd">Available sources</span>${opts}</span>
    </span></div>`
}

// only the stats the data actually carries get a row, never a blank or a crash
function statsHtml(s, slug, count) {
    const status = s.status || s.nfStatus || null
    const rows = [
        count ? `<div class="drow"><span class="k">Chapters</span><span class="v copyable" title="Click to copy">${count}</span></div>` : '',
        status ? `<div class="drow"><span class="k">Status</span><span class="v copyable" title="Click to copy">${esc(status)}</span></div>` : '',
        sourceRowHtml(s),
    ].filter(Boolean).join('')

    return `<div class="dstats">${rows}</div>`
}

function infoHtml(s, slug, count) {
    const cover = s.cover ? `<img src="${esc(s.cover)}" alt="" loading="lazy">` : `<span class="g">Cover</span>`
    const meta = [s.author, s.year, s.status || s.nfStatus].filter(Boolean).join(' · ')
    const pos = posGet(slug)
    const cont = pos ? `Continue &middot; Ch ${esc(pos.n)}` : 'Start reading'
    const isFol = followed(slug)

    return `<div class="cover-lg">${cover}</div>
      <div class="dtitle">${esc(s.title)}</div>
      ${meta ? `<div class="dmeta">${esc(meta)}</div>` : ''}
      ${ratingHtml(s)}
      ${taxHtml('Genre', s.genres, false)}
      ${taxHtml('Tags', s.tags, true)}
      <div class="dactions">
        <button class="btn primary" id="contbtn">${cont}</button>
        <button class="btn${isFol ? ' on' : ''}" id="followbtn">${isFol ? 'Following' : 'Follow'}</button>
      </div>
      ${synopsisHtml(s)}
      ${statsHtml(s, slug, count)}`
}

// chapters column

function chrow(c, read, curN) {
    const cls = ['chrow', read.has(c.n) && 'read', c.n === curN && 'cur'].filter(Boolean).join(' ')
    return `<div class="${cls}" data-n="${esc(c.n)}"><span class="chn">${esc(c.n)}</span><span class="cht">${esc(c.t || '')}</span><span class="chd"></span><span class="chdot"></span></div>`
}

function chaptersHtml(slug, chapters, count) {
    const read = readSet(slug)
    const curN = posGet(slug)?.n
    const rows = [...chapters].sort(byDesc).map(c => chrow(c, read, curN)).join('')
    const list = rows || `<div class="void">no chapters yet</div>`

    return `<div class="chtool">
        <div class="srch"><input id="chsearch" placeholder="Jump to chapter&hellip;"></div>
        <div class="seg" id="chorder"><span data-end="top">Top</span><span class="on" data-end="bottom">Bottom</span></div>
      </div>
      <div class="chhead">Chapter list <span class="ct">&middot; ${count}</span></div>
      <div class="chscroll"><div class="chlist" id="chlist">${list}</div></div>`
}

// behaviour

function checkSynOverflow() {
    const syn = $('#syn'), more = $('#synmore')
    if (!syn || !more) return
    if (!syn.classList.contains('clamp')) return

    more.style.display = syn.scrollHeight > syn.clientHeight + 2 ? '' : 'none'
}

function toggleSyn() {
    const syn = $('#syn'), more = $('#synmore')
    const clamped = syn.classList.toggle('clamp')
    more.textContent = clamped ? 'Show more' : 'Show less'
}

function toggleTags() {
    const cloud = $('#tagcloud'), all = $('#tagall')
    const clamped = cloud.classList.toggle('clamp')
    all.textContent = clamped ? 'Show all' : 'Show less'
}

function toggleFollow() {
    const btn = $('#followbtn')
    const { slug, series, count } = cur
    if (followed(slug)) {
        dropLibrary(slug)
        btn.classList.remove('on')
        btn.textContent = 'Follow'
    } else {
        touchLibrary({ slug, title: series.title, cover: series.cover, author: series.author, total: count })
        btn.classList.add('on')
        btn.textContent = 'Following'
    }
}

const writeClip = t => {
    try {
        if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(t).catch(() => execCopy(t)); return }
    } catch {}
    execCopy(t)
}

const execCopy = t => {
    const ta = document.createElement('textarea')
    ta.value = t
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch {}
    document.body.removeChild(ta)
}

function copyValue(el) {
    if (el.classList.contains('copied')) return

    const text = el.textContent
    writeClip(text)
    el.dataset.orig = text
    el.classList.add('copied')
    el.textContent = 'copied'
    setTimeout(() => {
        if (el.dataset.orig != null) el.textContent = el.dataset.orig
        el.classList.remove('copied')
    }, 900)
}

// pick an available source, refresh the dot, check and name, then close. switching the actual chapter
// feed needs a per source slug the metadata does not expose yet, so this updates the chosen label
function selectSource(opt) {
    if (opt.classList.contains('off')) return

    const menu = opt.closest('.srcmenu')
    menu.querySelectorAll('.srcopt').forEach(x => {
        x.classList.remove('cur')
        x.querySelector('.ck')?.remove()
        if (!x.classList.contains('off') && !x.querySelector('.smeta')) {
            const m = document.createElement('span')
            m.className = 'smeta'
            m.textContent = 'available'
            x.appendChild(m)
        }
    })
    opt.classList.add('cur')
    opt.querySelector('.smeta')?.remove()
    const ck = document.createElement('span')
    ck.className = 'ck'
    ck.textContent = '✓'
    opt.appendChild(ck)

    const name = $('#srcname')
    name.classList.remove('copied')
    name.textContent = opt.dataset.src
    $('#srcwrap').classList.remove('open')
}

function filterChapters(q) {
    q = q.trim().toLowerCase()
    $$('#chlist .chrow').forEach(r => {
        const t = r.querySelector('.cht').textContent.toLowerCase()
        const hit = !q || t.includes(q) || String(r.dataset.n).includes(q)
        r.style.display = hit ? '' : 'none'
    })
}

function setOrder(seg) {
    $$('#chorder span').forEach(o => o.classList.toggle('on', o === seg))
    const sc = $('.chscroll')
    if (sc) sc.scrollTo({ top: seg.dataset.end === 'top' ? 0 : sc.scrollHeight, behavior: 'smooth' })
}

const launchChapter = n => go(`#/read/${hashSlug(cur.slug)}/${n}`)

function launchContinue() {
    const pos = posGet(cur.slug)
    const first = [...cur.chapters].sort((a, b) => a.n - b.n)[0]
    launchChapter(pos ? pos.n : (first ? first.n : (cur.series.firstChapter ?? 1)))
}

function wire() {
    if (wired) return
    wired = true

    $('#sinfo').addEventListener('click', e => {
        if (e.target.closest('#synmore')) return toggleSyn()
        if (e.target.closest('#tagall')) return toggleTags()
        if (e.target.closest('#followbtn')) return toggleFollow()
        if (e.target.closest('#contbtn')) return launchContinue()
        if (e.target.closest('#srcpick')) { e.stopPropagation(); $('#srcwrap').classList.toggle('open'); return }
        const opt = e.target.closest('.srcopt')
        if (opt) { e.stopPropagation(); selectSource(opt); return }
        const cp = e.target.closest('.copyable')
        if (cp) { e.stopPropagation(); return copyValue(cp) }
        const chip = e.target.closest('.gchip')
        if (chip) { sessionStorage.setItem('vellum:discoverSeed', chip.textContent); go('#/discover') }
    })

    $('#schapters').addEventListener('click', e => {
        const seg = e.target.closest('#chorder span')
        if (seg) return setOrder(seg)
        const row = e.target.closest('.chrow')
        if (row) launchChapter(row.dataset.n)
    })

    $('#schapters').addEventListener('input', e => { if (e.target.id === 'chsearch') filterChapters(e.target.value) })

    // a click anywhere else closes the source flyout
    document.addEventListener('click', () => $('#srcwrap')?.classList.remove('open'))
    window.addEventListener('resize', checkSynOverflow)
}

// entry point, called whenever the series route is shown. origin is the browse screen we came from
export async function showSeries(key, origin) {
    wire()
    const mine = ++req
    const info = $('#sinfo'), chaps = $('#schapters')
    info.innerHTML = `<div class="void">loading&hellip;</div>`
    chaps.innerHTML = ''

    let series
    try { series = await getSeries(key) }
    catch (e) { if (mine === req) info.innerHTML = `<div class="void">${esc(e.message)}</div>`; return }
    if (mine !== req) return
    if (!series) { info.innerHTML = `<div class="void">series not found</div>`; return }

    const slug = series.nfSlug || key
    let chapters = []
    try { chapters = (await getChapters(slug))?.chapters || [] } catch {}
    if (mine !== req) return

    const count = chapters.length || series.totalChapters || 0
    cur = { key, slug, series, chapters, count }

    setSeriesCrumb(ORIGIN_LABEL[origin] || 'Library', series.title, () => back())
    info.innerHTML = infoHtml(series, slug, count)
    chaps.innerHTML = chaptersHtml(slug, chapters, count)

    // open anchored at the bottom, the start of the story, so the reader scrolls up toward new chapters
    const sc = $('.chscroll')
    if (sc) sc.scrollTop = sc.scrollHeight

    checkSynOverflow()
    if (document.fonts?.ready) document.fonts.ready.then(() => { if (mine === req) checkSynOverflow() })

    const next = posGet(slug)?.n
    if (next != null) prefetchChapter(slug, next)
}
