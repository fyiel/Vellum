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
import './styles/linkin.css'

import { startRouter, parseHash } from './lib/router.js'
import { setupNative } from './lib/native.js'
import { warmNuClearance } from './lib/nuwarm.js'
import { mountShell, setCrumb, setActiveNav } from './screens/shell.js'
import { initLinkIn, drainLink, openLinkIn } from './lib/linkin.js'
import { showLibrary } from './screens/library.js'
import { showDiscover } from './screens/discover.js'
import { showUpdates } from './screens/updates.js'
import { showSeries } from './screens/series.js'
import { installCoverFallback } from './lib/cover.js'

// the reader is the only heavy screen (it drags dompurify along), load it on first read
let readerMod = null
const loadReader = () => readerMod ??= import('./screens/reader.js')

const view = name => document.querySelectorAll('.den .view').forEach(v => { v.hidden = v.id !== `view-${name}` })

await setupNative()
installCoverFallback()
warmNuClearance()
initLinkIn()
// a link that arrived with the app (native launch) is consumed here, never auto-navigated:
// the sheet overlays whatever first renders
const coldLink = drainLink()
if (coldLink) openLinkIn(coldLink)

let origin = 'library'

startRouter(async route => {
    mountShell()

    if (route.name === 'read') {
        setActiveNav(origin)
        const { showReader } = await loadReader()
        // the route may have moved on while the chunk was loading, only act if still current
        const cur = parseHash()
        if (cur.name === 'read' && cur.slug === route.slug && cur.n === route.n) showReader(route.slug, route.n)
        return
    }

    if (readerMod) {
        const { closeReader } = await readerMod
        if (parseHash().name !== 'read') closeReader()
        // a link that arrived mid-read waits for the shell to come back
        const deferred = drainLink()
        if (deferred) openLinkIn(deferred)
    }
    if (parseHash().name !== route.name) return

    if (route.name === 'series') {
        // a series opened from Link In shows the 'Link' crumb origin
        if (sessionStorage.getItem('vellum:linkOrigin')) { sessionStorage.removeItem('vellum:linkOrigin'); origin = 'link' }
        setActiveNav(origin); view('series'); showSeries(route.key, origin)
    }
    else if (route.name === 'discover') { origin = 'discover'; setCrumb('Discover'); setActiveNav('discover'); view('discover'); showDiscover() }
    else if (route.name === 'updates') { origin = 'updates'; setCrumb('Updates'); setActiveNav('updates'); view('updates'); showUpdates() }
    else { origin = 'library'; setCrumb('Library'); setActiveNav('library'); view('library'); showLibrary() }
})
