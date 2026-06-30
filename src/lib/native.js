import { setTransport } from './http.js'

// in a native shell the default browser fetch would be blocked by cors, so swap in a transport that
// is not. tauri proxies the request through rust via its http plugin. capacitor patches the global
// fetch in its own bootstrap, so there is nothing to do for it here
export async function setupNative() {
    if (window.__TAURI_INTERNALS__) {
        const { fetch } = await import('@tauri-apps/plugin-http')
        setTransport((url, init) => fetch(url, init))
    }
}
