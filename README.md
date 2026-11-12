# Vellum

A fast, native-feeling reader for web novels and light novels

Vellum runs as a lightweight web frontend on a Rust/Tauri backend, so the same
interface ships as a native desktop app and as a web build. Chapters and browsing
data are cached locally, so searching, browsing, and reading stay responsive

> **Status:** actively developed. Tested on Linux (Arch). Desktop builds for
> Windows and macOS are expected to work but aren't verified yet; the web build
> is mobile-optimized, see [Mobile](#mobile)

## Features

- **Library** tracks what you're reading and resumes where you left off
- **Discover** browse trending titles and filter by tag or genre
- **Manga** browse and read manga, manhwa, and manhua
- **Watch** browse and play anime and K-drama
- **Updates** new chapters for the series you follow
- **Reader** clean, distraction-free reading view
- **Downloads** save chapters and episodes for offline reading and watching
- **Offline** the web app loads without a connection once visited; desktop is fully local

## Try it

- **Web:** https://fyiel.github.io/Vellum/ runs anywhere, but the native app is noticeably faster.
- **Desktop:** download a build from [Releases](https://github.com/fyiel/Vellum/releases).

## Platform support

| Platform      | Status                        |
|---------------|-------------------------------|
| Linux (x86_64)| Tested (Arch)                 |
| Windows       | Builds; not yet tested        |
| macOS         | Builds; not yet tested        |
| iOS / Android | Planned — no native build yet |

## Mobile

The web build is optimized for touch: compact series-detail layouts, a
collapsible top bar, and mobile-sized chapter lists on manga and novel pages.
Native iOS/Android builds are planned — until then, the web build works well in
a phone browser.

## Anime & video data path

Anime browse and search hit [AniList](https://anilist.co) directly from the
client — their GraphQL API is CORS-open, so it needs no proxy. Everything that
does need a server goes through the [pumg.fyi](https://pumg.fyi) adapter:
episode lists and media (anidb.app is Cloudflare-gated, with a HiAnime embed
fallback when it is down), playback, and the K-drama catalogue. Miruro.tv uses
the same AniList catalogue.

## Build from source

Requires [Rust](https://rustup.rs), [Node.js](https://nodejs.org) 20 or later,
and [Bun](https://bun.sh). Install dependencies with `bun install --frozen-lockfile`
so the mobile tooling patch is applied. On Linux also install the
[Tauri system dependencies](https://v2.tauri.app/start/prerequisites/).

## Tests

- `bun run test:unit` runs every deterministic Node unit test.
- `bun run test:security` checks the locked dependencies for known vulnerabilities.
- `bun run test:e2e:offline` runs provider-independent Chromium browser tests with mocked data.
- `bun run test:e2e:live` runs the `@live` catalogue, download, and subtitle tests against the real providers. These need network access and may fail when a provider is unavailable.
- `bun run test:e2e` runs both browser groups. Set `VELLUM_TEST_PORT` to use a port other than 5173.

Install the test browser with `bunx playwright install chromium`. CI runs the dependency
audit, unit tests, browser tests with mocked data, and production build before Pages
or release builds can publish.

Dependency overrides keep the Capacitor 6 build tools on fixed archive and glob
packages. The Capacitor CLI patch uses the archive package's named export.
Unit tests extract all three mobile templates and check migration cleanup so
dependency updates cannot silently break platform generation. Keep the patch and
overrides until the mobile toolchain can use fixed dependencies directly.

## Tech stack

- **Frontend:** Vite + vanilla JS/CSS
- **Backend / shell:** Rust via [Tauri](https://tauri.app)
- **Web:** static build deployed to GitHub Pages

## Demo

[![Vellum](https://files.catbox.moe/5l5o8g.png)](https://files.catbox.moe/2607z9.mp4)

▶ [Watch the demo video](https://files.catbox.moe/2607z9.mp4)

## License

Vellum is licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) — see [LICENSE](LICENSE).

You're free to use, study, modify, self-host, share, and fork Vellum, with two conditions:

- **NonCommercial** — you may not sell it, or use it or any fork for commercial advantage.
- **ShareAlike** — anything you distribute that's based on Vellum must be released under this same license and kept open source, never taken closed.

Attribution to the original author is required.
