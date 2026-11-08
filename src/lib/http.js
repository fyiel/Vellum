const HOST = import.meta.env.VITE_API_HOST ?? 'https://pumg.fyi'

const WEB_ABS = import.meta.env.VITE_WEB_ABS === '1'

const isCapacitor = () => !!window.Capacitor?.isNativePlatform?.()
const isTauri = () => !!window.__TAURI_INTERNALS__
export const isNative = isCapacitor() || isTauri()

export const apiUrl = path => (isNative || WEB_ABS ? HOST : '') + path

let transport = (url, init) => fetch(url, init)
export const setTransport = fn => { transport = fn }
// binary fetches (downloads) go through the same transport so Tauri stays CORS-free
export const rawFetch = (url, init) => transport(url, init)

// Some native transports and response bodies never reject when their signal is
// aborted. Let callers stop waiting even when the underlying operation ignores it.
export const raceAbort = (pending, signal) => {
    if (!signal) return pending
    let onAbort
    const interrupted = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason?.name === 'TimeoutError' ? new Error('download timed out')
            : signal.reason?.name === 'AbortError' ? new Error('download cancelled')
                : signal.reason || new Error('download cancelled'))
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
    })
    return Promise.race([pending, interrupted]).finally(() => signal.removeEventListener('abort', onAbort))
}

const TIMEOUT_MS = 15_000
const aborted = () => Object.assign(new Error('request aborted'), { name: 'AbortError' })
const wait = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted()); return }
    const timer = setTimeout(done, ms)
    const onAbort = () => { clearTimeout(timer); reject(aborted()) }
    function done() { signal?.removeEventListener('abort', onAbort); resolve() }
    signal?.addEventListener('abort', onAbort, { once: true })
})

async function request(path, signal, timeoutMs) {
    if (signal?.aborted) throw aborted()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const onAbort = () => ctrl.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    let rejectOnAbort
    const cancelled = new Promise((_, reject) => {
        rejectOnAbort = () => reject(aborted())
        ctrl.signal.addEventListener('abort', rejectOnAbort, { once: true })
    })
    try {
        // A transport or response body that ignores AbortSignal must not hold callers forever.
        const res = await Promise.race([transport(apiUrl(path), { headers: { accept: 'application/json' }, signal: ctrl.signal }), cancelled])
        if (signal?.aborted) throw aborted()
        const data = await Promise.race([res.json().catch(() => null), cancelled])
        if (signal?.aborted) throw aborted()
        if (ctrl.signal.aborted) throw new Error('request timed out')
        if (!res.ok) {
            const details = data?.error
            const error = new Error(typeof details === 'string' ? details : details?.message || `http ${res.status}`)
            error.status = res.status
            if (details && typeof details === 'object') {
                error.code = details.code
                error.provider = details.provider
                error.retryable = details.retryable
                error.retryAfterMs = details.retryAfterMs
            }
            throw error
        }
        if (data == null) throw new Error(`http ${res.status}`)
        return data
    } catch (error) {
        if (signal?.aborted) throw aborted()
        if (ctrl.signal.aborted) throw new Error('request timed out')
        throw error
    } finally {
        clearTimeout(timer)
        ctrl.signal.removeEventListener('abort', rejectOnAbort)
        signal?.removeEventListener('abort', onAbort)
    }
}

export async function apiGet(path, { signal, timeoutMs = TIMEOUT_MS } = {}) {
    try {
        return await request(path, signal, timeoutMs)
    } catch (error) {
        if (signal?.aborted || error.name === 'AbortError') throw error
        const transient = error.code !== 'provider_blocked' && (typeof error.retryable === 'boolean'
            ? error.retryable
            : !error.status || error.status === 408 || error.status === 429 || error.status >= 500)
        if (!transient) throw error
        const retryAfter = Number(error.retryAfterMs)
        await wait(Number.isFinite(retryAfter) ? Math.min(5_000, Math.max(0, retryAfter)) : 250, signal)
        return request(path, signal, timeoutMs)
    }
}
