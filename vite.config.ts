import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// the hosted beta backend has no CORS headers, so in browser dev we proxy the api through vite.
// native shells (tauri, capacitor) make requests off the main thread and never hit this proxy
const API_TARGET = process.env.VELLUM_API ?? 'https://pumg.fyi'

export default defineConfig({
  plugins: [react()],
  // tauri and capacitor both serve the bundle from their origin root, so absolute asset paths are fine
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
