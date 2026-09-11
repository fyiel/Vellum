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
