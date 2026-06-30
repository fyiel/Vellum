import { isNative } from './lib/http.js'
import { startRouter } from './lib/router.js'
import { setupNative } from './lib/native.js'

// boot. pick the right network transport for the platform first, then start the router. screen
// rendering hangs off these routes once the design html is wired in, so for now a route change
// just resolves to its parsed shape
await setupNative()

startRouter(route => {
    console.log('[vellum] route', route, 'native', isNative)
})
