// goplay.su blocks automated access behind a Cloudflare Turnstile challenge, so
// the provider exposes no scraping path: the registry entry carries an
// `unavailable` reason and every gp: route resolves to provider_unconfigured.
export const goplay = {
    key: 'gp',
    label: 'GoPlay',
    kinds: ['drama'],
    unavailable: 'goplay.su blocks automated access (Cloudflare Turnstile)',
}
