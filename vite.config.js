import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const API_TARGET = process.env.VITE_API_HOST ?? 'https://pumg.fyi'
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version

// precaches the whole build output so the web app boots offline. the cache name is
// stamped from file names + contents, so a new deploy rotates the cache and the old
// one is dropped on activate. navigations are network-first (fresh deploys win) with
// the cached index.html as the offline fallback; hashed assets are cache-first.
const SW_SOURCE = readFileSync(new URL('./src/service-worker.js', import.meta.url), 'utf8')
const PUBLIC_SHELL = ['manifest.webmanifest', 'icon-256.png', 'icon-512.png']

const offlineShell = () => ({
  name: 'vellum-offline-shell',
  apply: 'build',
  generateBundle(_, bundle) {
    const hash = createHash('sha256').update(VERSION).update(SW_SOURCE)
    const files = [...Object.keys(bundle).filter(name => name !== 'sw.js'), ...PUBLIC_SHELL].sort()
    for (const name of files) {
      const item = bundle[name]
      hash.update(name).update(item ? (item.type === 'asset' ? item.source : item.code) : readFileSync(new URL('./public/' + name, import.meta.url)))
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
