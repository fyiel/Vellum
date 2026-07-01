// novelupdates covers sit behind cloudflare and only a real browser clearance loads them. on the desktop
// build the app itself is a real browser, so we spin a hidden webview onto novelupdates once. it solves the
// challenge like any browser would, the cf_clearance lands in the shared cookie jar, and then the nu cover
// imgs retry and load directly. mobile and web have no such webview so they stay on the baka/nf resolver

let warmed = false

export async function warmNuClearance() {
    if (warmed || !window.__TAURI_INTERNALS__) return
    warmed = true
    try {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
        const { invoke } = await import('@tauri-apps/api/core')
        const old = await WebviewWindow.getByLabel('nuwarm')
        if (old) await old.close().catch(() => {})

        const w = new WebviewWindow('nuwarm', {
            url: 'https://www.novelupdates.com/',
            visible: false,
            skipTaskbar: true,
            focus: false,
            width: 1200,
            height: 900,
        })

        // give cloudflare time to clear, read the clearance into native state, retire the warm webview and
        // retry any nu covers on screen through the nucover proxy
        setTimeout(async () => {
            try { await invoke('nu_refresh', { ua: navigator.userAgent }) } catch {}
            await w.close().catch(() => {})
            retryNuCovers()
        }, 18000)
    } catch (e) {
        console.warn('nu clearance warm failed', e)
    }
}

// covers that already fell back to the resolver carry the original nu url in data-nu, so once the clearance
// is warm we point them back at novelupdates and let them load
export function retryNuCovers() {
    document.querySelectorAll('img[data-nu]').forEach(img => {
        delete img.dataset.cfDone
        img.style.display = ''
        img.src = img.dataset.nu
    })
}
