import { library, loadUpdLedger, saveUpdLedger, patchLibraryEntry } from './store.js'
import { getChapters, getSeries, seriesKey } from './api.js'

const rowOf = (e, led) => ({
    slug: e.slug, title: e.title, cover: e.cover,
    newNums: led.newNums, newCount: led.newNums.length, latest: led.latest,
    firstSeen: led.firstSeen, read: !!led.read,
})

// bounded concurrency so a big library does not serialize dozens of chapter fetches
async function mapPool(list, n, fn) {
    const out = new Array(list.length)
    let i = 0
    const worker = async () => {
        while (i < list.length) {
            const idx = i++
            out[idx] = await fn(list[idx], idx)
        }
    }
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker))
    return out
}

export async function buildFeed() {
    const lib = library()
    const ledger = loadUpdLedger()
    const now = Date.now()
    const feed = []
    let dirty = false

    const entries = await mapPool(lib, 5, async e => {
        try { return { e, chapters: (await getChapters(e.slug))?.chapters } } catch { return { e, chapters: null } }
    })

    for (const { e, chapters } of entries) {
        const led = ledger[e.slug]
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
    return feed.sort((a, b) => b.firstSeen - a.firstSeen)
}

// backfill genres for entries that have none, the 6h series cache keeps warm passes free
export async function enrichGenres() {
    const missing = library().filter(e => e.genres == null)
    if (!missing.length) return

    const entries = await mapPool(missing, 5, async e => {
        try {
            const s = await getSeries(seriesKey(e.slug))
            // a successful fetch is the truth, a genre-less series stores [] so it is never retried
            return { e, genres: Array.isArray(s?.genres) ? s.genres : [] }
        } catch {
            // failed or partial, leave the field unknown and retry the next pass
            return { e, genres: undefined }
        }
    })

    for (const { e, genres } of entries) {
        if (genres === undefined) continue
        patchLibraryEntry(e.slug, { genres })
    }
}

export const unreadTotal = feed => feed.reduce((n, u) => n + (u.read ? 0 : u.newCount), 0)

export function setRead(slug, read, upTo) {
    const ledger = loadUpdLedger()
    const n = upTo == null ? null : Number(upTo)
    if (ledger[slug]) {
        ledger[slug].read = read
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
        ledger[u.slug].seenUpTo = u.latest
        ledger[u.slug].newNums = []
    }
    saveUpdLedger(ledger)
}
