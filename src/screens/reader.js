import { getChapter, getChapters, getSeries, prefetchChapter } from '../lib/api.js'
import { go, back, hashSlug } from '../lib/router.js'
import { library, touchLibrary, readSet, saveRead, posGet, posSet, loadSettings, saveSettings, SET_DEFAULT } from '../lib/store.js'

// the reader screen. a focused full bleed overlay that paints one chapter of prose and walks prev or next
// through the chapter list. it restores the saved spot, marks chapters read, keeps the library continue
// strip current and prefetches the next chapter so the jump feels instant. matches the beta reader at
// pumg.fyi/read. display settings, the chapter drawer and chrome auto hide all live here

const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const WIDTHS = { narrow: '34em', normal: '40em', wide: '46em' }
const THEME_BG = { dark: '#181818', black: '#000000', sepia: '#f4ecd8', light: '#fbfbfd' }

let wired = false
let req = 0                  // guards against a slow fetch painting over a newer navigation
let chromeHidden = false
let settings = loadSettings()
const cur = { slug: null, n: null, chapters: [], idx: -1, series: null }
const dw = { lo: 0, hi: 0, q: '' }

// display settings paint as data attr and css vars on the overlay, theme colour follows for mobile chrome
const applySettings = () => {
    const r = $('#view-read')
    r.dataset.theme = settings.theme
    r.style.setProperty('--rsize', settings.size + 'px')
    r.style.setProperty('--rlh', settings.lh)
    r.style.setProperty('--rwidth', WIDTHS[settings.width] || WIDTHS.normal)
    r.style.setProperty('--rfont', settings.font === 'sans' ? 'var(--font)' : 'var(--serif)')

    const meta = $('meta[name=theme-color]')
    if (meta) meta.content = THEME_BG[settings.theme] || THEME_BG.black
}

// progress, position and read state

const scroller = () => $('#view-read')
const chapterProgress = () => {
    const s = scroller()
    const max = s.scrollHeight - s.clientHeight
    return max > 0 ? Math.min(1, Math.max(0, s.scrollTop / max)) : 0
}

const updateProgress = () => {
    if (cur.n == null) return
    const p = chapterProgress()
    $('#rprogbar').style.width = (p * 100).toFixed(1) + '%'
    $('#r-pos').textContent = `${cur.n} / ${cur.chapters.length} · ${Math.round(p * 100)}%`
}

const posSave = () => {
    if (cur.n == null) return
    posSet(cur.slug, { n: cur.n, p: chapterProgress(), at: Date.now() })
}

const markRead = n => {
    if (n == null) return false
    const set = readSet(cur.slug)
    if (set.has(n)) return false
    set.add(n)
    saveRead(cur.slug, set)
    return true
}

// keep the library entry current so the continue strip resumes here. series metadata fills in once hydrated
const touchLib = () => {
    const s = cur.series
    const have = library().find(e => e.slug === cur.slug)
    touchLibrary({
        slug: cur.slug,
        title: s?.title || have?.title || cur.slug.replace(/-/g, ' '),
        cover: s?.cover || have?.cover || '',
        author: s?.author || have?.author,
        total: cur.chapters.length,
        lastN: cur.n,
        readCount: readSet(cur.slug).size,
    })
}

// navigation

const goChapter = n => {
    posSave()
    const tIdx = cur.chapters.findIndex(c => c.n === n)
    if (tIdx > cur.idx) markRead(cur.n)
    touchLib()
    go(`#/read/${hashSlug(cur.slug)}/${n}`)
}

const jumpBy = d => {
    const c = cur.chapters[cur.idx + d]
    if (c) goChapter(c.n)
}

const exitReader = () => {
    posSave()
    touchLib()
    closeSheet()
    closeDrawer()
    back()
}

// chrome auto hide

const setChrome = hide => {
    chromeHidden = hide
    scroller().classList.toggle('hide-chrome', hide)
}

// render

const errEmpty = e => `<div class="empty">(x_x)\n\n${esc(e.message)}</div>`

const renderChapter = (ch, entry) => {
    const prose = $('#reader-prose')
    const total = cur.chapters.length
    const title = ch.title || entry?.t || ''
    const prev = cur.chapters[cur.idx - 1]

    prose.innerHTML =
        (prev ? `<button class="ch-prev" id="ch-prev">&lsaquo; ${esc(prev.t || `chapter ${prev.n}`)}</button>` : '') +
        `<div class="reader-ch-meta">chapter ${esc(cur.n)} of ${total}</div>` +
        (title ? `<h2>${esc(title)}</h2>` : '') +
        (ch.html || '')

    if (prev) $('#ch-prev').onclick = () => goChapter(prev.n)
}

const renderFoot = () => {
    const foot = $('#reader-foot')
    const next = cur.chapters[cur.idx + 1]
    if (next) {
        foot.innerHTML = `<button class="ch-next" id="ch-next">next chapter &rsaquo; ${esc(next.t || `chapter ${next.n}`)}</button>`
        $('#ch-next').onclick = () => goChapter(next.n)
        return
    }

    const s = cur.series
    const ongoing = /ongoing/i.test(s?.nfStatus || s?.status || '')
    foot.innerHTML = `<div class="rfoot-end">
      <div class="rfoot-end-mark">(￣▽￣)b</div>
      <div class="rfoot-end-title">all caught up</div>
      <div class="rfoot-end-sub">${ongoing ? 'this novel is ongoing. new chapters will appear here.' : `all ${cur.chapters.length} chapters read.`}</div>
      <button class="btn" id="rfoot-back">back to series</button></div>`
    $('#rfoot-back').onclick = exitReader
}

// deep links land here with only a slug, so pull series metadata in the background to fill title and cover
const hydrateSeries = async slug => {
    try {
        const key = slug.includes(':') ? slug : 'nf:' + slug
        const s = await getSeries(key)
        if (cur.slug !== slug || !s) return
        cur.series = { ...s, _slug: slug }
        renderFoot()
        touchLib()
    } catch {}
}

const fetchChapters = async slug => {
    if (cur.slug === slug && cur.chapters.length) return cur.chapters
    const { chapters } = await getChapters(slug)
    return chapters || []
}

// entry point, called whenever the read route is shown
export async function showReader(slug, n) {
    wire()
    applySettings()
    setChrome(false)
    const mine = ++req

    const prose = $('#reader-prose'), foot = $('#reader-foot')
    prose.innerHTML = `<div class="spinner"></div>`
    foot.innerHTML = ''
    scroller().scrollTop = 0

    let chapters
    try { chapters = await fetchChapters(slug) }
    catch (e) { if (mine === req) prose.innerHTML = errEmpty(e); return }
    if (mine !== req) return

    const idx = Math.max(0, chapters.findIndex(c => c.n === n))
    Object.assign(cur, { slug, n, chapters, idx })
    if (cur.series && cur.series._slug !== slug) cur.series = null
    const entry = chapters[idx]
    $('#r-title').textContent = entry?.t || `chapter ${n}`

    let ch
    try { ch = await getChapter(slug, n) }
    catch (e) { if (mine === req) prose.innerHTML = errEmpty(e); return }
    if (mine !== req) return

    renderChapter(ch, entry)
    renderFoot()

    // restore the saved spot inside this chapter, otherwise start at the top, then persist where we landed
    const pos = posGet(slug)
    requestAnimationFrame(() => {
        if (mine !== req) return
        const s = scroller()
        const max = s.scrollHeight - s.clientHeight
        s.scrollTop = pos && pos.n === n && pos.p > 0 ? pos.p * max : 0
        updateProgress()
        posSave()
    })

    touchLib()
    const next = chapters[idx + 1]
    if (next) prefetchChapter(slug, next.n)
    if (!cur.series) hydrateSeries(slug)
}

// chapter drawer, jump anywhere without leaving the reader

const openDrawer = () => {
    if (!cur.chapters.length) return
    dw.q = ''
    $('#dw-q').value = ''
    dw.lo = Math.max(0, cur.idx - 25)
    dw.hi = Math.min(cur.chapters.length, cur.idx + 75)
    renderDrawer()
    $('#drawer').classList.add('open')
    $('#drawer-backdrop').classList.add('open')
    $('#drawer-list .chap.current')?.scrollIntoView({ block: 'center' })
}

const closeDrawer = () => {
    $('#drawer')?.classList.remove('open')
    $('#drawer-backdrop')?.classList.remove('open')
}

function renderDrawer() {
    const listEl = $('#drawer-list')
    const set = readSet(cur.slug)
    const total = cur.chapters.length

    let rows
    if (dw.q) {
        const f = dw.q.toLowerCase()
        const asNum = Number(dw.q)
        rows = cur.chapters.map((c, i) => ({ c, i }))
            .filter(({ c }) => (c.t || '').toLowerCase().includes(f) || (Number.isFinite(asNum) && c.n === asNum))
            .slice(0, 200)
    } else {
        rows = cur.chapters.slice(dw.lo, dw.hi).map((c, k) => ({ c, i: dw.lo + k }))
    }

    const row = ({ c, i }) => `<a class="chap${set.has(c.n) ? ' read' : ''}${i === cur.idx ? ' current' : ''}" href="#/read/${hashSlug(cur.slug)}/${c.n}">
      <span class="n">#${esc(c.n)}</span><span class="t">${esc(c.t || '')}</span><span class="dot"></span></a>`

    listEl.innerHTML =
        (!dw.q && dw.lo > 0 ? `<button class="drawer-more" id="dw-earlier">${dw.lo} earlier&hellip;</button>` : '') +
        (rows.length ? rows.map(row).join('') : `<div class="empty">(´д｀)\n\nno matching chapters</div>`) +
        (!dw.q && dw.hi < total ? `<button class="drawer-more" id="dw-later">${total - dw.hi} later&hellip;</button>` : '')

    $('#dw-earlier')?.addEventListener('click', () => {
        const h = listEl.scrollHeight
        dw.lo = Math.max(0, dw.lo - 150)
        renderDrawer()
        listEl.scrollTop += listEl.scrollHeight - h
    })
    $('#dw-later')?.addEventListener('click', () => {
        dw.hi = Math.min(total, dw.hi + 150)
        renderDrawer()
    })
}

// display settings sheet

const openSheet = () => {
    syncSheet()
    $('#sheet').classList.add('open')
    $('#sheet-backdrop').classList.add('open')
}

const closeSheet = () => {
    $('#sheet')?.classList.remove('open')
    $('#sheet-backdrop')?.classList.remove('open')
}

const syncSheet = () => {
    $$('#set-theme .swatch').forEach(b => b.classList.toggle('on', b.dataset.theme === settings.theme))
    $$('#set-font button').forEach(b => b.classList.toggle('on', b.dataset.font === settings.font))
    $$('#set-lh button').forEach(b => b.classList.toggle('on', Number(b.dataset.lh) === settings.lh))
    $$('#set-width button').forEach(b => b.classList.toggle('on', b.dataset.width === settings.width))
}

const commit = () => {
    saveSettings(settings)
    applySettings()
    syncSheet()
    updateProgress()
}

// one time wiring of every reader control and the scroll engine

const onScrollIdle = () => {
    if (scroller().hidden || cur.n == null) return
    posSave()
    if (chapterProgress() >= 0.98 && markRead(cur.n)) touchLib()
}

function wire() {
    if (wired) return
    wired = true

    const r = scroller()
    $('#r-back').onclick = exitReader
    $('#r-list').onclick = openDrawer
    $('#r-settings').onclick = openSheet
    $('#drawer-backdrop').onclick = closeDrawer
    $('#sheet-backdrop').onclick = closeSheet
    $('#drawer-list').addEventListener('click', e => { if (e.target.closest('a')) closeDrawer() })
    $('#dw-q').addEventListener('input', e => { dw.q = e.target.value.trim(); renderDrawer() })

    $('#set-theme').onclick = e => { const b = e.target.closest('[data-theme]'); if (!b) return; settings.theme = b.dataset.theme; commit() }
    $('#set-font').onclick = e => { const b = e.target.closest('[data-font]'); if (!b) return; settings.font = b.dataset.font; commit() }
    $('#set-width').onclick = e => { const b = e.target.closest('[data-width]'); if (!b) return; settings.width = b.dataset.width; commit() }
    $('#set-lh').onclick = e => { const b = e.target.closest('[data-lh]'); if (!b) return; settings.lh = Number(b.dataset.lh); commit() }
    $('#set-size').onclick = e => {
        const b = e.target.closest('[data-size]')
        if (!b) return
        if (b.dataset.size === 'reset') settings.size = SET_DEFAULT.size
        else settings.size = Math.max(14, Math.min(28, settings.size + (b.dataset.size === '+' ? 1 : -1)))
        commit()
    }

    // tap anywhere that is not a link toggles the chrome, a real scroll handles the rest
    r.addEventListener('click', e => {
        if (e.target.closest('a, button')) return
        if (String(window.getSelection?.() ?? '')) return
        setChrome(!chromeHidden)
    })

    let ticking = false
    let idleTimer
    r.addEventListener('scroll', () => {
        if (r.hidden || cur.n == null) return
        if (!ticking) {
            ticking = true
            requestAnimationFrame(() => {
                if (!chromeHidden && r.scrollTop > 40) setChrome(true)
                updateProgress()
                ticking = false
            })
        }
        clearTimeout(idleTimer)
        idleTimer = setTimeout(onScrollIdle, 300)
    }, { passive: true })

    // arrows jump chapters, escape leaves, native scroll does the reading
    window.addEventListener('keydown', e => {
        if (r.hidden || cur.n == null || e.target.closest('input')) return
        if (e.key === 'ArrowRight') jumpBy(1)
        if (e.key === 'ArrowLeft') jumpBy(-1)
        if (e.key === 'Escape') exitReader()
    })

    window.addEventListener('pagehide', posSave)
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') posSave() })
}
