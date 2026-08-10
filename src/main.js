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
import './styles/kdrama.css'
import './styles/video.css'

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
import { showKDrama } from './screens/kdrama.js'
import { closeKDramaSeries, showKDramaSeries } from './screens/kdrama-series.js'
import { showVideo } from './screens/video.js'
import { showVideoSeries } from './screens/video-series.js'
import { installCoverFallback } from './lib/cover.js'

// Immersive reading and playback code stays out of the browsing shell until first use.
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
let videoPlayerMod = null
const loadVideoPlayer = () => videoPlayerMod ??= import('./screens/video-player.js').catch(error => {
    videoPlayerMod = null
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

const mangaReaderRouteIs = route => {
    const cur = parseHash()
    return cur.name === 'manga-read' && cur.key === route.key && cur.id === route.id
}
const videoPlayerRouteIs = route => {
    const cur = parseHash()
    return cur.name === 'video-play' && cur.key === route.key && cur.id === route.id
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
    const reader = document.querySelector('#mreader')
    reader.classList.remove('active', 'hide-chrome')
    reader.dataset.state = 'idle'
    reader.setAttribute('aria-busy', 'false')
    document.querySelector('#mr-list').hidden = false
    document.documentElement.classList.remove('manga-reading')
    document.body.classList.remove('manga-reading')
    document.body.style.background = ''
}

function closeVideoPlayerShell() {
    const player = document.querySelector('#vplayer')
    player.classList.remove('active')
    player.dataset.state = 'idle'
    player.setAttribute('aria-busy', 'false')
    document.documentElement.classList.remove('video-playing')
    document.body.classList.remove('video-playing')
    document.querySelector('#vp-stage').replaceChildren()
    document.querySelector('#vp-step').replaceChildren()
}

function showVideoPlayerLoadError(route) {
    if (!videoPlayerRouteIs(route)) return
    const player = document.querySelector('#vplayer')
    player.classList.add('active')
    player.dataset.state = 'error'
    player.setAttribute('aria-busy', 'false')
    document.documentElement.classList.add('video-playing')
    document.body.classList.add('video-playing')
    document.querySelector('#vp-title').textContent = 'Player unavailable'
    document.querySelector('#vp-episode').textContent = ''
    document.querySelector('#vp-step').replaceChildren()
    document.querySelector('#vp-stage').innerHTML = '<div class="video-player-state" role="alert">Couldn’t open the video player.<button id="video-player-load-retry" type="button">Try again</button></div>'
    document.querySelector('#vp-back').onclick = () => go(`#/watch/series/${encodeURIComponent(route.key)}`)
    document.querySelector('#video-player-load-retry').onclick = () => location.reload()
}

function showMangaReaderLoadError(route) {
    if (!mangaReaderRouteIs(route)) return
    const reader = document.querySelector('#mreader')
    reader.classList.add('active')
    reader.dataset.state = 'error'
    reader.setAttribute('aria-busy', 'false')
    document.documentElement.classList.add('manga-reading')
    document.body.classList.add('manga-reading')
    document.body.style.background = '#070707'
    document.querySelector('#mr-title').textContent = 'Reader unavailable'
    document.querySelector('#mr-list').hidden = true
    document.querySelector('#mr-pos').textContent = ''
    document.querySelector('#mr-progress').style.width = '0'
    document.querySelector('#mr-step').innerHTML = ''
    document.querySelector('#mr-pages').innerHTML = '<div class="mreader-empty" role="alert">Couldn’t open the manga reader.<button id="manga-reader-load-retry" type="button">Try again</button></div>'
    document.querySelector('#mr-back').onclick = () => go(`#/manga/series/${encodeURIComponent(route.key)}`)
    document.querySelector('#manga-reader-load-retry').onclick = () => location.reload()
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
        if (!mangaReaderRouteIs(route)) return
        document.querySelector('#mr-list').hidden = false
        await showMangaReader(route.key, route.id)
    } catch { showMangaReaderLoadError(route) }
}

async function openVideoPlayer(route) {
    try {
        const { showVideoPlayer } = await loadVideoPlayer()
        if (!videoPlayerRouteIs(route)) return
        await showVideoPlayer(route.key, route.id)
    } catch { showVideoPlayerLoadError(route) }
}

startRouter(async route => {
    mountShell()
    if (route.name !== 'kdrama-series') closeKDramaSeries()

    if (route.name === 'read') {
        if (mangaReaderMod) (await mangaReaderMod).closeMangaReader()
        if (videoPlayerMod) (await videoPlayerMod).closeVideoPlayer()
        setActiveNav(origin)
        await openReader(route)
        return
    }

    if (route.name === 'manga-read') {
        if (readerMod) (await readerMod).closeReader()
        if (videoPlayerMod) (await videoPlayerMod).closeVideoPlayer()
        setActiveNav('manga')
        await openMangaReader(route)
        return
    }
    if (route.name === 'video-play') {
        if (readerMod) (await readerMod).closeReader()
        if (mangaReaderMod) (await mangaReaderMod).closeMangaReader()
        setActiveNav('watch')
        await openVideoPlayer(route)
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
    if (videoPlayerMod) {
        try { (await videoPlayerMod).closeVideoPlayer() }
        catch { videoPlayerMod = null; closeVideoPlayerShell() }
    } else closeVideoPlayerShell()
    if (parseHash().name !== route.name) return

    if (route.name === 'series') { setActiveNav(origin); view('series'); showSeries(route.key, origin) }
    else if (route.name === 'manga-series') {
        origin = ['library', 'updates'].includes(origin) ? origin : 'manga'
        setActiveNav(origin)
        view('series')
        showMangaSeries(route.key, origin)
    }
    else if (route.name === 'video-series') {
        origin = ['library', 'updates'].includes(origin) ? origin : 'watch'
        setActiveNav(origin)
        view('video-series')
        showVideoSeries(route.key, origin)
    }
    else if (route.name === 'manga') { origin = 'manga'; setCrumb('Manga'); setActiveNav('manga'); view('manga'); showManga() }
    else if (route.name === 'kdrama-series') { origin = 'kdrama'; setActiveNav('kdrama'); view('kdrama-series'); showKDramaSeries(route.key) }
    else if (route.name === 'kdrama') { origin = 'kdrama'; setCrumb('K-Drama'); setActiveNav('kdrama'); view('kdrama'); showKDrama() }
    else if (route.name === 'video') { origin = 'watch'; setCrumb('Watch'); setActiveNav('watch'); view('watch'); showVideo() }
    else if (route.name === 'discover') { origin = 'discover'; setCrumb('Discover'); setActiveNav('discover'); view('discover'); showDiscover() }
    else if (route.name === 'updates') { origin = 'updates'; setCrumb('Updates'); setActiveNav('updates'); view('updates'); showUpdates() }
    else { origin = 'library'; setCrumb('Library'); setActiveNav('library'); view('library'); showLibrary() }
})
