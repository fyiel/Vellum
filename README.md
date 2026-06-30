# Vellum

a reading app that feels native everywhere. one vanilla js ui, wrapped by tauri on the
desktop and capacitor on mobile, talking to the hosted reader backend.

## stack

one ui codebase in plain html, css and es modules. no framework. vite is tooling only, it
bundles the app and runs the dev proxy. tauri 2 gives the desktop build a tiny footprint by
riding the system webview. capacitor 6 ships the same bundle to android and ios.

## layout

```
index.html              the shell, screen markup gets wired in here
src/
  main.js               boot. picks the platform transport then starts the router
  lib/
    http.js             platform aware fetch and the api base
    api.js              the four backend route wrappers
    store.js            localStorage for read state, positions, library, settings
    router.js           hash router, parse and navigate only
    native.js           swaps the transport for a cors free one in native shells
src-tauri/              the desktop shell
capacitor.config.json   the mobile config
vite.config.js          dev server and the api proxy
```

## how the data flows

the backend ships no cors headers, so the path to it depends on where the app runs. in browser
dev the request goes out on a relative path and vite proxies it to the host. on desktop tauri
runs the fetch through rust via its http plugin. on mobile capacitor http makes the request
natively. all three land on the same backend and get back the same json. one env var,
VITE_API_HOST, repoints the whole app at a different backend.

## run it

```
bun install
bun run dev              web dev at localhost 5173

bun run desktop          tauri dev window
bun run desktop:build    packaged desktop binary

bun run mobile:add:android   generate the android project
bun run mobile:add:ios       generate the ios project (needs macos)
bun run mobile:sync          rebuild the web bundle and sync it into the native projects
```

the android and ios folders are platform output so they stay out of git and get generated on
demand with the add scripts.

## what is wired and what waits

the plumbing is done. api, storage, routing, platform transports and both native shells all
work. the screens themselves get wired up as their design html arrives, since each one binds
to its own markup. drop a screen in and the logic hangs off it.
