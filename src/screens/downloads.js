import { dlGet, dlJob, deleteSeries, saveDl, onDl, estimate, fmtBytes, allDls, syncAutoSeries } from '../lib/downloads.js'
import { loadUpdLedger } from '../lib/store.js'
import { go, hashSlug } from '../lib/router.js'
import { coverImg } from '../lib/cover.js'
import { $, $$, esc } from '../lib/dom.js'

let wired = false
let items = []

function rowHtml(m) {
    const slug = m.slug
    const job = dlJob(slug)
    const title = m.meta?.title || slug
    const cover = coverImg(m.meta?.cover, title)
    const size = job
        ? `&#x2913; ${Math.round((100 * job.done) / Math.max(1, job.total))}% &middot; ${job.done}/${job.total}`
        : fmtBytes(m.bytes || 0)
    const pend = (loadUpdLedger()[slug]?.newNums || []).filter(n => !m.chapters.includes(n)).length
    return `<div class="trow dlrow" data-slug="${esc(slug)}">
      <span class="cv">${cover}</span>
      <div class="tt">
        <div class="n">${esc(title)}</div>
        <div class="au">
          <label class="tog${m.auto ? ' on' : ''}"><input type="checkbox" ${m.auto ? 'checked' : ''}><span>keep this series offline</span></label>
          ${pend ? `<span class="pend">+${pend} new</span>` : ''}
        </div>
      </div>
      <span class="dlsize">${size}</span>
      <span class="dlch">${m.chapters.length} ch</span>
      <button class="dlrm">remove</button>
    </div>`
}

function refresh() {
    items = allDls()
    $('#dllist').innerHTML = items.length
        ? items.map(rowHtml).join('')
        : `<div class="void">nothing downloaded yet — open a series and hit Download</div>`
}

async function renderQuota() {
    const el = $('#dlquota')
    if (!el) return
    const est = await estimate()
    if (est.quota == null || est.usage == null) {
        el.innerHTML = ''
        return
    }
    const pct = Math.min(100, Math.max(0, (100 * est.usage) / Math.max(1, est.quota)))
    el.innerHTML = `<span class="dq-t">${fmtBytes(est.usage)} of ${fmtBytes(est.quota)}</span><div class="bar"><span style="width:${pct.toFixed(1)}%"></span></div>`
}

async function toggleAuto(slug, on) {
    const m = dlGet(slug)
    if (!m) return
    m.auto = on
    saveDl(slug, m)
    refresh()
    if (on) syncAutoSeries(slug)
}

function openRow(slug) {
    const m = dlGet(slug)
    // offline reading starts at the latest downloaded chapter
    const n = m?.chapters?.length ? m.chapters[m.chapters.length - 1] : 1
    go(`#/read/${hashSlug(slug)}/${n}`)
}

function wire() {
    if (wired) return
    wired = true

    $('#dllist').addEventListener('click', e => {
        const rm = e.target.closest('.dlrm')
        if (rm) {
            e.stopPropagation()
            const slug = rm.closest('.dlrow').dataset.slug
            deleteSeries(slug).then(refresh).then(renderQuota)
            return
        }
        const tog = e.target.closest('.tog input')
        if (tog) {
            e.stopPropagation()
            toggleAuto(tog.closest('.dlrow').dataset.slug, tog.checked)
            return
        }
        const row = e.target.closest('.dlrow')
        if (row) openRow(row.dataset.slug)
    })

    onDl(ev => {
        if (ev.type === 'progress') {
            // patch the size cell in place, re parsing every manifest per chapter is wasteful
            const row = items.length && document.querySelector(`#dllist .dlrow[data-slug="${CSS.escape(ev.slug)}"]`)
            if (row) {
                const size = row.querySelector('.dlsize')
                if (size) size.textContent = `⤓ ${Math.round((100 * ev.done) / Math.max(1, ev.total))}% · ${ev.done}/${ev.total}`
            }
        } else {
            refresh()
            renderQuota()
        }
    })
}

export async function showDownloads() {
    wire()
    refresh()
    renderQuota()
    // a series toggled to stay offline catches new chapters on every visit, fed by the
    // updates ledger when it knows about them and by a live diff otherwise
    for (const it of items) if (it.auto) syncAutoSeries(it.slug)
}
