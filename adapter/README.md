# Anime adapter

`anime-adapter.mjs` is a dependency-free Fetch handler for Vellum's
`/read/api/anime/*` and shared `/read/api/video/*` contracts. It reads public
metadata directly from AniList and keeps playback behind Vellum's Slipgate. It
does not call Miruro's private secure pipe or contain Miruro obfuscation values;
the fallback preserves Miruro's current `pewe` IDs and resolves them through the
matching AniDB App upstream.

Deploy the module in any Web Fetch API runtime (Cloudflare Workers, Bun, or a
small Node wrapper) and route `/read/api/anime/*` to `handleAnimeRequest`.

Server environment:

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
