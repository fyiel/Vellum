import { getVideoSeries, parseVideoKey } from '../lib/video-api.js'
import { go, parseHash } from '../lib/router.js'
import { dropLibrary, library, posGet, readSet, resetProgress, touchLibrary } from '../lib/store.js'
import { coverImg } from '../lib/cover.js'
import { setSeriesCrumb } from './shell.js'
import { $, esc } from '../lib/dom.js'

const BATCH = 200
const ORIGIN_LABEL = { library: 'Library', updates: 'Updates', watch: 'Watch' }
const ORIGIN_ROUTE = { library: '#/', updates: '#/updates', watch: '#/watch' }
const PROVIDER_LABEL = { miruro: 'Miruro', dc: 'DramaCooli', gp: 'GoPlay', goplay: 'GoPlay', cineby: 'Cineby' }
export const videoProviderLabel = key => PROVIDER_LABEL[String(key || '').toLowerCase()] || null
const kindName = kind => kind === 'drama' ? 'K-drama' : 'Anime'
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
    return {
        slug: series.key,
        key: series.key,
        kind: series.kind,
        title: series.title,
        cover: series.poster,
        author: series.studio || series.cast?.[0],
        source: series.source || parseVideoKey(series.key)?.provider,
        format: kindName(series.kind),
        total: series.episodes.length,
        episodeIds: series.episodes.map(episode => episode.id),
        watchedCount: readSet(series.key).size,
        lastId: saved?.id,
        lastLabel: series.episodes.find(episode => episode.id === saved?.id) ? episodeLabel(series.episodes.find(episode => episode.id === saved.id)) : undefined,
        lastPosition: saved?.id ? (saved.position || 0) : undefined,
        lastDuration: saved?.id ? (saved.duration || 0) : undefined,
    }
}

function info(series) {
    const saved = posGet(series.key)
    const meta = [kindName(series.kind), series.year, series.status].filter(Boolean).join(' · ')
    const tags = (series.genres || []).map(genre => `<span class="video-tag">${esc(genre)}</span>`).join('')
    return `<div class="video-poster-lg">${coverImg(series.poster, series.title, { useResolver: false, eager: true }) || '<span>No poster</span>'}</div>
      <div class="video-copy"><div class="video-title">${esc(series.title)}</div>${meta ? `<div class="video-meta">${esc(meta)}</div>` : ''}${tags ? `<div class="video-tags">${tags}</div>` : ''}
      <div class="video-actions"><button class="btn primary" id="video-start" type="button">${saved ? `Continue · ${esc(episodeLabel(series.episodes.find(episode => episode.id === saved.id) || series.episodes[0]))}` : 'Watch episode 1'}</button><button class="btn${followed(series.key) ? ' on' : ''}" id="video-follow" type="button">${followed(series.key) ? 'Following' : 'Follow'}</button><button class="btn video-reset" id="video-reset" type="button" ${saved || readSet(series.key).size ? '' : 'hidden'}>Reset progress</button></div></div>
      ${series.synopsis ? `<div class="video-synopsis"><div class="seclab">Synopsis</div><div class="dsyn">${esc(series.synopsis)}</div></div>` : ''}
      <div class="video-stats"><div class="drow"><span class="k">Episodes</span><span class="v">${series.episodes.length}</span></div>${series.source ? `<div class="drow"><span class="k">Source</span><span class="v">${esc(series.source)}</span></div>` : ''}</div>`
}

function episodeRows(episodes) {
    const watched = readSet(current.series.key)
    const saved = posGet(current.series.key)?.id
    return episodes.map(episode => `<button type="button" class="video-episode-row${watched.has(episode.id) ? ' watched' : ''}${saved === episode.id ? ' current' : ''}" data-id="${esc(episode.id)}"${saved === episode.id ? ' aria-current="page"' : ''}>
      <span class="video-episode-number">${esc(episodeLabel(episode))}</span><span class="video-episode-name">${esc(episodeName(episode))}</span>${episode.runtime ? `<span class="video-runtime">${esc(episode.runtime)}m</span>` : '<span></span>'}<span class="video-episode-dot"></span>
    </button>`).join('')
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
    try {
        const series = await getVideoSeries(key)
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
        const action = degraded
            ? `<a id="video-series-back" href="${ORIGIN_ROUTE[origin] || '#/watch'}">Back to ${ORIGIN_LABEL[origin] || 'Watch'}</a>`
            : `<button id="video-series-retry" type="button">Try again</button>`
        $('#vinfo').innerHTML = `<div class="video-state" role="status">${esc(message)}${action}</div>`
        $('#vepisodes').innerHTML = ''
        const back = $('#video-series-back')
        if (back) back.addEventListener('click', event => { event.preventDefault(); go(ORIGIN_ROUTE[origin] || '#/watch') })
        else $('#video-series-retry').onclick = () => showVideoSeries(key, origin)
        $('#vinfo').setAttribute('aria-busy', 'false')
        $('#vepisodes').setAttribute('aria-busy', 'false')
    }
}
