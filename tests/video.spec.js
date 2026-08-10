import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`
const key = 'mock:signal-season'
const poster = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="600" height="900"%3E%3Crect width="100%25" height="100%25" fill="%231d1f25"/%3E%3C/svg%3E'
const episode = number => ({ id: `episode-${number}`, season: 1, number, title: `Signal ${number}`, runtime: 24 })

test.setTimeout(60_000)

test.beforeEach(async ({ page }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() !== 'error') return
    if (message.text().startsWith('Failed to load resource')) return
    errors.push(message.text())
  })
  await page.goto(app)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  page._vellumErrors = errors
})

test.afterEach(async ({ page }) => expect(page._vellumErrors).toEqual([]))

function videoSeries(episodes) {
  return {
    key,
    kind: 'anime',
    title: 'Signal Season',
    poster,
    year: 2026,
    status: 'Releasing',
    studio: 'Vellum Studio',
    source: 'Mock catalogue',
    synopsis: 'A clean provider-neutral fixture.',
    genres: ['Mystery', 'Drama'],
    episodes,
  }
}

async function mockVideo(page, state, playback) {
  await page.route('**/read/api/video/discover?**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ results: [videoSeries(state.episodes)], hasMore: false, partial: false, errors: [] }),
  }))
  await page.route('**/read/api/video/series/**', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(videoSeries(state.episodes)),
  }))
  await page.route('**/read/api/video/playback?**', route => {
    const id = new URL(route.request().url()).searchParams.get('id')
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(playback(id)) })
  })
  await page.route('**/read/api/video/media/**', route => route.request().url().endsWith('.vtt')
    ? route.fulfill({ contentType: 'text/vtt', body: 'WEBVTT\n' })
    : route.fulfill({ contentType: 'video/mp4', body: '' }))
}

test('validates tagged direct and HTTPS embed playback contracts', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { parseVideoKey, validVideoDetail, validVideoPlayback } = await import('/src/lib/video-api.js')
    const key = 'mock:show'
    const base = { key, episodeId: 'ep-1', providerLabel: 'Mock Video' }
    const direct = { ...base, sources: [{ kind: 'direct', url: '/read/api/video/media/ep-1.mp4', type: 'video/mp4' }] }
    const embed = { ...base, sources: [{ kind: 'embed', url: 'https://embed.example/watch?v=ep-1' }] }
    return {
      parsed: parseVideoKey(key),
      direct: validVideoPlayback(direct, key, 'ep-1'),
      embed: validVideoPlayback(embed, key, 'ep-1'),
      untagged: validVideoPlayback({ ...base, sources: [{ url: 'https://embed.example/watch?v=ep-1' }] }, key, 'ep-1'),
      directWithoutMime: validVideoPlayback({ ...base, sources: [{ kind: 'direct', url: '/media/ep-1' }] }, key, 'ep-1'),
      insecureEmbed: validVideoPlayback({ ...base, sources: [{ kind: 'embed', url: 'http://embed.example/watch' }] }, key, 'ep-1'),
      scriptEmbed: validVideoPlayback({ ...base, sources: [{ kind: 'embed', url: 'javascript:alert(1)' }] }, key, 'ep-1'),
      missingProvider: validVideoPlayback({ key, episodeId: 'ep-1', sources: direct.sources }, key, 'ep-1'),
      wrongOwner: validVideoPlayback({ ...direct, key: 'mock:other' }, key, 'ep-1'),
      invalidExpected: validVideoPlayback(direct, 'not-a-key', 'ep-1'),
      duplicateEpisodes: validVideoDetail({ key, kind: 'anime', title: 'Show', episodes: [{ id: 'ep-1' }, { id: 'ep-1' }] }, key),
    }
  })

  expect(result).toEqual({
    parsed: { provider: 'mock', id: 'show' }, direct: true, embed: true, untagged: false,
    directWithoutMime: false, insecureEmbed: false, scriptEmbed: false, missingProvider: false,
    wrongOwner: false, invalidExpected: false, duplicateEpisodes: false,
  })
})

test('browses, follows, resumes, and detects updates through a lazy native player', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const state = { episodes: [episode(1), episode(2)] }
  let playerChunkRequests = 0
  page.on('request', request => { if (request.url().includes('/src/screens/video-player.js')) playerChunkRequests++ })
  await mockVideo(page, state, id => ({
    key, episodeId: id, providerLabel: 'Mock Stream',
    sources: [{ kind: 'direct', url: `/read/api/video/media/${id}.mp4`, type: 'video/mp4' }],
    subtitles: [{ url: '/read/api/video/media/en.vtt', lang: 'en', label: 'English', default: true }],
  }))

  await page.locator('[data-nav="watch"]').click()
  await expect(page.locator('[data-nav="watch"]')).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('#vlist .watch-card')).toHaveCount(1)
  expect(playerChunkRequests).toBe(0)
  await page.locator('#vlist .watch-card').click()
  await expect(page.locator('#video-episode-list .video-episode-row')).toHaveCount(2)
  await expect(page.locator('#vinfo')).toContainText('Signal Season')
  await expect(page.locator('#vplayer video')).toHaveCount(0)
  expect(playerChunkRequests).toBe(0)

  await page.locator('#video-follow').click()
  await page.locator('#video-episode-list .video-episode-row').first().click()
  await expect(page.locator('#vplayer')).toHaveAttribute('data-state', 'ready')
  await expect(page.locator('.video-provider-label')).toHaveText('Provided by Mock Stream')
  const media = page.locator('#vplayer video')
  await expect(media).toHaveCount(1)
  await expect(media).toHaveAttribute('preload', 'none')
  expect(playerChunkRequests).toBe(1)

  await page.evaluate(() => {
    const video = document.querySelector('#vplayer video')
    video.play = () => { window.__videoPlayIntent = true; return Promise.resolve() }
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 42, writable: true })
    Object.defineProperty(video, 'duration', { configurable: true, value: 100 })
    video.dispatchEvent(new Event('pause'))
  })
  await page.locator('#vplayer').focus()
  await page.keyboard.press('Space')
  expect(await page.evaluate(() => window.__videoPlayIntent)).toBe(true)
  await page.locator('#vp-back').click()
  await expect(page.locator('#video-start')).toContainText('Continue · S1 · E1')

  await page.locator('[data-nav="library"]').click()
  await expect(page.locator('#continue .ctile')).toContainText('S1 · E1 · 0:42 / 1:40')
  const saved = await page.evaluate(k => ({
    position: JSON.parse(localStorage.getItem(`vellum:pos:${k}`)),
    entry: JSON.parse(localStorage.getItem('vellum:lib'))[0],
  }), key)
  expect(saved.position).toMatchObject({ id: 'episode-1', position: 42, duration: 100 })
  expect(saved.entry).toMatchObject({ kind: 'anime', lastId: 'episode-1', watchedCount: 0, total: 2 })

  state.episodes = [...state.episodes, episode(3)]
  await page.locator('[data-nav="updates"]').click()
  await expect(page.locator('#ufeed .urow')).toContainText('Signal Season')
  await expect(page.locator('#ufeed .uchip')).toHaveText('S1 · E3')
  await expect(page.locator('#count-updates')).toHaveText('1')

  const diagnostics = await page.evaluate(() => ({
    contractMs: performance.getEntriesByName('vellum:video-player:contract').at(-1)?.duration,
    shellMs: performance.getEntriesByName('vellum:video-player:media-shell').at(-1)?.duration,
    overflow: document.documentElement.scrollWidth - innerWidth,
    reducedTransition: getComputedStyle(document.querySelector('.watch-poster img')).transitionDuration,
  }))
  expect(diagnostics.contractMs).toBeGreaterThanOrEqual(0)
  expect(diagnostics.shellMs).toBeGreaterThanOrEqual(0)
  expect(diagnostics.overflow).toBeLessThanOrEqual(1)
})

test('loads an HTTPS embed only after consent with allow-restrictions', async ({ page }) => {
  const state = { episodes: [episode(1), episode(2)] }
  let embedRequests = 0
  await mockVideo(page, state, id => ({
    key, episodeId: id, providerLabel: 'Mock Embed',
    sources: [{ kind: 'embed', url: `https://embed.example/watch?v=${id}` }],
  }))
  await page.route('https://embed.example/watch?**', route => {
    // the liveness probe issues a second no-cors fetch; count only the iframe's document request
    if (route.request().resourceType() === 'document') embedRequests++
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Mock player</title><p>ready</p>' })
  })

  await page.goto(`${app}#/watch/play/mock%3Asignal-season/episode-1`)
  await expect(page.locator('#vplayer')).toHaveAttribute('data-state', 'ready')
  await expect(page.locator('.video-provider-label')).toHaveText('Provided by Mock Embed')
  await expect(page.locator('.video-embed-load')).toBeVisible()
  await expect(page.locator('.video-embed-frame')).toHaveCount(0)
  expect(embedRequests).toBe(0)

  await page.locator('.video-embed-load').click()
  const frame = page.locator('.video-embed-frame')
  await expect(frame).toHaveCount(1)
  // no sandbox attribute: embed hosts refuse to play inside any sandboxed frame; the embed is an
  // adapter-gated cross-origin https URL, and the remaining restrictions below still apply
  await expect(frame).not.toHaveAttribute('sandbox')
  await expect(frame).not.toHaveAttribute('referrerpolicy')
  await expect(frame).toHaveAttribute('allow', 'fullscreen; picture-in-picture; encrypted-media')
  await expect(frame).not.toHaveAttribute('allow', /autoplay/)
  await expect.poll(() => embedRequests).toBe(1)

  await frame.evaluate(element => element.dispatchEvent(new Event('error')))
  await expect(page.locator('#vplayer')).toHaveAttribute('data-state', 'blocked')
  await expect(page.locator('.video-embed-shell')).toContainText('couldn’t be opened in Vellum')
  await expect(page.locator('.video-embed-shell [role="alert"]')).toBeVisible()
  expect(await page.evaluate(k => JSON.parse(localStorage.getItem(`vellum:pos:${k}`)), key)).toMatchObject({ id: 'episode-1' })
})

test('reports an organic embed failure as blocked after the unavailable timer', async ({ page }) => {
  const state = { episodes: [episode(1)] }
  await mockVideo(page, state, id => ({
    key, episodeId: id, providerLabel: 'Mock Embed',
    sources: [{ kind: 'embed', url: `https://embed.example/watch?v=${id}` }],
  }))
  await page.route('https://embed.example/watch?**', route => route.abort())

  await page.goto(`${app}#/watch/play/mock%3Asignal-season/episode-1`)
  await page.locator('.video-embed-load').click()
  // the unavailable timer (12s) must fire: about:blank and error documents do not clear it
  await expect(page.locator('#vplayer')).toHaveAttribute('data-state', 'blocked', { timeout: 20000 })
  await expect(page.locator('.video-embed-shell [role="alert"]')).toBeVisible()
})

test('marks a slow-but-successful embed ready before the unavailable timer', async ({ page }) => {
  const state = { episodes: [episode(1)] }
  await mockVideo(page, state, id => ({
    key, episodeId: id, providerLabel: 'Mock Embed',
    sources: [{ kind: 'embed', url: `https://embed.example/slow?v=${id}` }],
  }))
  await page.route('https://embed.example/slow?**', route => {
    if (route.request().resourceType() === 'document') {
      // the frame navigation itself is slow (> the 8s probe window if it started at click time)
      return new Promise(resolve => setTimeout(() => resolve(route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>slow embed</title><p>ready</p>' })), 9000))
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>probe</title>' })
  })

  await page.goto(`${app}#/watch/play/mock%3Asignal-season/episode-1`)
  await page.locator('.video-embed-load').click()
  // ready must arrive after the ~9s load and before the 12s unavailable timer
  await expect(page.locator('#vplayer')).toHaveAttribute('data-state', 'ready', { timeout: 15000 })
  await expect(page.locator('#vplayer')).not.toHaveAttribute('data-state', 'blocked')
})

test('browses K-drama through Watch and opens its shared player', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const drama = {
    key: 'dc:a-shop-for-killers', kind: 'drama', title: 'A Shop for Killers', poster,
    year: 2026, status: 'Ongoing', source: 'DramaCool', synopsis: 'A niece uncovers the truth.',
    genres: ['Action', 'Mystery'], episodes: [episode(1), episode(2)],
  }
  await page.route('**/read/api/video/discover?**', route => {
    const all = new URL(route.request().url()).searchParams.get('kind') !== 'drama'
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      results: [drama], hasMore: false, partial: all,
      errors: all ? [{ provider: 'miruro', code: 'provider_unconfigured', message: 'Anime playback is not configured' }] : [],
    }) })
  })
  await page.route('**/read/api/video/series/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(drama) }))
  await page.route('**/read/api/video/playback?**', route => {
    const id = new URL(route.request().url()).searchParams.get('id')
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      key: drama.key, episodeId: id, providerLabel: 'DramaCool · EmbedLoad',
      sources: [{ kind: 'embed', url: `https://embed.example/watch?v=${id}` }],
    }) })
  })

  await page.locator('[data-nav="watch"]').click()
  await expect(page.locator('.watch-notice')).toContainText('Miruro is temporarily unavailable; others still show')
  await page.locator('#vkind [data-kind="drama"]').click()
  await expect(page.locator('#vkind [data-kind="drama"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#vlist a.watch-card')).toHaveCount(1)
  await expect(page.locator('.watch-notice')).toHaveCount(0)
  await page.locator('#vlist a.watch-card').click()
  await expect(page.locator('#vinfo')).toContainText('A Shop for Killers')
  await expect(page.locator('#video-episode-list .video-episode-row')).toHaveCount(2)
  await page.locator('#video-episode-list .video-episode-row').first().click()
  await expect(page.locator('.video-provider-label')).toHaveText('Provided by DramaCool · EmbedLoad')
  await expect(page.locator('.video-embed-load')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('ignores a stale Watch search', async ({ page }) => {
  let releaseSlow
  const slow = new Promise(resolve => { releaseSlow = resolve })
  await page.route('**/read/api/video/discover?**', async route => {
    const query = new URL(route.request().url()).searchParams.get('q') || ''
    if (query === 'slow') await slow
    const title = query || 'Healthy title'
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      results: [{ key: `dc:${title.replaceAll(' ', '-')}`, kind: 'drama', title }],
      hasMore: false, partial: false, errors: [],
    }) })
  })

  await page.locator('[data-nav="watch"]').click()
  await expect(page.locator('#vlist')).toContainText('Healthy title')
  await page.locator('#vsearch').fill('slow')
  await page.waitForRequest(request => request.url().includes('/video/discover?') && request.url().includes('q=slow'))
  await page.locator('#vsearch').fill('fast')
  await expect(page.locator('#vlist')).toContainText('fast')
  releaseSlow()
  await page.waitForTimeout(100)
  await expect(page.locator('#vlist')).toContainText('fast')
  await expect(page.locator('#vlist')).not.toContainText('slow')
})

test('preserves and retries a failed Watch pagination boundary', async ({ page }) => {
  let pageTwoDown = true
  await page.route('**/read/api/video/discover?**', route => {
    const pageNumber = Number(new URL(route.request().url()).searchParams.get('page'))
    if (pageNumber === 2 && pageTwoDown) return route.fulfill({
      status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'provider_unavailable', message: 'DramaCool unavailable', retryable: false } }),
    })
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      results: [{ key: `dc:page-${pageNumber}`, kind: 'drama', title: `DramaCool page ${pageNumber}` }],
      hasMore: pageNumber === 1, partial: false, errors: [],
    }) })
  })

  await page.locator('[data-nav="watch"]').click()
  await expect(page.locator('#vlist .watch-card')).toHaveCount(1)
  await page.locator('#vmore').click()
  await expect(page.locator('#vmore')).toHaveText('Try again')
  await expect(page.locator('#vlist .watch-card')).toHaveCount(1)
  page._vellumErrors.length = 0
  pageTwoDown = false
  await page.locator('#vmore').click()
  await expect(page.locator('#vlist .watch-card')).toHaveCount(2)
  await expect(page.locator('#vlist')).toContainText('DramaCool page 2')
})

test('loads HLS through the lazy fallback when native playback is unavailable', async ({ page }) => {
  const state = { episodes: [episode(1)] }
  let playlistRequests = 0
  await mockVideo(page, state, id => ({
    key, episodeId: id, providerLabel: 'Mock HLS',
    sources: [{ kind: 'direct', url: '/read/api/video/media/playlist.m3u8', type: 'application/x-mpegURL' }],
  }))
  await page.route('**/read/api/video/media/playlist.m3u8', route => {
    playlistRequests++
    return route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-ENDLIST\n' })
  })

  await page.goto(`${app}#/watch/play/mock%3Asignal-season/episode-1`)
  const media = page.locator('#vplayer video')
  await expect(media).toHaveCount(1)
  await expect(page.locator('.video-provider-label')).toHaveText('Provided by Mock HLS')
  await media.evaluate(video => video.play().catch(() => {}))
  await expect.poll(() => playlistRequests).toBeGreaterThan(0)
})

test('bounds and searches a large provider-neutral episode list', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const state = { episodes: Array.from({ length: 501 }, (_, index) => episode(index + 1)) }
  await mockVideo(page, state, id => ({
    key, episodeId: id, providerLabel: 'Mock Stream',
    sources: [{ kind: 'direct', url: `/read/api/video/media/${id}.mp4`, type: 'video/mp4' }],
  }))
  await page.goto(`${app}#/watch/series/mock%3Asignal-season`)
  await expect(page.locator('#video-episode-list .video-episode-row')).toHaveCount(200)
  await expect(page.locator('#video-episode-more')).toContainText('200 of 501')
  await page.locator('#video-episode-more').click()
  await expect(page.locator('#video-episode-list .video-episode-row')).toHaveCount(400)
  await page.locator('#video-episode-search').fill('Signal 477')
  await expect(page.locator('#video-episode-list .video-episode-row')).toHaveCount(1)
  await expect(page.locator('#video-episode-list .video-episode-row')).toContainText('S1 · E477')
  await page.locator('[data-nav="watch"]').click()
  await expect(page.locator('.watch-poster img')).toHaveCount(1)
  expect(await page.locator('.watch-poster img').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
})

test('a stale playback contract cannot replace the newly selected episode', async ({ page }) => {
  const state = { episodes: [episode(1), episode(2)] }
  let releaseFirst
  const first = new Promise(resolve => { releaseFirst = resolve })
  await page.route('**/read/api/video/series/**', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(videoSeries(state.episodes)),
  }))
  await page.route('**/read/api/video/playback?**', async route => {
    const id = new URL(route.request().url()).searchParams.get('id')
    if (id === 'episode-1') await first
    try {
      return await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        key, episodeId: id, providerLabel: `Owner ${id}`,
        sources: [{ kind: 'direct', url: `/read/api/video/media/${id}.mp4`, type: 'video/mp4' }],
      }) })
    } catch {}
  })
  await page.route('**/read/api/video/media/**', route => route.fulfill({ contentType: 'video/mp4', body: '' }))

  const firstRequest = page.waitForRequest(request => request.url().includes('/video/playback?') && request.url().includes('episode-1'))
  await page.goto(`${app}#/watch/play/mock%3Asignal-season/episode-1`)
  await firstRequest
  await page.evaluate(() => { location.hash = '#/watch/play/mock%3Asignal-season/episode-2' })
  await expect(page.locator('.video-provider-label')).toHaveText('Provided by Owner episode-2')
  releaseFirst()
  await page.waitForTimeout(100)
  await expect(page.locator('#vp-episode')).toContainText('E2')
  await expect(page.locator('.video-provider-label')).toHaveText('Provided by Owner episode-2')
})

test('names an offline player failure and recovers from a lazy chunk failure', async ({ page }) => {
  await page.evaluate(() => import('/src/screens/video-player.js'))
  await page.route('**/read/api/video/**', route => route.abort('internetdisconnected'))
  await page.context().setOffline(true)
  await page.evaluate(() => { location.hash = '#/watch/play/mock%3Aoffline/episode-1' })
  await expect(page.locator('#vplayer')).toHaveAttribute('data-state', 'offline')
  await expect(page.locator('#vp-stage')).toContainText('You’re offline')
  page._vellumErrors.length = 0

  await page.context().setOffline(false)
  await page.unroute('**/read/api/video/**')
  await page.route('**/src/screens/video-player.js', route => route.abort('failed'))
  await page.reload()
  await page.evaluate(() => { location.hash = '#/watch/play/mock%3Achunk-failure/episode-1' })
  await expect(page.locator('#vplayer')).toHaveAttribute('data-state', 'error')
  await expect(page.locator('#vp-stage')).toContainText('Couldn’t open the video player')
  await expect(page.locator('#video-player-load-retry')).toBeVisible()
  page._vellumErrors.length = 0
})

test('keeps provider prefixes intact through parseVideoKey', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { parseVideoKey } = await import('/src/lib/video-api.js')
    return ['mock:signal-season', 'dc:a-shop-for-killers', 'cineby:817', 'gp:dark-city', 'miruro:12345', 'nokey']
      .map(key => ({ key, parsed: parseVideoKey(key) }))
  })
  expect(result).toEqual([
    { key: 'mock:signal-season', parsed: { provider: 'mock', id: 'signal-season' } },
    { key: 'dc:a-shop-for-killers', parsed: { provider: 'dc', id: 'a-shop-for-killers' } },
    { key: 'cineby:817', parsed: { provider: 'cineby', id: '817' } },
    { key: 'gp:dark-city', parsed: { provider: 'gp', id: 'dark-city' } },
    { key: 'miruro:12345', parsed: { provider: 'miruro', id: '12345' } },
    { key: 'nokey', parsed: null },
  ])
})

test('renders DramaCooli rows in the K-drama tab with provider-prefixed keys', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const drama = {
    key: 'dc:blood-free', kind: 'drama', title: 'Blood Free', poster,
    year: 2026, status: 'Ongoing', source: 'DramaCooli', synopsis: 'A chef chases the truth.',
    genres: ['Thriller'], episodes: [episode(1), episode(2)],
  }
  await page.route('**/read/api/video/discover?**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ results: [drama], hasMore: false, partial: false, errors: [] }),
  }))
  await page.route('**/read/api/video/series/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(drama) }))
  await page.route('**/read/api/video/playback?**', route => {
    const id = new URL(route.request().url()).searchParams.get('id')
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      key: drama.key, episodeId: id, providerLabel: 'DramaCooli',
      sources: [{ kind: 'embed', url: `https://embed.example/watch?v=${id}` }],
    }) })
  })

  await page.locator('[data-nav="watch"]').click()
  const dramaRequest = page.waitForRequest(request => request.url().includes('/video/discover?') && request.url().includes('kind=drama'))
  await page.locator('#vkind [data-kind="drama"]').click()
  await dramaRequest
  await expect(page.locator('#vkind [data-kind="drama"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#vlist .watch-card')).toHaveCount(1)
  await expect(page.locator('#vlist .watch-card')).toHaveAttribute('href', '#/watch/series/dc%3Ablood-free')
  await expect(page.locator('#vlist .watch-card')).toHaveAttribute('aria-label', 'Blood Free, K-drama')
  await page.locator('#vlist .watch-card').click()
  await expect(page.locator('#vinfo')).toContainText('Blood Free')
  await expect(page.locator('#vinfo .video-stats')).toContainText('DramaCooli')
  await expect(page.locator('#video-episode-list .video-episode-row')).toHaveCount(2)
})

test('merges provider rows on Watch and names the unconfigured provider', async ({ page }) => {
  const anime = {
    key: 'mock:signal-season', kind: 'anime', title: 'Signal Season', poster,
    year: 2026, status: 'Releasing', source: 'Mock catalogue', synopsis: 'A clean provider-neutral fixture.',
    genres: ['Mystery'], episodes: [episode(1)],
  }
  const drama = {
    key: 'dc:blood-free', kind: 'drama', title: 'Blood Free', poster,
    year: 2026, status: 'Ongoing', source: 'DramaCooli', synopsis: 'A chef chases the truth.',
    genres: ['Thriller'], episodes: [episode(1)],
  }
  await page.route('**/read/api/video/discover?**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      results: [drama, anime], hasMore: false, partial: true,
      errors: [{ provider: 'goplay', code: 'provider_unconfigured', message: 'GoPlay playback is not configured' }],
    }),
  }))

  await page.locator('[data-nav="watch"]').click()
  await expect(page.locator('#vlist .watch-card')).toHaveCount(2)
  await expect(page.locator('#vlist')).toContainText('Blood Free')
  await expect(page.locator('#vlist')).toContainText('Signal Season')
  await expect(page.locator('.watch-notice')).toContainText('GoPlay is temporarily unavailable; others still show')
  await expect(page.locator('#vlist a[href="#/watch/series/dc%3Ablood-free"]')).toHaveCount(1)
  await expect(page.locator('#vlist a[href="#/watch/series/mock%3Asignal-season"]')).toHaveCount(1)
})

test('reaches a ready player through a provider embed with its badge', async ({ page }) => {
  // cineby keys carry numeric ids and cineby series are anime
  const key = 'cineby:817'
  const state = { episodes: [episode(1), episode(2)] }
  let embedRequests = 0
  await page.route('**/read/api/video/series/**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      key, kind: 'anime', title: 'Love Lies', poster, year: 2026, status: 'Ongoing',
      source: 'Cineby', synopsis: 'A romance built on omissions.', genres: ['Romance'], episodes: state.episodes,
    }),
  }))
  await page.route('**/read/api/video/playback?**', route => {
    const id = new URL(route.request().url()).searchParams.get('id')
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      key, episodeId: id, providerLabel: 'Cineby',
      sources: [{ kind: 'embed', url: `https://embed.example/player?e=${id}` }],
    }) })
  })
  await page.route('https://embed.example/player?**', route => {
    if (route.request().resourceType() === 'document') embedRequests++
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Mock player</title><p>ready</p>' })
  })

  await page.goto(`${app}#/watch/play/cineby%3A817/episode-1`)
  await expect(page.locator('#vplayer')).toHaveAttribute('data-state', 'ready')
  await expect(page.locator('.video-provider-label')).toHaveText('Provided by Cineby')
  await expect(page.locator('.video-embed-load')).toBeVisible()
  await page.locator('.video-embed-load').click()
  const frame = page.locator('.video-embed-frame')
  await expect(frame).toHaveCount(1)
  await expect(frame).not.toHaveAttribute('sandbox')
  await expect(frame).not.toHaveAttribute('referrerpolicy')
  await expect(frame).toHaveAttribute('allow', 'fullscreen; picture-in-picture; encrypted-media')
  await expect.poll(() => embedRequests).toBe(1)
  await expect(page.locator('#vplayer')).toHaveAttribute('data-state', 'ready')
  await expect(page.locator('.video-provider-label')).toHaveText('Provided by Cineby')
})

test('names a degraded GoPlay playback and leaves other providers playable', async ({ page }) => {
  const goplay = {
    key: 'gp:dark-city', kind: 'anime', title: 'Dark City', poster,
    year: 2026, status: 'Complete', source: 'GoPlay', synopsis: 'A provider that lost its upstream.',
    genres: ['Action'], episodes: [episode(1)],
  }
  const healthy = {
    key: 'mock:signal-season', kind: 'anime', title: 'Signal Season', poster,
    year: 2026, status: 'Releasing', source: 'Mock catalogue', synopsis: 'A clean provider-neutral fixture.',
    genres: ['Mystery'], episodes: [episode(1)],
  }
  await page.route('**/read/api/video/series/**', route => {
    const seriesKey = decodeURIComponent(route.request().url().split('/series/')[1])
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(seriesKey === goplay.key ? goplay : healthy) })
  })
  await page.route('**/read/api/video/playback?**', route => {
    const keyParam = new URL(route.request().url()).searchParams.get('key')
    if (keyParam === goplay.key) return route.fulfill({
      status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: { provider: 'gp', code: 'provider_unconfigured', message: 'GoPlay playback is not configured', retryable: false } }),
    })
    const id = new URL(route.request().url()).searchParams.get('id')
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      key: healthy.key, episodeId: id, providerLabel: 'Mock Stream',
      sources: [{ kind: 'direct', url: `/read/api/video/media/${id}.mp4`, type: 'video/mp4' }],
    }) })
  })
  await page.route('**/read/api/video/media/**', route => route.fulfill({ contentType: 'video/mp4', body: '' }))

  await page.goto(`${app}#/watch/play/gp%3Adark-city/episode-1`)
  await expect(page.locator('#vplayer')).toHaveAttribute('data-state', 'error')
  await expect(page.locator('#video-player-back')).toBeVisible()
  // degraded providers keep their badge and show humanized copy, not the raw API message
  await expect(page.locator('.video-provider-label')).toContainText('GoPlay')
  await expect(page.locator('#vp-stage')).toContainText('GoPlay')
  await expect(page.locator('#vp-stage')).not.toContainText('playback is not configured')

  await page.evaluate(() => { location.hash = '#/watch/play/mock%3Asignal-season/episode-1' })
  await expect(page.locator('#vplayer')).toHaveAttribute('data-state', 'ready')
  await expect(page.locator('.video-provider-label')).toHaveText('Provided by Mock Stream')
})
