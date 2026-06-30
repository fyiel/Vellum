// hash router. three routes, all derived from location.hash so deep links and the back button just work.
// this layer only parses and navigates. what each route shows on screen gets wired once the markup exists

export const hashSlug = s => encodeURIComponent(s)
export const go = hash => { location.hash = hash }
export const back = () => { history.length > 1 ? history.back() : go('#/') }

// home is the default, series carries a key, read carries a slug and a chapter number (which may be decimal)
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

// fire the callback once now and again on every hash change
export function startRouter(onRoute) {
    const fire = () => onRoute(parseHash())
    window.addEventListener('hashchange', fire)
    fire()
}
