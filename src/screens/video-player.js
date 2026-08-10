import { getVideoPlayback, getVideoSeries, videoAssetUrl } from '../lib/video-api.js'
import { go, parseHash } from '../lib/router.js'
import { posGet, posSet, readSet, saveRead, touchLibrary } from '../lib/store.js'
import { $, esc } from '../lib/dom.js'

const player = $('#vplayer')
const stage = $('#vp-stage')

const state = { active: false, key: '', id: '', gen: 0, ctrl: null, series: null, episode: null, episodes: [], video: null, embedTimer: 0, savedAt: 0 }
const seriesRoute = key => `#/watch/series/${encodeURIComponent(key)}`
const playRoute = (key, id) => `#/watch/play/${encodeURIComponent(key)}/${encodeURIComponent(id)}`
const ordered = episodes => [...episodes].sort((a, b) => (a.season || 1) - (b.season || 1)
    || (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER)
    || a.id.localeCompare(b.id))
const episodeLabel = episode => episode.season && episode.number != null ? `S${episode.season} · E${episode.number}`
    : episode.number != null ? `Episode ${episode.number}` : episode.title || 'Special'
const stillHere = (key, id, gen) => {
    const current = parseHash()
    return state.active && state.gen === gen && current.name === 'video-play' && current.key === key && current.id === id
}

function beginMeasure() {
    try {
        performance.clearMarks('vellum:video-player:start')
        performance.clearMeasures('vellum:video-player:contract')
        performance.clearMeasures('vellum:video-player:media-shell')
        performance.mark('vellum:video-player:start')
    } catch {}
}
const measure = name => { try { performance.measure(name, 'vellum:video-player:start') } catch {} }

function currentIndex() {
    return state.episodes.findIndex(episode => episode.id === state.id)
}

function renderSteps() {
    const index = currentIndex()
    const previous = state.episodes[index - 1]
    const next = state.episodes[index + 1]
    $('#vp-step').innerHTML = `${previous ? `<a href="${playRoute(state.key, previous.id)}"><span>Previous</span>${esc(episodeLabel(previous))}</a>` : '<span></span>'}${next ? `<a href="${playRoute(state.key, next.id)}"><span>Next</span>${esc(episodeLabel(next))}</a>` : '<span></span>'}`
}

function libraryEntry(position, duration) {
    const progress = Number.isFinite(position) && Number.isFinite(duration) ? { lastPosition: position, lastDuration: duration } : {}
    return {
        slug: state.key,
        key: state.key,
        kind: state.series.kind,
        title: state.series.title,
        cover: state.series.poster,
        author: state.series.studio || state.series.cast?.[0],
        source: state.series.source,
        format: state.series.kind === 'drama' ? 'K-drama' : 'Anime',
        total: state.episodes.length,
        episodeIds: state.episodes.map(episode => episode.id),
        watchedCount: readSet(state.key).size,
        lastId: state.id,
        lastLabel: episodeLabel(state.episode),
        ...progress,
    }
}

function saveEpisodeIntent() {
    posSet(state.key, { id: state.id, at: Date.now() })
    touchLibrary(libraryEntry(0, 0))
}

function recordSelection() {
    const saved = posGet(state.key)
    if (saved?.id === state.id) touchLibrary(libraryEntry(Number(saved.position) || 0, Number(saved.duration) || 0))
    else saveEpisodeIntent()
}

function saveProgress(force = false) {
    const video = state.video
    if (!state.active || !video || !state.series || !state.episode) return
    const now = Date.now()
    if (!force && now - state.savedAt < 1000) return
    state.savedAt = now
    const position = Number.isFinite(video.currentTime) ? video.currentTime : 0
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    if (duration > 0 && position / duration >= .9) {
        const watched = readSet(state.key)
        if (!watched.has(state.id)) { watched.add(state.id); saveRead(state.key, watched) }
    }
    posSet(state.key, { id: state.id, position, duration, at: now })
    touchLibrary(libraryEntry(position, duration))
}

function showMediaError() {
    const old = stage.querySelector('.video-playback-error')
    if (old) return
    const error = document.createElement('div')
    player.dataset.state = navigator.onLine ? 'playback-error' : 'offline'
    error.className = 'video-playback-error'
    error.setAttribute('role', 'alert')
    error.innerHTML = `${navigator.onLine ? 'This stream couldn’t start.' : 'The stream is unavailable offline.'}<button type="button">Retry stream</button>`
    error.querySelector('button').onclick = () => showVideoPlayer(state.key, state.id)
    stage.append(error)
}

const providerBadge = label => {
    const badge = document.createElement('div')
    badge.className = 'video-provider-label'
    badge.textContent = `Provided by ${label}`
    return badge
}

function renderDirect(playback, source) {
    stage.replaceChildren()
    const video = document.createElement('video')
    video.className = 'video-media'
    video.controls = true
    video.playsInline = true
    // Let the contract and player shell resolve instantly; native controls request media on intent.
    video.preload = 'none'
    video.setAttribute('aria-label', `${state.series.title}, ${episodeLabel(state.episode)}`)
    if (playback.poster || state.series.backdrop || state.series.poster) video.poster = videoAssetUrl(playback.poster || state.series.backdrop || state.series.poster)
    video.src = videoAssetUrl(source.url)
    for (const subtitle of playback.subtitles || []) {
        const track = document.createElement('track')
        track.src = videoAssetUrl(subtitle.url)
        track.srclang = subtitle.lang
        track.label = subtitle.label || subtitle.lang.toUpperCase()
        track.kind = 'subtitles'
        track.default = Boolean(subtitle.default)
        video.append(track)
    }
    const hint = document.createElement('div')
    hint.className = 'video-player-hint'
    hint.textContent = 'Space play/pause · ←/→ seek 10s · F fullscreen'
    stage.append(providerBadge(playback.providerLabel), video, hint)
    state.video = video
    const saved = posGet(state.key)
    video.addEventListener('loadedmetadata', () => {
        if (saved?.id === state.id && Number(saved.position) > 0 && Number(saved.position) < video.duration * .9) video.currentTime = Number(saved.position)
    }, { once: true })
    video.addEventListener('timeupdate', () => saveProgress())
    video.addEventListener('pause', () => saveProgress(true))
    video.addEventListener('ended', () => saveProgress(true))
    video.addEventListener('error', showMediaError)
    measure('vellum:video-player:media-shell')
}

function renderEmbed(playback, source) {
    stage.replaceChildren()
    player.dataset.state = 'ready'
    const shell = document.createElement('div')
    shell.className = 'video-embed-shell'
    shell.innerHTML = `<div class="video-embed-copy"><span class="video-embed-mark" aria-hidden="true">▶</span><h2>Open ${esc(playback.providerLabel)} player</h2><p>This episode uses a sandboxed provider player. It loads only when you choose to continue.</p><button type="button" class="video-embed-load">Load provider player</button></div>`
    const button = shell.querySelector('button')
    button.addEventListener('click', () => {
        if (!navigator.onLine) { showMediaError(); return }
        const gen = state.gen
        const key = state.key
        const id = state.id
        saveEpisodeIntent()
        player.dataset.state = 'embed-loading'
        shell.dataset.state = 'loading'
        shell.setAttribute('aria-busy', 'true')
        shell.innerHTML = '<div class="video-player-state" role="status"><div class="spinner" aria-hidden="true"></div><span>Connecting to provider…</span></div>'
        const frame = document.createElement('iframe')
        frame.className = 'video-embed-frame'
        frame.title = `${playback.providerLabel} player for ${episodeLabel(state.episode)}`
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation')
        frame.referrerPolicy = 'no-referrer'
        frame.allow = 'fullscreen; picture-in-picture; encrypted-media'
        frame.allowFullscreen = true
        const unavailable = () => {
            if (!stillHere(key, id, gen)) return
            clearTimeout(state.embedTimer)
            shell.dataset.state = 'error'
            player.dataset.state = 'blocked'
            shell.setAttribute('aria-busy', 'false')
            shell.innerHTML = `<div class="video-player-state" role="alert">${esc(playback.providerLabel)} couldn’t be opened in Vellum.<button type="button">Try again</button></div>`
            shell.querySelector('button').onclick = () => renderEmbed(playback, source)
        }
        frame.addEventListener('load', () => {
            if (!stillHere(key, id, gen)) { frame.remove(); return }
            clearTimeout(state.embedTimer)
            shell.dataset.state = 'ready'
            player.dataset.state = 'ready'
            shell.setAttribute('aria-busy', 'false')
        }, { once: true })
        frame.addEventListener('error', unavailable, { once: true })
        shell.replaceChildren(frame)
        frame.src = source.url
        state.embedTimer = setTimeout(unavailable, 12000)
    })
    stage.append(providerBadge(playback.providerLabel), shell)
    measure('vellum:video-player:media-shell')
}

function renderUnsupported(playback) {
    stage.replaceChildren()
    player.dataset.state = 'unsupported'
    const notice = document.createElement('div')
    notice.className = 'video-player-state'
    notice.setAttribute('role', 'alert')
    notice.innerHTML = 'This stream format isn’t supported on this device.<button type="button">Try again</button>'
    notice.querySelector('button').onclick = () => showVideoPlayer(state.key, state.id)
    stage.append(providerBadge(playback.providerLabel), notice)
    measure('vellum:video-player:media-shell')
}

function renderMedia(playback) {
    const probe = document.createElement('video')
    const direct = playback.sources.find(item => item.kind === 'direct' && probe.canPlayType(item.type))
    const embed = playback.sources.find(item => item.kind === 'embed')
    if (direct) renderDirect(playback, direct)
    else if (embed) renderEmbed(playback, embed)
    else renderUnsupported(playback)
}

function showError(message) {
    player.dataset.state = navigator.onLine ? 'error' : 'offline'
    player.setAttribute('aria-busy', 'false')
    stage.innerHTML = `<div class="video-player-state" role="alert">${esc(navigator.onLine ? message : 'You’re offline. Reconnect to load this episode.')}<button id="video-player-retry" type="button">Try again</button></div>`
    $('#vp-step').innerHTML = ''
    $('#video-player-retry').onclick = () => showVideoPlayer(state.key, state.id)
}

let wired = false
function wire() {
    if (wired) return
    wired = true
    $('#vp-back').onclick = () => go(seriesRoute(state.key))
    window.addEventListener('keydown', event => {
        if (!state.active || !state.video || event.target.closest('input, textarea, button, a') || event.target === state.video) return
        if (event.key === 'Escape') { event.preventDefault(); go(seriesRoute(state.key)); return }
        if (event.key === ' ') {
            event.preventDefault()
            if (state.video.paused) state.video.play().catch(showMediaError)
            else state.video.pause()
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            const delta = event.key === 'ArrowLeft' ? -10 : 10
            state.video.currentTime = Math.max(0, Math.min(Number.isFinite(state.video.duration) ? state.video.duration : Infinity, state.video.currentTime + delta))
        }
        if (event.key.toLowerCase() === 'f') {
            event.preventDefault()
            if (document.fullscreenElement) document.exitFullscreen?.()
            else state.video.requestFullscreen?.()
        }
    })
    window.addEventListener('pagehide', () => saveProgress(true))
    document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(true) })
}

export async function showVideoPlayer(key, id) {
    wire()
    saveProgress(true)
    state.video?.pause()
    state.ctrl?.abort()
    const ctrl = new AbortController()
    const gen = ++state.gen
    clearTimeout(state.embedTimer)
    Object.assign(state, { active: true, key, id, gen, ctrl, series: null, episode: null, episodes: [], video: null, embedTimer: 0, savedAt: 0 })
    beginMeasure()
    player.classList.add('active')
    player.dataset.state = 'loading'
    player.setAttribute('aria-busy', 'true')
    document.documentElement.classList.add('video-playing')
    document.body.classList.add('video-playing')
    $('#vp-title').textContent = 'Loading episode…'
    $('#vp-episode').textContent = ''
    $('#vp-step').innerHTML = ''
    stage.innerHTML = '<div class="video-player-state" role="status"><div class="spinner" aria-hidden="true"></div><span>Preparing stream…</span></div>'
    try {
        const [series, playback] = await Promise.all([
            getVideoSeries(key, { signal: ctrl.signal }),
            getVideoPlayback(key, id, { signal: ctrl.signal }),
        ])
        if (!stillHere(key, id, gen)) return
        const episodes = ordered(series.episodes)
        const episode = episodes.find(item => item.id === id)
        if (!episode) throw new Error('Episode is no longer available')
        Object.assign(state, { series: { ...series, episodes }, episodes, episode })
        $('#vp-title').textContent = series.title
        $('#vp-episode').textContent = `${episodeLabel(episode)}${episode.title ? ` · ${episode.title}` : ''}`
        measure('vellum:video-player:contract')
        recordSelection()
        player.dataset.state = 'ready'
        renderMedia(playback)
        renderSteps()
        player.setAttribute('aria-busy', 'false')
        player.focus({ preventScroll: true })
    } catch (error) {
        if (stillHere(key, id, gen)) showError(error.name === 'AbortError' ? 'Playback request stopped' : error.message || 'Playback unavailable')
    }
}

export function closeVideoPlayer() {
    if (!state.active) return
    saveProgress(true)
    state.active = false
    state.ctrl?.abort()
    state.ctrl = null
    state.gen++
    clearTimeout(state.embedTimer)
    state.embedTimer = 0
    if (state.video) {
        state.video.pause()
        state.video.removeAttribute('src')
        state.video.load()
    }
    state.video = null
    player.classList.remove('active')
    player.dataset.state = 'idle'
    player.setAttribute('aria-busy', 'false')
    stage.replaceChildren()
    $('#vp-step').replaceChildren()
    document.documentElement.classList.remove('video-playing')
    document.body.classList.remove('video-playing')
}
