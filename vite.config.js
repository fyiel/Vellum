import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

const API_TARGET = process.env.VITE_API_HOST ?? 'https://pumg.fyi'
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version

export default defineConfig({

  base: process.env.VITE_BASE || '/',
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
    sourcemap: true,
  },
})
