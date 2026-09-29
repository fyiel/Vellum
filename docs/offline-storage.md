# Keeping downloads on iPhone and iPad

Use Safari’s **Share → Add to Home Screen**, open Vellum from that icon, then download your books there. Safari and the Home Screen app have separate storage; existing Safari downloads do not move automatically.

Vellum requests persistent storage for downloads and Home Screen use. The Downloads section reports whether the browser granted it. Saved chapters, images and videos have no automatic expiry. Novel downloads remain readable even if their online metadata cache has been cleared.

This is not a guarantee of permanent storage. Safari can decline persistence, and removing the app or clearing its website data can remove saved content. Private browsing is unsuitable for keeping downloads. Cookies also retain the expiry and access rules imposed by Safari and the site that issued them.

The current web download writer requires OPFS writable streams, supported in Safari 26 and later. Persistence requests are supported from Safari 17; availability alone does not guarantee a grant.

Vellum keeps its offline application shell separately from downloaded files. App updates replace the shell, while downloaded files remain. Live searches and playback URLs are refreshed instead of being retained indefinitely by the service worker.

References: [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/), [Home Screen storage exemption](https://webkit.org/tracking-prevention/#home-screen-web-application-domain-exempt-from-itp), [Safari 26 writable-stream support](https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes).
