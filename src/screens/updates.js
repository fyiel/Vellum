import { buildFeed, setRead, markAll } from '../lib/updates.js'
import { coverImg } from '../lib/cover.js'
import { go, hashSlug } from '../lib/router.js'
import { $, $$, esc } from '../lib/dom.js'
import { relTime } from '../lib/time.js'

const CHIP_MAX = 5
const BUCKETS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['earlier', 'Earlier']]

let wired = false
let feed = []
let failed = false
let filter = 'all'
const formatName = value => value ? value[0].toUpperCase() + value.slice(1) : ''

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
    const updates = u.kind === 'manga' ? u.newChapters : u.newNums.map(n => ({ n, label: `Ch ${n}` }))
    const chips = updates.slice(0, CHIP_MAX).map(chapter => u.kind === 'manga'
        ? `<a class="uchip" data-id="${esc(chapter.id)}">${esc(chapter.label)}</a>`
        : `<a class="uchip" data-n="${esc(chapter.n)}">${esc(chapter.label)}</a>`).join('')
    const more = updates.length > CHIP_MAX ? `<span class="umore">+${updates.length - CHIP_MAX}</span>` : ''
    const badge = u.read ? '' : `<span class="unew">+${u.newCount} new</span>`
    const cover = coverImg(u.cover, u.title)
    const meta = u.kind === 'manga' ? `<div class="umeta">${esc([formatName(u.format), u.source].filter(Boolean).join(' · '))}</div>` : ''
    return `<div class="urow ${u.read ? 'read' : 'unread'}" data-slug="${esc(u.slug)}" data-kind="${u.kind === 'manga' ? 'manga' : 'novel'}" data-new="${esc(u.newCount)}" data-up="${esc(u.latest)}">
      <span class="cv">${cover}</span>
      <div class="utt"><div class="n">${esc(u.title)}</div>${meta}<div class="uch">${badge}${chips}${more}</div></div>
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

    const warning = failed ? `<div class="void">${feed.length ? 'couldn’t check every series' : 'couldn’t check for updates'}</div>` : ''
    $('#ufeed').innerHTML = warning + (html || (failed ? '' : `<div class="void">no new chapters. you are all caught up</div>`))
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
    const item = feed.find(entry => entry.slug === row.dataset.slug)
    if (item) item.read = read
    setRead(row.dataset.slug, read, read ? row.dataset.up : null, item?.latestIds)

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
        if (chip) {
            const row = chip.closest('.urow')
            if (row.dataset.kind === 'manga') go(`#/manga/read/${encodeURIComponent(row.dataset.slug)}/${encodeURIComponent(chip.dataset.id)}`)
            else go(`#/read/${hashSlug(row.dataset.slug)}/${chip.dataset.n}`)
            return
        }
        const row = e.target.closest('.urow')
        if (row) go(row.dataset.kind === 'manga' ? `#/manga/series/${encodeURIComponent(row.dataset.slug)}` : `#/series/${encodeURIComponent(row.dataset.slug)}`)
    })
}

export async function showUpdates() {
    wire()
    $('#ufeed').innerHTML = `<div class="void">checking for new chapters&hellip;</div>`
    const result = await buildFeed()
    feed = result.feed
    failed = result.failed
    render()
    refresh()
}
