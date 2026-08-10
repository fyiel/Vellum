export const $ = (s, el = document) => el.querySelector(s)
export const $$ = (s, el = document) => [...el.querySelectorAll(s)]
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
// the real scroller for a chapter/episode list: .chscroll on desktop, the detail view on mobile
export const activeScroller = () => {
    const ch = document.querySelector('.chscroll')
    if (ch && ch.scrollHeight > ch.clientHeight + 2) return ch
    return document.querySelector('#view-series')
}
