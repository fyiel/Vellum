// fonts bundled locally so the desktop build needs no network to render. archivo for ui, plex mono for data
import '@fontsource/archivo/400.css'
import '@fontsource/archivo/500.css'
import '@fontsource/archivo/600.css'
import '@fontsource/archivo/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './styles/library.css'

import { startRouter } from './lib/router.js'
import { setupNative } from './lib/native.js'
import { showLibrary } from './screens/library.js'

// boot. pick the platform transport first, then route. the library is the home screen, the series
// and reader screens hang off the other routes as their designs land
await setupNative()

startRouter(route => {
    if (route.name === 'home') showLibrary()
})
