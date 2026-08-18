import { getSeries, getChapters, prefetchChapter, seriesKey } from '../lib/api.js'
import { srcName } from '../lib/source.js'
import { go, hashSlug, parseHash } from '../lib/router.js'
import { library, touchLibrary, dropLibrary, readSet, posGet } from '../lib/store.js'
import { cancelNovelDownload, deleteNovelDownload, downloadNovelChapter, novelDlActive, novelDlEntry, onNovelDl } from '../lib/dl-novel.js'
import { dlBatch } from '../lib/downloads.js'
import { setSeriesCrumb } from './shell.js'
import { coverImg } from '../lib/cover.js'
import { $, $$, esc, activeScroller } from '../lib/dom.js'

const ORIGIN_LABEL = { library: 'Library', discover: 'Read', updates: 'Updates' }
const ORIGIN_ROUTE = { library: '#/', discover: '#/discover', updates: '#/updates' }

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
      ${statsHtml(s, slug, count)}`
}

const dlFailed = new Map()
let batch = null

// batch buttons sit in .chtool; "next" counts from the continue chapter, skipping
// chapters that are already downloaded or in flight
const batchPaint = () => {
    const next = $('#dl-next'), all = $('#dl-all')
    if (!next || !all) return
    next.disabled = all.disabled = !!batch
    next.textContent = batch ? `↓ ${batch.done}/${batch.total}` : '↓ next 10'
    all.textContent = '↓ all'
}

const batchCandidates = count => {
    const pos = posGet(cur.slug)?.n
    const pending = [...cur.chapters].sort((a, b) => a.n - b.n)
        .filter(c => (pos == null || c.n >= pos) && !novelDlEntry(cur.slug, c.n) && !novelDlActive(cur.slug, c.n))
    return count ? pending.slice(0, count) : pending
}

async function runBatch(count) {
    if (batch || !cur) return
    const ns = batchCandidates(count).map(c => c.n)
    if (!ns.length) {
        const next = $('#dl-next')
        if (next) { next.textContent = 'up to date'; setTimeout(batchPaint, 1500) }
        return
    }
    if (count == null && !confirm(`Download all ${ns.length} chapters of ${cur.series.title}?`)) return
    batch = { done: 0, total: ns.length }
    batchPaint()
    await dlBatch(ns, n => downloadNovelChapter(cur.slug, n, cur.series.title), {
        onStep: done => { if (batch) { batch.done = done; batchPaint() } },
        onError: (n, error) => { dlFailed.set(n, error?.message || 'Download failed'); paintDl() },
    })
    batch = null
    batchPaint()
}

const dlState = (slug, n) => {
    const active = novelDlActive(slug, n)
    const state = active ? 'active' : novelDlEntry(slug, n) ? 'done' : dlFailed.has(n) ? 'failed' : ''
    const label = active ? '…' : state === 'done' ? '✓' : state === 'failed' ? '!' : '↓'
    const hint = active ? 'Cancel download' : state === 'done' ? 'Delete downloaded chapter' : state === 'failed' ? dlFailed.get(n) : 'Download for offline reading'
    return { state, label, hint }
}
const dlButton = (slug, n) => {
    const { state, label, hint } = dlState(slug, n)
    return `<button type="button" class="chdl${state ? ` ${state}` : ''}" data-dl="${esc(n)}" title="${esc(hint)}" aria-label="${esc(hint)}">${label}</button>`
}
function paintDl() {
    if (!cur) return
    $$('#chlist .chdl').forEach(btn => {
        const { state, label, hint } = dlState(cur.slug, Number(btn.dataset.dl))
        btn.className = `chdl${state ? ` ${state}` : ''}`
        btn.textContent = label
        btn.title = hint
        btn.setAttribute('aria-label', hint)
    })
}

function chrow(slug, c, read, curN) {
    const cls = ['chrow', read.has(c.n) && 'read', c.n === curN && 'cur'].filter(Boolean).join(' ')
    return `<div class="chline"><div class="${cls}" data-n="${esc(c.n)}"><span class="chn">${esc(c.n)}</span><span class="cht">${esc(c.t || '')}</span><span class="chd"></span><span class="chdot"></span></div>${dlButton(slug, c.n)}</div>`
}

function chaptersHtml(slug, chapters, count) {
    const read = readSet(slug)
    const curN = posGet(slug)?.n
    const rows = [...chapters].sort(byDesc).map(c => chrow(slug, c, read, curN)).join('')
    const list = rows || `<div class="void">no chapters yet</div>`
    // mobile opens at the top of the page (info + newest chapters in flow); desktop auto-scrolls to the bottom
    const mobileTop = matchMedia('(max-width: 640px)').matches

    return `<div class="chtool">
        <div class="srch"><input id="chsearch" placeholder="Jump to chapter&hellip;"></div>
        <div class="chbatch"><button type="button" id="dl-next">↓ next 10</button><button type="button" id="dl-all">↓ all</button></div>
        <div class="seg" id="chorder"><span${mobileTop ? ' class="on"' : ''} data-end="top">Top</span><span${mobileTop ? '' : ' class="on"'} data-end="bottom">Bottom</span></div>
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
let filterLastQ = '', filterTop = 0

function filterChapters(q, restoreTop = 0) {
    q = q.trim().toLowerCase()
    for (const r of chRows) {
        const hit = !q || r.t.includes(q) || String(r.n).includes(q)
        r.el.style.display = hit ? '' : 'none'
    }
    // hiding rows clamps scrollTop; put the reader back where they were when the filter clears
    if (!q) {
        const sc = activeScroller()
        if (sc) sc.scrollTop = Math.min(restoreTop, sc.scrollHeight - sc.clientHeight)
    }
}

function setOrder(seg) {
    $$('#chorder span').forEach(o => o.classList.toggle('on', o === seg))
    const sc = activeScroller()
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
        if (e.target.closest('#dl-next')) { runBatch(10); return }
        if (e.target.closest('#dl-all')) { runBatch(null); return }
        const dl = e.target.closest('.chdl')
        if (dl && cur) {
            const n = Number(dl.dataset.dl)
            if (novelDlActive(cur.slug, n)) return cancelNovelDownload(cur.slug, n)
            if (novelDlEntry(cur.slug, n)) {
                if (confirm('Delete the downloaded copy of this chapter?')) deleteNovelDownload(cur.slug, n)
                return
            }
            dlFailed.delete(n)
            downloadNovelChapter(cur.slug, n, cur.series.title).catch(error => {
                dlFailed.set(n, error?.message || 'Download failed')
                paintDl()
            })
            return
        }
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
        if (!filterLastQ && v.trim()) { const sc = activeScroller(); filterTop = sc?.scrollTop ?? 0 }
        filterLastQ = v
        t = setTimeout(() => filterChapters(v, filterTop), 150)
    })

    window.addEventListener('resize', checkSynOverflow)
    onNovelDl(paintDl)
}

async function loadChapters(slug, mine) {
    let chapters = []
    try {
        const d = await getChapters(slug)
        if (!Array.isArray(d?.chapters)) throw new Error('bad chapter list')
        chapters = d.chapters
    } catch (e) {
        if (mine === req && parseHash().name === 'series' && parseHash().key === cur?.key) {
            // MangaBaka catalogue entries have no readable chapters in Vellum — offer their external links
            if (cur?.series?.links?.length && cur.series.readable === false) {
                $('#schapters').innerHTML = `<div class="void">This title is a MangaBaka catalogue entry with no readable chapters in Vellum.<div class="mb-links">${cur.series.links.map(url => `<a href="${esc(url)}" target="_blank" rel="noopener">Read externally ↗</a>`).join('')}</div></div>`
                return
            }
            $('#schapters').innerHTML = `<div class="void">couldn't load the chapter list<button class="btn" id="schapters-retry">retry</button></div>`
            $('#schapters-retry').onclick = () => loadChapters(slug, mine)
        }
        return
    }
    if (mine !== req || parseHash().name !== 'series' || parseHash().key !== cur?.key) return

    const count = chapters.length
    cur.chapters = chapters
    cur.count = count
    // a follow may have landed before the count was known, backfill the total so updates can alert
    if (followed(slug)) touchLibrary({ slug, total: count })

    $('#schapters').innerHTML = chaptersHtml(slug, chapters, count)
    batchPaint()
    chRows = [...$$('#chlist .chrow')].map(el => ({ el, t: el.querySelector('.cht').textContent.toLowerCase(), n: el.dataset.n }))

    const stat = $('#chstat')
    if (stat) {
        stat.textContent = count
        stat.classList.add('copyable')
        stat.title = 'Click to copy'
    }

    const sc = activeScroller()
    if (sc && sc.classList.contains('chscroll')) sc.scrollTop = sc.scrollHeight
}

export async function showSeries(key, origin) {
    wire()
    const mine = ++req
    const info = $('#sinfo'), chaps = $('#schapters')
    filterLastQ = ''
    filterTop = 0
    // re-showing the same series: keep the rendered content (and the scroll position) until the
    // fresh fetch lands; blanking first collapses the scroller and loses the user's place
    const same = !!cur && cur.key === key
    if (!same) {
        info.innerHTML = `<div class="void">loading&hellip;</div>`
        chaps.innerHTML = ''
    }

    let series
    try { series = await getSeries(seriesKey(key)) }
    catch (e) {
        if (mine === req && parseHash().name === 'series' && parseHash().key === key) info.innerHTML = `<div class="void">${esc(e.message)}</div>`
        return
    }
    if (mine !== req || parseHash().name !== 'series' || parseHash().key !== key) return
    if (!series) { info.innerHTML = `<div class="void">series not found</div>`; return }

    const slug = series.nfSlug || key
    const knownCount = series.totalChapters == null || series.totalChapters === ''
        ? NaN
        : Number(series.totalChapters)
    const count = Number.isFinite(knownCount) && knownCount >= 0 ? knownCount : null
    cur = { key, slug, series, chapters: [], count }

    setSeriesCrumb(ORIGIN_LABEL[origin] || 'Library', series.title, () => go(ORIGIN_ROUTE[origin] || '#/'))
    info.innerHTML = infoHtml(series, slug, count)
    if (!same) chaps.innerHTML = `<div class="void">loading chapters&hellip;</div>`

    checkSynOverflow()
    if (document.fonts?.ready) document.fonts.ready.then(() => {
        if (mine === req && parseHash().name === 'series' && parseHash().key === key) checkSynOverflow()
    })

    const next = posGet(slug)?.n
    if (next != null) prefetchChapter(slug, next)

    loadChapters(slug, mine)
}
