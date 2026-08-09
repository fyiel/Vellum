import { buildFeed, setRead, markAll } from '../lib/updates.js'
import { coverImg } from '../lib/cover.js'
import { go, hashSlug } from '../lib/router.js'
import { $, $$, esc } from '../lib/dom.js'
import { relTime } from '../lib/time.js'

const CHIP_MAX = 5
const BUCKETS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['earlier', 'Earlier']]

let wired = false
let feed = []
let filter = 'all'

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
    const chips = u.newNums.slice(0, CHIP_MAX).map(n => `<a class="uchip" data-n="${esc(n)}">Ch ${esc(n)}</a>`).join('')
    const more = u.newNums.length > CHIP_MAX ? `<span class="umore">+${u.newNums.length - CHIP_MAX}</span>` : ''
    const badge = u.read ? '' : `<span class="unew">+${u.newCount} new</span>`
    const cover = coverImg(u.cover, u.title)
    return `<div class="urow ${u.read ? 'read' : 'unread'}" data-slug="${esc(u.slug)}" data-new="${esc(u.newCount)}" data-up="${esc(u.latest)}">
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
    setRead(row.dataset.slug, read, read ? row.dataset.up : null)

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
