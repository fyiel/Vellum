export const hashSlug = s => encodeURIComponent(s)
export const go = hash => { location.hash = hash }
export const back = () => { history.length > 1 ? history.back() : go('#/') }

export function parseHash() {
    const h = decodeURIComponent(location.hash || '#/')

    const read = h.match(/^#\/read\/([^/]+)\/(\d+(?:\.\d+)?)/)
    if (read) return { name: 'read', slug: read[1], n: Number(read[2]) }

    const series = h.match(/^#\/series\/(.+)$/)
    if (series) return { name: 'series', key: series[1] }

    if (h.startsWith('#/discover')) return { name: 'discover' }
    if (h.startsWith('#/updates')) return { name: 'updates' }

    return { name: 'home' }
}

export function startRouter(onRoute) {
    const fire = () => onRoute(parseHash())
    window.addEventListener('hashchange', fire)
    fire()
}
