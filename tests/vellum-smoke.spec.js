import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

test.setTimeout(60_000)

test.beforeEach(async ({ page }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto(app)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  page._vellumErrors = errors
})

test.afterEach(async ({ page }) => {
  expect(page._vellumErrors).toEqual([])
})

test('walks the complete reading journey', async ({ page }) => {
  await expect(page.getByText('nothing in your library yet')).toBeVisible()

  await page.locator('[data-nav="discover"]').click()
  await expect(page.locator('#dlist .rrow').first()).toBeVisible()

  await page.locator('#dsearch').fill('Lord of the Mysteries')
  await expect(page.locator('#dlist .rrow').first()).toContainText('Lord of the Mysteries')
  await page.locator('#dlist .rrow').first().click()

  await expect(page.locator('#sinfo .dtitle')).toHaveText('Lord of the Mysteries')
  await expect(page.locator('#chlist .chrow').first()).toBeVisible()
  expect(await page.locator('#chlist .chrow').count()).toBeGreaterThan(1000)

  await page.locator('#followbtn').click()
  await expect(page.locator('#followbtn')).toHaveText('Following')
  await page.locator('#contbtn').click()

  await expect(page.locator('#reader .ch-block').first()).toBeVisible()
  await expect(page.locator('#reader-prose')).toContainText('Painful!')
  await expect(page.locator('#r-pos')).toContainText('1 / 1432')

  await page.locator('#r-list').click()
  await expect(page.locator('#drawer')).toHaveClass(/open/)
  await page.locator('#dw-q').fill('1432')
  await page.locator('#drawer-list .chap').click()
  await expect(page.locator('#r-title')).toContainText('1432')
  await expect(page.locator('#reader-prose')).toContainText('Parvi')

  await page.locator('#r-settings').click()
  await page.locator('[data-theme="sepia"]').click()
  await page.locator('[data-font="sans"]').click()
  await expect(page.locator('#reader')).toHaveAttribute('data-theme', 'sepia')
  await page.locator('#sheet-backdrop').click()

  await page.locator('#r-back').click()
  await expect(page.locator('#sinfo .dtitle')).toHaveText('Lord of the Mysteries')
  await page.locator('[data-nav="library"]').click()
  await expect(page.locator('#view-library')).toContainText('Lord of the Mysteries')
})

test('walks discover filters and empty updates', async ({ page }) => {
  await page.locator('[data-nav="discover"]').click()
  await expect(page.locator('#dlist .rrow').first()).toBeVisible()

  await page.locator('#ftoggle').click()
  await expect(page.locator('#fpanel')).toHaveClass(/open/)
  await page.locator('#toksearch').fill('Adventure')
  await expect(page.locator('#tokdrop .topt').first()).toBeVisible()
  await page.locator('#tokdrop .topt').first().click()
  await page.locator('#fapply').click()
  await expect(page.locator('#dlist .rrow').first()).toBeVisible()

  await page.locator('[data-nav="updates"]').click()
  await expect(page.locator('#ufeed')).toContainText('all caught up')
})

test('shows recoverable API failures', async ({ page }) => {
  let failures = 2
  await page.route('**/read/api/discover?**', async route => {
    if (failures > 0) {
      failures--
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporarily unavailable"}' })
    } else {
      await route.continue()
    }
  })

  await page.locator('[data-nav="discover"]').click()
  await expect(page.locator('#dlist')).toContainText('could not reach trending')
  page._vellumErrors.length = 0
  await page.locator('#ftoggle').click()
  await page.locator('#freset').click()
  await expect(page.locator('#dlist .rrow').first()).toBeVisible()
})

test('loads search, series, and reader at a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-nav="discover"]').click()
  await page.locator('#dsearch').fill('Mother of Learning')
  await expect(page.locator('#dlist .rrow').first()).toContainText('Mother of Learning')
  await page.locator('#dlist .rrow').first().click()
  await expect(page.locator('#sinfo .dtitle')).toContainText('Mother of Learning')
  await page.locator('#contbtn').click()
  await expect(page.locator('#reader .ch-block').first()).toBeVisible()

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})

test('walks the manga shelf and image reader at a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const key = 'mf:72no8'
  const chapters = [
    { id: '9349688', number: 2, title: 'Second ascent', language: 'en', sourceUrl: 'https://mangafire.to/title/72no8/chapter/9349688' },
    { id: '9349687', number: 1, title: 'First ascent', language: 'en', sourceUrl: 'https://mangafire.to/title/72no8/chapter/9349687' },
  ]
  const series = {
    key,
    kind: 'manga',
    format: 'manhua',
    title: 'The Privilege of the Second Life Is Power Leveling',
    cover: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="600" height="900"%3E%3Crect width="100%25" height="100%25" fill="%23171717"/%3E%3C/svg%3E',
    status: 'releasing',
    synopsis: 'A climber gets one more ascent.',
    authors: ['Studio Vellum'],
    genres: ['Action', 'Fantasy'],
    sourceUrl: 'https://mangafire.to/title/72no8',
  }

  await page.route('**/read/api/manga/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/discover') || url.pathname.endsWith('/search')) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ page: 1, results: [series], hasMore: false, partial: false, errors: [] }) })
      return
    }
    if (url.pathname.includes('/series/')) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(series) })
      return
    }
    if (url.pathname.endsWith('/chapters')) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ key, chapters, partial: false, errors: [] }) })
      return
    }
    if (url.pathname.endsWith('/chapter')) {
      const id = url.searchParams.get('id')
      const chapter = chapters.find(item => item.id === id)
      const mangaPages = [0, 1].map(index => ({ url: `/read/api/manga/image?key=mf%3A72no8&id=${id}&page=${index}`, width: 900, height: 1200 }))
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ key, chapter, pages: mangaPages }) })
      return
    }
    if (url.pathname.endsWith('/image')) {
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><rect width="100%" height="100%" fill="#171717"/></svg>' })
      return
    }
    await route.abort()
  })

  await page.locator('[data-nav="manga"]').click()
  await expect(page.locator('#mlist .manga-card').first()).toBeVisible()
  await expect(page.locator('#mlist .manga-card').first()).toHaveAttribute('href', '#/manga/series/mf%3A72no8')
  await expect(page.locator('#mformat button[aria-pressed="true"]')).toHaveText('All')
  await page.locator('#msearch').fill('second life')
  await expect(page.locator('#mlist .manga-card').first()).toContainText('Second Life')
  await page.locator('#mlist .manga-card').first().click()

  await expect(page.locator('#sinfo .dtitle')).toContainText('Second Life')
  await expect(page.locator('#mchapter-list .mchrow')).toHaveCount(2)
  await page.locator('#manga-follow').click()
  await expect(page.locator('#manga-follow')).toHaveText('Following')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('vellum:lib'))?.[0])).toMatchObject({
    slug: key, key, kind: 'manga', format: 'manhua', source: 'MangaFire', total: 2,
  })
  await page.reload()
  await expect(page.locator('#manga-follow')).toHaveText('Following')
  await expect(page.locator('#mchapter-list .mchrow')).toHaveCount(2)
  await page.locator('#manga-start').click()

  await expect(page.locator('#mreader')).toHaveClass(/active/)
  await expect(page.locator('#mr-pages .manga-page')).toHaveCount(2)
  await expect(page.locator('#mr-title')).toContainText('Ch. 1')
  await page.locator('#mr-list').click()
  await expect(page.locator('#mdrawer')).toHaveClass(/open/)
  await page.locator('#mdrawer-list .chap').filter({ hasText: 'Ch. 2' }).click()
  await expect(page.locator('#mr-title')).toContainText('Ch. 2')

  await page.locator('#mr-back').click()
  await expect(page.locator('#mchapter-list .mchrow.read')).toHaveCount(2)
  await expect(page.locator('#mchapter-list .mchrow.current')).toContainText('Ch. 2')
  await page.locator('[data-nav="library"]').click()
  await expect(page.locator('#continue .ctile')).toContainText('Manhua · MangaFire')
  await expect(page.locator('#continue .ctile')).toContainText('Ch. 2 · page 1 of 2')
  await page.locator('#continue .ctile').click()
  await expect(page.locator('#mr-title')).toContainText('Ch. 2')

  await page.locator('#mr-back').click()
  page.once('dialog', dialog => dialog.accept())
  await page.locator('#manga-reset').click()
  await expect(page.locator('#manga-start')).toHaveText('Start reading')
  await expect(page.locator('#mchapter-list .mchrow.read')).toHaveCount(0)
  expect(await page.evaluate(k => ({ read: localStorage.getItem(`vellum:read:${k}`), pos: localStorage.getItem(`vellum:pos:${k}`) }), key)).toEqual({ read: null, pos: null })
  await page.locator('#manga-follow').click()
  await expect(page.locator('#manga-follow')).toHaveText('Follow')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('vellum:lib')))).toEqual([])

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})

test('bounds a large manga chapter list without hiding searchable chapters', async ({ page }) => {
  const key = 'mf:large-series'
  const chapters = Array.from({ length: 1001 }, (_, index) => {
    const number = 1001 - index
    return { id: `chapter-${number}`, number, title: `Chapter ${number}`, language: 'en' }
  })
  await page.route('**/read/api/manga/series/**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ key, kind: 'manga', format: 'manga', title: 'A Thousand Chapters', cover: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="600" height="900"/%3E' }),
  }))
  await page.route('**/read/api/manga/chapters?**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ key, chapters, partial: false, errors: [] }),
  }))
  await page.route('**/read/api/manga/chapter?**', route => {
    const id = new URL(route.request().url()).searchParams.get('id')
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        key,
        chapter: chapters.find(chapter => chapter.id === id),
        pages: [{ url: `/read/api/manga/image?key=mf%3Alarge-series&id=${id}&page=0`, width: 900, height: 1200 }],
      }),
    })
  })

  await page.goto(`${app}#/manga/series/mf%3Alarge-series`)
  await expect(page.locator('#mchapter-list .mchrow')).toHaveCount(250)
  await expect(page.locator('#mchapter-more')).toContainText('250 of 1001')
  await page.locator('#mchapter-more').click()
  await expect(page.locator('#mchapter-list .mchrow')).toHaveCount(500)
  await page.locator('#mchsearch').fill('Chapter 777')
  await expect(page.locator('#mchapter-list .mchrow')).toHaveCount(1)
  await expect(page.locator('#mchapter-list .mchrow')).toContainText('Ch. 777')
})

test('restores manga pages, windows image memory, and separates page and chapter keys', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const key = 'mf:long-reader'
  const chapters = [1, 2, 3].map(number => ({ id: `chapter-${number}`, number, title: `Chapter ${number}`, language: 'en' }))
  await page.route('**/read/api/manga/series/**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ key, kind: 'manga', format: 'manhwa', title: 'Long Reader' }),
  }))
  await page.route('**/read/api/manga/chapters?**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ key, chapters, partial: false, errors: [] }),
  }))
  await page.route('**/read/api/manga/chapter?**', route => {
    const id = new URL(route.request().url()).searchParams.get('id')
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        key,
        chapter: chapters.find(chapter => chapter.id === id),
        pages: Array.from({ length: 30 }, (_, index) => ({
          url: `/read/api/manga/image?key=mf%3Along-reader&id=${id}&page=${index}`,
          width: 900,
          height: 1200,
        })),
      }),
    })
  })
  await page.route('**/read/api/manga/image?**', route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><rect width="100%" height="100%" fill="#171717"/></svg>',
  }))
  await page.evaluate(key => localStorage.setItem(`vellum:pos:${key}`, JSON.stringify({ id: 'chapter-2', page: 15, at: Date.now() })), key)

  await page.goto(`${app}#/manga/read/mf%3Along-reader/chapter-2`)
  await expect(page.locator('#mreader')).toHaveAttribute('data-state', 'ready')
  await expect(page.locator('#mr-pos')).toHaveText('Page 16 / 30')
  await expect(page.locator('#mr-pages .manga-page')).toHaveCount(30)
  await expect(page.locator('#mr-pages .manga-page[data-page="15"]')).toBeInViewport()
  await expect.poll(() => page.locator('#mr-pages img[src]').count()).toBeLessThanOrEqual(14)

  await page.keyboard.press('ArrowRight')
  await expect(page.locator('#mr-pos')).toHaveText('Page 17 / 30')
  await expect(page).toHaveURL(/chapter-2$/)
  await page.keyboard.press('Shift+ArrowRight')
  await expect(page).toHaveURL(/chapter-3$/)
  await expect(page.locator('#mr-pos')).toHaveText('Page 1 / 30')

  await page.locator('#mr-list').click()
  await expect(page.locator('#mdw-q')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('#mr-list')).toBeFocused()

  const diagnostics = await page.evaluate(() => ({
    metadataMs: performance.getEntriesByName('vellum:manga-reader:metadata').at(-1)?.duration,
    firstImageMs: performance.getEntriesByName('vellum:manga-reader:first-image').at(-1)?.duration,
    chromeTransition: getComputedStyle(document.querySelector('.mreader-chrome')).transitionDuration,
    saved: JSON.parse(localStorage.getItem('vellum:pos:mf:long-reader')),
  }))
  expect(diagnostics.metadataMs).toBeGreaterThanOrEqual(0)
  expect(diagnostics.firstImageMs).toBeGreaterThanOrEqual(0)
  expect(diagnostics.chromeTransition).toBe('0s')
  expect(diagnostics.saved).toMatchObject({ id: 'chapter-3', page: 0 })

  await page.locator('#mr-back').click()
  await expect(page.locator('#manga-start')).toContainText('Continue · Ch. 3')
  await expect(page.locator('#mr-pages img')).toHaveCount(0)
})

test('labels an unreachable manga chapter as offline and offers retry', async ({ page }) => {
  await page.evaluate(() => import('/src/screens/manga-reader.js'))
  await page.route('**/read/api/manga/**', route => route.abort('internetdisconnected'))
  await page.context().setOffline(true)

  await page.evaluate(() => { location.hash = '#/manga/read/mf%3Aoffline/chapter-1' })
  await expect(page.locator('#mreader')).toHaveAttribute('data-state', 'offline')
  await expect(page.locator('#mr-pages')).toContainText('You’re offline')
  await expect(page.locator('#mr-retry')).toBeVisible()
  page._vellumErrors.length = 0
})

test('offers recovery when the lazy manga reader module fails to load', async ({ page }) => {
  await page.route('**/src/screens/manga-reader.js', route => route.abort('failed'))
  await page.goto(`${app}#/manga/read/mf%3Achunk-failure/chapter-1`)
  await expect(page.locator('#mreader')).toHaveAttribute('data-state', 'error')
  await expect(page.locator('#mr-pages')).toContainText('Couldn’t open the manga reader')
  await expect(page.locator('#manga-reader-load-retry')).toBeVisible()
  await expect(page.locator('#mr-list')).toBeHidden()
  page._vellumErrors.length = 0
})

test('surfaces manga updates by opaque chapter id and opens the updated chapter', async ({ page }) => {
  const key = 'mh:Series_CASE.9'
  const oldId = 'Chapter_OLD.1'
  const newId = 'Chapter_NEW.2'
  const chapters = [
    { id: newId, number: 2, title: 'New signal', language: 'en' },
    { id: oldId, number: 1, title: 'Baseline', language: 'en' },
  ]
  const series = { key, kind: 'manga', format: 'manhwa', title: 'Opaque Signals', authors: ['Han Mira'] }

  await page.route('**/read/api/manga/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.includes('/series/')) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(series) })
      return
    }
    if (url.pathname.endsWith('/chapters')) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ key, chapters, partial: false, errors: [] }) })
      return
    }
    if (url.pathname.endsWith('/chapter')) {
      const id = url.searchParams.get('id')
      const chapter = chapters.find(item => item.id === id)
      const imageKey = encodeURIComponent(key)
      const imageId = encodeURIComponent(id)
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ key, chapter, pages: [{ url: `/read/api/manga/image?key=${imageKey}&id=${imageId}&page=0`, width: 900, height: 1200 }] }),
      })
      return
    }
    if (url.pathname.endsWith('/image')) {
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"/>' })
      return
    }
    await route.abort()
  })

  await page.evaluate(({ key, oldId }) => {
    localStorage.setItem('vellum:lib', JSON.stringify([{
      slug: key, key, kind: 'manga', title: 'Opaque Signals', format: 'manhwa', source: 'MangaHub', total: 1, chapterIds: [oldId], updatedAt: Date.now(),
    }]))
    localStorage.setItem('vellum:updates', JSON.stringify({
      [key]: { firstSeen: Date.now(), read: true, seenIds: [oldId], newChapters: [], latest: 1, latestIds: [oldId] },
    }))
  }, { key, oldId })

  await page.locator('[data-nav="updates"]').click()
  const update = page.locator('#ufeed .urow')
  await expect(update).toContainText('Opaque Signals')
  await expect(update).toContainText('Manhwa · MangaHub')
  await expect(update.locator('.uchip')).toHaveAttribute('data-id', newId)
  await expect(page.locator('#count-updates')).toHaveText('1')

  await update.locator('.umark').click()
  await expect(page.locator('#count-updates')).toHaveText('')
  await expect.poll(() => page.evaluate(k => JSON.parse(localStorage.getItem('vellum:updates'))[k].seenIds, key)).toEqual([newId, oldId])
  await update.locator('.uchip').click()
  await expect(page.locator('#mr-title')).toContainText('Ch. 2')
  expect(await page.evaluate(() => decodeURIComponent(location.hash))).toBe(`#/manga/read/${key}/${newId}`)
  await expect.poll(() => page.evaluate(k => JSON.parse(localStorage.getItem('vellum:lib'))[0].lastId, key)).toBe(newId)
})

test('walks MangaHub chapter boundaries and recovers a failed image', async ({ page }) => {
  const key = 'mh:stone'
  const chapters = [
    { id: 'chapter-2', number: 2, title: 'The next page' },
    { id: 'chapter-1', number: 1, title: 'The first page' },
  ]
  const series = { key, kind: 'manga', format: 'manga', title: 'Stone', cover: null }
  let firstImage = true

  await page.route('**/read/api/manga/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.includes('/series/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(series) })
    if (url.pathname.endsWith('/chapters')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ key, chapters }) })
    if (url.pathname.endsWith('/chapter')) {
      const id = url.searchParams.get('id')
      const chapter = chapters.find(item => item.id === id)
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        key,
        chapter,
        pages: [{ url: `/read/api/manga/image?key=mh%3Astone&id=${id}&page=0` }],
      }) })
    }
    if (url.pathname.endsWith('/image')) {
      if (firstImage) {
        firstImage = false
        return route.abort('failed')
      }
      return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><rect width="100%" height="100%" fill="#171717"/></svg>' })
    }
    return route.abort()
  })

  await page.goto(`${app}#/manga/series/${encodeURIComponent(key)}`)
  await expect(page.locator('#sinfo')).toContainText('MangaHub')
  await page.locator('#manga-start').click()
  await expect(page.locator('#mr-title')).toContainText('Ch. 1')
  await expect(page.locator('#mr-pages .manga-page')).toHaveClass(/failed/)
  page._vellumErrors.length = 0
  await page.locator('[data-page-retry="0"]').click()
  await expect.poll(() => page.locator('#mr-pages img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0)
  await expect(page.locator('#mr-step a')).toHaveCount(1)
  await expect(page.locator('#mr-step')).toContainText('Next')
  await page.locator('#mr-step a').click()
  await expect(page.locator('#mr-title')).toContainText('Ch. 2')
  await expect(page.locator('#mr-step a')).toHaveCount(1)
  await expect(page.locator('#mr-step')).toContainText('Previous')
})

test('keeps manga pagination alive across filtered and duplicate provider rows', async ({ page }) => {
  await page.route('**/read/api/manga/discover?**', route => {
    const url = new URL(route.request().url())
    const source = url.searchParams.get('source')
    const requestedPage = Number(url.searchParams.get('page'))
    const item = (key, title) => ({ key, kind: 'manga', format: 'manga', title })
    let results = [item('mf:initial', 'Initial')]
    let hasMore = false
    if (source === 'mf' && requestedPage === 1) {
      results = [item('mf:one', 'One'), item('mh:leak', 'Wrong provider')]
      hasMore = true
    } else if (source === 'mf' && requestedPage === 2) {
      results = [item('mf:one', 'One')]
      hasMore = true
    } else if (source === 'mf' && requestedPage === 3) {
      results = [item('mf:two', 'Two')]
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ page: requestedPage, results, hasMore }) })
  })

  await page.locator('[data-nav="manga"]').click()
  await expect(page.locator('#mlist')).toContainText('Initial')
  await page.locator('#msource [data-source="mf"]').click()
  await expect(page.locator('#mlist')).toContainText('One')
  await expect(page.locator('#mlist')).not.toContainText('Wrong provider')
  await expect(page.locator('#mlist')).toContainText('unexpected results were ignored')
  await page.locator('#mmore').click()
  await expect(page.locator('#mmore')).toBeVisible()
  await page.locator('#mmore').click()
  await expect(page.locator('#mlist')).toContainText('Two')
  await expect(page.locator('#mlist .manga-card')).toHaveCount(2)
  await expect(page.locator('#mmore')).toBeHidden()
})

test('ignores a stale manga search and names a selected provider outage', async ({ page }) => {
  let releaseSlow
  const slow = new Promise(resolve => { releaseSlow = resolve })
  await page.route('**/read/api/manga/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/discover') && url.searchParams.get('source') === 'mh') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        page: 1,
        results: [],
        hasMore: false,
        partial: true,
        errors: [{ provider: 'mh', code: 'provider_unavailable' }],
      }) })
    }
    if (url.pathname.endsWith('/search')) {
      const query = url.searchParams.get('q')
      if (query === 'slow') await slow
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        page: 1,
        results: [{ key: `mf:${query}`, kind: 'manga', format: 'manga', title: query }],
        hasMore: false,
      }) })
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ page: 1, results: [], hasMore: false }) })
  })

  await page.locator('[data-nav="manga"]').click()
  await page.locator('#msearch').fill('slow')
  await page.waitForRequest(request => request.url().includes('/manga/search?') && request.url().includes('q=slow'))
  await page.locator('#msearch').fill('fast')
  await expect(page.locator('#mlist')).toContainText('fast')
  releaseSlow()
  await page.waitForTimeout(100)
  await expect(page.locator('#mlist')).toContainText('fast')
  await expect(page.locator('#mlist')).not.toContainText('slow')

  await page.locator('#msearch').fill('')
  await page.locator('#msource [data-source="mh"]').click()
  await expect(page.locator('#mlist')).toContainText('MangaHub is unavailable right now')
})

test('does not duplicate a chapter after rapid reader navigation', async ({ page }) => {
  let releaseFirst = () => {}
  let releaseSecond
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  const secondGate = new Promise(resolve => { releaseSecond = resolve })

  await page.route('**/read/api/chapter?**', async route => {
    const n = new URL(route.request().url()).searchParams.get('n')
    if (n === '1') await firstGate
    if (n === '2') await secondGate
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ title: `Chapter ${n}`, html: `<p>body ${n}</p>` }),
    })
  })

  const firstRequest = page.waitForRequest(request => request.url().includes('/chapter?') && request.url().includes('n=1'))
  await page.goto(`${app}#/read/lord-of-the-mysteries/1`)
  await firstRequest

  const secondRequest = page.waitForRequest(request => request.url().includes('/chapter?') && request.url().includes('n=2'))
  await page.evaluate(() => { location.hash = '#/read/lord-of-the-mysteries/2' })
  await secondRequest
  releaseFirst()
  await page.waitForTimeout(100)
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')))
  releaseSecond()

  await expect(page.locator('#reader-prose')).toContainText('body 2')
  await expect(page.locator('.ch-block[data-idx="1"]')).toHaveCount(1)
})

test('keeps loading when an older tab blocks the cache upgrade', async ({ page, context }) => {
  const holder = await context.newPage()
  await holder.goto(app)
  await holder.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const del = indexedDB.deleteDatabase('vellum')
      del.onsuccess = resolve
      del.onerror = () => reject(del.error)
    })
    window._heldVellumDb = await new Promise((resolve, reject) => {
      const open = indexedDB.open('vellum', 1)
      open.onupgradeneeded = () => open.result.createObjectStore('cache')
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
  })

  await page.locator('[data-nav="discover"]').click()
  await expect(page.locator('#dlist .rrow').first()).toBeVisible()
  await holder.evaluate(() => window._heldVellumDb.close())
})

test('falls back to the network when IndexedDB is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      value: { open: () => { throw new DOMException('storage disabled', 'SecurityError') } },
    })
  })
  await page.route('**/read/api/discover?**', route => route.fulfill({
    contentType: 'application/json',
    body: '{"results":[{"key":"nf:network-only","title":"Network Only","sources":["novelfire"],"readable":true}]}',
  }))
  await page.route('**/read/api/series/**', route => route.fulfill({
    contentType: 'application/json',
    body: '{"title":"Network Only"}',
  }))

  await page.reload()
  await page.locator('[data-nav="discover"]').click()
  await expect(page.locator('#dlist')).toContainText('Network Only')
})

test('does not resolve an HTTP request aborted during JSON parsing', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { apiGet, setTransport } = await import('/src/lib/http.js')
    setTransport(async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(resolve => setTimeout(() => resolve({ stale: true }), 80)),
    }))
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 10)
    try {
      await apiGet('/abort-during-json', { signal: ctrl.signal })
      return 'resolved'
    } catch (error) {
      return error.name
    }
  })

  expect(result).toBe('AbortError')
})

test('an older cache producer cannot overwrite a newer reader request', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { cached } = await import('/src/lib/cache.js')
    const key = `producer-race-${Date.now()}`
    let releaseOld
    const oldGate = new Promise(resolve => { releaseOld = resolve })
    const old = cached(key, 60_000, async () => {
      await oldGate
      return { body: 'stale' }
    })

    const closing = new AbortController()
    const joined = cached(key, 60_000, () => new Promise((_, reject) => {
      const rejectAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      if (closing.signal.aborted) { rejectAbort(); return }
      closing.signal.addEventListener('abort', rejectAbort, { once: true })
    }), { signal: closing.signal })
    const joinedResult = joined.catch(error => error.name)
    closing.abort()

    const reopened = new AbortController()
    const fresh = await cached(key, 60_000, async () => ({ body: 'fresh' }), { signal: reopened.signal })
    releaseOld()
    await old
    await joinedResult
    const final = await cached(key, 60_000, async () => ({ body: 'unexpected-loader' }))
    return { fresh: fresh.body, final: final.body }
  })

  expect(result).toEqual({ fresh: 'fresh', final: 'fresh' })
})

test('an older stale-while-revalidate writer cannot overwrite a newer foreground result', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { cached } = await import('/src/lib/cache.js')
    const key = `swr-race-${Date.now()}`
    await cached(key, 1, async () => 'seed')
    await new Promise(resolve => setTimeout(resolve, 30))

    let releaseBackground
    let markBackgroundStarted
    const backgroundGate = new Promise(resolve => { releaseBackground = resolve })
    const backgroundStarted = new Promise(resolve => { markBackgroundStarted = resolve })
    const stale = await cached(key, 60_000, async () => {
      markBackgroundStarted()
      await backgroundGate
      return 'background-old'
    })
    await backgroundStarted

    const fresh = await cached(key, 60_000, async () => 'fresh', { swr: false })
    releaseBackground()
    await new Promise(resolve => setTimeout(resolve, 0))
    const final = await cached(key, 60_000, async () => 'unexpected-loader')
    return { stale, fresh, final }
  })

  expect(result).toEqual({ stale: 'seed', fresh: 'fresh', final: 'fresh' })
})

test('a second stale caller keeps the active background refresh alive', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { cached } = await import('/src/lib/cache.js')
    const key = `swr-join-${Date.now()}`
    await cached(key, 1, async () => 'seed')
    await new Promise(resolve => setTimeout(resolve, 30))

    let releaseBackground
    let markBackgroundStarted
    const backgroundGate = new Promise(resolve => { releaseBackground = resolve })
    const backgroundStarted = new Promise(resolve => { markBackgroundStarted = resolve })
    const loader = async () => {
      markBackgroundStarted()
      await backgroundGate
      return 'background-new'
    }
    const firstStale = await cached(key, 60_000, loader)
    await backgroundStarted
    const secondStale = await cached(key, 60_000, async () => 'unexpected-second-loader')
    releaseBackground()
    await new Promise(resolve => setTimeout(resolve, 10))
    const final = await cached(key, 60_000, async () => 'unexpected-final-loader')
    return { firstStale, secondStale, final }
  })

  expect(result).toEqual({ firstStale: 'seed', secondStale: 'seed', final: 'background-new' })
})

test('a pre-aborted cache caller rejects even when the value is hot', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { cached } = await import('/src/lib/cache.js')
    const key = `hot-abort-${Date.now()}`
    await cached(key, 60_000, async () => ({ ok: true }))
    const ctrl = new AbortController()
    ctrl.abort()
    try {
      await cached(key, 60_000, async () => ({ unexpected: true }), { signal: ctrl.signal })
      return 'resolved'
    } catch (error) {
      return error.name
    }
  })

  expect(result).toBe('AbortError')
})

test('validates manga identities and never accepts an empty image chapter', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const {
      mangaKey,
      parseMangaKey,
      mangaPageUrl,
      validMangaSeries,
      validMangaChapters,
      validMangaChapter,
    } = await import('/src/lib/manga-api.js')

    const key = mangaKey('MF', '72NO8')
    const series = { key, kind: 'manga', format: 'manhua', title: 'Second Life' }
    const chapters = {
      key,
      chapters: [
        { id: '9349687', number: 72, title: 'Hidden Way' },
        { id: '9339335', number: 71, title: 'Illusioned Crossing' },
      ],
    }
    const chapter = {
      key,
      chapter: { id: '9349687', number: 72, title: 'Hidden Way' },
      pages: [{ url: '/read/api/manga/image?key=mf%3A72NO8&id=9349687&page=0', width: 940, height: 956 }],
    }

    return {
      key,
      parsed: parseMangaKey(key),
      series: validMangaSeries(series, key),
      otherSeries: validMangaSeries({ ...series, format: 'other' }, key),
      wrongSeries: validMangaSeries({ ...series, key: 'mh:other' }, key),
      chapters: validMangaChapters(chapters, key),
      wrongChapters: validMangaChapters({ ...chapters, key: 'mh:other' }, key),
      opaqueChapter: validMangaChapters({ key, chapters: [{ id: 'chapter-special', number: null }] }, key),
      badNumber: validMangaChapters({ key, chapters: [{ id: 'chapter-special', number: 'unknown' }] }, key),
      duplicateChapters: validMangaChapters({ ...chapters, chapters: [chapters.chapters[0], chapters.chapters[0]] }),
      chapter: validMangaChapter(chapter, key, '9349687'),
      directPage: validMangaChapter({ ...chapter, pages: [{ url: 'https://o48.mfcdn2.xyz/page.jpg' }] }, key, '9349687'),
      wrongPage: validMangaChapter({ ...chapter, pages: [{ url: '/read/api/manga/image?key=mf%3A72NO8&id=9349687&page=1' }] }, key, '9349687'),
      badDimensions: validMangaChapter({ ...chapter, pages: [{ ...chapter.pages[0], width: '940' }] }, key, '9349687'),
      pageUrl: mangaPageUrl(chapter.pages[0]),
      emptyChapter: validMangaChapter({ ...chapter, pages: [] }, key, '9349687'),
      wrongChapter: validMangaChapter(chapter, key, '9339335'),
    }
  })

  expect(result).toEqual({
    key: 'mf:72NO8',
    parsed: { provider: 'mf', id: '72NO8' },
    series: true,
    otherSeries: false,
    wrongSeries: false,
    chapters: true,
    wrongChapters: false,
    opaqueChapter: true,
    badNumber: false,
    duplicateChapters: false,
    chapter: true,
    directPage: false,
    wrongPage: false,
    badDimensions: false,
    pageUrl: '/read/api/manga/image?key=mf%3A72NO8&id=9349687&page=0',
    emptyChapter: false,
    wrongChapter: false,
  })
})

test('validates manga response boundaries and orders both provider chapter ids', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { orderMangaChapters, searchManga, validMangaSeries } = await import('/src/lib/manga-api.js')
    const { setTransport } = await import('/src/lib/http.js')
    let calls = 0
    setTransport(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        calls++
        if (calls === 1) return { page: 1, results: [], hasMore: false }
        return {
          page: 2,
          results: [
            { key: 'mf:kept', kind: 'manga', format: 'manga', title: 'Kept' },
            { key: 'mh:dropped', kind: 'manga', format: 'manga', title: 'Dropped' },
          ],
          hasMore: true,
        }
      },
    }))

    const nonce = Date.now()
    const mismatch = await searchManga(`page-${nonce}`, { source: 'mf', page: 2 }).then(() => 'resolved', error => error.message)
    const filtered = await searchManga(`page-${nonce}`, { source: 'mf', page: 2 })
    return {
      calls,
      mismatch,
      keys: filtered.results.map(item => item.key),
      partial: filtered.partial,
      badGenres: validMangaSeries({ key: 'mh:bad', kind: 'manga', format: 'manga', title: 'Bad', genres: {} }),
      mangaFire: orderMangaChapters([{ id: '20', number: 2 }, { id: '10', number: 1 }]).map(item => item.id),
      mangaHub: orderMangaChapters([{ id: 'chapter-special', number: null }, { id: 'chapter-2', number: 2 }, { id: 'chapter-1', number: 1 }]).map(item => item.id),
    }
  })

  expect(result).toEqual({
    calls: 2,
    mismatch: 'manga search unavailable',
    keys: ['mf:kept'],
    partial: true,
    badGenres: false,
    mangaFire: ['10', '20'],
    mangaHub: ['chapter-1', 'chapter-2', 'chapter-special'],
  })
})

test('accepts a multi-row manga catalogue without treating row indexes as expected keys', async ({ page }) => {
  await page.route('**/read/api/manga/search?**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      results: [
        { key: 'mf:one', kind: 'manga', format: 'manga', title: 'One' },
        { key: 'mh:two', kind: 'manga', format: 'manhwa', title: 'Two' },
      ],
      hasMore: false,
      partial: false,
      errors: [],
    }),
  }))
  const count = await page.evaluate(async () => {
    const { searchManga } = await import('/src/lib/manga-api.js')
    return (await searchManga('multi-row-regression')).results.length
  })
  expect(count).toBe(2)
})

test('does not cache an empty manga source response', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { searchManga } = await import('/src/lib/manga-api.js')
    const { setTransport } = await import('/src/lib/http.js')
    let calls = 0
    setTransport(async () => ({
      ok: true,
      status: 200,
      json: async () => ++calls === 1
        ? ({ results: [], hasMore: false })
        : ({ results: [{ key: 'mf:72no8', kind: 'manga', format: 'manhua', title: 'Second Life' }], hasMore: false }),
    }))
    const query = `recovery-${Date.now()}`
    const first = await searchManga(query)
    const second = await searchManga(query)
    return { calls, first: first.results.length, second: second.results.length }
  })

  expect(result).toEqual({ calls: 2, first: 0, second: 1 })
})

test('does not cache incomplete manga results or chapter lists', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { searchManga, getMangaChapters } = await import('/src/lib/manga-api.js')
    const { setTransport } = await import('/src/lib/http.js')
    const nonce = Date.now()
    const key = `mh:cache-${nonce}`
    let searchCalls = 0
    let chapterCalls = 0

    setTransport(async url => {
      const isChapters = String(url).includes('/read/api/manga/chapters?')
      if (isChapters) chapterCalls++
      else searchCalls++
      return {
        ok: true,
        status: 200,
        json: async () => isChapters
          ? chapterCalls === 1
            ? ({ key, chapters: [{ id: 'chapter-special', number: null }], partial: true, errors: [{ provider: 'mh' }] })
            : ({ key, chapters: [{ id: 'chapter-special', number: null }, { id: 'chapter-2', number: 2 }] })
          : searchCalls === 1
            ? ({ results: [{ key, kind: 'manga', format: 'manhwa', title: 'Partial' }], hasMore: false, partial: true, errors: [{ provider: 'mf' }] })
            : ({ results: [{ key, kind: 'manga', format: 'manhwa', title: 'Recovered' }], hasMore: false }),
      }
    })

    const query = `partial-${nonce}`
    const firstSearch = await searchManga(query)
    const secondSearch = await searchManga(query)
    const firstChapters = await getMangaChapters(key).then(() => 'resolved', error => error.message)
    const secondChapters = await getMangaChapters(key)
    return {
      searchCalls,
      chapterCalls,
      firstSearch: firstSearch.results[0].title,
      secondSearch: secondSearch.results[0].title,
      firstChapters,
      secondChapters: secondChapters.chapters.length,
    }
  })

  expect(result).toEqual({
    searchCalls: 2,
    chapterCalls: 2,
    firstSearch: 'Partial',
    secondSearch: 'Recovered',
    firstChapters: 'chapter list unavailable',
    secondChapters: 2,
  })
})

test('does not cache partial manga metadata or image chapters', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { getMangaChapter, getMangaSeries } = await import('/src/lib/manga-api.js')
    const { setTransport } = await import('/src/lib/http.js')
    const key = `mh:partial-${Date.now()}`
    const id = 'chapter-1'
    const series = { key, kind: 'manga', format: 'manhwa', title: 'Recovered' }
    const chapter = {
      key,
      chapter: { id, number: 1 },
      pages: [{ url: `/read/api/manga/image?key=${encodeURIComponent(key)}&id=${id}&page=0` }],
    }
    let seriesCalls = 0
    let chapterCalls = 0
    setTransport(async url => {
      const isChapter = String(url).includes('/manga/chapter?')
      const call = isChapter ? ++chapterCalls : ++seriesCalls
      const value = isChapter ? chapter : series
      return {
        ok: true,
        status: 200,
        json: async () => call === 1 ? { ...value, partial: true, errors: [{ provider: 'mh' }] } : value,
      }
    })

    const firstSeries = await getMangaSeries(key).then(() => 'resolved', error => error.message)
    const secondSeries = await getMangaSeries(key)
    const firstChapter = await getMangaChapter(key, id).then(() => 'resolved', error => error.message)
    const secondChapter = await getMangaChapter(key, id)
    return { seriesCalls, chapterCalls, firstSeries, seriesTitle: secondSeries.title, firstChapter, pages: secondChapter.pages.length }
  })

  expect(result).toEqual({
    seriesCalls: 2,
    chapterCalls: 2,
    firstSeries: 'manga unavailable',
    seriesTitle: 'Recovered',
    firstChapter: 'chapter unavailable',
    pages: 1,
  })
})

test('preserves structured provider errors without retrying blocked requests', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { apiGet, setTransport } = await import('/src/lib/http.js')
    let calls = 0
    setTransport(async () => {
      calls++
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: {
          code: 'provider_blocked',
          message: 'MangaHub is checking the session',
          provider: 'mh',
          retryable: true,
          retryAfterMs: 2000,
        } }),
      }
    })
    try {
      await apiGet('/read/api/manga/search?q=blocked')
      return { resolved: true, calls }
    } catch (error) {
      return {
        calls,
        message: error.message,
        code: error.code,
        provider: error.provider,
        retryable: error.retryable,
        retryAfterMs: error.retryAfterMs,
      }
    }
  })

  expect(result).toEqual({
    calls: 1,
    message: 'MangaHub is checking the session',
    code: 'provider_blocked',
    provider: 'mh',
    retryable: true,
    retryAfterMs: 2000,
  })
})

test('does not call a failed updates check all caught up', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('vellum:lib', JSON.stringify([{
      slug: 'offline-series',
      title: 'Offline Series',
      total: 10,
      updatedAt: Date.now(),
    }]))
  })
  await page.route('**/read/api/chapters?slug=offline-series', route => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: '{"error":"offline"}',
  }))

  await page.locator('[data-nav="updates"]').click()
  await expect(page.locator('#ufeed')).toContainText('couldn’t check for updates')
  await expect(page.locator('#ufeed')).not.toContainText('all caught up')
  page._vellumErrors.length = 0
})

test('sorts trending without applying staged filters', async ({ page }) => {
  await page.locator('[data-nav="discover"]').click()
  await expect(page.locator('#dlist .rrow').first()).toBeVisible()
  await page.locator('#ftoggle').click()
  await page.locator('[data-filter="status"] [data-v="ongoing"]').click()

  const sortedRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname.endsWith('/read/api/discover') && url.searchParams.get('sort') === 'rating'
  })
  await page.locator('#dsort [data-sort="rating"]').click()
  const sortedUrl = new URL((await sortedRequest).url())
  expect(sortedUrl.searchParams.has('status')).toBe(false)

  const filteredRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname.endsWith('/read/api/discover') && url.searchParams.get('status') === 'ongoing'
  })
  await page.locator('#fapply').click()
  await filteredRequest
})

test('returns a directly opened series to Library', async ({ page }) => {
  await page.goto(`${app}#/series/nf%3Alord-of-the-mysteries`)
  await expect(page.locator('#sinfo .dtitle')).toHaveText('Lord of the Mysteries')
  await page.locator('.crumb .back').click()
  await expect(page).toHaveURL(/#\/$/)
  await expect(page.locator('#view-library')).toBeVisible()
})

test('does not turn an unknown chapter total into a zero update baseline', async ({ page }) => {
  let releaseChapters
  const chapterGate = new Promise(resolve => { releaseChapters = resolve })
  await page.route('**/read/api/series/nf%3Anull-total', route => route.fulfill({
    contentType: 'application/json',
    body: '{"key":"nf:null-total","nfSlug":"null-total","title":"Null Total","totalChapters":null}',
  }))
  await page.route('**/read/api/chapters?slug=null-total', async route => {
    await chapterGate
    await route.fulfill({
      contentType: 'application/json',
      body: '{"chapters":[{"n":1,"t":"One"}]}',
    })
  })

  await page.goto(`${app}#/series/nf%3Anull-total`)
  await expect(page.locator('#sinfo .dtitle')).toHaveText('Null Total')
  await expect(page.locator('#chstat')).toHaveText('…')
  await page.locator('#followbtn').click()
  const followed = await page.evaluate(() => JSON.parse(localStorage.getItem('vellum:lib'))[0])
  expect(followed.total).toBeUndefined()
  releaseChapters()
  await expect(page.locator('#chstat')).toHaveText('1')
})

test('retries a failed reader chapter list', async ({ page }) => {
  let listRequests = 0
  await page.route('**/read/api/chapters?slug=retry-series', route => {
    listRequests++
    if (listRequests <= 2) return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":"offline"}',
    })
    return route.fulfill({
      contentType: 'application/json',
      body: '{"chapters":[{"n":1,"t":"One"}]}',
    })
  })
  await page.route('**/read/api/chapter?slug=retry-series&n=1', route => route.fulfill({
    contentType: 'application/json',
    body: '{"title":"One","html":"<p>loaded after retry</p>"}',
  }))
  await page.route('**/read/api/series/nf%3Aretry-series', route => route.fulfill({
    contentType: 'application/json',
    body: '{"key":"nf:retry-series","nfSlug":"retry-series","title":"Retry Series"}',
  }))

  await page.goto(`${app}#/read/retry-series/1`)
  await expect(page.locator('#reader-list-retry')).toBeVisible()
  page._vellumErrors.length = 0
  await page.locator('#reader-list-retry').click()
  await expect(page.locator('#reader-prose')).toContainText('loaded after retry')
})

test('offers recovery when the lazy reader module fails to load', async ({ page }) => {
  let failChunk = true
  await page.route('**/src/screens/reader.js', route => failChunk ? route.abort('failed') : route.continue())
  await page.route('**/read/api/chapters?slug=chunk-retry', route => route.fulfill({
    contentType: 'application/json',
    body: '{"chapters":[{"n":1,"t":"One"}]}',
  }))
  await page.route('**/read/api/chapter?slug=chunk-retry&n=1', route => route.fulfill({
    contentType: 'application/json',
    body: '{"title":"One","html":"<p>reader recovered</p>"}',
  }))
  await page.route('**/read/api/series/nf%3Achunk-retry', route => route.fulfill({
    contentType: 'application/json',
    body: '{"key":"nf:chunk-retry","nfSlug":"chunk-retry","title":"Chunk Retry"}',
  }))

  await page.goto(`${app}#/read/chunk-retry/1`)
  await expect(page.locator('#reader-load-retry')).toBeVisible()
  page._vellumErrors.length = 0
  failChunk = false
  await page.locator('#reader-load-retry').click()
  await expect(page.locator('#reader-prose')).toContainText('reader recovered')
})

test('closes a failed reader overlay when browser navigation leaves the route', async ({ page }) => {
  await page.route('**/src/screens/reader.js', route => route.abort('failed'))
  await page.goto(`${app}#/read/chunk-back/1`)
  await expect(page.locator('#reader-load-retry')).toBeVisible()
  page._vellumErrors.length = 0

  await page.evaluate(() => { location.hash = '#/' })
  await expect(page.locator('#reader')).not.toHaveClass(/active/)
  await expect(page.locator('html')).not.toHaveClass(/reading/)
  await expect(page.locator('body')).not.toHaveClass(/reading/)
})

test('rejects an empty chapter list instead of showing a false ending', async ({ page }) => {
  await page.route('**/read/api/chapters?slug=empty-series', route => route.fulfill({
    contentType: 'application/json',
    body: '{"chapters":[]}',
  }))

  await page.goto(`${app}#/read/empty-series/1`)
  await expect(page.locator('#reader-list-retry')).toBeVisible()
  await expect(page.locator('#reader-prose')).toContainText('chapter list unavailable')
  await expect(page.locator('#reader-foot')).not.toContainText('all caught up')
})

test('rejects partial chapter lists and missing deep links', async ({ page }) => {
  await page.route('**/read/api/chapters?slug=partial-series', route => route.fulfill({
    contentType: 'application/json',
    body: '{"total":2,"chapters":[{"n":1,"t":"One"}]}',
  }))
  await page.goto(`${app}#/read/partial-series/1`)
  await expect(page.locator('#reader-prose')).toContainText('chapter list unavailable')

  await page.route('**/read/api/chapters?slug=missing-chapter', route => route.fulfill({
    contentType: 'application/json',
    body: '{"total":1,"chapters":[{"n":1,"t":"One"}]}',
  }))
  await page.goto(`${app}#/read/missing-chapter/99`)
  await expect(page.locator('#reader-prose')).toContainText('chapter 99 isn’t available')
  await expect(page.locator('#reader .ch-block')).toHaveCount(0)
})

test('does not retry a missing chapter response', async ({ page }) => {
  const attempts = await page.evaluate(async () => {
    const { apiGet, setTransport } = await import('/src/lib/http.js')
    let count = 0
    setTransport(async () => {
      count++
      return { ok: false, status: 404, json: async () => ({ error: 'missing' }) }
    })
    try { await apiGet('/read/api/chapter?slug=gone&n=1') } catch {}
    return count
  })
  expect(attempts).toBe(1)
})

test('rejects invalid chapter bodies instead of rendering a blank chapter', async ({ page }) => {
  await page.route('**/read/api/chapters?slug=invalid-body', route => route.fulfill({
    contentType: 'application/json',
    body: '{"chapters":[{"n":1,"t":"One"}]}',
  }))
  await page.route('**/read/api/chapter?slug=invalid-body&n=1', route => route.fulfill({
    contentType: 'application/json',
    body: '{"title":"One","html":42}',
  }))
  await page.route('**/read/api/series/nf%3Ainvalid-body', route => route.fulfill({
    contentType: 'application/json',
    body: '{"key":"nf:invalid-body","nfSlug":"invalid-body","title":"Invalid Body"}',
  }))

  await page.goto(`${app}#/read/invalid-body/1`)
  await expect(page.locator('#reader-prose')).toContainText('couldn’t load this chapter')
  await expect(page.locator('#reader .ch-block')).toHaveCount(0)
})

test('starts a fresh chapter request when a closed reader is reopened', async ({ page }) => {
  let chapterRequests = 0
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  await page.route('**/read/api/chapters?slug=reopen-series', route => route.fulfill({
    contentType: 'application/json',
    body: '{"chapters":[{"n":1,"t":"One"}]}',
  }))
  await page.route('**/read/api/chapter?slug=reopen-series&n=1', async route => {
    chapterRequests++
    if (chapterRequests === 1) {
      await firstGate
      try {
        await route.fulfill({ contentType: 'application/json', body: '{"title":"Stale","html":"<p>stale body</p>"}' })
      } catch {}
      return
    }
    await route.fulfill({ contentType: 'application/json', body: '{"title":"Fresh","html":"<p>fresh body</p>"}' })
  })
  await page.route('**/read/api/series/nf%3Areopen-series', route => route.fulfill({
    contentType: 'application/json',
    body: '{"key":"nf:reopen-series","nfSlug":"reopen-series","title":"Reopen Series"}',
  }))

  try {
    await page.goto(`${app}#/read/reopen-series/1`)
    await expect.poll(() => chapterRequests).toBe(1)
    await page.locator('#r-back').click()
    await page.goto(`${app}#/read/reopen-series/1`)
    await expect(page.locator('#reader-prose')).toContainText('fresh body')
    expect(chapterRequests).toBe(2)
  } finally {
    releaseFirst()
  }
})

test('ignores delayed series metadata after the reader closes', async ({ page }) => {
  let releaseSeries = () => {}
  const seriesGate = new Promise(resolve => { releaseSeries = resolve })
  await page.route('**/read/api/chapters?slug=slow-meta', route => route.fulfill({
    contentType: 'application/json',
    body: '{"chapters":[{"n":1,"t":"One"}]}',
  }))
  await page.route('**/read/api/chapter?slug=slow-meta&n=1', route => route.fulfill({
    contentType: 'application/json',
    body: '{"title":"One","html":"<p>loaded chapter</p>"}',
  }))
  await page.route('**/read/api/series/nf%3Aslow-meta', async route => {
    await seriesGate
    try {
      await route.fulfill({
        contentType: 'application/json',
        body: '{"key":"nf:slow-meta","nfSlug":"slow-meta","title":"Slow Metadata"}',
      })
    } catch {}
  })

  try {
    await page.goto(`${app}#/read/slow-meta/1`)
    await expect(page.locator('#reader-prose')).toContainText('loaded chapter')
    await page.locator('#r-back').click()
    releaseSeries()
    await page.waitForTimeout(100)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vellum:lib') || '[]'))).toEqual([])
  } finally {
    releaseSeries()
  }
})

test('opens a Continue card directly in its saved chapter', async ({ page }) => {
  await page.route('**/read/api/chapters?slug=continue-series', route => route.fulfill({
    contentType: 'application/json',
    body: '{"chapters":[{"n":1,"t":"One"},{"n":2,"t":"Two"},{"n":3,"t":"Three"}]}',
  }))
  await page.route('**/read/api/chapter?slug=continue-series&n=3', route => route.fulfill({
    contentType: 'application/json',
    body: '{"title":"Three","html":"<p>continued here</p>"}',
  }))
  await page.route('**/read/api/series/nf%3Acontinue-series', route => route.fulfill({
    contentType: 'application/json',
    body: '{"key":"nf:continue-series","nfSlug":"continue-series","title":"Continue Series"}',
  }))
  await page.evaluate(() => {
    localStorage.setItem('vellum:lib', JSON.stringify([{
      slug: 'continue-series', title: 'Continue Series', total: 10, readCount: 2, lastN: 3, updatedAt: Date.now(),
    }]))
    localStorage.setItem('vellum:pos:continue-series', JSON.stringify({ n: 3, p: 0, at: Date.now() }))
  })
  await page.reload()

  await page.locator('#continue .ctile').click()
  await expect(page).toHaveURL(/#\/read\/continue-series\/3$/)
  await expect(page.locator('#reader-prose')).toContainText('continued here')
})

test('counts earlier chapters when opening a later chapter directly', async ({ page }) => {
  await page.route('**/read/api/chapters?slug=jump-series', route => route.fulfill({
    contentType: 'application/json',
    body: '{"chapters":[{"n":1,"t":"One"},{"n":2,"t":"Two"},{"n":3,"t":"Three"},{"n":4,"t":"Four"}]}',
  }))
  await page.route('**/read/api/chapter?slug=jump-series&n=4', route => route.fulfill({
    contentType: 'application/json',
    body: '{"title":"Four","html":"<p>jumped here</p>"}',
  }))
  await page.route('**/read/api/series/nf%3Ajump-series', route => route.fulfill({
    contentType: 'application/json',
    body: '{"key":"nf:jump-series","nfSlug":"jump-series","title":"Jump Series"}',
  }))

  await page.goto(`${app}#/read/jump-series/4`)
  await expect(page.locator('#reader-prose')).toContainText('jumped here')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('vellum:read:jump-series')).length)).toBe(4)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('vellum:lib'))?.[0]?.readCount)).toBe(4)
})

test('loads reader slugs containing an encoded slash', async ({ page }) => {
  await page.route('**/read/api/chapters?slug=source%2Fbook', route => route.fulfill({
    contentType: 'application/json',
    body: '{"chapters":[{"n":12,"t":"Twelve"}]}',
  }))
  await page.route('**/read/api/chapter?slug=source%2Fbook&n=12', route => route.fulfill({
    contentType: 'application/json',
    body: '{"title":"Twelve","html":"<p>encoded slug loaded</p>"}',
  }))
  await page.route('**/read/api/series/nf%3Asource%2Fbook', route => route.fulfill({
    contentType: 'application/json',
    body: '{"key":"nf:source/book","nfSlug":"source/book","title":"Encoded Series"}',
  }))

  await page.goto(`${app}#/read/source%2Fbook/12`)
  await expect(page.locator('#reader-prose')).toContainText('encoded slug loaded')
})

test('stops buffering as soon as the reader closes', async ({ page }) => {
  let chapterRequests = 0
  const chapters = Array.from({ length: 30 }, (_, i) => ({ n: i + 1, t: `Chapter ${i + 1}` }))
  await page.route('**/read/api/chapters?slug=close-series', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ chapters }),
  }))
  await page.route('**/read/api/chapter?slug=close-series&n=*', route => {
    chapterRequests++
    const n = new URL(route.request().url()).searchParams.get('n')
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ title: `Chapter ${n}`, html: `<p>body ${n}</p>` }),
    })
  })
  await page.route('**/read/api/series/nf%3Aclose-series', route => route.fulfill({
    contentType: 'application/json',
    body: '{"key":"nf:close-series","nfSlug":"close-series","title":"Close Series"}',
  }))

  await page.goto(`${app}#/read/close-series/1`)
  await expect(page.locator('.ch-block').first()).toBeVisible()
  await page.waitForTimeout(200)
  const before = chapterRequests
  await page.evaluate(() => {
    window.dispatchEvent(new Event('scroll'))
    document.querySelector('#r-back').click()
  })
  await page.waitForTimeout(300)
  expect(chapterRequests).toBe(before)
})

test('continues discover pagination when the API returns short pages', async ({ page }) => {
  const rows = prefix => Array.from({ length: 20 }, (_, i) => ({
    key: `nf:${prefix}-${i}`,
    title: `${prefix.toUpperCase()} Title ${i}`,
    sources: ['novelfire'],
    readable: true,
  }))
  await page.route('**/read/api/discover?**', route => {
    const pageNumber = Number(new URL(route.request().url()).searchParams.get('page'))
    const results = pageNumber === 1 ? rows('a') : rows('b')
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ page: pageNumber, limit: 30, total: 20, results }),
    })
  })
  await page.route('**/read/api/series/**', route => route.fulfill({
    contentType: 'application/json',
    body: '{"title":"Enriched"}',
  }))

  await page.locator('[data-nav="discover"]').click()
  await expect(page.locator('#dlist')).toContainText('A Title 0')
  await page.locator('#view-discover .scroll').evaluate(element => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event('scroll'))
  })
  await expect(page.locator('#dlist')).toContainText('B Title 0')
})
