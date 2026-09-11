import { test, expect } from '@playwright/test'

const app = `http://127.0.0.1:${process.env.VELLUM_TEST_PORT || '5173'}/`
const SLUG = 'teleporter'

const chapters = [1, 2, 3, 4, 5].map(n => ({ n, t: `Chapter ${n}` }))

const body = (n, count = 42) =>
    Array.from({ length: count }, (_, i) => `<p>c${n}p${i} ${'lorem ipsum dolor sit amet consectetur '.repeat(3)}</p>`).join('')

test('keeps the reading position while buffering, trimming and a late image land', async ({ page }) => {
    const errors = []
    page.on('pageerror', error => errors.push(error.message))

    await page.route('**/read/api/series/**', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ key: 'nu:teleporter', kind: 'novel', title: 'Teleporter', status: 'ongoing' }),
    }))
    await page.route('**/read/api/chapters?**', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ slug: SLUG, chapters, total: chapters.length, errors: [] }),
    }))
    await page.route('**/read/api/chapter?**', route => {
        const n = Number(new URL(route.request().url()).searchParams.get('n'))
        // the image sits at the end of chapter 2: by the time it resolves the reader has
        // scrolled into chapter 3, so it lands above the viewport and shifts the text
        const html = body(n) + (n === 2 ? '<img src="/slow.png" alt="">' : '')
        return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ slug: SLUG, n, title: `Chapter ${n}`, html }),
        })
    })
    await page.route('**/slow.png', async route => {
        await new Promise(resolve => setTimeout(resolve, 2500))
        return route.fulfill({
            contentType: 'image/svg+xml',
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1400"><rect width="100%" height="100%" fill="#222"/></svg>',
        })
    })

    // what the reader is actually showing: the text under this point must not move on its own
    const probe = () => page.evaluate(() => {
        const el = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight * 0.3))
        const block = el?.closest?.('.ch-block')
        return {
            text: (el?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48),
            idx: block ? Number(block.dataset.idx) : null,
            y: Math.round(window.scrollY),
            title: document.querySelector('#r-title')?.textContent ?? '',
            blocks: document.querySelectorAll('.ch-block').length,
        }
    })

    const jump = (fraction) => page.evaluate(f => window.scrollBy(0, window.innerHeight * f), fraction)

    await page.goto(`${app}#/read/${SLUG}/1`)
    await expect(page.locator('.ch-block')).toHaveCount(1)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

    const trace = []
    const violations = []
    for (let i = 0; i < 26; i++) {
        const before = await probe()
        await jump(0.85)
        // let the lazy image, the buffer append and the idle trim fire, without scrolling ourselves
        const settled = await probe()
        await page.waitForTimeout(650)
        const after = await probe()
        trace.push({ step: i, before, settled, after })
        // no input happened between `settled` and `after`, so the view must not have moved
        if (after.text !== settled.text || after.idx !== settled.idx) violations.push({ step: i, settled, after })
    }

    console.log(JSON.stringify(trace.map(t => ({
        step: t.step,
        y: [t.before.y, t.settled.y, t.after.y],
        idx: [t.before.idx, t.settled.idx, t.after.idx],
        blocks: [t.before.blocks, t.settled.blocks, t.after.blocks],
        title: t.after.title,
        text: t.after.text.slice(0, 20),
    })), null, 1))
    expect(violations, `\n${JSON.stringify(violations, null, 1)}`).toEqual([])
    expect(errors).toEqual([])
})

// the mid-scroll trim (reader.js:549) only fires once 20+ chapters sit in the DOM, and the
// idle trim clears that buffer whenever the reader pauses: drive a long stream with short,
// continuous steps so the buffer grows past the threshold, then hold the reader to "scrolling
// down never goes back" while that trim runs
test('never walks the reader backwards while a deep stream trims mid-scroll', async ({ page }) => {
    const long = Array.from({ length: 60 }, (_, i) => ({ n: i + 1, t: `Chapter ${i + 1}` }))
    const errors = []
    page.on('pageerror', error => errors.push(error.message))

    await page.route('**/read/api/series/**', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ key: 'nu:deep', kind: 'novel', title: 'Deep', status: 'ongoing' }),
    }))
    await page.route('**/read/api/chapters?**', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ slug: 'deep', chapters: long, total: long.length, errors: [] }),
    }))
    await page.route('**/read/api/chapter?**', route => {
        const n = Number(new URL(route.request().url()).searchParams.get('n'))
        return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ slug: 'deep', n, title: `Chapter ${n}`, html: body(n, 8) }),
        })
    })

    const state = () => page.evaluate(() => ({
        title: document.querySelector('#r-title')?.textContent ?? '',
        blocks: document.querySelectorAll('.ch-block').length,
        first: Number(document.querySelector('.ch-block')?.dataset.idx ?? -1),
        last: Number(document.querySelector('.ch-block:last-of-type')?.dataset.idx ?? -1),
        y: Math.round(window.scrollY),
        // the chapter actually under the top of the viewport, straight from layout
        actual: (() => {
            const edge = window.scrollY + 90
            let idx = null
            for (const block of document.querySelectorAll('.ch-block')) {
                if (block.offsetTop <= edge) idx = Number(block.dataset.idx)
                else break
            }
            return idx
        })(),
    }))
    const chapterOf = title => Number(String(title).match(/Chapter (\d+)/)?.[1] ?? 0)

    await page.goto(`${app}#/read/deep/1`)
    await expect(page.locator('.ch-block').first()).toBeVisible()

    // short chapters + small continuous steps: every scroll event appends more, so the DOM
    // fills past the trim threshold before anything can idle
    let deepest = { first: 0, last: 0 }
    for (let i = 0; i < 90; i++) {
        await page.evaluate(() => window.scrollBy(0, 150))
        await page.waitForTimeout(20)
        const now = await state()
        if (now.last - now.first > deepest.last - deepest.first) deepest = now
    }
    expect(deepest.last - deepest.first, `never buffered a deep stream: ${JSON.stringify({ deepest, ...(await state()) })}`).toBeGreaterThan(20)

    // keep stepping: every 120th scroll event runs the mid-scroll trim on the deep buffer
    let previousChapter = chapterOf((await state()).title)
    const regressions = []
    const mismatches = []
    for (let i = 0; i < 200; i++) {
        await page.evaluate(() => window.scrollBy(0, 130))
        await page.waitForTimeout(20)
        const now = await state()
        const chapter = chapterOf(now.title)
        if (chapter < previousChapter) regressions.push({ step: i, was: previousChapter, now: chapter, y: now.y, blocks: now.blocks })
        previousChapter = Math.max(previousChapter, chapter)
        // the header drives the url, the progress bar and the saved resume point, so it has to
        // name the chapter the reader is actually looking at (fixture blocks are idx = chapter - 1)
        if (now.actual != null && chapter !== now.actual + 1) {
            mismatches.push({ step: i, shown: chapter, actual: now.actual + 1, y: now.y, blocks: now.blocks })
        }
    }
    const end = await state()
    console.log(JSON.stringify({ deepest: { first: deepest.first, last: deepest.last, blocks: deepest.blocks }, end, regressions: regressions.length, mismatches: mismatches.slice(0, 5) }, null, 1))

    expect(regressions, `reader went backwards while only scrolling down:\n${JSON.stringify(regressions, null, 1)}`).toEqual([])
    expect(mismatches, `header named a chapter the reader was not looking at:\n${JSON.stringify(mismatches.slice(0, 10), null, 1)}`).toEqual([])
    expect(errors).toEqual([])
})

// a jump (drawer / link / restored position) leaves every earlier chapter thousands of px above
// the viewport, so one idle trim pass sheds many blocks at once. The compensation has to keep the
// text under the reader still no matter how far away the removed blocks were.
test('keeps the view steady when a jump leaves far-away chapters to trim', async ({ page }) => {
    // long enough that no amount of buffering reaches the end of the stream: the reader has to
    // stay mid-book with chapters far above it for the trim to have work to do
    const long = Array.from({ length: 200 }, (_, i) => ({ n: i + 1, t: `Chapter ${i + 1}` }))
    const errors = []
    page.on('pageerror', error => errors.push(error.message))

    await page.route('**/read/api/series/**', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ key: 'nu:jump', kind: 'novel', title: 'Jump', status: 'ongoing' }),
    }))
    await page.route('**/read/api/chapters?**', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ slug: 'jump', chapters: long, total: long.length, errors: [] }),
    }))
    await page.route('**/read/api/chapter?**', route => {
        const n = Number(new URL(route.request().url()).searchParams.get('n'))
        return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ slug: 'jump', n, title: `Chapter ${n}`, html: body(n, 12) }),
        })
    })

    // what is under the top of the viewport right now
    const probe = () => page.evaluate(() => {
        const el = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight * 0.3))
        const block = el?.closest?.('.ch-block')
        return {
            text: (el?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
            idx: block ? Number(block.dataset.idx) : null,
            y: Math.round(window.scrollY),
            blocks: document.querySelectorAll('.ch-block').length,
            firstTop: (() => { const b = document.querySelector('.ch-block'); return b ? Math.round(b.offsetTop) : null })(),
        }
    })

    await page.goto(`${app}#/read/jump/1`)
    await expect(page.locator('.ch-block').first()).toBeVisible()
    // buffer deep without idling so nothing trims yet
    for (let i = 0; i < 34; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2))
        await page.waitForTimeout(15)
    }

    // jump: land far from every buffered chapter, then let the idle trim run untouched
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 4))
    await page.waitForTimeout(120)
    const before = await probe()
    await page.waitForTimeout(900)
    const after = await probe()

    console.log('DUMP ' + JSON.stringify({ before, after, removed: before.blocks - after.blocks }))
    expect(before.blocks - after.blocks, `no trim ran, test proves nothing:\n${JSON.stringify({ before, after })}`).toBeGreaterThan(0)
    // the reader was not scrolling during that window, so the text under the top must not move
    expect({ text: after.text, idx: after.idx }, JSON.stringify({ before, after })).toEqual({ text: before.text, idx: before.idx })
    expect(errors).toEqual([])
})

// iOS keeps the momentum running after the finger lifts, and resolves a programmatic scroll
// differently mid-gesture than a wheel does, which is what can throw the reader out of place.
// On a touch device every scroll correction waits for the page to settle instead.
test.describe('touch device', () => {
    test.use({ hasTouch: true })

    test('defers scroll corrections until the gesture has settled', async ({ page }) => {
        const long = Array.from({ length: 60 }, (_, i) => ({ n: i + 1, t: `Chapter ${i + 1}` }))
        const errors = []
        page.on('pageerror', error => errors.push(error.message))

        await page.route('**/read/api/series/**', route => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ key: 'nu:touch', kind: 'novel', title: 'Touch', status: 'ongoing' }),
        }))
        await page.route('**/read/api/chapters?**', route => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ slug: 'touch', chapters: long, total: long.length, errors: [] }),
        }))
        await page.route('**/read/api/chapter?**', route => {
            const n = Number(new URL(route.request().url()).searchParams.get('n'))
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ slug: 'touch', n, title: `Chapter ${n}`, html: body(n, 8) }),
            })
        })

        const state = () => page.evaluate(() => ({
            blocks: document.querySelectorAll('.ch-block').length,
            first: Number(document.querySelector('.ch-block')?.dataset.idx ?? -1),
            last: Number(document.querySelector('.ch-block:last-of-type')?.dataset.idx ?? -1),
        }))

        await page.goto(`${app}#/read/touch/1`)
        await expect(page.locator('.ch-block').first()).toBeVisible()

        // fill the buffer past the trim threshold while the page is quiet
        for (let i = 0; i < 90; i++) {
            await page.evaluate(() => window.scrollBy(0, 150))
            await page.waitForTimeout(20)
        }
        const deep = await state()
        expect(deep.last - deep.first, `no deep buffer: ${JSON.stringify(deep)}`).toBeGreaterThan(20)

        // keep the scroll events coming: every 120th tick would trim on a non-touch device
        let trimmedMidGesture = 0
        for (let i = 0; i < 140; i++) {
            const before = await state()
            await page.evaluate(() => window.scrollBy(0, 130))
            await page.waitForTimeout(20)
            const after = await state()
            if (after.blocks < before.blocks) trimmedMidGesture += 1
        }
        expect(trimmedMidGesture, 'a trim ran while the gesture was still active').toBe(0)

        // let it settle: the deferred work happens now
        const settledBefore = await state()
        await page.waitForTimeout(700)
        const settledAfter = await state()
        expect(settledAfter.blocks, `nothing trimmed after settling: ${JSON.stringify({ settledBefore, settledAfter })}`).toBeLessThan(settledBefore.blocks)
        expect(errors).toEqual([])
    })
})
