import { getSeries, getChapters, prefetchChapter, seriesKey } from '../lib/api.js'
import { srcName } from '../lib/source.js'
import { go, back, hashSlug } from '../lib/router.js'
import { library, touchLibrary, dropLibrary, readSet, posGet, getReview, saveReview, clearReview } from '../lib/store.js'
import { setSeriesCrumb } from './shell.js'
import { coverImg } from '../lib/cover.js'
import { $, $$, esc } from '../lib/dom.js'
import { relTime } from '../lib/time.js'

const ORIGIN_LABEL = { library: 'Library', discover: 'Discover', updates: 'Updates' }
const REVIEW_MAX = 2000

let wired = false
let cur = null
let req = 0

// reviews tab state, reset per series visit
let rv = { sort: 'newest', open: false, rating: 0, spoiler: false }

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

function starGlyphs(n) {
    return Array.from({ length: 5 }, (_, i) => `<span class="st${i < n ? ' on' : ''}">&#9733;</span>`).join('')
}

function reviewCardHtml(r) {
    const body = r.text
        ? `<div class="rvbody${r.spoiler ? ' blur' : ''}"${r.spoiler ? ' tabindex="0" role="button" aria-label="Spoiler, tap to reveal"' : ''}>${esc(r.text)}</div>`
        : ''
    return `<div class="revcard">
      <div class="rvtop"><span class="rvsrow" aria-label="${r.rating} of 5 stars">${starGlyphs(r.rating)}</span><span class="rvd">${relTime(r.at)}</span><span class="rvlocal" title="Saved on this device">local</span></div>
      ${body}
      <div class="rvact"><button type="button" class="rvlnk" id="rvedit">Edit</button><button type="button" class="rvlnk warn" id="rvdel">Delete</button></div>
    </div>`
}

function composerHtml() {
    return `<div class="rvcomposer" id="rvcomposer" hidden>
      <div class="rvstars" role="group" aria-label="Your rating">
        ${[1, 2, 3, 4, 5].map(n => `<button type="button" class="rst" data-n="${n}" aria-label="Rate ${n} of 5" aria-pressed="false">&#9733;</button>`).join('')}
      </div>
      <textarea id="rvtext" maxlength="${REVIEW_MAX}" placeholder="What did you think?"></textarea>
      <div class="rvmeta">
        <span class="rvchars" id="rvchars">0 / ${REVIEW_MAX}</span>
        <button type="button" class="chip" id="rvspoiler" aria-pressed="false">Contains spoilers</button>
        <span class="rvspacer"></span>
        <button type="button" class="btn" id="rvcancel">Cancel</button>
        <button type="button" class="btn primary" id="rvpost">Post</button>
      </div>
    </div>`
}

function reviewsPaneHtml() {
    const r = getReview(cur.slug)
    return `<div class="rvtool">
        <span class="rvcount" id="rvcount">${r ? '1 review' : '0 reviews'}</span>
        <span class="rvnote">saved on this device</span>
        <div class="seg" id="rvsort"><span class="on" data-sort="newest">Newest</span><span data-sort="stars">Stars</span></div>
        <button type="button" class="btn" id="rvwrite">Write a review</button>
      </div>
      <div class="rvwrap">${composerHtml()}<div class="rvlist" id="rvlist"></div></div>`
}

function columnShellHtml() {
    return `<div class="sectabs"><div class="seg" id="chttabs"><span class="on" data-pane="chapters" tabindex="0">Chapters</span><span data-pane="reviews" tabindex="0">Reviews</span></div></div>
      <div class="spane" id="pane-chapters"><div class="void">loading chapters&hellip;</div></div>
      <div class="spane" id="pane-reviews" hidden>${reviewsPaneHtml()}</div>`
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

function setPane(pane) {
    $$('#chttabs span').forEach(o => o.classList.toggle('on', o.dataset.pane === pane))
    const cp = $('#pane-chapters'), rp = $('#pane-reviews')
    if (cp) cp.hidden = pane !== 'chapters'
    if (rp) rp.hidden = pane !== 'reviews'
}

function renderStars() {
    $$('#rvcomposer .rst').forEach((b, i) => {
        const on = i < rv.rating
        b.classList.toggle('on', on)
        b.setAttribute('aria-pressed', String(on))
    })
}

function setStar(n) {
    rv.rating = n
    renderStars()
}

function updateChars(ta) {
    const c = $('#rvchars')
    if (c) c.textContent = `${ta.value.length} / ${REVIEW_MAX}`
}

function growText(ta) {
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px'
}

function toggleSpoiler() {
    rv.spoiler = !rv.spoiler
    const chip = $('#rvspoiler')
    if (chip) {
        chip.classList.toggle('on', rv.spoiler)
        chip.setAttribute('aria-pressed', String(rv.spoiler))
    }
}

function renderRvList() {
    const list = $('#rvlist'), count = $('#rvcount')
    if (!list) return
    const r = getReview(cur.slug)
    if (count) count.textContent = r ? '1 review' : '0 reviews'
    if (!r) {
        // while the composer is open an empty list stays out of the way
        list.innerHTML = rv.open ? '' : `<div class="void">No reviews yet. First impressions count.<br><button type="button" class="btn" id="rvemptybtn">Write a review</button></div>`
        return
    }
    const cmp = rv.sort === 'stars' ? (a, b) => b.rating - a.rating || b.at - a.at : (a, b) => b.at - a.at
    list.innerHTML = [r].sort(cmp).map(reviewCardHtml).join('')
}

function setRvSort(span) {
    $$('#rvsort span').forEach(o => o.classList.toggle('on', o === span))
    rv.sort = span.dataset.sort
    renderRvList()
}

function openComposer(editing) {
    const box = $('#rvcomposer')
    if (!box) return
    rv.open = true
    const r = editing ? getReview(cur.slug) : null
    rv.rating = r?.rating ?? 0
    rv.spoiler = r?.spoiler ?? false
    const ta = box.querySelector('#rvtext')
    ta.value = r?.text ?? ''
    renderStars()
    const chip = box.querySelector('#rvspoiler')
    chip.classList.toggle('on', rv.spoiler)
    chip.setAttribute('aria-pressed', String(rv.spoiler))
    box.hidden = false
    updateChars(ta)
    growText(ta)
    ta.focus()
    renderRvList()
}

function closeComposer() {
    const box = $('#rvcomposer')
    if (box) box.hidden = true
    rv.open = false
    rv.rating = 0
    rv.spoiler = false
    renderRvList()
}

function postReview() {
    if (!Number.isInteger(rv.rating) || rv.rating < 1 || rv.rating > 5) {
        const stars = $('#rvcomposer .rvstars')
        if (stars) {
            stars.classList.remove('nudge')
            void stars.offsetWidth
            stars.classList.add('nudge')
        }
        return
    }
    const ta = $('#rvtext')
    if (!ta) return
    // caps are enforced at write time, the stored copy is plain text
    saveReview(cur.slug, { rating: rv.rating, text: ta.value.trim().slice(0, REVIEW_MAX), spoiler: rv.spoiler, at: Date.now() })
    closeComposer()
}

function deleteReview() {
    const btn = $('#rvdel')
    if (!btn) return
    if (btn.dataset.arm !== '1') {
        btn.dataset.arm = '1'
        btn.textContent = 'Sure?'
        setTimeout(() => { if (btn.dataset.arm === '1') { btn.dataset.arm = ''; btn.textContent = 'Delete' } }, 2500)
        return
    }
    clearReview(cur.slug)
    closeComposer()
}

function revealSpoiler(el) {
    el.classList.remove('blur')
    el.removeAttribute('role')
    el.removeAttribute('aria-label')
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
        const tab = e.target.closest('#chttabs span')
        if (tab) return setPane(tab.dataset.pane)
        const seg = e.target.closest('#chorder span')
        if (seg) return setOrder(seg)
        const sort = e.target.closest('#rvsort span')
        if (sort) return setRvSort(sort)
        if (e.target.closest('#rvwrite') || e.target.closest('#rvemptybtn')) return openComposer(getReview(cur.slug) != null)
        if (e.target.closest('#rvcancel')) return closeComposer()
        if (e.target.closest('#rvpost')) return postReview()
        if (e.target.closest('#rvspoiler')) return toggleSpoiler()
        if (e.target.closest('#rvedit')) return openComposer(true)
        if (e.target.closest('#rvdel')) return deleteReview()
        const st = e.target.closest('#rvcomposer .rst')
        if (st) return setStar(+st.dataset.n)
        const blur = e.target.closest('.rvbody.blur')
        if (blur) return revealSpoiler(blur)
        const row = e.target.closest('.chrow')
        if (row) launchChapter(row.dataset.n)
    })

    // the new tab/sort segs are focusable spans, give them keyboard activation
    $('#schapters').addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        const tab = e.target.closest('#chttabs span')
        if (tab) { e.preventDefault(); return setPane(tab.dataset.pane) }
        const sort = e.target.closest('#rvsort span')
        if (sort) { e.preventDefault(); return setRvSort(sort) }
        const blur = e.target.closest('.rvbody.blur')
        if (blur) { e.preventDefault(); return revealSpoiler(blur) }
    })

    let t
    $('#schapters').addEventListener('input', e => {
        if (e.target.id === 'chsearch') {
            clearTimeout(t)
            const v = e.target.value
            t = setTimeout(() => filterChapters(v), 150)
            return
        }
        if (e.target.id === 'rvtext') { updateChars(e.target); growText(e.target) }
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
        if (mine === req) $('#pane-chapters').innerHTML = `<div class="void">couldn't load the chapter list</div>`
        return
    }
    if (mine !== req) return

    const count = chapters.length
    cur.chapters = chapters
    cur.count = count
    // a follow may have landed before the count was known, backfill the total so updates can alert
    if (followed(slug)) touchLibrary({ slug, total: count })

    $('#pane-chapters').innerHTML = chaptersHtml(slug, chapters, count)
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
    rv = { sort: 'newest', open: false, rating: 0, spoiler: false }

    setSeriesCrumb(ORIGIN_LABEL[origin] || 'Library', series.title, () => back())
    info.innerHTML = infoHtml(series, slug, null)
    chaps.innerHTML = columnShellHtml()
    renderRvList()

    checkSynOverflow()
    if (document.fonts?.ready) document.fonts.ready.then(() => { if (mine === req) checkSynOverflow() })

    const next = posGet(slug)?.n
    if (next != null) prefetchChapter(slug, next)

    loadChapters(slug, mine)
}
