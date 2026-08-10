# Video adapter

`anime-adapter.mjs` is a dependency-free Fetch handler for Vellum's
`/read/api/anime/*` and shared `/read/api/video/*` contracts. It routes provider
keys through a fixed registry (a `Map` of four provider objects — not a plugin
system) into per-provider `discover`, `series`, `episodes`, and `playback`
handlers. Each handler receives a context of `{ env, fetchImpl, request, cached }`.

## Provider registry

| key | label | kinds | data path |
| --- | --- | --- | --- |
| `miruro` | Miruro | anime | AniList metadata; owned playback service or Slipgate |
| `dc` | DramaCooli | drama | open WordPress REST API (`wp-json/wp/v2/*`) |
| `gp` | GoPlay | drama | **unavailable** — goplay.su blocks automated access (Cloudflare Turnstile) |
| `cineby` | Cineby | anime | SSR `__NEXT_DATA__` pages |

Keys are `provider:id` with a per-provider id gate: `miruro` and `cineby` take
numeric ids, `dc` and `gp` take `[a-z0-9._-]{1,100}` slugs. An unknown prefix
returns `400 invalid_request 'Unknown video provider'` (non-retryable); a known
prefix that fails its id gate is rejected as an invalid key.

GoPlay carries `unavailable` instead of handlers, so every `gp:` route resolves
to `503 provider_unconfigured` with the reason attached; it never participates
in discovery results.

Provider modules live in `adapter/providers/`:

- `dramacooli.mjs` — catalogue via the open wp-json API: categories (ordered by
  post count) become `dc:<categoryId>` rows; category posts become episodes
  ordered by `-episode-N` / `-full-movie` slug; playback extracts the first
  `<iframe src>` (https only) from the post body as an embed.
- `cineby.mjs` — parses SSR `__NEXT_DATA__` pages with a plain browser
  user-agent: series pages map to `cineby:<tmdbId>` rows, seasons flatten to
  flat `s{season}e{episode}` ids (movies are a single `s1e1`), and playback
  emits only validated https HLS/MP4 or embed sources. It fails closed: any
  missing or non-https player payload raises `stream_unavailable`. The listing
  path (`/browse`) is the named discover source; if it cannot be parsed,
  discover returns `{ rows: [], hasMore: false, partial: true }` plus an error
  entry.
- `goplay.mjs` — registry entry only; no scraping path.

`/read/api/video/discover` aggregates discovery across every provider serving
the requested kind (`all`/`anime`/`drama`) into
`{ page, results, hasMore, partial, errors }`. A provider that fails to produce
rows reports an entry in `errors` and sets `partial: true`; fully successful
aggregations return `partial: false` with an empty `errors` array.

Failure responses carry `error.provider` (the registry key):

- `400 invalid_request` — bad key, id, kind, format, or method.
- `404 not_found` — unknown route or series.
- `499 request_cancelled` — client aborted.
- `502 provider_unavailable` — upstream failure (retryable).
- `502 stream_unavailable` — provider returned no playable stream (retryable).
- `503 provider_unconfigured` — playback service or provider not configured.

## Server environment

- `VELLUM_ANIME_PLAYBACK_URL` — optional HTTPS base URL. When absent, discovery
  and series metadata keep working while episode requests return an explicit
  `provider_unconfigured` response.
- `VELLUM_ANIME_PLAYBACK_KEY` — optional bearer token, held only by the server.
- `VELLUM_ANIME_PROVIDER` — optional provider name sent to the owned service;
  defaults to `default`.
- `VELLUM_SLIPGATE_URL` — Slipgate base URL used when the owned playback service
  is absent.
- `VELLUM_SLIPGATE_KEY` — optional `X-Slipgate-Key`, held only by the server.

The Slipgate fallback maps an exact AniDB App title, emits Miruro-compatible
`anidbapp:<series>:<episode>` IDs, verifies `pewe`/category/source identity on
playback, and exposes HLS only through `/read/api/video/media/*`.

The owned playback service must expose two GET routes:

- `episodes?anilistId=<id>&language=sub|dub` → an array (or `{ episodes }`) of
  `{ id, number, title?, description?, image?, airDate? }`.
- `sources?episodeId=<opaque-id>&provider=<name>&category=sub|dub` →
  `{ sources: [{ url, quality? }], subtitles?: [{ url, label?, language? }] }`.

IDs are passed through without parsing or reconstruction. Only HTTPS media and
subtitle URLs cross the adapter boundary.
