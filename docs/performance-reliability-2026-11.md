# Performance and reliability engineering changelog — 8–9 November 2026

This records the work on `codex/performance-reliability-20261107` compared with
`aa492aa` (`master` when the engineering work began). The 112 engineering commits
are listed individually below. Changes address the existing Vellum client and
its native integration, with regression coverage for desktop and web behavior.

## Performance improvements

- **Novel startup and offline reading:** Avoid parsing text-only chapters for
  illustrations, and checkpoint unchanged downloaded chapters so subsequent
  launches skip the expensive full storage scan. A benchmark with 250 ~19 KB
  text chapters and one illustrated chapter improved from ~178 ms / 252 file
  reads to ~7.2–7.7 ms / 3 reads on a subsequent launch. Chapter illustration
  downloads are now bounded and parallel, and saved illustrations load in
  parallel with cancellation support. A representative illustration benchmark
  measured 249.7 ms serial versus 64.8 ms concurrent.
- **Manga reading and downloads:** Read cached pages concurrently and overlap
  reader metadata requests. Bound page downloads to avoid unnecessary serial
  waits without unbounded work. A representative 18-page download benchmark
  measured 374.5 ms serial versus 65.2 ms concurrent. Reuse sorted catalog
  results and update chapters, tiles, and reading progress incrementally.
- **Video and media:** Prefetch HLS segments with bounded concurrency and
  decrypt subtitles in batches. Avoid redundant update-ledger reads during
  playback progress. Reuse filtered episode matches when revealing more rows.
- **Large library and browse views:** Append additional manga chapters, video
  episodes, reader drawer links, and browse pages without replacing visible
  elements. Retain unchanged library rows, keyboard focus, and scroll context.
  Limit search work to matches that can actually be displayed. Update only the
  affected download controls and alert indicators rather than repainting all
  cards.
- **Request and persistence overhead:** Cache cover-registry lookups; avoid
  unnecessary update-ledger writes and repeated novel history scans; move
  GTK cookie waits off the Tauri asynchronous worker threads.

## Reliability and correctness fixes

- **Offline novel data:** Preserve downloaded chapters and illustrations
  during failed cleanup, interrupted repair, deletion races, missing provider
  metadata, and retries. Keep chapter totals and reading position consistent.
  Repair image references across uppercase, single-quoted, double-quoted, and
  unquoted legacy HTML attributes without overwriting occupied image slots.
- **Offline manga data:** Reject incomplete/empty saved pages and recover from
  interrupted redownloads or streaming failures. Preserve remaining pages,
  read progress, and chapter navigation when metadata or provider requests
  fail. Scope batch controls to the correct title.
- **Offline video data and playback:** Reject incomplete streams; protect
  native media writes and stop incomplete writes before cleanup. Keep download
  registry entries if file deletion fails. Preserve WebM types and play saved
  episodes even when a provider omits them. Support HLS encryption key changes,
  AES-128 initialization maps, and byte ranges; report unsupported encryption
  and playlist failures. Offer an embed fallback when HLS playback is
  unsupported. Bound stalled downloads even if a stream emits empty chunks.
- **Cache and covers:** Recover IndexedDB reads when transactions close or a
  database version changes, including blocked upgrades. Retry missing or
  temporarily unreadable cached covers, prevent offline cover filename
  collisions, and release failed or detached object URLs. Retain cached
  content if registry writes fail and avoid stale cache repaint events.
- **Navigation and networks:** Settle requests when transports ignore abort,
  cancel abandoned catalogues, chapter lists, Discover pagination, detail
  views, subtitles, embed checks, and AniList lookups. Clear stale detail
  content across formats and resolve loading or retry states after failures.
- **Library and updates:** Preserve followed titles and every pending update
  during partial or shrinking provider responses. Keep acknowledgement state
  across concurrent checks, refresh saved chapter caches and library cards,
  and synchronize download registry changes across browser tabs.

## Verification

The latest completed full offline Playwright run on the code at `0a637ee`
passed **345/345 tests**. The unit suite reported **89 passed, 1 skipped**;
`npm run build`, `npm run web:build`, and `git diff --check` succeeded. Targeted
tests were added for download failure and repair, offline manga/novel/video
loading, cover fallback and quota handling, request cancellation, IndexedDB
recovery, navigation, scrolling, list rendering, HLS and update state.

Benchmarks above are recorded results from the engineering work; they are
workload-specific and should not be interpreted as universal startup or
network-speed guarantees.

## Open investigations and limits

- The cover cache holds up to 240 entries. With more than 240 downloaded titles,
  repeated library visits may requeue evicted covers; this remains an
  investigation and is **not** reported as fixed.
- Native Tauri and mobile device integration, live external providers, and
  full end-user performance across devices require separate validation. The
  Playwright run exercised offline browser behavior.
- Both Vite builds succeed but warn about a minified HLS chunk over 500 kB.
- This work contains no dependency additions, releases, deployments, or
  automatic production migration.

## Complete engineering commit log (oldest first)

1. `8bfdbdc` — fix: abort manga downloads before saving cancelled copies
2. `20c1c38` — perf: parallelize saved manga reads and overlap reader metadata
3. `a6bbe92` — perf: speed up offline novel illustration loading and cancellation
4. `d71967c` — fix: release failed and detached offline cover URLs
5. `901fb81` — fix: cancel and release encrypted subtitle tracks on navigation
6. `d893d83` — fix: cancel pending embed liveness probes on navigation
7. `44d3afd` — fix: preserve offline video media types for WebM downloads
8. `8808967` — fix: promptly cancel cache reads and pending provider results
9. `67ea7f1` — fix: reopen cache after IndexedDB version changes
10. `02aa7ec` — fix: preserve offline covers when registry writes fail
11. `103fd22` — fix: roll back interrupted novel chapter repairs
12. `fbe8620` — fix: serialize novel repair cancellation with deletion
13. `bb66a16` — fix: surface HLS playlist HTTP errors to downloaders
14. `e302f2d` — fix: decrypt AES-128 HLS initialization maps
15. `57fa55a` — fix: retain HLS initialization maps across segment changes
16. `deed21f` — fix: wait for active media writes before deleting downloads
17. `ad13e98` — fix: reject unsupported HLS encryption after key changes
18. `8b02176` — fix: honor HLS byte ranges in offline video downloads
19. `be92914` — fix: cancel stale library and updates checks on navigation
20. `93ea940` — fix: preserve update acknowledgements during pending checks
21. `d6473e1` — perf: keep GTK cookie waits off Tauri async workers
22. `5033334` — fix: cancel abandoned manga and watch catalogue loads
23. `7ddb782` — fix: cancel abandoned Discover feeds and resume pagination
24. `e176a63` — fix: cancel abandoned detail and chapter list requests
25. `db087ec` — fix: settle manga chapter panel after metadata failure
26. `94ba58f` — fix: cancel pending chapter filters on detail navigation
27. `81cc6bb` — fix: offer retry after novel detail metadata failures
28. `d90a2ce` — fix: clear stale shared detail content across formats
29. `ae1cd57` — perf: cache cover registry and recover stalled cover prefetches
30. `45ac90f` — perf: avoid repeated update ledger writes on mark all
31. `177f7ff` — fix: settle API requests when transports ignore abort
32. `e0cbfd0` — fix: settle stalled media downloads and release jobs
33. `50a98b6` — fix: bound novel illustration fetches and unblock repair cancellation
34. `63cc6f8` — fix: settle stalled AniList lookups and unblock Watch feeds
35. `46187e0` — fix: ignore embed liveness responses after probe timeout
36. `b2f5374` — fix: settle abandoned encrypted subtitle requests
37. `a14b856` — perf: decrypt encrypted subtitles in bounded batches
38. `0e98414` — perf: download manga pages with bounded concurrency
39. `2801ba7` — perf: prefetch HLS segments with bounded concurrency
40. `b2b069a` — perf: avoid reloading update ledger during playback progress
41. `02696a4` — perf: avoid update ledger reads on manga page progress
42. `0f32c14` — fix: preserve manga chapter totals during offline progress
43. `c2b2b3c` — fix: keep known novel chapter totals during offline reading
44. `b52704b` — fix: track read progress when opening offline manga
45. `ba2d81b` — fix: navigate saved manga chapters without provider metadata
46. `5da6b6f` — perf: reuse sorted manga catalog across navigation
47. `6d15abe` — perf: avoid rescanning novel read history on navigation
48. `c6f1ea6` — fix: resolve failed progressive search loading state
49. `c5b9186` — fix: retry retained manga pages after chapter streaming
50. `d4f217b` — perf: overlap novel illustration downloads in bounded batches
51. `84ba460` — fix: recover from failed manga chapter streaming
52. `03e7da0` — fix: preserve novel resume position after chapter retry
53. `ed0c8c7` — fix: notify active cache readers without stale refresh repaint
54. `5826d79` — fix: reject incomplete offline video responses
55. `669fd41` — fix: reject empty saved manga pages when opening offline
56. `436b8f9` — fix: persist full native video writes
57. `f7ae240` — fix: retry offline covers after cached files become available
58. `a678100` — fix: restore unread manga and video alerts after acknowledgement
59. `d60fcd7` — fix: refresh followed series and share updated chapter caches
60. `cdd83bc` — perf: update library alerts without rebuilding rows
61. `1eb703c` — perf: keep browse cards mounted while loading more
62. `15706e0` — perf: append browse pages without remounting existing cards
63. `747f65f` — perf: prune manga shelf without replacing visible cards
64. `a2d5898` — perf: update manga and video download buttons in place
65. `c14f5a0` — fix: recover missing or empty offline cover files
66. `0b7e9a4` — fix: reject empty offline video downloads
67. `fd58ac4` — fix: recover missing offline video downloads
68. `9930f9e` — fix: recover incomplete offline manga chapters
69. `4bc3455` — fix: recover invalid offline novel chapters safely
70. `67be5f5` — fix: preserve offline cover cache after temporary read errors
71. `11bc533` — fix: refresh novel reader HTML when saved chapter changes
72. `0c0d5d0` — fix: resume disk caching after blocked IndexedDB upgrade
73. `417982d` — fix: restore surviving manga pages after failed redownload
74. `3247d67` — fix: retain every followed library title
75. `a9d7689` — fix: preserve novel position across failed chapter switches
76. `03eccc4` — fix: persist visible manga page before rapid mode switches
77. `4a797d2` — fix: rehydrate novel catalog after offline fallback
78. `a0f23bd` — fix: offer embed when HLS playback is unsupported
79. `4832a8a` — fix: update novel download control after deletion
80. `f2f2d06` — perf: avoid redundant novel download button mutations
81. `d709578` — perf: cache novel chapter row targets during filtering
82. `495787d` — fix: scope download batch controls to each title
83. `f26086d` — fix: retain downloads when filesystem deletion fails
84. `6b6a4c3` — fix: play saved video after provider removes episode
85. `19f174d` — fix: start saved video before catalogue responds
86. `a0c7bad` — fix: open saved manga before provider metadata
87. `c9980e9` — fix: preserve novel downloads when illustration cleanup fails
88. `2e20e47` — fix: recover when IndexedDB cache transactions close
89. `b727a4f` — fix: prevent offline cover cache filename collisions
90. `dff8a7d` — fix: abort partial OPFS video writes before cleanup
91. `ca60441` — fix: reclaim redundant update snapshots under storage pressure
92. `1153c99` — fix: timeout stalled direct video streams despite empty chunks
93. `aac48b2` — fix: retain unread updates when provider lists shrink
94. `583d368` — fix: preserve all pending updates across partial provider responses
95. `9e939b6` — perf: update only the changed novel download button
96. `396120d` — perf: update only changed manga download buttons
97. `a33a54a` — perf: append manga chapter batches without rebuilding rows
98. `9eddf5c` — perf: append video episode batches without rebuilding rows
99. `30abb1e` — perf: repaint only affected video download buttons
100. `6de7179` — perf: append manga reader drawer chapter batches
101. `693e900` — perf: extend novel reader drawer without rebuilding links
102. `148223b` — perf: stop novel drawer search at visible result limit
103. `3989ced` — perf: reuse manga drawer chapter search matches on reveal
104. `84e81a3` — perf: reuse manga chapter search results on reveal
105. `e68cf30` — perf: reuse video episode search matches on reveal
106. `43e7134` — perf: reconcile saved downloads without replacing library rows
107. `64f5143` — fix: update download registry listeners across tabs
108. `04f3350` — perf: retain unchanged library rows and keyboard focus
109. `5b72ded` — test: force fresh images when checking offline covers
110. `68be119` — fix: keep library tiles and followed titles in sync
111. `3d57dc5` — perf: checkpoint scanned novel chapters across launches
112. `0a637ee` — fix: preserve and load legacy novel illustration slots
