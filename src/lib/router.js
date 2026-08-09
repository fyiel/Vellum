export const hashSlug = s => encodeURIComponent(s)
export const go = hash => { location.hash = hash }
export const back = () => { history.length > 1 ? history.back() : go('#/') }

export function parseHash() {
    const h = location.hash || '#/'
    const decode = value => {
        try { return decodeURIComponent(value) } catch { return null }
    }

    const read = h.match(/^#\/read\/([^/]+)\/(\d+)$/)
    if (read) {
        const slug = decode(read[1])
        if (slug != null) return { name: 'read', slug, n: Number(read[2]) }
    }

    const mangaRead = h.match(/^#\/manga\/read\/([^/]+)\/([^/]+)$/)
    if (mangaRead) {
        const key = decode(mangaRead[1])
        const id = decode(mangaRead[2])
        if (key != null && id != null) return { name: 'manga-read', key, id }
    }

    const mangaSeries = h.match(/^#\/manga\/series\/(.+)$/)
    if (mangaSeries) {
        const key = decode(mangaSeries[1])
        if (key != null) return { name: 'manga-series', key }
    }

    const series = h.match(/^#\/series\/(.+)$/)
    if (series) {
        const key = decode(series[1])
        if (key != null) return { name: 'series', key }
    }

    if (h.startsWith('#/discover')) return { name: 'discover' }
    if (h === '#/manga' || h.startsWith('#/manga?')) return { name: 'manga' }
    if (h.startsWith('#/updates')) return { name: 'updates' }

    return { name: 'home' }
}

export function startRouter(onRoute) {
    const fire = () => onRoute(parseHash())
    window.addEventListener('hashchange', fire)
    fire()
}
