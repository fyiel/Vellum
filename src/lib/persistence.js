let request

// The browser makes the decision. A grant protects origin storage from ordinary eviction,
// but cannot protect it from the user clearing site data or removing the app.
export function preserveOfflineStorage() {
    if (globalThis.window?.__TAURI_INTERNALS__) return Promise.resolve(true)
    if (request) return request
    request = (async () => {
        try {
            const storage = globalThis.navigator?.storage
            if (await storage?.persisted?.()) return true
            return !!await storage?.persist?.()
        } catch { return false }
    })()
    return request
}

export const isStandalone = () => !!globalThis.navigator?.standalone
    || !!globalThis.matchMedia?.('(display-mode: standalone)').matches
