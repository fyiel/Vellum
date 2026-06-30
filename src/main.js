import { isNative } from './lib/http.js'
import { startRouter } from './lib/router.js'

// boot. the router is live from the first frame. screen rendering hangs off these routes once the
// design html is wired in, so for now a route change just resolves to its parsed shape
startRouter(route => {
    console.log('[vellum] route', route, 'native', isNative)
})
