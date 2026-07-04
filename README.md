# Vellum

A fast, native-feeling reader for web novels and light novels

Vellum runs as a lightweight web frontend on a Rust/Tauri backend, so the same
interface ships as a native desktop app and as a web build. Chapters and browsing
data are cached locally, so searching, browsing, and reading stay responsive

> **Status:** actively developed. Tested on Linux (Arch). Desktop builds for
> Windows and macOS are expected to work but aren't verified yet, and there's no
> mobile-optimized build yet, see [Mobile](#mobile)

## Features

- **Library** tracks what you're reading and resumes where you left off
- **Discover** browse trending titles and filter by tag or genre
- **Updates** new chapters for the series you follow
- **Reader** clean, distraction-free reading view

## Try it

- **Web:** https://fyiel.github.io/Vellum/ runs anywhere, but the native app is noticeably faster.
- **Desktop:** download a build from [Releases](https://github.com/fyiel/Vellum/releases).

## Platform support

| Platform      | Status                        |
|---------------|-------------------------------|
| Linux (x86_64)| Tested (Arch)                 |
| Windows       | Builds; not yet tested        |
| macOS         | Builds; not yet tested        |
| iOS / Android | Planned — no mobile build yet |

## Mobile

There's no mobile-optimized build of Vellum yet. Until there is,
[pumg.fyi/read](https://pumg.fyi/read) works better on phones.

## Build from source

Requires [Rust](https://rustup.rs) and [Node.js](https://nodejs.org). On Linux
you'll also need the Tauri system dependencies — see the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

​```bash
npm install
npm run tauri dev      # run the desktop app with hot reload
npm run tauri build    # produce a native build
npm run web:build      # produce the static web build
​```

## Tech stack

- **Frontend:** Vite + vanilla JS/CSS
- **Backend / shell:** Rust via [Tauri](https://tauri.app)
- **Web:** static build deployed to GitHub Pages

## Demo

[![Vellum](https://files.catbox.moe/5l5o8g.png)](https://files.catbox.moe/2607z9.mp4)

▶ [Watch the demo video](https://files.catbox.moe/2607z9.mp4)

## License

<MIT — see LICENSE>
