import { defineConfig } from 'vite'

const API_TARGET = process.env.VITE_API_HOST ?? 'https://pumg.fyi'

export default defineConfig({

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
