import { library, loadUpdLedger, saveUpdLedger } from './store.js'
import { getChapters } from './api.js'

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

        if (!led) ledger[e.slug] = { firstSeen: now, read: false, seenUpTo: base, newNums: [], latest: 0 }
        const cur = ledger[e.slug]
        if (cur.read) {
            cur.read = false
            cur.firstSeen = now
        }
        cur.newNums = chapters.slice(upTo).map(c => c.n)
        cur.latest = latest
        feed.push(rowOf(e, cur))
    }

    saveUpdLedger(ledger)
    return feed.sort((a, b) => b.firstSeen - a.firstSeen)
}

export const unreadTotal = feed => feed.reduce((n, u) => n + (u.read ? 0 : u.newCount), 0)

export function setRead(slug, read, upTo) {
    const ledger = loadUpdLedger()
    const n = upTo == null ? null : Number(upTo)
    if (ledger[slug]) {
        ledger[slug].read = read
        // ack raises the watermark to the acknowledged count, unack resets it to the follow baseline
        ledger[slug].seenUpTo = read ? (n != null ? n : ledger[slug].seenUpTo) : null
    } else ledger[slug] = { firstSeen: Date.now(), read, seenUpTo: read ? n : null, newNums: [], latest: n ?? 0 }
    saveUpdLedger(ledger)
}

export function markAll(feed) {
    const ledger = loadUpdLedger()
    for (const u of feed) if (ledger[u.slug]) {
        ledger[u.slug].read = true
        ledger[u.slug].seenUpTo = u.latest
    }
    saveUpdLedger(ledger)
}
