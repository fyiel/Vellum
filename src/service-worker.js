const CACHE = 'vellum-' + __STAMP__
const BASE = new URL(self.registration.scope).pathname
const LOCAL = [BASE, ...__SHELL__.map(name => BASE + name)]

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(LOCAL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(key => key.startsWith('vellum-') && key !== CACHE).map(key => caches.delete(key))))
        .then(() => self.clients.claim()))
})

self.addEventListener('fetch', event => {
    const { request } = event
    if (request.method !== 'GET') return
    const url = new URL(request.url)
    if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return
    // API freshness is managed by the data cache. Never freeze a pending search, an expiring
    // playback URL, or a large media stream inside the permanent offline application shell.
    if (url.pathname.startsWith('/read/api/')) return
    if (request.mode === 'navigate') {
        event.respondWith(fetch(request).then(response => {
            if (response.ok) return response
            return caches.match(BASE).then(hit => hit || response)
        }).catch(() => caches.match(BASE)))
        return
    }
    // Only this build's finite set of static assets belongs in the shell cache.
    if (!LOCAL.includes(url.pathname)) return
    // Static same-origin build files are identical across Origin headers. Some hosts emit
    // Vary: Origin, while module requests and the install prefetch send different headers.
    event.respondWith(caches.match(request, { ignoreVary: true }).then(hit => hit || fetch(request)))
})
