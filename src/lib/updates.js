import { library, loadUpdLedger, saveUpdLedger } from './store.js'
import { getChapters } from './api.js'

// the new chapter feed, shared by the updates screen and the library sidebar count so both agree. for
// each followed novel the live chapter count is compared to the user baseline (the total known when last
// read). anything past the baseline is new. the ledger remembers when each update was first seen and
// whether it was marked read, so read items linger in the feed and the unread total stays stable

export async function buildFeed() {
    const lib = library()
    const ledger = loadUpdLedger()
    const now = Date.now()
    const feed = []

    for (const e of lib) {
        let chapters = null
        try { chapters = (await getChapters(e.slug))?.chapters } catch {}
        const latest = chapters ? chapters.length : 0
        const base = e.total || 0

        // nothing new, drop any stale ledger entry so it does not haunt the feed
        if (!chapters || latest <= base) {
            if (ledger[e.slug]) delete ledger[e.slug]
            continue
        }

        const led = ledger[e.slug] || (ledger[e.slug] = { firstSeen: now, read: false })
        const newNums = chapters.slice(base).map(c => c.n)
        feed.push({
            slug: e.slug, title: e.title, cover: e.cover,
            newNums, newCount: newNums.length, firstSeen: led.firstSeen, read: !!led.read,
        })
    }

    saveUpdLedger(ledger)
    return feed.sort((a, b) => b.firstSeen - a.firstSeen)
}

export const unreadTotal = feed => feed.reduce((n, u) => n + (u.read ? 0 : u.newCount), 0)

export function setRead(slug, read) {
    const ledger = loadUpdLedger()
    if (ledger[slug]) ledger[slug].read = read
    else ledger[slug] = { firstSeen: Date.now(), read }
    saveUpdLedger(ledger)
}

export function markAll(feed) {
    const ledger = loadUpdLedger()
    for (const u of feed) if (ledger[u.slug]) ledger[u.slug].read = true
    saveUpdLedger(ledger)
}
