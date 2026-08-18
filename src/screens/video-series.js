import { getVideoSeries, parseVideoKey } from '../lib/video-api.js'
import { anilistSeries } from '../lib/anilist.js'
import { go, parseHash } from '../lib/router.js'
import { dropLibrary, library, posGet, readSet, resetProgress, touchLibrary } from '../lib/store.js'
import { cancelVideoDownload, deleteVideoDownload, downloadVideoEpisode, onVideoDl, videoDlActive, videoDlEntry } from '../lib/dl-video.js'
import { coverImg } from '../lib/cover.js'
import { setSeriesCrumb } from './shell.js'
import { $, esc } from '../lib/dom.js'

const BATCH = 200
const ORIGIN_LABEL = { library: 'Library', updates: 'Updates', watch: 'Watch' }
const ORIGIN_ROUTE = { library: '#/', updates: '#/updates', watch: '#/watch' }
const PROVIDER_LABEL = { miruro: 'Miruro', dc: 'DramaCooli', gp: 'GoPlay', goplay: 'GoPlay', cineby: 'Cineby', kiss: 'KissKH' }
export const videoProviderLabel = key => PROVIDER_LABEL[String(key || '').toLowerCase()] || null
const kindName = kind => kind === 'drama' ? 'Drama' : 'Anime'
// the drama origin comes from the catalogue's country (series pages carry it as "Country")
export const dramaLabel = country => {
    const c = String(country || '').toLowerCase().replace(/[^a-z]/g, '')
    if (c.includes('korea')) return 'K-Drama'
    if (c.includes('chinese') || c.includes('china')) return 'C-Drama'
    if (c.includes('taiwan')) return 'T-Drama'
    if (c.includes('hong')) return 'HK-Drama'
    if (c.includes('thailand') || c === 'thai') return 'Thai-Drama'
    if (c.includes('japan') || c === 'japanese') return 'J-Drama'
    return 'Drama'
}
const kindLabel = item => item.kind === 'drama' ? dramaLabel(item.country) : 'Anime'
const route = (key, id) => `#/watch/play/${encodeURIComponent(key)}/${encodeURIComponent(id)}`
const followed = key => library().some(entry => entry.slug === key)
const currentRouteIs = key => {
    const current = parseHash()
    return current.name === 'video-series' && current.key === key
}
const ordered = episodes => [...episodes].sort((a, b) => (a.season || 1) - (b.season || 1)
    || (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER)
    || a.id.localeCompare(b.id))
const episodeLabel = episode => {
    if (episode.season && episode.number != null) return `S${episode.season} · E${episode.number}`
    if (episode.number != null) return `Episode ${episode.number}`
    return episode.title || 'Special'
}
const episodeName = episode => episode.title && episode.title !== episodeLabel(episode) ? episode.title : ''

let request = 0
let current = null
let wired = false
let query = ''
let limit = BATCH

function entryFor(series) {
    const saved = posGet(series.key)
    const episodes = series.episodes || []
    const savedEpisode = saved?.id ? episodes.find(episode => episode.id === saved.id) : undefined
    return {
        slug: series.key,
        key: series.key,
        kind: series.kind,
        title: series.title,
        cover: series.poster || series.cover,
        author: series.studio || series.cast?.[0],
        source: series.source || parseVideoKey(series.key)?.provider,
        format: kindLabel(series),
        total: episodes.length || series.totalEpisodes || undefined,
        episodeIds: episodes.length ? episodes.map(episode => episode.id) : undefined,
        watchedCount: readSet(series.key).size,
        lastId: saved?.id,
        lastLabel: savedEpisode ? episodeLabel(savedEpisode) : undefined,
        lastPosition: saved?.id ? (saved.position || 0) : undefined,
        lastDuration: saved?.id ? (saved.duration || 0) : undefined,
    }
}

function info(series) {
    const saved = posGet(series.key)
    // episodes may be absent while the interim AniList row renders before the proxy episodes arrive
    const episodes = series.episodes || []
    const cont = episodes.find(episode => episode.id === saved?.id) || episodes[0]
    const meta = [kindLabel(series), series.year, series.status].filter(Boolean).join(' · ')
    const tags = (series.genres || []).map(genre => `<span class="video-tag">${esc(genre)}</span>`).join('')
    const start = episodes.length
        ? saved ? `Continue · ${esc(episodeLabel(cont))}` : 'Watch episode 1'
        : 'Loading episodes…'
    return `<div class="video-poster-lg">${coverImg(series.poster, series.title, { useResolver: false, eager: true }) || '<span>No poster</span>'}</div>
      <div class="video-title">${esc(series.title)}</div>${meta ? `<div class="video-meta">${esc(meta)}</div>` : ''}${tags ? `<div class="video-tags">${tags}</div>` : ''}
      <div class="video-actions"><button class="btn primary" id="video-start" type="button"${episodes.length ? '' : ' disabled'}>${start}</button><button class="btn${followed(series.key) ? ' on' : ''}" id="video-follow" type="button">${followed(series.key) ? 'Following' : 'Follow'}</button><button class="btn video-reset" id="video-reset" type="button" ${saved || readSet(series.key).size ? '' : 'hidden'}>Reset progress</button></div>
      ${series.synopsis ? `<div class="video-synopsis"><div class="seclab">Synopsis</div><div class="dsyn">${esc(series.synopsis)}</div></div>` : ''}
      <div class="video-stats"><div class="drow"><span class="k">Episodes</span><span class="v">${episodes.length ? episodes.length : (series.totalEpisodes ?? '…')}</span></div>${series.source ? `<div class="drow"><span class="k">Source</span><span class="v">${esc(series.source)}</span></div>` : ''}</div>`
}

const dlFailed = new Map()
const dlButton = (key, id) => {
    const active = videoDlActive(key, id)
    const label = active ? (active.total ? `${Math.min(99, Math.round(active.done / active.total * 100))}%` : '…')
        : videoDlEntry(key, id) ? '✓'
            : dlFailed.has(id) ? '!' : '↓'
    const state = active ? 'active' : videoDlEntry(key, id) ? 'done' : dlFailed.has(id) ? 'failed' : ''
    const hint = active ? 'Cancel download' : state === 'done' ? 'Delete downloaded episode' : state === 'failed' ? dlFailed.get(id) : 'Download for offline watching'
    return `<button type="button" class="chdl${state ? ` ${state}` : ''}" data-dl="${esc(id)}" title="${esc(hint)}" aria-label="${esc(hint)}">${label}</button>`
}

function episodeRows(episodes) {
    const watched = readSet(current.series.key)
    const saved = posGet(current.series.key)?.id
    return episodes.map(episode => `<div class="chline"><button type="button" class="video-episode-row${watched.has(episode.id) ? ' watched' : ''}${saved === episode.id ? ' current' : ''}" data-id="${esc(episode.id)}"${saved === episode.id ? ' aria-current="page"' : ''}>
      <span class="video-episode-number">${esc(episodeLabel(episode))}</span><span class="video-episode-name">${esc(episodeName(episode))}</span>${episode.runtime ? `<span class="video-runtime">${esc(episode.runtime)}m</span>` : '<span></span>'}<span class="video-episode-dot"></span>
    </button>${dlButton(current.series.key, episode.id)}</div>`).join('')
}

function renderEpisodes() {
    if (!current) return
    const q = query.toLowerCase()
    const filtered = current.episodes.filter(episode => !q || `${episodeLabel(episode)} ${episode.title || ''}`.toLowerCase().includes(q))
    const shown = filtered.slice(0, limit)
    $('#video-episode-list').innerHTML = shown.length
        ? `${episodeRows(shown)}${shown.length < filtered.length ? `<button class="video-episode-more" id="video-episode-more" type="button">Show ${Math.min(BATCH, filtered.length - shown.length)} more <span>${shown.length} of ${filtered.length}</span></button>` : ''}`
        : '<div class="video-episode-empty" role="status">No matching episodes</div>'
}

function startEpisode() {
    if (!current.episodes.length) return // interim AniList row — episodes not loaded yet
    const saved = posGet(current.series.key)?.id
    return current.episodes.find(episode => episode.id === saved) || current.episodes[0]
}

function wire() {
    if (wired) return
    wired = true
    $('#vinfo').addEventListener('click', event => {
        if (event.target.closest('#video-start') && current) go(route(current.series.key, startEpisode().id))
        if (event.target.closest('#video-follow') && current) {
            const button = $('#video-follow')
            if (followed(current.series.key)) {
                dropLibrary(current.series.key)
                button.classList.remove('on')
                button.textContent = 'Follow'
            } else {
                touchLibrary(entryFor(current.series))
                button.classList.add('on')
                button.textContent = 'Following'
            }
        }
        if (event.target.closest('#video-reset') && current && confirm(`Reset watch progress for ${current.series.title}?`)) {
            resetProgress(current.series.key)
            $('#video-start').textContent = 'Watch episode 1'
            $('#video-reset').hidden = true
            renderEpisodes()
        }
    })
    $('#vepisodes').addEventListener('click', event => {
        const dl = event.target.closest('.chdl')
        if (dl && current) {
            const id = dl.dataset.dl
            if (videoDlActive(current.series.key, id)) {
                cancelVideoDownload(current.series.key, id)
                return
            }
            if (videoDlEntry(current.series.key, id)) {
                if (confirm('Delete the downloaded copy of this episode?')) deleteVideoDownload(current.series.key, id)
                return
            }
            dlFailed.delete(id)
            const episode = current.episodes.find(item => item.id === id)
            downloadVideoEpisode(current.series.key, id, { title: current.series.title, label: episodeLabel(episode || { id }) }).catch(error => {
                dlFailed.set(id, error?.message || 'Download failed')
                renderEpisodes()
            })
            return
        }
        if (event.target.closest('#video-episode-more')) {
            const before = $('#video-episode-list').querySelectorAll('.video-episode-row').length
            limit += BATCH
            renderEpisodes()
            $('#video-episode-list').querySelectorAll('.video-episode-row')[before]?.focus({ preventScroll: true })
            return
        }
        const episode = event.target.closest('.video-episode-row')
        if (episode && current) go(route(current.series.key, episode.dataset.id))
    })
    $('#vepisodes').addEventListener('input', event => {
        if (event.target.id !== 'video-episode-search') return
        query = event.target.value.trim()
        limit = BATCH
        renderEpisodes()
    })
    // download progress/cancel/delete lands here; repaint the rows in place, coalesced
    let dlPaintT = 0
    onVideoDl(() => {
        if (!current || dlPaintT) return
        dlPaintT = setTimeout(() => { dlPaintT = 0; if (current) renderEpisodes() }, 250)
    })
}

export async function showVideoSeries(key, origin = 'watch') {
    wire()
    const mine = ++request
    current = null
    query = ''
    limit = BATCH
    $('#vinfo').setAttribute('aria-busy', 'true')
    $('#vepisodes').setAttribute('aria-busy', 'true')
    $('#vinfo').innerHTML = '<div class="video-state" role="status">Loading series…</div>'
    $('#vepisodes').innerHTML = '<div class="video-state" role="status">Finding episodes…</div>'
    const seriesRequest = getVideoSeries(key)
    // miruro: render the info block from AniList (client-side, instant) while episodes load via
    // the proxy; the authoritative proxy response overwrites the interim render when it lands
    const parsed = parseVideoKey(key)
    if (parsed?.provider === 'miruro' && parsed.id) {
        anilistSeries(parsed.id).then(row => {
            if (mine !== request || !currentRouteIs(key) || current?.series?.episodes?.length) return
            current = { series: { ...row, poster: row.cover, source: 'Miruro · pewe (AniDB App)' }, episodes: [] }
            $('#vinfo').innerHTML = info(current.series)
            $('#vinfo').setAttribute('aria-busy', 'false')
        }).catch(() => {})
    }
    try {
        const series = await seriesRequest
        if (mine !== request || !currentRouteIs(key)) return
        const episodes = ordered(series.episodes)
        current = { series: { ...series, episodes }, episodes }
        if (followed(key)) touchLibrary(entryFor(current.series))
        setSeriesCrumb(ORIGIN_LABEL[origin] || 'Watch', series.title, () => go(ORIGIN_ROUTE[origin] || '#/watch'))
        $('#vinfo').innerHTML = info(current.series)
        $('#vepisodes').innerHTML = `<div class="video-episode-tool"><div class="srch"><input id="video-episode-search" inputmode="search" autocomplete="off" aria-label="Find an episode" placeholder="Find an episode…"></div></div><div class="video-episode-head">Episodes <span>· ${episodes.length}</span></div><div class="video-episode-scroll"><div id="video-episode-list"></div></div>`
        renderEpisodes()
        $('#vinfo').setAttribute('aria-busy', 'false')
        $('#vepisodes').setAttribute('aria-busy', 'false')
    } catch (error) {
        if (mine !== request || !currentRouteIs(key)) return
        const provider = videoProviderLabel(error.provider) || videoProviderLabel(parseVideoKey(key)?.provider)
        const degraded = provider && (error.code === 'provider_unconfigured' || error.retryable === false)
        const message = !navigator.onLine ? 'You’re offline. Reconnect to load this series.'
            : error.code === 'not_found' ? (error.message || `${provider || 'This source'} has no playable copy of this title`)
                : degraded ? `${provider} isn’t available in this build right now`
                    : error.message || 'Series unavailable'
        $('#vinfo').setAttribute('aria-busy', 'false')
        $('#vepisodes').setAttribute('aria-busy', 'false')
        // the interim AniList info is still valid — fail only the episode list
        if (current?.series?.title && !current.series.episodes?.length) {
            $('#vepisodes').innerHTML = `<div class="video-state" role="status">${esc(message)}<button id="video-episode-retry" type="button">Try again</button></div>`
            $('#video-episode-retry').onclick = () => showVideoSeries(key, origin)
            return
        }
        const action = degraded
            ? `<a id="video-series-back" href="${ORIGIN_ROUTE[origin] || '#/watch'}">Back to ${ORIGIN_LABEL[origin] || 'Watch'}</a>`
            : `<button id="video-series-retry" type="button">Try again</button>`
        $('#vinfo').innerHTML = `<div class="video-state" role="status">${esc(message)}${action}</div>`
        $('#vepisodes').innerHTML = ''
        const back = $('#video-series-back')
        if (back) back.addEventListener('click', event => { event.preventDefault(); go(ORIGIN_ROUTE[origin] || '#/watch') })
        else $('#video-series-retry').onclick = () => showVideoSeries(key, origin)
    }
}
