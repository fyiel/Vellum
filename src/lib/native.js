import { setTransport } from './http.js'

export async function setupNative() {
    if (window.__TAURI_INTERNALS__) {
        const { fetch } = await import('@tauri-apps/plugin-http')
        setTransport((url, init) => fetch(url, init))
    }
}
