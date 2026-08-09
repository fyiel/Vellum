import { setTransport } from './http.js'
import { receiveLink } from './linkin.js'

export async function setupNative() {
    if (window.__TAURI_INTERNALS__) {
        const { fetch } = await import('@tauri-apps/plugin-http')
        setTransport((url, init) => fetch(url, init))
        // a vellum:// launch url arrives as a process argument on desktop (see deep_link_url in
        // src-tauri). macOS delivers open-url as an apple event instead, which needs a native
        // listener, so mac deep links are a documented limitation for now.
        try {
            const { invoke } = await import('@tauri-apps/api/core')
            const url = await invoke('deep_link_url')
            if (url) receiveLink(url)
        } catch {}
        return
    }
    if (window.Capacitor?.isNativePlatform?.()) {
        try {
            const { App } = await import('@capacitor/app')
            // cold start: the launch url is only available through getLaunchUrl, the listener
            // only fires for links delivered while the app is alive
            const launch = await App.getLaunchUrl()
            if (launch?.url) receiveLink(launch.url)
            await App.addListener('appUrlOpen', ({ url }) => { if (url) receiveLink(url) })
        } catch {}
    }
}
