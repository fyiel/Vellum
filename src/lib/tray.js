const KEY = 'vellum:traykeep'

const loadTrayKeep = () => {
    try { return localStorage.getItem(KEY) === 'true' } catch { return false }
}

const saveTrayKeep = v => {
    try { localStorage.setItem(KEY, v ? 'true' : 'false') } catch {}
}

function toast(msg) {
    const t = document.getElementById('toast')
    if (!t) return
    t.textContent = msg
    t.hidden = false
    clearTimeout(toast._t)
    toast._t = setTimeout(() => { t.hidden = true }, 4000)
}

// push the persisted keep in tray flag to rust at boot, mirror the tray menu
// toggles back into local storage, and surface a toast when the tray could not
// start so the user knows the X really quits
export async function syncTray() {
    if (!window.__TAURI_INTERNALS__) return
    try {
        const { invoke } = await import('@tauri-apps/api/core')
        const available = await invoke('tray_keep', { value: loadTrayKeep() })
        if (available === false) toast('tray unavailable')
        try {
            const { listen } = await import('@tauri-apps/api/event')
            await listen('traykeep', e => saveTrayKeep(Boolean(e.payload)))
        } catch {}
    } catch {}
}
