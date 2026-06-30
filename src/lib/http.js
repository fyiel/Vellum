// the reader data comes from the hosted beta backend. it ships no cors headers, so the request path
// differs per platform. browser dev goes through the vite proxy on a relative path. native shells call
// the host directly and dodge cors by making the request off the webview thread

// host
const HOST = import.meta.env.VITE_API_HOST ?? 'https://pumg.fyi'

// platform detect. capacitor and tauri both inject their globals before our module evaluates
const isCapacitor = () => !!window.Capacitor?.isNativePlatform?.()
const isTauri = () => !!window.__TAURI_INTERNALS__
export const isNative = isCapacitor() || isTauri()

// relative paths in the browser hit the vite proxy, absolute paths in native shells hit the host
export const apiUrl = path => (isNative ? HOST : '') + path

// transport: a fetch compatible function. defaults to the global fetch and gets swapped by the native
// bootstraps for a cors free one (tauri http plugin, or capacitor http patching the global)
let transport = (url, init) => fetch(url, init)
export const setTransport = fn => { transport = fn }

export async function apiGet(path) {
    const res = await transport(apiUrl(path), { headers: { accept: 'application/json' } })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `http ${res.status}`)

    return data
}
