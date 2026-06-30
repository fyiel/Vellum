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
import './styles/reader.css'

import { startRouter } from './lib/router.js'
import { setupNative } from './lib/native.js'
import { mountShell, setCrumb, setActiveNav } from './screens/shell.js'
import { showLibrary } from './screens/library.js'
import { showDiscover } from './screens/discover.js'
import { showUpdates } from './screens/updates.js'
import { showSeries } from './screens/series.js'
import { showReader, closeReader } from './screens/reader.js'

const view = name => document.querySelectorAll('.den .view').forEach(v => { v.hidden = v.id !== `view-${name}` })

await setupNative()

let origin = 'library'

startRouter(route => {
    mountShell()
    if (route.name === 'read') { setActiveNav(origin); showReader(route.slug, route.n); return }

    closeReader()
    if (route.name === 'series') { setActiveNav(origin); view('series'); showSeries(route.key, origin) }
    else if (route.name === 'discover') { origin = 'discover'; setCrumb('Discover'); setActiveNav('discover'); view('discover'); showDiscover() }
    else if (route.name === 'updates') { origin = 'updates'; setCrumb('Updates'); setActiveNav('updates'); view('updates'); showUpdates() }
    else { origin = 'library'; setCrumb('Library'); setActiveNav('library'); view('library'); showLibrary() }
})
