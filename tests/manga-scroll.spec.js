import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`

test.setTimeout(60_000)

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

const poster = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="600" height="900"%3E%3Crect width="100%25" height="100%25" fill="%231d1f25"/%3E%3C/svg%3E'

const pageRows = pageNumber => [1, 2, 3].map(n => ({
  key: `mf:scroll-${pageNumber}-${n}`, kind: 'manga', format: 'manga', title: `Scroll ${pageNumber} row ${n}`, cover: poster,
}))

test('endlessly scrolls the manga shelf with no load-more button', async ({ page }) => {
  await page.route('**/read/api/manga/discover?**', route => {
    const pageNumber = Number(new URL(route.request().url()).searchParams.get('page'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      page: pageNumber, results: pageRows(pageNumber), hasMore: pageNumber === 1,
    }) })
  })

  const pageTwo = page.waitForRequest(request => request.url().includes('/manga/discover?') && request.url().includes('page=2'))
  await page.locator('[data-nav="manga"]').click()
  await expect(page.locator('#mlist .manga-card')).toHaveCount(3)
  await expect(page.locator('#mlist')).toContainText('Scroll 1 row 1')
  await page.locator('#mscroll').evaluate(element => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event('scroll'))
  })
  await pageTwo
  await expect(page.locator('#mlist .manga-card')).toHaveCount(6)
  await expect(page.locator('#mlist')).toContainText('Scroll 2 row 1')
  await expect(page.locator('#mmore')).toBeHidden()
})

test('streams across manga chapter boundaries without navigating', async ({ page }) => {
  const key = 'mf:streamer'
  const chapters = [1, 2, 3].map(number => ({ id: `chapter-${number}`, number, title: `Chapter ${number}`, language: 'en' }))
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
        pages: Array.from({ length: 60 }, (_, index) => ({
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
  await expect(page.locator('#mr-pages .manga-page')).toHaveCount(60)
  await expect(page.locator('#mr-title')).toContainText('Ch. 1')

  const stream = () => page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight)
    window.dispatchEvent(new Event('scroll'))
  })
  await stream()
  await expect.poll(() => page.locator('#mr-pages .manga-page').count()).toBeGreaterThan(60)
  await expect(page).toHaveURL(/chapter-1$/)
  await expect(page.locator('#mr-title')).toContainText('Ch. 1')
  await expect.poll(() => page.evaluate(k => JSON.parse(localStorage.getItem(`vellum:read:${k}`))?.includes('chapter-1'), key)).toBe(true)

  await stream()
  await expect.poll(() => page.locator('#mr-pages .manga-page').count()).toBeGreaterThan(120)
  await expect(page).toHaveURL(/chapter-1$/)
  expect(await page.locator('#mr-pages .manga-page').count()).toBeLessThanOrEqual(150)
})
