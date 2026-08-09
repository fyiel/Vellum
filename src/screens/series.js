import { getSeries, getChapters, prefetchChapter, seriesKey, discover } from '../lib/api.js'
import { srcName } from '../lib/source.js'
import { go, back, hashSlug } from '../lib/router.js'
import { library, touchLibrary, dropLibrary, readSet, posGet } from '../lib/store.js'
import { setSeriesCrumb } from './shell.js'
import { coverImg } from '../lib/cover.js'
import { $, $$, esc } from '../lib/dom.js'

const ORIGIN_LABEL = { library: 'Library', discover: 'Discover', updates: 'Updates' }

let wired = false
let cur = null
let req = 0

const followed = slug => library().some(e => e.slug === slug)

const byDesc = (a, b) => b.n - a.n

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
    return `<div class="seclab">Synopsis</div><div class="synhost"><div class="dsyn clamp" id="syn">${esc(s.description)}</div></div><div class="dmore" id="synmore" style="display:none">Show more</div>`
}

function sourceRowHtml(s) {
    const sources = Array.isArray(s.sources) ? s.sources : []
    const name = s.sourceName || (sources[0] && srcName(sources[0])) || 'Unknown'
    // the source list is informational only, switching is not implemented so do not imply it
    const others = sources.map(srcName).filter(n => n && n !== name)
    const tail = others.length ? ` <span class="smeta">also on ${esc(others.join(' · '))}</span>` : ''
    return `<div class="drow"><span class="k">Source</span><span class="srcwrap" id="srcwrap"><span class="srcname copyable" id="srcname" title="Click to copy">${esc(name)}</span>${tail}</span></div>`
}

function statsHtml(s, slug, count) {
    const status = s.status || s.nfStatus || null
    // the chapter stat is backfilled from the live chapter list once it loads, ellipsis until then
    const chval = count != null
        ? `<span class="v copyable" id="chstat" title="Click to copy">${count}</span>`
        : `<span class="v" id="chstat">&hellip;</span>`
    const rows = [
        `<div class="drow"><span class="k">Chapters</span>${chval}</div>`,
        status ? `<div class="drow"><span class="k">Status</span><span class="v copyable" title="Click to copy">${esc(status)}</span></div>` : '',
        sourceRowHtml(s),
    ].filter(Boolean).join('')

    return `<div class="dstats">${rows}</div>`
}

// ---- more like this ----
const MORE_TAKE = 6
const MORE_MIN = 3

// skeletons keep the same grid geometry as the real tiles, so the rail never jumps on swap
function moreSecHtml(s) {
    if (!Array.isArray(s.genres) || !s.genres.length) return ''
    const tile = `<div class="mtile sk"><span class="cv"></span><div class="mbd"><div class="mn"></div><div class="mm"></div></div></div>`
    return `<div class="more" id="moresec"><div class="seclab">More like this</div><div class="mgrid">${tile.repeat(4)}</div></div>`
}

function moreTileHtml(c, s, src) {
    const shared = (s.genres || []).find(g => src.genres.includes(g)) || (s.genres || [])[0] || ''
    const meta = []
    if (typeof s.rating === 'number') meta.push(`&#9733;${s.rating.toFixed(1)}`)
    if (shared) meta.push(esc(shared))
    const fol = followed(s.nfSlug)
    return `<a class="mtile" href="#/series/${encodeURIComponent(c.key)}">
      <span class="cv">${coverImg(s.cover, s.title)}</span>
      <div class="mbd"><div class="mn">${esc(s.title)}</div>${meta.length ? `<div class="mm">${meta.join(' · ')}</div>` : ''}</div>
      ${fol ? `<span class="mfol">Following</span>` : ''}
    </a>`
}

function hideMore() {
    $('#moresec')?.remove()
}

async function loadMoreLike(mine) {
    const src = cur
    if (!Array.isArray(src?.series?.genres) || !src.series.genres.length) return
    const self = seriesKey(src.key)

    let data
    try { data = await discover({ genres: [src.series.genres[0]], sort: 'rating', order: 'desc', limit: 30 }) }
    catch (e) { if (mine === req) hideMore(); return }
    if (mine !== req) return

    const seen = new Set()
    const cands = (data.results || []).filter(r => {
        if (!r?.key || r.key === self || seen.has(r.key)) return false
        seen.add(r.key)
        return true
    }).slice(0, MORE_TAKE)

    // the existing 6h series cache dedupes inflight fetches, so parallel enrichment is free
    const settled = await Promise.allSettled(cands.map(c => getSeries(seriesKey(c.key))))
    if (mine !== req) return

    const tiles = []
    cands.forEach((c, i) => {
        const s = settled[i].status === 'fulfilled' ? settled[i].value : null
        if (!s?.title) return
        tiles.push(moreTileHtml(c, s, src.series))
    })
    if (tiles.length < MORE_MIN) { hideMore(); return }

    const sec = $('#moresec')
    if (sec) sec.innerHTML = `<div class="seclab">More like this</div><div class="mgrid">${tiles.join('')}</div>`
}

function infoHtml(s, slug, count) {
    const cover = coverImg(s.cover, s.title) || `<span class="g">Cover</span>`
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
      ${statsHtml(s, slug, count)}
      ${moreSecHtml(s)}`
}

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

let chRows = []

function filterChapters(q) {
    q = q.trim().toLowerCase()
    for (const r of chRows) {
        const hit = !q || r.t.includes(q) || String(r.n).includes(q)
        r.el.style.display = hit ? '' : 'none'
    }
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

    let t
    $('#schapters').addEventListener('input', e => {
        if (e.target.id !== 'chsearch') return
        clearTimeout(t)
        const v = e.target.value
        t = setTimeout(() => filterChapters(v), 150)
    })

    window.addEventListener('resize', checkSynOverflow)
}

async function loadChapters(slug, mine) {
    let chapters = []
    try {
        const d = await getChapters(slug)
        if (!Array.isArray(d?.chapters)) throw new Error('bad chapter list')
        chapters = d.chapters
    } catch (e) {
        if (mine === req) $('#schapters').innerHTML = `<div class="void">couldn't load the chapter list</div>`
        return
    }
    if (mine !== req) return

    const count = chapters.length
    cur.chapters = chapters
    cur.count = count
    // a follow may have landed before the count was known, backfill the total so updates can alert
    if (followed(slug)) touchLibrary({ slug, total: count })

    $('#schapters').innerHTML = chaptersHtml(slug, chapters, count)
    chRows = [...$$('#chlist .chrow')].map(el => ({ el, t: el.querySelector('.cht').textContent.toLowerCase(), n: el.dataset.n }))

    const stat = $('#chstat')
    if (stat) {
        stat.textContent = count
        stat.classList.add('copyable')
        stat.title = 'Click to copy'
    }

    const sc = $('.chscroll')
    if (sc) sc.scrollTop = sc.scrollHeight
}

export async function showSeries(key, origin) {
    wire()
    const mine = ++req
    const info = $('#sinfo'), chaps = $('#schapters')
    info.innerHTML = `<div class="void">loading&hellip;</div>`
    chaps.innerHTML = ''

    let series
    try { series = await getSeries(seriesKey(key)) }
    catch (e) { if (mine === req) info.innerHTML = `<div class="void">${esc(e.message)}</div>`; return }
    if (mine !== req) return
    if (!series) { info.innerHTML = `<div class="void">series not found</div>`; return }

    const slug = series.nfSlug || key
    cur = { key, slug, series, chapters: [], count: null }

    setSeriesCrumb(ORIGIN_LABEL[origin] || 'Library', series.title, () => back())
    info.innerHTML = infoHtml(series, slug, null)
    chaps.innerHTML = `<div class="void">loading chapters&hellip;</div>`

    checkSynOverflow()
    if (document.fonts?.ready) document.fonts.ready.then(() => { if (mine === req) checkSynOverflow() })

    const next = posGet(slug)?.n
    if (next != null) prefetchChapter(slug, next)

    loadChapters(slug, mine)
    loadMoreLike(mine)
}
