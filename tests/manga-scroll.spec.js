import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

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

const poster = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="600" height="900"%3E%3Crect width="100%25" height="100%25" fill="%231d1f25"/%3E%3C/svg%3E'

const pageRows = (pageNumber, count = 3) => Array.from({ length: count }, (_, index) => ({
  key: `mf:scroll-${pageNumber}-${index + 1}`, kind: 'manga', format: 'manga', title: `Scroll ${pageNumber} row ${index + 1}`, cover: poster,
}))

test('paged manga progress avoids reparsing the update ledger for every page', async ({ page }) => {
  const key = 'mf:progress-perf'
  const chapters = Array.from({ length: 600 }, (_, i) => ({ id: `chapter-${i + 1}`, number: i + 1 }))
  await page.route('**/read/api/manga/series/**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ key, kind: 'manga', format: 'manga', title: 'Progress Manga' }),
  }))
  await page.route('**/read/api/manga/chapters?**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ key, chapters, partial: false, errors: [] }),
  }))
  await page.route('**/read/api/manga/chapter?**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ key, chapter: chapters[0], pages: Array.from({ length: 40 }, (_, i) => ({
      url: `/read/api/manga/image?key=mf%3Aprogress-perf&id=chapter-1&page=${i}`, width: 800, height: 1200,
    })) }),
  }))
  await page.route('**/read/api/manga/image?**', route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200"/>',
  }))
  await page.evaluate(() => {
    const ledger = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [
      `mf:followed-${i}`,
      { read: true, seenIds: Array.from({ length: 500 }, (_, j) => `chapter-${j}`) },
    ]))
    localStorage.setItem('vellum:updates', JSON.stringify(ledger))
  })

  await page.goto(`${app}#/manga/read/mf%3Aprogress-perf/chapter-1`)
  await expect(page.locator('#mreader')).toHaveAttribute('data-state', 'ready')
  const result = await page.evaluate(k => {
    const original = Storage.prototype.getItem
    let ledgerReads = 0
    Storage.prototype.getItem = function (storageKey) {
      if (storageKey === 'vellum:updates') ledgerReads++
      return original.call(this, storageKey)
    }
    const start = performance.now()
    try {
      for (let i = 0; i < 30; i++) document.querySelector('#mr-next').click()
    } finally {
      Storage.prototype.getItem = original
    }
    return {
      ledgerReads,
      durationMs: performance.now() - start,
      position: JSON.parse(localStorage.getItem(`vellum:pos:${k}`)),
      entry: JSON.parse(localStorage.getItem('vellum:lib'))[0],
      read: JSON.parse(localStorage.getItem(`vellum:read:${k}`)),
      tracked: JSON.parse(localStorage.getItem('vellum:updates'))[k]?.seenIds?.length,
    }
  }, key)
  console.log(`30 paged manga turns: ${result.durationMs.toFixed(1)}ms; update ledger reads: ${result.ledgerReads}`)
  expect(result.ledgerReads).toBe(0)
  expect(result.position).toMatchObject({ id: 'chapter-1', page: 30 })
  expect(result.entry).toMatchObject({ lastId: 'chapter-1', lastPage: 31, pageCount: 40, readCount: 1, total: 600 })
  expect(result.entry.chapterIds).toHaveLength(600)
  expect(result.read).toContain('chapter-1')
  expect(result.tracked).toBe(600)
})

test('endlessly scrolls the manga shelf with no load-more button', async ({ page }) => {
  // a full grid keeps the bottom sentinel out of its 800px reveal margin, so the
  // page-2 load is driven by the explicit scroll and cannot auto-fire early
  const perPage = 48
  await page.route('**/read/api/manga/discover?**', route => {
    const pageNumber = Number(new URL(route.request().url()).searchParams.get('page'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      page: pageNumber, results: pageRows(pageNumber, perPage), hasMore: pageNumber === 1,
    }) })
  })

  await page.locator('[data-nav="manga"]').click()
  await expect(page.locator('#mlist .manga-card')).toHaveCount(perPage)
  await expect(page.locator('#mlist')).toContainText('Scroll 1 row 1')
  await page.locator('#mscroll').evaluate(element => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event('scroll'))
  })
  await expect(page.locator('#mlist .manga-card')).toHaveCount(perPage * 2)
  await expect(page.locator('#mlist')).toContainText('Scroll 2 row 1')
  await expect(page.locator('#mmore')).toBeHidden()
})

test('keeps the same page in view when old chapters are trimmed', async ({ page }) => {
  const key = 'mf:trimmer'
  const chapters = [1, 2, 3].map(number => ({ id: `chapter-${number}`, number, title: `Chapter ${number}`, language: 'en' }))
  const pagesPerChapter = 60
  await page.route('**/read/api/manga/series/**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ key, kind: 'manga', format: 'manhwa', title: 'Trimmer' }),
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
        pages: Array.from({ length: pagesPerChapter }, (_, index) => ({
          url: `/read/api/manga/image?key=mf%3Atrimmer&id=${id}&page=${index}`,
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

  const centeredPage = () => page.evaluate(() => {
    const mid = window.innerHeight / 2
    for (const figure of document.querySelectorAll('.manga-page')) {
      const rect = figure.getBoundingClientRect()
      if (rect.top <= mid && rect.bottom >= mid) return figure.dataset.page
    }
    return null
  })
  const stream = () => page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight)
    window.dispatchEvent(new Event('scroll'))
  })

  await page.goto(`${app}#/manga/read/mf%3Atrimmer/chapter-1`)
  await expect(page.locator('#mreader')).toHaveAttribute('data-state', 'ready')
  await expect(page.locator('#mr-pages .manga-page')).toHaveCount(pagesPerChapter)
  // let the restore-scroll rAF pair settle before driving scrolls (same race as below)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

  await stream()
  await expect(page.locator('#mr-title')).toContainText('Ch. 2')
  // bottom of chapter 2: its last page (global data-page 119) is centered when the
  // chapter-3 stream lands and wipes chapter 1 from the DOM
  await stream()
  await expect(page.locator('#mr-title')).toContainText('Ch. 3')
  await expect(page.locator('.mr-chapter-divider')).toHaveCount(1)
  await expect.poll(centeredPage).toBe('119')
})

test('does not wipe the chapter being read when a slow stream lands', async ({ page }) => {
  const key = 'mf:guard'
  const chapters = [1, 2, 3].map(number => ({ id: `chapter-${number}`, number, title: `Chapter ${number}`, language: 'en' }))
  const pagesPerChapter = 60
  await page.route('**/read/api/manga/series/**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ key, kind: 'manga', format: 'manhwa', title: 'Guard' }),
  }))
  await page.route('**/read/api/manga/chapters?**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ key, chapters, partial: false, errors: [] }),
  }))
  await page.route('**/read/api/manga/chapter?**', async route => {
    const id = new URL(route.request().url()).searchParams.get('id')
    // chapter 3 arrives slowly so the reader can scroll back into chapter 1 first
    if (id === 'chapter-3') await new Promise(resolve => setTimeout(resolve, 400))
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        key,
        chapter: chapters.find(chapter => chapter.id === id),
        pages: Array.from({ length: pagesPerChapter }, (_, index) => ({
          url: `/read/api/manga/image?key=mf%3Aguard&id=${id}&page=${index}`,
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

  const centeredPage = () => page.evaluate(() => {
    const mid = window.innerHeight / 2
    for (const figure of document.querySelectorAll('.manga-page')) {
      const rect = figure.getBoundingClientRect()
      if (rect.top <= mid && rect.bottom >= mid) return figure.dataset.page
    }
    return null
  })
  const stream = () => page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight)
    window.dispatchEvent(new Event('scroll'))
  })

  await page.goto(`${app}#/manga/read/mf%3Aguard/chapter-1`)
  await expect(page.locator('#mreader')).toHaveAttribute('data-state', 'ready')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

  await stream()
  await expect(page.locator('#mr-title')).toContainText('Ch. 2')
  // bottom of chapter 2 starts the chapter-3 fetch; the reader goes back to the
  // top of chapter 1 while it is in flight (scrolling away in the same task would
  // skip the IntersectionObserver frame that starts the fetch)
  const fetching3 = page.waitForRequest(request =>
    request.url().includes('/read/api/manga/chapter?') && request.url().includes('id=chapter-3'))
  await stream()
  await fetching3
  await page.evaluate(() => {
    window.scrollTo(0, 0)
    window.dispatchEvent(new Event('scroll'))
  })
  await expect(page.locator('#mr-title')).toContainText('Ch. 3')
  // the trim must skip the chapter under the reader's eyes: both dividers stay
  // and the viewport is still on chapter 1's first page
  await expect(page.locator('.mr-chapter-divider')).toHaveCount(2)
  await expect.poll(centeredPage).toBe('0')
})

test('streams across manga chapter boundaries without navigating', async ({ page }) => {
  const key = 'mf:streamer'
  const chapters = [1, 2, 3].map(number => ({ id: `chapter-${number}`, number, title: `Chapter ${number}`, language: 'en' }))
  const pagesPerChapter = 60
  await page.route('**/read/api/manga/series/**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ key, kind: 'manga', format: 'manhwa', title: 'Streamer' }),
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
        pages: Array.from({ length: pagesPerChapter }, (_, index) => ({
          url: `/read/api/manga/image?key=mf%3Astreamer&id=${id}&page=${index}`,
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

  await page.goto(`${app}#/manga/read/mf%3Astreamer/chapter-1`)
  await expect(page.locator('#mreader')).toHaveAttribute('data-state', 'ready')
  await expect(page.locator('#mr-pos')).toHaveText('Page 1 / 60')
  await expect(page.locator('#mr-pages .manga-page')).toHaveCount(pagesPerChapter)
  await expect(page.locator('#mr-title')).toContainText('Ch. 1')

  // the reader restores the scroll position one rAF pair after render; streaming
  // from the bottom would race that pending scroll, so wait for it to settle first
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const stream = () => page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight)
    window.dispatchEvent(new Event('scroll'))
  })
  // streaming is scroll-driven: each bottom scroll streams the next chapter, and
  // the DOM stays bounded at the current chapter plus one behind (2 * 60 pages)
  await stream()
  await expect(page.locator('#mr-title')).toContainText('Ch. 2')
  await expect(page.locator('#mr-pages .manga-page')).toHaveCount(pagesPerChapter * 2)
  await stream()
  await expect(page.locator('#mr-title')).toContainText('Ch. 3')
  await expect(page).toHaveURL(/chapter-3$/)
  await expect(page.locator('#mr-pages .manga-page')).toHaveCount(pagesPerChapter * 2)
  await expect(page.locator('.mr-chapter-divider')).toHaveCount(1)
  await expect(page.locator('.mr-chapter-divider')).toContainText('Ch. 3')
  await expect(page.locator('#mr-pages .manga-page').first()).toHaveAttribute('data-page', '60')
  await expect.poll(() => page.evaluate(k => JSON.parse(localStorage.getItem(`vellum:read:${k}`))?.includes('chapter-1'), key)).toBe(true)
  await expect.poll(() => page.evaluate(k => JSON.parse(localStorage.getItem(`vellum:read:${k}`))?.includes('chapter-2'), key)).toBe(true)
})
