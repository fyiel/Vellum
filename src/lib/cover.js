import { apiUrl } from "./http.js";
import { cachedCover, localCover } from "./cover-cache.js";
import { esc } from "./dom.js";

const enc = encodeURIComponent;

const isNu = (u) => /novelupdates\.com/i.test(u || "");
const isTauri = () => !!window.__TAURI_INTERNALS__;
const placeholder = (u) => !u || /noimagemid/i.test(u);
const resolver = (title) => apiUrl(`/read/api/cover?t=${enc(title)}&v=nu1`);

export function coverImg(url, title, options = {}) {
  const useResolver = typeof options === "boolean" ? options : options.useResolver !== false;
  const eager = typeof options === "object" && options.eager === true;
  const cached = typeof options === "object" && options.cache === true;
  // only the surfaces you look at with no network carry the lookup key for a stored copy
  const keep = cached || typeof options === "object" && options.offline === true;
  const fb = useResolver && title ? resolver(title) : "";
  let src = placeholder(url) ? fb : url;
  let nu = "";
  if (isNu(url) && !placeholder(url)) {
    if (isTauri()) {
      src = `nucover://cover/?u=${enc(url)}`;
      nu = ` data-nu="${esc(src)}"`;
    } else src = fb;
  }
  if (!src) return "";
  const cf = fb && fb !== src ? ` data-cf="${esc(fb)}"` : "";
  const hide = !useResolver ? " data-hide-error" : "";
  // the offline copy is keyed by the url we asked for, so remember it on the element
  const remember = keep ? (url && !placeholder(url) ? url : fb) : "";
  const offline = remember ? ` data-cover="${esc(remember)}"` : "";
  const imageSource = cached ? `data-src="${esc(src)}" data-cache-cover data-title="${esc(title)}"` : `src="${esc(src)}"`;
  return `<img ${imageSource}${cf}${nu}${offline}${hide} loading="${eager ? "eager" : "lazy"}"${eager ? ' fetchpriority="high"' : ""} alt="">`;
}

let installed = false;
export function installCoverFallback() {
  if (installed) return;
  installed = true;
  const pending = new Map();
  const useLocal = (img, blob) => {
    pending.get(img)?.();
    const url = URL.createObjectURL(blob);
    const release = () => {
      if (pending.get(img) !== release) return;
      pending.delete(img);
      img.removeEventListener("load", release);
      img.removeEventListener("error", release);
      URL.revokeObjectURL(url);
      if (img.naturalWidth) img.style.removeProperty("display");
    };
    pending.set(img, release);
    img.addEventListener("load", release);
    img.addEventListener("error", release);
    img.src = url;
  };
  // a lazy img created while offline is not fetched at all — it just sits there pending, so no
  // error ever fires and the fallback below would never run. swap in the stored copy up front.
  const hydrate = async (img) => {
    if (!img?.dataset?.cover || img.dataset.coverDone) return;
    img.dataset.coverDone = "1";
    const blob = await localCover(img.dataset.cover).catch(() => null);
    if (!blob || !img.isConnected) {
      delete img.dataset.coverDone;
      return;
    }
    useLocal(img, blob);
  };
  const hydrateCached = async (img) => {
    if (!img?.dataset?.cover || img.dataset.coverDone) return;
    img.dataset.coverDone = "1";
    const blob = await cachedCover(img.dataset.cover, img.dataset.title).catch(() => null);
    if (!img.isConnected) return;
    if (blob) useLocal(img, blob);
    else {
      delete img.dataset.coverDone;
      img.src = img.dataset.src;
    }
  };
  const cachedImages = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      cachedImages.unobserve(entry.target);
      void hydrateCached(entry.target);
    }
  }, { rootMargin: '300px' }) : null;
  const watchCached = root => {
    const imgs = root instanceof HTMLImageElement ? [root] : [...(root.querySelectorAll?.('img[data-cache-cover]') ?? [])];
    for (const img of imgs) if ('cacheCover' in img.dataset && !img.dataset.coverDone) {
      if (cachedImages) cachedImages.observe(img);
      else void hydrateCached(img);
    }
  };
  const hydrateSoon = (root) => {
    if (navigator.onLine !== false) return;
    const imgs = root instanceof HTMLImageElement
      ? [root]
      : [...(root.querySelectorAll?.("img[data-cover]") ?? [])];
    for (const img of imgs) void hydrate(img);
  };
  window.addEventListener("offline", () => hydrateSoon(document));
  new MutationObserver((records) => {
    for (const record of records) {
      // Cards can be removed before an image fires load/error. Retire their URLs.
      if (pending.size) for (const node of record.removedNodes) {
        if (node instanceof HTMLImageElement) { if (!node.isConnected) pending.get(node)?.(); }
        else for (const img of node.querySelectorAll?.("img") ?? []) if (!img.isConnected) pending.get(img)?.();
      }
      if (cachedImages) for (const node of record.removedNodes) {
        if (node.isConnected) continue;
        if (node instanceof HTMLImageElement) cachedImages.unobserve(node);
        else for (const img of node.querySelectorAll?.('img[data-cache-cover]') ?? []) cachedImages.unobserve(img);
      }
      for (const node of record.addedNodes) watchCached(node);
      if (navigator.onLine === false) for (const node of record.addedNodes) hydrateSoon(node);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  watchCached(document);
  document.addEventListener(
    "error",
    async (e) => {
      const img = e.target;
      if (img?.tagName !== "IMG" || !(img.dataset.cf || img.dataset.nu || 'hideError' in img.dataset)) return;
      // the host died while we are online, or the resolver is gone too: the stored copy is the
      // last thing that can still paint this tile
      if (img.dataset.cover && !img.dataset.coverDone && (img.dataset.cfDone || !img.dataset.cf)) {
        img.dataset.coverDone = "1";
        const blob = await localCover(img.dataset.cover).catch(() => null);
        if (blob && img.isConnected) {
          useLocal(img, blob);
          return;
        }
        delete img.dataset.coverDone;
      }
      // one hop to the resolver, then give up quietly so a broken icon never shows over the placeholder
      if (img.dataset.cf && !img.dataset.cfDone) {
        img.dataset.cfDone = "1";
        img.src = img.dataset.cf;
        return;
      }
      if ('hideError' in img.dataset) img.remove();
      else img.style.display = "none";
    },
    true,
  );
}
