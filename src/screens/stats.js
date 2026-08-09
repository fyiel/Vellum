import { statsAll, statsActive, statsCap } from '../lib/store.js'
import { localDayKey, relTime } from '../lib/time.js'
import { $ } from '../lib/dom.js'

const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

const minsOf = ms => (ms >= 60000 ? Math.floor(ms / 60000) : ms > 0 ? 1 : 0)
const hoursOf = ms => (ms >= 3600000 ? `${Math.floor(ms / 3600000)}h` : `${minsOf(ms)}m`)
const chWord = n => `${n} chapter${n === 1 ? '' : 's'}`

// current streak with today grace: an empty today does not break the run until the day ends
export const statsStreak = (days, now = Date.now()) => {
    const t = new Date(now)
    let n = statsActive(days.get(localDayKey(t.getTime()))) ? 1 : 0
    t.setDate(t.getDate() - 1)
    while (statsActive(days.get(localDayKey(t.getTime())))) {
        n++
        t.setDate(t.getDate() - 1)
    }
    return n
}

// best run anywhere in the day window, never below the archived best.
// walk calendar days so a day with no bucket breaks the run like any other gap
export const statsBest = (days, archive) => {
    let best = archive?.bestStreak || 0
    const keys = [...days.keys()]
    if (!keys.length) return best
    const oldest = keys.sort()[0]
    let run = 0
    const t = new Date()
    while (true) {
        const k = localDayKey(t.getTime())
        run = statsActive(days.get(k)) ? run + 1 : 0
        if (run > best) best = run
        if (k === oldest) break
        t.setDate(t.getDate() - 1)
    }
    return best
}

export function showStats() {
    const { days, archive } = statsAll()
    const todayKey = localDayKey(Date.now())
    const totalMs = archive.ms + [...days.values()].reduce((a, b) => a + (b.ms || 0), 0)
    const totalCh = archive.ch + [...days.values()].reduce((a, b) => a + (b.ch || 0), 0)
    const body = $('#stats-body')
    if (!body) return

    if (!totalMs && !totalCh) {
        body.innerHTML = `<div class="void">(・_・)\n\nreading time shows up here — open a novel and read for a couple of minutes</div>`
        return
    }

    const today = days.get(todayKey) || { ms: 0, ch: 0 }
    const tMin = minsOf(today.ms)
    const todayLine =
        tMin || today.ch
            ? `today ${tMin}m · ${chWord(today.ch)}`
            : 'no reading yet today'

    // last 14 days as a 7x2 weekday grid, monday rows with this week right of last week
    const now = new Date()
    const dow = (now.getDay() + 6) % 7
    const cellKey = (w, wk) => {
        const t = new Date(now)
        t.setDate(t.getDate() - (dow - w) - 7 * (1 - wk))
        return localDayKey(t.getTime())
    }
    const grid = DAY_LETTERS.map((L, w) => {
        const cells = [0, 1]
            .map(wk => {
                const k = cellKey(w, wk)
                const d = days.get(k)
                const on = statsActive(d)
                const a = on ? 0.14 + 0.86 * Math.min(1, (d.ms || 0) / 240000) : 0
                const cls = ['scell', on && 'on', k === todayKey && 'today'].filter(Boolean).join(' ')
                const tip = on ? `${k} · ${minsOf(d.ms)}m` : k
                return `<span class="${cls}"${on ? ` style="--sa:${a.toFixed(2)}"` : ''} title="${tip}"></span>`
            })
            .join('')
        return `<div class="srow"><span class="sl">${L}</span>${cells}</div>`
    }).join('')

    const activeKeys = [...days.keys()].filter(k => statsActive(days.get(k))).sort()
    const lastTs = activeKeys.length
        ? new Date(`${activeKeys[activeKeys.length - 1]}T12:00:00`).getTime()
        : 0

    body.innerHTML = `
        <div class="shero">
            <div class="sline1">${todayLine}</div>
            <div class="sline2">streak ${statsStreak(days)}d · best ${statsBest(days, archive)}d</div>
            ${lastTs ? `<div class="sline3">last read ${relTime(lastTs)}</div>` : ''}
        </div>
        <div class="sgrid">${grid}</div>
        <div class="sfoot">all time ${hoursOf(totalMs)} · ${chWord(totalCh)}</div>
        ${statsCap() ? '<div class="scap">history capped — some reading time was dropped while storage was full</div>' : ''}
    `
}
