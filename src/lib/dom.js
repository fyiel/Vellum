export const $ = (s, el = document) => el.querySelector(s)
export const $$ = (s, el = document) => [...el.querySelectorAll(s)]
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
