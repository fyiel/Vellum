// fonts bundled locally so the desktop build needs no network to render. archivo for ui, plex mono for data
import '@fontsource/archivo/400.css'
import '@fontsource/archivo/500.css'
import '@fontsource/archivo/600.css'
import '@fontsource/archivo/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './styles/library.css'
import './styles/discover.css'
import './styles/updates.css'
import './styles/series.css'

import { startRouter } from './lib/router.js'
import { setupNative } from './lib/native.js'
import { mountShell, setCrumb, setActiveNav } from './screens/shell.js'
import { showLibrary } from './screens/library.js'
import { showDiscover } from './screens/discover.js'
import { showUpdates } from './screens/updates.js'
import { showSeries } from './screens/series.js'

// swap which view fills the main column
const view = name => document.querySelectorAll('.den .view').forEach(v => { v.hidden = v.id !== `view-${name}` })

// boot. pick the platform transport, then route. every browse screen sits in the shared shell, the
// reader and series screens get their own shells as their designs land
await setupNative()

// remembers which browse screen launched a series so its crumb and active nav point back to the origin
let origin = 'library'

startRouter(route => {
    mountShell()
    if (route.name === 'series') { setActiveNav(origin); view('series'); showSeries(route.key, origin) }
    else if (route.name === 'discover') { origin = 'discover'; setCrumb('Discover'); setActiveNav('discover'); view('discover'); showDiscover() }
    else if (route.name === 'updates') { origin = 'updates'; setCrumb('Updates'); setActiveNav('updates'); view('updates'); showUpdates() }
    else { origin = 'library'; setCrumb('Library'); setActiveNav('library'); view('library'); showLibrary() }
})
