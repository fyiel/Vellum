import {
    library, readSet, saveRead, posGet, posSet, touchLibrary, saveLibrary,
    loadSettings, saveSettings, loadFeel, saveFeel, loadLibSort, saveLibSort,
    loadUpdLedger, saveUpdLedger, loadLastBackup, saveLastBackup,
} from '../lib/store.js'
import { $ } from '../lib/dom.js'
import { relTime } from '../lib/time.js'

const BACKUP_VERSION = 1
const CAP = 60
// conservative headroom under the ~5MB webview quotas (units = utf-16 code units)
const QUOTA_UNITS = 3_000_000
const BAD_SLUGS = new Set(['__proto__', 'constructor', 'prototype'])
const RD = 'vellum:read:'
const PS = 'vellum:pos:'

const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v)
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

const fmtSize = bytes => bytes < 1024 ? `${bytes} b` : `${Math.round(bytes / 1024)} kb`

// nucover:// is a tauri-only protocol wrapper; normalize back to the plain https url so the
// backup round-trips in any shell (the shell rewraps it again on render)
const normCover = cover => {
    if (!cover || !cover.startsWith('nucover://')) return cover
    try {
        const u = new URL(cover)
        const t = u.searchParams.get('u')
        if (t) return t
    } catch {}
    return ''
}

export function buildExportData() {
    const lib = library()
    const read = {}, pos = {}, updates = {}
    const ledger = loadUpdLedger()
    for (const e of lib) {
        const s = e.slug
        const rs = [...readSet(s)]
        if (rs.length) read[s] = rs
        const p = posGet(s)
        if (p) pos[s] = p
        // the ledger snapshot is recomputable from the api, shed newNums on export
        const l = ledger[s]
        if (l) updates[s] = {
            firstSeen: l.firstSeen,
            read: !!l.read,
            seenUpTo: l.seenUpTo == null ? null : l.seenUpTo,
            latest: l.latest ?? 0,
        }
    }
    return {
        format: 'vellum-backup',
        version: BACKUP_VERSION,
        app: 'vellum',
        exportedAt: Date.now(),
        data: {
            lib: lib.map(e => ({ ...e, cover: normCover(e.cover) })),
            read, pos,
            settings: loadSettings(),
            feel: loadFeel(),
            libsort: loadLibSort(),
            updates,
        },
    }
}

// fail closed: parse, gate, and normalize before a single byte is written
export function validateBackup(text) {
    let raw
    try { raw = JSON.parse(text) } catch { return { ok: false, error: 'not a vellum backup file' } }
    if (!isObj(raw) || raw.format !== 'vellum-backup') return { ok: false, error: 'not a vellum backup file' }
    if (!Number.isFinite(raw.version) || raw.version < 1) return { ok: false, error: 'unsupported backup version' }
    if (raw.version > BACKUP_VERSION) return { ok: false, error: 'this backup is from a newer vellum — update the app to restore it' }

    const d = raw.data
    if (!isObj(d) || !Array.isArray(d.lib)) return { ok: false, error: 'corrupt backup' }

    const lib = [], slugs = new Set()
    for (const e of d.lib) {
        if (!isObj(e) || typeof e.slug !== 'string' || !e.slug || BAD_SLUGS.has(e.slug)) return { ok: false, error: 'corrupt backup' }
        if (slugs.has(e.slug)) continue
        slugs.add(e.slug)
        lib.push({ ...e })
    }

    const read = {}
    if (d.read != null && !isObj(d.read)) return { ok: false, error: 'corrupt backup' }
    for (const [slug, arr] of Object.entries(d.read ?? {})) {
        if (!slugs.has(slug) || !Array.isArray(arr)) continue
        const nums = arr.filter(n => Number.isFinite(n))
        if (nums.length) read[slug] = nums
    }

    const pos = {}
    if (d.pos != null && !isObj(d.pos)) return { ok: false, error: 'corrupt backup' }
    for (const [slug, p] of Object.entries(d.pos ?? {})) {
        if (!slugs.has(slug) || !isObj(p)) continue
        if (!Number.isFinite(p.n) || !Number.isFinite(p.p) || !Number.isFinite(p.at)) continue
        pos[slug] = { n: p.n, p: p.p, at: p.at }
    }

    for (const k of ['settings', 'feel', 'libsort', 'updates']) {
        if (d[k] != null && !isObj(d[k])) return { ok: false, error: 'corrupt backup' }
    }

    // ledger entries for slugs we are not restoring are dropped, newNums never imported
    const updates = {}
    for (const [slug, u] of Object.entries(d.updates ?? {})) {
        if (!slugs.has(slug) || !isObj(u) || !Number.isFinite(u.firstSeen)) continue
        updates[slug] = {
            firstSeen: u.firstSeen,
            read: !!u.read,
            seenUpTo: Number.isFinite(u.seenUpTo) ? u.seenUpTo : null,
            latest: Number.isFinite(u.latest) ? u.latest : 0,
        }
    }

    return {
        ok: true,
        data: {
            lib, read, pos,
            settings: d.settings ?? {},
            feel: d.feel ?? {},
            libsort: d.libsort ?? {},
            updates,
            exportedAt: Number.isFinite(raw.exportedAt) ? raw.exportedAt : 0,
        },
    }
}

const usageUnits = () => {
    let n = 0
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        n += k.length + (localStorage.getItem(k)?.length ?? 0)
    }
    return n
}

// serialized values the accessors will write, used for the quota pre-check and the post-write verify
function writePlan(norm) {
    const keys = new Map()
    for (const [slug, arr] of Object.entries(norm.read)) keys.set(`${RD}${slug}`, JSON.stringify([...new Set(arr)]))
    for (const [slug, p] of Object.entries(norm.pos)) keys.set(`${PS}${slug}`, JSON.stringify(p))
    keys.set('vellum:settings', JSON.stringify(norm.settings))
    keys.set('vellum:feel', JSON.stringify(norm.feel))
    keys.set('vellum:libsort', JSON.stringify(norm.libsort))
    keys.set('vellum:updates', JSON.stringify(norm.updates))
    return keys
}

function projectedUnits(norm) {
    const keys = writePlan(norm)
    const keep = new Set(norm.lib.slice(0, CAP).map(e => e.slug))
    let units = usageUnits()
    for (const k of keys.keys()) {
        const old = localStorage.getItem(k)
        if (old != null) units -= k.length + old.length
    }
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if ((k.startsWith(RD) || k.startsWith(PS)) && !keep.has(k.slice(k.startsWith(RD) ? RD.length : PS.length))) {
            units -= k.length + (localStorage.getItem(k)?.length ?? 0)
        }
    }
    for (const [k, v] of keys) units += k.length + v.length
    // lib lands last through touchLibrary (recency stamps), over-approximate its size
    let libUnits = 'vellum:lib'.length
    for (const e of norm.lib.slice(0, CAP)) libUnits += JSON.stringify(e).length + 32
    return units + libUnits
}

function snapshot() {
    const read = Object.create(null), pos = Object.create(null)
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k.startsWith(RD)) read[k.slice(RD.length)] = [...readSet(k.slice(RD.length))]
        else if (k.startsWith(PS)) pos[k.slice(PS.length)] = posGet(k.slice(PS.length))
    }
    // raw prior values so a rollback is byte-exact (absent keys stay absent)
    const cfg = Object.create(null)
    for (const k of ['vellum:settings', 'vellum:feel', 'vellum:libsort', 'vellum:updates']) {
        const v = localStorage.getItem(k)
        if (v != null) cfg[k] = v
    }
    return { lib: library(), read, pos, cfg }
}

function rollback(snap) {
    for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i)
        if (k.startsWith(RD)) { if (!hasOwn(snap.read, k.slice(RD.length))) localStorage.removeItem(k) }
        else if (k.startsWith(PS)) { if (!hasOwn(snap.pos, k.slice(PS.length))) localStorage.removeItem(k) }
    }
    for (const [slug, arr] of Object.entries(snap.read)) saveRead(slug, new Set(arr))
    for (const [slug, p] of Object.entries(snap.pos)) if (p) posSet(slug, p)
    for (const k of ['vellum:settings', 'vellum:feel', 'vellum:libsort', 'vellum:updates']) {
        if (hasOwn(snap.cfg, k)) localStorage.setItem(k, snap.cfg[k])
        else localStorage.removeItem(k)
    }
    saveLibrary(snap.lib)
}

function verifyWrite(norm, expected) {
    for (const [k, v] of expected) if (localStorage.getItem(k) !== v) return false
    const got = library()
    const want = norm.lib.slice(0, CAP).map(e => e.slug)
    if (got.length !== want.length) return false
    for (let i = 0; i < want.length; i++) if (got[i]?.slug !== want[i]) return false
    return true
}

// replace semantics: the imported snapshot becomes the whole state; the prior one is
// remembered in memory and restored wholesale if the write hits the quota wall
export function restoreFrom(norm) {
    if (projectedUnits(norm) > QUOTA_UNITS) throw new Error('restore too large for this device')
    const snap = snapshot()
    const expected = writePlan(norm)
    try {
        for (const [slug, arr] of Object.entries(norm.read)) saveRead(slug, new Set(arr))
        for (const [slug, p] of Object.entries(norm.pos)) posSet(slug, p)
        saveSettings(norm.settings)
        saveFeel(norm.feel)
        saveLibSort(norm.libsort)
        saveUpdLedger(norm.updates)
        // vellum:lib lands last as the commit marker, cap 60 re-applied per entry,
        // reverse order keeps the backup's own ordering
        for (let i = norm.lib.length - 1; i >= 0; i--) touchLibrary(norm.lib[i])
        // touchLibrary stamps recency and merges, so give the backup its captured
        // timestamps back and drop anything the replace wiped
        const imp = new Map(norm.lib.slice(0, CAP).map(e => [e.slug, e]))
        saveLibrary(library().filter(e => imp.has(e.slug)).map(e => {
            const src = imp.get(e.slug)
            return src && src.updatedAt != null ? { ...e, updatedAt: src.updatedAt } : e
        }))
        // stale read/pos keys absent from the imported lib are pruned
        const keep = new Set(norm.lib.slice(0, CAP).map(e => e.slug))
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i)
            if (k.startsWith(RD) || k.startsWith(PS)) {
                const slug = k.slice(k.startsWith(RD) ? RD.length : PS.length)
                if (!keep.has(slug)) localStorage.removeItem(k)
            }
        }
        // the accessors swallow quota errors, verify every write actually landed
        if (!verifyWrite(norm, expected)) throw new Error('restore too large for this device')
    } catch (err) {
        try { rollback(snap) } catch {}
        throw err
    }
}

// ---- sheet ui ----

let wired = false
let pending = null

const refreshView = () => window.dispatchEvent(new Event('hashchange'))

function renderSummary() {
    const payload = buildExportData()
    const n = library().length
    const size = fmtSize(new Blob([JSON.stringify(payload)]).size)
    const lb = loadLastBackup()
    const ago = lb ? (relTime(lb) === 'now' ? 'just now' : `${relTime(lb)} ago`) : 'never backed up'
    $('#ds-sum').textContent = `${n} title${n === 1 ? '' : 's'} · ${size} · last backup ${ago}`
}

const backupName = ts => {
    const d = new Date(ts)
    const p = n => String(n).padStart(2, '0')
    return `vellum-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`
}

const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

async function saveFile(payload) {
    const name = backupName(payload.exportedAt)
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
    // ios wkwebview ignores the download attribute, hand the file to the share sheet instead
    if (iOS && navigator.share && navigator.canShare?.({ files: [new File([blob], name, { type: 'application/json' })] })) {
        await navigator.share({ files: [new File([blob], name, { type: 'application/json' })] })
        return
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
}

async function onExport() {
    const btn = $('#ds-export')
    try {
        const payload = buildExportData()
        await saveFile(payload)
        saveLastBackup(payload.exportedAt)
        renderSummary()
        const t = btn.textContent
        btn.textContent = 'Backup saved'
        setTimeout(() => { btn.textContent = t }, 1400)
    } catch { /* share dismissed — nothing was saved */ }
}

async function onFile() {
    const input = $('#ds-file')
    const f = input.files?.[0]
    input.value = ''
    if (!f) return
    let text
    try { text = await f.text() } catch { return showPage(1, 'could not read that file') }
    const v = validateBackup(text)
    if (!v.ok) return showPage(1, v.error)
    pending = v.data
    renderPreview(v.data, f.size)
    showPage(2)
}

function renderPreview(data, bytes) {
    const n = Math.min(data.lib.length, CAP)
    const date = data.exportedAt
        ? new Date(data.exportedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : 'unknown date'
    $('#ds-prev-info').textContent = `restore from ${date} · ${n} title${n === 1 ? '' : 's'} · ${fmtSize(bytes)}`
    $('#ds-prev-warn').textContent = 'will REPLACE library, progress, settings'
}

function onReplace() {
    if (!pending) return
    try {
        restoreFrom(pending)
        pending = null
        showPage(1)
        $('#data-sheet').classList.remove('open')
        $('#data-backdrop').classList.remove('open')
        refreshView()
    } catch (err) {
        showPage(1, err.message || 'restore failed')
    }
}

const showPage = (n, err) => {
    const errEl = $('#ds-err')
    errEl.hidden = !err
    errEl.textContent = err || ''
    $('#ds-act').style.display = n === 1 ? '' : 'none'
    $('#ds-prev').style.display = n === 2 ? '' : 'none'
}

export function mountData() {
    if (wired) return
    wired = true
    const sheet = $('#data-sheet'), backdrop = $('#data-backdrop')
    const open = () => { renderSummary(); sheet.classList.add('open'); backdrop.classList.add('open') }
    const close = () => { pending = null; showPage(1); sheet.classList.remove('open'); backdrop.classList.remove('open') }
    $('#data-row').addEventListener('click', open)
    backdrop.addEventListener('click', close)
    $('#ds-export').addEventListener('click', onExport)
    $('#ds-restore').addEventListener('click', () => $('#ds-file').click())
    $('#ds-file').addEventListener('change', onFile)
    $('#ds-cancel').addEventListener('click', () => { pending = null; showPage(1) })
    $('#ds-replace').addEventListener('click', onReplace)
}
