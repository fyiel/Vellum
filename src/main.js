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
import './styles/manga.css'

import { startRouter, parseHash, back, go } from './lib/router.js'
import { setupNative } from './lib/native.js'
import { warmNuClearance } from './lib/nuwarm.js'
import { mountShell, setCrumb, setActiveNav } from './screens/shell.js'
import { showLibrary } from './screens/library.js'
import { showDiscover } from './screens/discover.js'
import { showUpdates } from './screens/updates.js'
import { showSeries } from './screens/series.js'
import { showManga } from './screens/manga.js'
import { showMangaSeries } from './screens/manga-series.js'
import { installCoverFallback } from './lib/cover.js'

// the reader is the only heavy screen (it drags dompurify along), load it on first read
let readerMod = null
const loadReader = () => readerMod ??= import('./screens/reader.js').catch(error => {
    readerMod = null
    throw error
})
let mangaReaderMod = null
const loadMangaReader = () => mangaReaderMod ??= import('./screens/manga-reader.js').catch(error => {
    mangaReaderMod = null
    throw error
})

const view = name => document.querySelectorAll('.den .view').forEach(v => { v.hidden = v.id !== `view-${name}` })

await setupNative()
installCoverFallback()
warmNuClearance()

let origin = 'library'

const readerRouteIs = route => {
    const cur = parseHash()
    return cur.name === 'read' && cur.slug === route.slug && cur.n === route.n
}

function closeReaderShell() {
    const reader = document.querySelector('#reader')
    reader.classList.remove('active')
    document.documentElement.classList.remove('reading')
    document.body.classList.remove('reading')
    document.body.style.background = ''
    document.querySelector('#r-list').hidden = false
    document.querySelector('#r-settings').hidden = false
}

function closeMangaReaderShell() {
    document.querySelector('#mreader').classList.remove('active', 'hide-chrome')
    document.documentElement.classList.remove('manga-reading')
    document.body.classList.remove('manga-reading')
    document.body.style.background = ''
}

function showReaderLoadError(route) {
    if (!readerRouteIs(route)) return
    const reader = document.querySelector('#reader')
    reader.classList.add('active')
    document.documentElement.classList.add('reading')
    document.body.classList.add('reading')
    document.querySelector('#r-title').textContent = 'Reader unavailable'
    document.querySelector('#reader-foot').innerHTML = ''
    document.querySelector('#reader-prose').innerHTML = '<div class="empty">couldn’t open the reader<button class="btn" id="reader-load-retry">retry</button></div>'
    document.querySelector('#r-list').hidden = true
    document.querySelector('#r-settings').hidden = true
    document.querySelector('#r-back').onclick = () => {
        closeReaderShell()
        back()
    }
    document.querySelector('#reader-load-retry').onclick = () => location.reload()
}

async function openReader(route) {
    try {
        const { showReader } = await loadReader()
        if (!readerRouteIs(route)) return
        document.querySelector('#r-list').hidden = false
        document.querySelector('#r-settings').hidden = false
        await showReader(route.slug, route.n)
    } catch {
        showReaderLoadError(route)
    }
}

async function openMangaReader(route) {
    try {
        const { showMangaReader } = await loadMangaReader()
        if (parseHash().name !== 'manga-read') return
        await showMangaReader(route.key, route.id)
    } catch {
        if (parseHash().name !== 'manga-read') return
        closeMangaReaderShell()
        go('#/manga')
    }
}

startRouter(async route => {
    mountShell()

    if (route.name === 'read') {
        if (mangaReaderMod) (await mangaReaderMod).closeMangaReader()
        setActiveNav(origin)
        await openReader(route)
        return
    }

    if (route.name === 'manga-read') {
        if (readerMod) (await readerMod).closeReader()
        setActiveNav('manga')
        await openMangaReader(route)
        return
    }

    if (readerMod) {
        try {
            const { closeReader } = await readerMod
            if (parseHash().name !== 'read') closeReader()
        } catch {
            readerMod = null
            closeReaderShell()
        }
    } else {
        closeReaderShell()
    }
    if (mangaReaderMod) {
        try { (await mangaReaderMod).closeMangaReader() }
        catch { mangaReaderMod = null; closeMangaReaderShell() }
    } else closeMangaReaderShell()
    if (parseHash().name !== route.name) return

    if (route.name === 'series') { setActiveNav(origin); view('series'); showSeries(route.key, origin) }
    else if (route.name === 'manga-series') { origin = 'manga'; setActiveNav('manga'); view('series'); showMangaSeries(route.key) }
    else if (route.name === 'manga') { origin = 'manga'; setCrumb('Manga'); setActiveNav('manga'); view('manga'); showManga() }
    else if (route.name === 'discover') { origin = 'discover'; setCrumb('Discover'); setActiveNav('discover'); view('discover'); showDiscover() }
    else if (route.name === 'updates') { origin = 'updates'; setCrumb('Updates'); setActiveNav('updates'); view('updates'); showUpdates() }
    else { origin = 'library'; setCrumb('Library'); setActiveNav('library'); view('library'); showLibrary() }
})
