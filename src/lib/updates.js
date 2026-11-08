import { library, loadUpdLedger, saveUpdLedger } from './store.js'
import { getChapters } from './api.js'
import { getMangaChapters } from './manga-api.js'
import { getVideoSeries } from './video-api.js'

const isVideo = e => e.kind === 'anime' || e.kind === 'drama'

const rowOf = (e, led) => ({
    slug: e.slug, key: e.key, kind: e.kind, title: e.title, cover: e.cover,
    source: e.source, format: e.format,
    newNums: led.newNums || [], newChapters: led.newChapters || [], newEpisodes: led.newEpisodes || [],
    newCount: e.kind === 'manga' ? (led.newChapters?.length || 0) : isVideo(e) ? (led.newEpisodes?.length || 0) : (led.newNums?.length || 0),
    latest: led.latest, latestIds: led.latestIds,
    firstSeen: led.firstSeen, read: !!led.read,
})

// bounded concurrency so a big library does not serialize dozens of chapter fetches
async function mapPool(list, n, fn, signal) {
    const out = new Array(list.length)
    let i = 0
    const worker = async () => {
        while (i < list.length && !signal?.aborted) {
            const idx = i++
            out[idx] = await fn(list[idx], idx)
        }
    }
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker))
    return out
}

export async function buildFeed({ signal, fresh = false } = {}) {
    const lib = library()
    const now = Date.now()
    const feed = []
    let dirty = false

    const entries = await mapPool(lib, 5, async e => {
        try {
            const data = e.kind === 'manga' ? await getMangaChapters(e.key || e.slug, { signal, fresh })
                : isVideo(e) ? await getVideoSeries(e.key || e.slug, { fresh: true, signal }) : await getChapters(e.slug, { signal, fresh })
            return { e, chapters: isVideo(e) ? data?.episodes : data?.chapters }
        } catch { return { e, chapters: null } }
    }, signal)
    // A superseded visit must not write its stale ledger snapshot.
    if (signal?.aborted) throw new DOMException('updates check cancelled', 'AbortError')
    // Read the latest acknowledgements after network I/O, just before computing
    // and persisting alerts, so a check cannot undo a concurrent mark-as-read.
    const ledger = loadUpdLedger()
    const failed = entries.some(({ e, chapters }) => !Array.isArray(chapters) || (e.total > 0 && chapters.length === 0))

    for (const { e, chapters } of entries) {
        const led = ledger[e.slug]

        if (isVideo(e)) {
            if (!Array.isArray(chapters)) {
                if (led && !led.read && led.newEpisodes?.length) feed.push(rowOf(e, led))
                continue
            }
            const latestIds = chapters.map(episode => episode.id)
            const baseline = led?.seenIds || e.episodeIds
            if (!Array.isArray(baseline)) {
                ledger[e.slug] = { firstSeen: now, read: true, seenIds: latestIds, newEpisodes: [], latest: chapters.length }
                dirty = true
                continue
            }
            const seen = new Set(baseline)
            const fresh = chapters.filter(episode => !seen.has(episode.id)).map(episode => ({
                id: episode.id,
                label: episode.season && episode.number != null ? `S${episode.season} · E${episode.number}`
                    : episode.number != null ? `Episode ${episode.number}` : episode.title || 'Special',
            }))
            if (!fresh.length) continue
            if (!led) ledger[e.slug] = { firstSeen: now, read: false, seenIds: baseline, newEpisodes: [], latest: 0, latestIds: [] }
            const cur = ledger[e.slug]
            if (cur.read) { cur.read = false; cur.firstSeen = now }
            cur.newEpisodes = fresh
            cur.latest = chapters.length
            cur.latestIds = latestIds
            dirty = true
            feed.push(rowOf(e, cur))
            continue
        }

        if (e.kind === 'manga') {
            if (!Array.isArray(chapters)) {
                if (led && !led.read && led.newChapters?.length) feed.push(rowOf(e, led))
                continue
            }

            const latestIds = chapters.map(chapter => chapter.id)
            const baseline = led?.seenIds || e.chapterIds
            if (!Array.isArray(baseline)) {
                ledger[e.slug] = { firstSeen: now, read: true, seenIds: latestIds, newChapters: [], latest: chapters.length }
                dirty = true
                continue
            }

            const seen = new Set(baseline)
            const fresh = chapters.filter(chapter => !seen.has(chapter.id)).map(chapter => ({
                id: chapter.id,
                label: chapter.number == null ? (chapter.title || 'Special') : `Ch. ${chapter.number}`,
            }))
            if (!fresh.length) continue

            if (!led) ledger[e.slug] = { firstSeen: now, read: false, seenIds: baseline, newChapters: [], latest: 0, latestIds: [] }
            const cur = ledger[e.slug]
            if (cur.read) { cur.read = false; cur.firstSeen = now }
            cur.newChapters = fresh
            cur.latest = chapters.length
            cur.latestIds = latestIds
            dirty = true
            feed.push(rowOf(e, cur))
            continue
        }

        if (e.kind === 'anime') {
            if (!Array.isArray(chapters)) {
                if (led && !led.read && led.newEpisodes?.length) feed.push(rowOf(e, led))
                continue
            }
            const latestIds = chapters.map(episode => episode.id)
            const baseline = led?.seenIds || e.episodeIds
            if (!Array.isArray(baseline)) {
                ledger[e.slug] = { firstSeen: now, read: true, seenIds: latestIds, newEpisodes: [], latest: chapters.length }
                dirty = true
                continue
            }
            const seen = new Set(baseline)
            const fresh = chapters.filter(episode => !seen.has(episode.id)).map(episode => ({ id: episode.id, label: `EP ${episode.number}` }))
            if (!fresh.length) continue
            if (!led) ledger[e.slug] = { firstSeen: now, read: false, seenIds: baseline, newEpisodes: [], latest: 0, latestIds: [] }
            const cur = ledger[e.slug]
            if (cur.read) { cur.read = false; cur.firstSeen = now }
            cur.newEpisodes = fresh
            cur.latest = chapters.length
            cur.latestIds = latestIds
            dirty = true
            feed.push(rowOf(e, cur))
            continue
        }

        const base = e.total

        // a failed fetch or unknown base tells us nothing, surface the last known alert from storage
        if (!chapters || !Array.isArray(chapters) || base == null) {
            if (led && !led.read && led.newNums?.length) feed.push(rowOf(e, led))
            continue
        }

        const latest = chapters.length
        const upTo = led ? (led.seenUpTo ?? base) : base
        // nothing new since the follow or since the last ack, keep the entry so the watermark survives
        if (latest <= upTo) continue

        if (!led) {
            ledger[e.slug] = { firstSeen: now, read: false, seenUpTo: base, newNums: [], latest: 0 }
            dirty = true
        }
        const cur = ledger[e.slug]
        if (cur.read) {
            cur.read = false
            cur.firstSeen = now
        }
        cur.newNums = chapters.slice(upTo).map(c => c.n)
        cur.latest = latest
        dirty = true
        feed.push(rowOf(e, cur))
    }

    if (dirty) saveUpdLedger(ledger)
    return { feed: feed.sort((a, b) => b.firstSeen - a.firstSeen), failed }
}

export const unreadTotal = feed => feed.reduce((n, u) => n + (u.read ? 0 : u.newCount), 0)

export function setRead(slug, read, upTo, latestIds, update) {
    const ledger = loadUpdLedger()
    const n = upTo == null ? null : Number(upTo)
    if (ledger[slug]) {
        ledger[slug].read = read
        if (read && Array.isArray(latestIds)) {
            ledger[slug].seenIds = latestIds
            ledger[slug].newChapters = []
            ledger[slug].newEpisodes = []
            delete ledger[slug].latestIds
            saveUpdLedger(ledger)
            return
        }
        // Undoing an acknowledgement must also undo its ID watermark. The
        // original alert is still in the visible row, so restore just those
        // IDs and labels instead of keeping every acknowledged alert in storage.
        const reopened = !read && update && (update.kind === 'manga' || isVideo(update))
            ? (update.kind === 'manga' ? update.newChapters : update.newEpisodes) : null
        if (reopened?.length) {
            const ids = new Set(reopened.map(chapter => chapter.id))
            const seen = Array.isArray(ledger[slug].seenIds) ? ledger[slug].seenIds : latestIds || []
            ledger[slug].seenIds = seen.filter(id => !ids.has(id))
            // Reopening a row needs its full snapshot again for an offline acknowledgement.
            if (Array.isArray(latestIds)) ledger[slug].latestIds = latestIds
            if (update.kind === 'manga') ledger[slug].newChapters = reopened
            else ledger[slug].newEpisodes = reopened
        }
        // ack raises the watermark to the acknowledged count, unack resets it to the follow baseline
        ledger[slug].seenUpTo = read ? (n != null ? n : ledger[slug].seenUpTo) : null
        // the snapshot is recomputable from the api, shed it on ack so the ledger stays lean
        if (read) ledger[slug].newNums = []
    } else ledger[slug] = { firstSeen: Date.now(), read, seenUpTo: read ? n : null, newNums: [], latest: n ?? 0 }
    saveUpdLedger(ledger)
}

export function markAll(feed) {
    const ledger = loadUpdLedger()
    for (const u of feed) if (ledger[u.slug]) {
        ledger[u.slug].read = true
        if (u.kind === 'manga' || isVideo(u)) {
            ledger[u.slug].seenIds = u.latestIds
            delete ledger[u.slug].latestIds
            if (u.kind === 'manga') ledger[u.slug].newChapters = []
            else ledger[u.slug].newEpisodes = []
        } else {
            ledger[u.slug].seenUpTo = u.latest
            ledger[u.slug].newNums = []
        }
    }
    saveUpdLedger(ledger)
}
