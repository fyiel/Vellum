import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const API_TARGET = process.env.VITE_API_HOST ?? 'https://pumg.fyi'
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version

// precaches the whole build output so the web app boots offline. the cache name is
// stamped from file names + contents, so a new deploy rotates the cache and the old
// one is dropped on activate. navigations are network-first (fresh deploys win) with
// the cached index.html as the offline fallback; hashed assets are cache-first.
const SW_SOURCE = `
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
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone()
        caches.open(CACHE).then(cache => cache.put(request, copy))
      }
      return response
    }).catch(() => caches.match(BASE)))
    return
  }
  event.respondWith(caches.match(request).then(hit => hit || fetch(request).then(response => {
    if (response.ok) {
      const copy = response.clone()
      caches.open(CACHE).then(cache => cache.put(request, copy))
    }
    return response
  })))
})
`

const offlineShell = () => ({
  name: 'vellum-offline-shell',
  apply: 'build',
  generateBundle(_, bundle) {
    const hash = createHash('sha256').update(VERSION)
    const files = Object.keys(bundle).filter(name => name !== 'sw.js').sort()
    for (const name of files) {
      const item = bundle[name]
      hash.update(name).update(item.type === 'asset' ? item.source : item.code)
    }
    this.emitFile({
      type: 'asset',
      fileName: 'sw.js',
      source: SW_SOURCE
        .replace('__STAMP__', JSON.stringify(hash.digest('hex').slice(0, 12)))
        .replace('__SHELL__', JSON.stringify(files)),
    })
  },
})

export default defineConfig({

  base: process.env.VITE_BASE || '/',
  plugins: [offlineShell()],
  define: { __APP_VERSION__: JSON.stringify(VERSION) },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/read/api': { target: API_TARGET, changeOrigin: true, secure: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
})
