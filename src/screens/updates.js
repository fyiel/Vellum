import { buildFeed, setRead, markAll } from '../lib/updates.js'
import { go, hashSlug } from '../lib/router.js'

const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const CHIP_MAX = 5
const BUCKETS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['earlier', 'Earlier']]

let wired = false
let feed = []
let filter = 'all'

function relTime(ts) {
    const s = (Date.now() - ts) / 1000
    if (s < 60) return 'now'
    const m = s / 60
    if (m < 60) return `${Math.floor(m)}m`
    const h = m / 60
    if (h < 24) return `${Math.floor(h)}h`
    const d = h / 24
    if (d < 7) return `${Math.floor(d)}d`
    const w = d / 7
    return w < 5 ? `${Math.floor(w)}w` : `${Math.floor(d / 30)}mo`
}

function bucketOf(ts) {
    const n = new Date()
    const startToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()
    const day = 86400000
    if (ts >= startToday) return 'today'
    if (ts >= startToday - day) return 'yesterday'
    if (ts >= startToday - 7 * day) return 'week'
    return 'earlier'
}

function rowHtml(u) {
    const chips = u.newNums.slice(0, CHIP_MAX).map(n => `<a class="uchip" data-n="${n}">Ch ${n}</a>`).join('')
    const more = u.newNums.length > CHIP_MAX ? `<span class="umore">+${u.newNums.length - CHIP_MAX}</span>` : ''
    const badge = u.read ? '' : `<span class="unew">+${u.newCount} new</span>`
    const cover = u.cover ? `<img src="${esc(u.cover)}" loading="lazy" alt="">` : ''
    return `<div class="urow ${u.read ? 'read' : 'unread'}" data-slug="${esc(u.slug)}" data-new="${u.newCount}">
      <span class="cv">${cover}</span>
      <div class="utt"><div class="n">${esc(u.title)}</div><div class="uch">${badge}${chips}${more}</div></div>
      <span class="utime">${esc(relTime(u.firstSeen))}</span>
      <button class="umark" title="${u.read ? 'Mark unread' : 'Mark read'}">&#10003;</button>
    </div>`
}

function render() {
    const groups = {}
    for (const u of feed) (groups[bucketOf(u.firstSeen)] ||= []).push(u)

    let html = ''
    for (const [key, label] of BUCKETS) {
        const items = groups[key]
        if (!items?.length) continue
        const ct = key === 'earlier' ? '' : ` <span class="ct">&middot; ${items.length} series</span>`
        html += `<div class="usec"><div class="lab">${label}${ct}</div>${items.map(rowHtml).join('')}</div>`
    }

    $('#ufeed').innerHTML = html || `<div class="void">no new chapters. you are all caught up</div>`
}

function refresh() {
    let n = 0
    $$('#ufeed .urow:not(.read)').forEach(r => { n += parseInt(r.dataset.new || '0', 10) })
    $('#count-updates').textContent = n ? String(n) : ''

    const unreadOnly = filter === 'unread'
    $('#den').classList.toggle('flt-unread', unreadOnly)
    $$('#ufeed .usec').forEach(sec => {
        const anyUnread = !!sec.querySelector('.urow.unread')
        sec.style.display = unreadOnly && !anyUnread ? 'none' : ''
    })
}

function setRowRead(row, read) {
    row.classList.toggle('read', read)
    row.classList.toggle('unread', !read)
    setRead(row.dataset.slug, read)

    const uch = row.querySelector('.uch')
    const badge = uch.querySelector('.unew')
    if (read) badge?.remove()
    else if (!badge) {
        const b = document.createElement('span')
        b.className = 'unew'
        b.textContent = `+${row.dataset.new} new`
        uch.prepend(b)
    }
    row.querySelector('.umark').title = read ? 'Mark unread' : 'Mark read'
}

function wire() {
    if (wired) return
    wired = true

    $('#useg').addEventListener('click', e => {
        const s = e.target.closest('span[data-f]')
        if (!s) return
        $$('#useg span').forEach(o => o.classList.toggle('on', o === s))
        filter = s.dataset.f
        refresh()
    })

    $('#umarkall').addEventListener('click', () => {
        markAll(feed)
        $$('#ufeed .urow:not(.read)').forEach(r => setRowRead(r, true))
        refresh()
    })

    $('#ufeed').addEventListener('click', e => {
        const mark = e.target.closest('.umark')
        if (mark) { e.stopPropagation(); const row = mark.closest('.urow'); setRowRead(row, !row.classList.contains('read')); refresh(); return }
        const chip = e.target.closest('.uchip')
        if (chip) { const row = chip.closest('.urow'); go(`#/read/${hashSlug(row.dataset.slug)}/${chip.dataset.n}`); return }
        const row = e.target.closest('.urow')
        if (row) go(`#/series/${encodeURIComponent(row.dataset.slug)}`)
    })
}

export async function showUpdates() {
    wire()
    $('#ufeed').innerHTML = `<div class="void">checking for new chapters&hellip;</div>`
    feed = await buildFeed()
    render()
    refresh()
}
