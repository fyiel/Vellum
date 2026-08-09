import { getKDramaEpisodes, getKDramaSeries, kDramaErrorMessage, kDramaProviderName, kDramaResponseNotice, parseKDramaKey } from '../lib/kdrama-api.js'
import { go, parseHash } from '../lib/router.js'
import { setSeriesCrumb } from './shell.js'
import { coverImg } from '../lib/cover.js'
import { $, esc } from '../lib/dom.js'

let request = 0
let ctrl = null

const currentRouteIs = key => {
    const route = parseHash()
    return route.name === 'kdrama-series' && route.key === key
}
const episodeLabel = episode => episode.number == null ? (episode.title || 'Special') : `Episode ${episode.number}`

function info(series) {
    const provider = kDramaProviderName(parseKDramaKey(series.key)?.provider)
    const meta = [series.year, series.status, series.country].filter(value => value != null).join(' · ')
    const genres = (series.genres || []).map(item => `<span class="kdrama-tag">${esc(item)}</span>`).join('')
    return `<div class="kdrama-poster"><span>Poster</span>${coverImg(series.cover, series.title, false)}</div>
      <div class="kdrama-title">${esc(series.title)}</div>
      ${meta ? `<div class="kdrama-series-meta">${esc(meta)}</div>` : ''}
      ${genres ? `<div class="kdrama-tags">${genres}</div>` : ''}
      ${series.synopsis ? `<div class="kdrama-section">Synopsis</div><div class="kdrama-synopsis">${esc(series.synopsis)}</div>` : ''}
      <div class="kdrama-stats"><div><span>Source</span><b>${esc(provider)}</b></div>${series.episodeCount != null ? `<div><span>Episodes</span><b>${esc(series.episodeCount)}</b></div>` : ''}</div>`
}

function episodes(value) {
    const notice = kDramaResponseNotice(value, parseKDramaKey(value.key)?.provider)
    const rows = value.episodes.map(episode => `<div class="kepisode" data-id="${esc(episode.id)}">
      <span class="kepisode-number">${esc(episodeLabel(episode))}</span><span class="kepisode-title">${esc(episode.title && episode.title !== episodeLabel(episode) ? episode.title : '')}</span><span class="kepisode-date">${esc(episode.airedAt || '')}</span>
    </div>`).join('')
    return `${notice ? `<div class="kdrama-notice">${esc(notice)}</div>` : ''}<div class="kepisode-head">Episodes <span>· ${value.episodes.length}</span></div><div class="kepisode-list">${rows || '<div class="kdrama-empty">No episodes available yet</div>'}</div>`
}

export async function showKDramaSeries(key) {
    ctrl?.abort()
    ctrl = new AbortController()
    const mine = ++request
    $('#kinfo').innerHTML = '<div class="kdrama-empty">Loading K-drama…</div>'
    $('#kepisodes').innerHTML = '<div class="kdrama-empty">Finding episodes…</div>'
    $('#kinfo').setAttribute('aria-busy', 'true')
    $('#kepisodes').setAttribute('aria-busy', 'true')

    const [seriesResult, episodeResult] = await Promise.allSettled([
        getKDramaSeries(key, { signal: ctrl.signal }),
        getKDramaEpisodes(key, { signal: ctrl.signal }),
    ])
    if (mine !== request || !currentRouteIs(key)) return

    if (seriesResult.status === 'rejected') {
        const message = kDramaErrorMessage(seriesResult.reason, 'K-drama unavailable')
        $('#kinfo').innerHTML = `<div class="kdrama-empty kdrama-error" role="status">${esc(message)}<button id="kseries-retry" type="button">Try again</button></div>`
        $('#kseries-retry').onclick = () => showKDramaSeries(key)
        $('#kepisodes').innerHTML = ''
    } else {
        setSeriesCrumb('K-Drama', seriesResult.value.title, () => go('#/kdrama'))
        $('#kinfo').innerHTML = info(seriesResult.value)
        if (episodeResult.status === 'fulfilled') $('#kepisodes').innerHTML = episodes(episodeResult.value)
        else {
            const message = kDramaErrorMessage(episodeResult.reason, 'Episode list unavailable')
            $('#kepisodes').innerHTML = `<div class="kdrama-empty kdrama-error" role="status">${esc(message)}<button id="kepisode-retry" type="button">Try again</button></div>`
            $('#kepisode-retry').onclick = () => showKDramaSeries(key)
        }
    }
    $('#kinfo').setAttribute('aria-busy', 'false')
    $('#kepisodes').setAttribute('aria-busy', 'false')
}

export function closeKDramaSeries() {
    ctrl?.abort()
    ctrl = null
    request++
}
