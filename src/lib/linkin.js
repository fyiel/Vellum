import { searchNovels, getSeries } from './api.js'
import { go, hashSlug } from './router.js'
import { srcIds, srcLabel } from './source.js'
import { coverImg } from './cover.js'
import { $, esc } from './dom.js'

// Link In: a novelupdates link (native launch, top-bar button, or a url pasted into discover)
// is validated, resolved against the catalog search, and shown on a confirm card. the user
// explicitly opens the series or chapter — nothing ever auto-navigates.

const LINKIN_HOSTS = new Set(['novelupdates.com', 'www.novelupdates.com'])
const PICKER_MAX = 3
const MAX_CHAPTER_N = 99999

const ERR = {
    empty: 'Paste a novelupdates link to get started.',
    url: 'That doesn\u2019t look like a link.',
    host: 'Only novelupdates.com links are supported.',
    path: 'Only series and chapter links are supported.',
}

// links that arrive before the sheet is wired (native cold start) park here until drained
const queue = []
export const queueLink = url => { const v = String(url ?? '').trim(); if (v) queue.push(v) }
export const drainLink = () => queue.shift() || null

let wired = false
let open = false
let req = 0
let lastLink = ''
let lastQuery = ''
let lastN = null
let state = null // confirm-card target: { key, slug, n }
let picked = [] // candidates shown in the ambiguous picker

// called by the native layer any time a url arrives; before wiring it just queues for the cold
// start, and while the reader takeover hides the shell it queues again so the sheet only ever
// appears over the shell (main.js drains the queue when the reader closes)
export function receiveLink(url) {
    if (!wired || document.body.classList.contains('reading')) queueLink(url)
    else openLinkIn(url)
}

// parse and validate a raw link. accepts only exact-match novelupdates hosts, only the path is
// trusted (search params and fragments are ignored entirely), ports and userinfo are rejected.
export function parseLink(raw) {
    const s = String(raw ?? '').trim()
    if (!s) return { ok: false, why: 'empty' }
    let u
    try { u = new URL(s) } catch { return { ok: false, why: 'url' } }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, why: 'host' }
    if (u.username || u.password || u.port) return { ok: false, why: 'host' }
    if (!LINKIN_HOSTS.has(u.hostname)) return { ok: false, why: 'host' }

    const series = u.pathname.match(/^\/series\/([^/]+)\/?$/)
    if (series) {
        const slug = cleanSlug(series[1])
        return slug ? { ok: true, slug } : { ok: false, why: 'path' }
    }

    const ext = u.pathname.match(/^\/extnu\/([^/]+)\/(\d+)\/?$/)
    if (ext) {
        const slug = cleanSlug(ext[1])
        if (!slug) return { ok: false, why: 'path' }
        const n = Number(ext[2])
        // a chapter number that cannot be resolved falls back to opening the series
        if (Number.isInteger(n) && n >= 1 && n <= MAX_CHAPTER_N) return { ok: true, slug, n }
        return { ok: true, slug }
    }
    return { ok: false, why: 'path' }
}

// the slug is only ever a search query, but still decode it and require the plain
// alphanumeric-dash shape novelupdates uses so encoded junk cannot ride along
const cleanSlug = raw => {
    let slug
    try { slug = decodeURIComponent(raw) } catch { return null }
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return null
    return slug
}

const titleFromSlug = slug => String(slug).replace(/[-_]+/g, ' ')

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
// relevance bonus so an exact title match surfaces first in the picker
const score = (r, q) => {
    const t = norm(r.title), n = norm(q)
    if (t === n) return 2
    if (t.startsWith(n) || n.startsWith(t)) return 1
    return 0
}

const metaOf = r => [r.author, r.year, r.chapters ? `${r.chapters} ch` : ''].filter(Boolean).join(' · ')
const stars = r => typeof r.rating === 'number' ? `<span class="st">&#9733;</span>${r.rating.toFixed(1)}` : ''
const srcOf = r => srcLabel(srcIds(r)[0] || r.sourceName)

const confirmHtml = (link, r, n) => {
    const chBtn = n != null ? `<button class="btn" id="li-chapter">Open chapter ${esc(n)}</button>` : ''
    const meta = metaOf(r), rt = stars(r)
    return `<div class="linkin-card">
      <div class="linkin-raw" title="${esc(link)}">${esc(link)}</div>
      <div class="linkin-match">
        <span class="cv">${coverImg(r.cover, r.title)}</span>
        <div class="tt">
          <div class="n">${esc(r.title)}</div>
          ${meta ? `<div class="au">${esc(meta)}</div>` : ''}
          <div class="pr">${esc(srcOf(r))}</div>
        </div>
        ${rt ? `<span class="rt">${rt}</span>` : ''}
      </div>
      <div class="linkin-actions">
        <button class="btn primary" id="li-series">Open series</button>
        ${chBtn}
        <button class="btn" id="li-cancel">Cancel</button>
      </div>
    </div>`
}

const pickerHtml = (link, cands, n) => {
    const rows = cands.map((r, i) => {
        const meta = metaOf(r), rt = stars(r)
        return `<div class="linkin-row" data-i="${i}">
        <span class="cv">${coverImg(r.cover, r.title)}</span>
        <div class="tt">
          <div class="n">${esc(r.title)}</div>
          <div class="au">${esc(meta)}</div>
          <div class="pr">${esc(srcOf(r))}</div>
        </div>
        ${rt ? `<span class="rt">${rt}</span>` : ''}
      </div>`
    }).join('')
    return `<div class="linkin-pick">
      <div class="linkin-raw" title="${esc(link)}">${esc(link)}</div>
      <div class="linkin-picklab">Several series match, pick one</div>
      ${rows}
    </div>`
}

const errorHtml = (msg, extra) => `<div class="linkin-err">${esc(msg)}${extra || ''}</div>`

const setStatus = t => { $('#linkin-status').textContent = t || '' }
const setBody = h => { $('#linkin-body').innerHTML = h || '' }
const focusUrl = () => { const el = $('#linkin-url'); el.focus(); el.select() }

const still = mine => open && mine === req

function openSheet() {
    open = true
    $('#linkin').classList.add('open')
    $('#linkin-backdrop').classList.add('open')
}

function closeSheet() {
    open = false
    $('#linkin').classList.remove('open')
    $('#linkin-backdrop').classList.remove('open')
}

function navigateSeries(key) {
    sessionStorage.setItem('vellum:linkOrigin', '1')
    go(`#/series/${encodeURIComponent(key)}`)
    closeSheet()
}

function navigateChapter(slug, n) {
    sessionStorage.setItem('vellum:linkOrigin', '1')
    go(`#/read/${hashSlug(slug)}/${n}`)
    closeSheet()
}

function showConfirm(r, n) {
    state = { key: r.key, slug: r.nfSlug || r.key, n }
    setStatus('')
    setBody(confirmHtml(lastLink, r, n))
    const btn = $('#li-series')
    if (btn) btn.focus()
    // search rows carry no rating, backfill it from the series record once it lands
    getSeries(r.key).then(s => {
        if (!(s && typeof s.rating === 'number' && still(req))) return
        const match = $('.linkin-match')
        if (!match) return
        let rt = match.querySelector('.rt')
        if (!rt) {
            rt = document.createElement('span')
            rt.className = 'rt'
            match.appendChild(rt)
        }
        rt.innerHTML = `<span class="st">&#9733;</span>${s.rating.toFixed(1)}`
    }).catch(() => {})
}

async function resolve(mine) {
    const parsed = parseLink(lastLink)
    if (!parsed.ok) {
        setBody(errorHtml(ERR[parsed.why] || ERR.url))
        setStatus('')
        focusUrl()
        return
    }
    lastN = parsed.n ?? null
    lastQuery = titleFromSlug(parsed.slug)
    setBody('')
    setStatus('Resolving\u2026')

    let data
    try { data = await searchNovels(lastQuery) }
    catch { if (still(mine)) { setStatus(''); setBody(errorHtml('Couldn\u2019t reach the catalog right now.', '<button class="btn" id="li-retry">Retry</button>')) } return }
    if (!still(mine)) return

    const cands = (data?.results || [])
        .map(r => ({ r, sc: score(r, lastQuery) }))
        .sort((a, b) => b.sc - a.sc || (b.r.rating || 0) - (a.r.rating || 0))

    if (!cands.length) {
        setStatus('')
        setBody(errorHtml(`No series matched \u201c${lastQuery}\u201d.`, '<button class="btn" id="li-search">Search Vellum</button>'))
        return
    }
    if (cands.length === 1) { showConfirm(cands[0].r, lastN); return }

    // ambiguous: top-3 picker rows, a click promotes the row to the confirm card
    state = null
    picked = cands.slice(0, PICKER_MAX).map(c => c.r)
    setStatus('')
    setBody(pickerHtml(lastLink, picked, lastN))
}

export function openLinkIn(raw) {
    const mine = ++req
    lastLink = String(raw ?? '').trim()
    openSheet()
    if (!lastLink) { setBody(''); setStatus(''); focusUrl(); return }
    resolve(mine)
}

function onClickBody(e) {
    if (e.target.closest('#li-series')) { if (state) navigateSeries(state.key); return }
    if (e.target.closest('#li-chapter')) { if (state?.n != null) navigateChapter(state.slug, state.n); return }
    if (e.target.closest('#li-cancel')) { closeSheet(); return }
    if (e.target.closest('#li-search')) { sessionStorage.setItem('vellum:discoverSeed', lastQuery); closeSheet(); go('#/discover'); return }
    if (e.target.closest('#li-retry')) { openLinkIn(lastLink); return }
    const row = e.target.closest('.linkin-row')
    if (row) {
        const i = Number(row.dataset.i)
        if (Number.isInteger(i)) showConfirm(picked[i], lastN)
    }
}

export function initLinkIn() {
    if (wired) return
    wired = true

    const url = $('#linkin-url')
    $('#linkin-paste').addEventListener('click', async () => {
        try {
            const t = await navigator.clipboard.readText()
            if (t) { url.value = t; openLinkIn(t) } else url.focus()
        } catch { url.focus() }
    })
    url.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); openLinkIn(url.value) }
    })
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && open) closeSheet()
    })
    $('#linkin-backdrop').addEventListener('click', closeSheet)
    $('#linkin-body').addEventListener('click', onClickBody)
    $('#linkin-btn').addEventListener('click', () => openLinkIn(''))
}
