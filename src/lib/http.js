const HOST = import.meta.env.VITE_API_HOST ?? 'https://pumg.fyi'

// the web build (github pages) has no dev proxy in front of it, so it talks to the host directly
const WEB_ABS = import.meta.env.VITE_WEB_ABS === '1'

const isCapacitor = () => !!window.Capacitor?.isNativePlatform?.()
const isTauri = () => !!window.__TAURI_INTERNALS__
export const isNative = isCapacitor() || isTauri()

export const apiUrl = path => (isNative || WEB_ABS ? HOST : '') + path

let transport = (url, init) => fetch(url, init)
export const setTransport = fn => { transport = fn }

export async function apiGet(path) {
    const res = await transport(apiUrl(path), { headers: { accept: 'application/json' } })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `http ${res.status}`)

    return data
}
