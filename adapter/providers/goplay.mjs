// goplay.su sits behind a Cloudflare Turnstile access token wall instead of serving pages so the
// provider exposes no scraping path and every gp route fails fast and loud rather than hanging.
// The anime registry short circuits on `unavailable` and pumg-kdrama rejects gp before this module
// is reached, so requesting gp costs no network call. Verified again 20260917, GET / answers 404
// with the gate at md5 a8963d38413ca120d09440d296cb05cf, content paths 302 to / and no cookie is
// ever set. FlareSolverr and slipgate cannot solve an embedded Turnstile widget, so nothing here
// can change until the site does. Keep `unavailable` and keep this frozen, a stray mutation must
// not let a dead provider look usable.
export const goplay = Object.freeze({
    key: 'gp',
    label: 'GoPlay',
    kinds: ['drama'],
    unavailable: 'goplay.su blocks automated access (Cloudflare Turnstile)',
})
