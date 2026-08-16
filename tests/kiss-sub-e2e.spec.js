// throwaway e2e probe: encrypted KissKH subtitle track must attach with parsed cues
import { test, expect } from '@playwright/test'

test('kiss encrypted subtitles attach as parsed cues', async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto('http://127.0.0.1:5173/#/watch/play/kiss%3A8705/173841')
    const video = page.locator('video.video-media')
    await video.waitFor({ timeout: 60_000 })
    // the default (English) track decrypts, attaches, and parses to real cues
    await expect.poll(() => page.evaluate(() => {
        const v = document.querySelector('video.video-media')
        if (!v) return 0
        const en = [...v.textTracks].find(t => t.label === 'English')
        return en && en.cues ? en.cues.length : 0
    }), { timeout: 60_000 }).toBeGreaterThan(100)
    const info = await page.evaluate(() => {
        const v = document.querySelector('video.video-media')
        const en = [...v.textTracks].find(t => t.label === 'English')
        return {
            tracks: [...v.textTracks].length,
            mode: en.mode,
            firstCue: en.cues[0].text,
            src: v.querySelector('track[kind="subtitles"]').src.slice(0, 20),
        }
    })
    console.log(JSON.stringify(info))
    expect(info.mode).toBe('showing')
    expect(info.firstCue).toContain('White Olive Tree')
})
