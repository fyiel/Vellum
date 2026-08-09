import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

test.beforeEach(async ({ page }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto(app)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  page._vellumErrors = errors
})

test.afterEach(async ({ page }) => expect(page._vellumErrors).toEqual([]))

test('validates opaque K-drama provider, series, and episode contracts', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const {
      kDramaKey,
      parseKDramaKey,
      validKDramaSeries,
      validKDramaEpisodes,
      validKDramaEpisode,
    } = await import('/src/lib/kdrama-api.js')
    const key = kDramaKey('GP', 'Opaque_ID~9')
    const series = {
      key,
      kind: 'kdrama',
      title: 'Signal',
      year: 2016,
      genres: ['Crime'],
      sourceUrl: 'https://goplay.su/show/Opaque_ID~9',
    }
    const episodes = {
      key,
      episodes: [
        { id: 'episode.A_2', number: 2, title: 'The second signal' },
        { id: 'special~one', number: null, title: 'Special' },
      ],
    }
    const episode = { key, episode: episodes.episodes[0], available: true }
    return {
      key,
      parsed: parseKDramaKey(key),
      series: validKDramaSeries(series, key),
      dramaCool: validKDramaSeries({ ...series, key: 'dc:show_1', sourceUrl: 'https://dramacooli.buzz/drama-detail/show/' }),
      wrongProvider: validKDramaSeries({ ...series, key: 'dc:show_1' }, key),
      badYear: validKDramaSeries({ ...series, year: '2016' }),
      badGenres: validKDramaSeries({ ...series, genres: 'Crime' }),
      unsafeUrl: validKDramaSeries({ ...series, sourceUrl: 'javascript:alert(1)' }),
      episodes: validKDramaEpisodes(episodes, key),
      duplicates: validKDramaEpisodes({ ...episodes, episodes: [episodes.episodes[0], episodes.episodes[0]] }, key),
      badNumber: validKDramaEpisodes({ key, episodes: [{ id: 'episode-1', number: '1' }] }, key),
      episode: validKDramaEpisode(episode, key, 'episode.A_2'),
      wrongEpisode: validKDramaEpisode(episode, key, 'episode.A_3'),
    }
  })

  expect(result).toEqual({
    key: 'gp:Opaque_ID~9',
    parsed: { provider: 'gp', id: 'Opaque_ID~9' },
    series: true,
    dramaCool: true,
    wrongProvider: false,
    badYear: false,
    badGenres: false,
    unsafeUrl: false,
    episodes: true,
    duplicates: false,
    badNumber: false,
    episode: true,
    wrongEpisode: false,
  })
})

test('fails over providers and only caches a complete K-drama result', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { discoverKDrama } = await import('/src/lib/kdrama-api.js')
    const { setTransport } = await import('/src/lib/http.js')
    const calls = []
    let dramaCoolHealthy = false
    const item = (key, title) => ({ key, kind: 'kdrama', title, year: 2026 })
    setTransport(async url => {
      const provider = new URL(String(url), location.origin).searchParams.get('source')
      calls.push(provider)
      if (provider === 'dc' && !dramaCoolHealthy) return {
        ok: false,
        status: 503,
        json: async () => ({ error: { provider: 'dc', code: 'provider_unavailable', message: 'catalogue offline', retryable: false } }),
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ page: 1, results: [provider === 'gp' ? item('gp:signal', 'Signal') : item('dc:queen', 'Queen')], hasMore: false }),
      }
    })

    const first = await discoverKDrama()
    const second = await discoverKDrama()
    dramaCoolHealthy = true
    const third = await discoverKDrama()
    const fourth = await discoverKDrama()
    return {
      calls,
      first: { keys: first.results.map(item => item.key), partial: first.partial, errors: first.errors },
      secondPartial: second.partial,
      third: { keys: third.results.map(item => item.key), partial: third.partial },
      fourth: fourth.results.map(item => item.key),
    }
  })

  expect(result).toEqual({
    calls: ['gp', 'dc', 'gp', 'dc', 'gp', 'dc'],
    first: {
      keys: ['gp:signal'],
      partial: true,
      errors: [{ provider: 'dc', code: 'provider_unavailable', message: 'catalogue offline', retryable: false }],
    },
    secondPartial: true,
    third: { keys: ['gp:signal', 'dc:queen'], partial: false },
    fourth: ['gp:signal', 'dc:queen'],
  })
})

test('treats provider drift as partial data and does not cache it', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { searchKDrama } = await import('/src/lib/kdrama-api.js')
    const { setTransport } = await import('/src/lib/http.js')
    let calls = 0
    const good = provider => ({ key: `${provider}:valid`, kind: 'kdrama', title: provider === 'gp' ? 'GoPlay title' : 'DramaCool title' })
    setTransport(async url => {
      calls++
      const provider = new URL(String(url), location.origin).searchParams.get('source')
      const firstPass = calls <= 2
      return {
        ok: true,
        status: 200,
        json: async () => ({
          page: 1,
          results: firstPass
            ? provider === 'gp' ? [{ ...good('gp'), genres: 'Drama' }] : [good('gp')]
            : [good(provider)],
          hasMore: false,
        }),
      }
    })

    const first = await searchKDrama('drift')
    const second = await searchKDrama('drift')
    return {
      calls,
      first: { count: first.results.length, partial: first.partial, codes: first.errors.map(error => error.code) },
      second: { keys: second.results.map(item => item.key), partial: second.partial },
    }
  })

  expect(result).toEqual({
    calls: 4,
    first: { count: 0, partial: true, codes: ['provider_unavailable', 'invalid_results'] },
    second: { keys: ['gp:valid', 'dc:valid'], partial: false },
  })
})

test('rejects cancelled K-drama requests and recovers partial metadata paths', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { discoverKDrama, getKDramaEpisode, getKDramaEpisodes, getKDramaSeries } = await import('/src/lib/kdrama-api.js')
    const { setTransport } = await import('/src/lib/http.js')
    const key = `dc:contract-${Date.now()}`
    const id = 'episode_1'
    const series = { key, kind: 'kdrama', title: 'Contract' }
    const episodes = { key, episodes: [{ id, number: 1 }] }
    let seriesCalls = 0
    let episodeListCalls = 0
    let episodeCalls = 0
    setTransport((url, init) => {
      const value = String(url)
      if (value.includes('/discover?')) return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
      })
      if (value.includes('/series/')) {
        seriesCalls++
        return Promise.resolve({ ok: true, status: 200, json: async () => seriesCalls === 1 ? { ...series, partial: true } : series })
      }
      if (value.includes('/episodes?')) {
        episodeListCalls++
        return Promise.resolve({ ok: true, status: 200, json: async () => episodeListCalls === 1 ? { ...episodes, partial: true, errors: [{ provider: 'dc' }] } : episodes })
      }
      episodeCalls++
      return Promise.resolve({ ok: true, status: 200, json: async () => episodeCalls === 1 ? { key, episode: { id: 'wrong', number: 1 } } : { key, episode: episodes.episodes[0], available: true } })
    })

    const ctrl = new AbortController()
    const cancelled = discoverKDrama({ source: 'dc', signal: ctrl.signal }).then(() => 'resolved', error => error.name)
    ctrl.abort()
    const firstSeries = await getKDramaSeries(key).then(() => 'resolved', error => error.message)
    const secondSeries = await getKDramaSeries(key)
    const firstEpisodes = await getKDramaEpisodes(key)
    const secondEpisodes = await getKDramaEpisodes(key)
    const firstEpisode = await getKDramaEpisode(key, id).then(() => 'resolved', error => error.message)
    const secondEpisode = await getKDramaEpisode(key, id)
    return {
      cancelled: await cancelled,
      seriesCalls,
      episodeListCalls,
      episodeCalls,
      firstSeries,
      title: secondSeries.title,
      firstEpisodesPartial: firstEpisodes.partial,
      episodes: secondEpisodes.episodes.length,
      firstEpisode,
      available: secondEpisode.available,
    }
  })

  expect(result).toEqual({
    cancelled: 'AbortError',
    seriesCalls: 2,
    episodeListCalls: 2,
    episodeCalls: 2,
    firstSeries: 'K-drama unavailable',
    title: 'Contract',
    firstEpisodesPartial: true,
    episodes: 1,
    firstEpisode: 'Episode unavailable',
    available: true,
  })
})

test('browses both K-drama providers and opens a series without a player', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const item = (key, title) => ({ key, kind: 'kdrama', title, year: 2026, status: 'Ongoing', country: 'South Korea' })
  const goPlay = item('gp:signal', 'Signal')
  const dramaCool = { ...item('dc:shop', 'A Shop for Killers'), synopsis: 'A niece uncovers the truth.', genres: ['Action', 'Mystery'], episodeCount: 6 }

  await page.route('**/read/api/kdrama/**', route => {
    const url = new URL(route.request().url())
    const provider = url.searchParams.get('source')
    if (url.pathname.endsWith('/discover') || url.pathname.endsWith('/search')) return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ page: Number(url.searchParams.get('page')), results: [provider === 'gp' ? goPlay : dramaCool], hasMore: false }),
    })
    if (url.pathname.includes('/series/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(dramaCool) })
    if (url.pathname.endsWith('/episodes')) return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ key: dramaCool.key, episodes: [{ id: 'episode_2', number: 2 }, { id: 'episode_1', number: 1 }] }),
    })
    return route.abort()
  })

  await page.locator('[data-nav="kdrama"]').click()
  await expect(page.locator('#klist .kdrama-card')).toHaveCount(2)
  await expect(page.locator('#klist')).toContainText('GoPlay')
  await expect(page.locator('#klist')).toContainText('DramaCool')
  await page.locator('#klist .kdrama-card').filter({ hasText: 'A Shop for Killers' }).click()
  await expect(page.locator('#kinfo')).toContainText('A Shop for Killers')
  await expect(page.locator('#kinfo')).toContainText('DramaCool')
  await expect(page.locator('#kepisodes .kepisode')).toHaveCount(2)
  await expect(page.locator('#reader')).not.toHaveClass(/active/)
  await expect(page.locator('#mreader')).not.toHaveClass(/active/)
  await expect(page.locator('video')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('keeps the healthy provider visible and ignores a stale K-drama search', async ({ page }) => {
  let releaseSlow
  const slow = new Promise(resolve => { releaseSlow = resolve })
  await page.route('**/read/api/kdrama/**', async route => {
    const url = new URL(route.request().url())
    const provider = url.searchParams.get('source')
    const query = url.searchParams.get('q')
    if (provider === 'gp') return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { provider: 'gp', code: 'provider_blocked', message: 'GoPlay access token required', retryable: false } }),
    })
    if (query === 'slow') await slow
    const title = query || 'Healthy title'
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ page: 1, results: [{ key: `dc:${title.replaceAll(' ', '-')}`, kind: 'kdrama', title }], hasMore: false }),
    })
  })

  await page.locator('[data-nav="kdrama"]').click()
  await expect(page.locator('#klist')).toContainText('Healthy title')
  await expect(page.locator('#klist')).toContainText('GoPlay unavailable')
  await page.locator('#ksearch').fill('slow')
  await page.waitForRequest(request => request.url().includes('/kdrama/search?') && request.url().includes('q=slow'))
  await page.locator('#ksearch').fill('fast')
  await expect(page.locator('#klist')).toContainText('fast')
  releaseSlow()
  await page.waitForTimeout(100)
  await expect(page.locator('#klist')).toContainText('fast')
  await expect(page.locator('#klist')).not.toContainText('slow')
  expect(page._vellumErrors).not.toEqual([])
  expect(page._vellumErrors.every(error => error.includes('status of 503'))).toBe(true)
  page._vellumErrors.length = 0
})

test('preserves and retries the previous page when every provider fails at a pagination boundary', async ({ page }) => {
  let pageTwoDown = true
  await page.route('**/read/api/kdrama/**', route => {
    const url = new URL(route.request().url())
    const provider = url.searchParams.get('source')
    const pageNumber = Number(url.searchParams.get('page'))
    if (pageNumber === 2 && pageTwoDown) return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { provider, code: 'provider_blocked', message: 'provider unavailable', retryable: false } }),
    })
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        page: pageNumber,
        results: [{ key: `${provider}:page-${pageNumber}`, kind: 'kdrama', title: `${provider} page ${pageNumber}` }],
        hasMore: pageNumber === 1,
      }),
    })
  })

  await page.locator('[data-nav="kdrama"]').click()
  await expect(page.locator('#klist .kdrama-card')).toHaveCount(2)
  await page.locator('#kmore').click()
  await expect(page.locator('#kmore')).toHaveText('Try again')
  await expect(page.locator('#klist .kdrama-card')).toHaveCount(2)
  await expect(page.locator('#klist')).toContainText('GoPlay and DramaCool unavailable')

  pageTwoDown = false
  await page.locator('#kmore').click()
  await expect(page.locator('#klist .kdrama-card')).toHaveCount(4)
  await expect(page.locator('#klist')).toContainText('dc page 2')
  expect(page._vellumErrors).toHaveLength(2)
  expect(page._vellumErrors.every(error => error.includes('status of 503'))).toBe(true)
  page._vellumErrors.length = 0
})
