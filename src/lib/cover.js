import { apiUrl } from "./http.js";
import { localCover } from "./cover-cache.js";
import { esc } from "./dom.js";

const enc = encodeURIComponent;

const isNu = (u) => /novelupdates\.com/i.test(u || "");
const isTauri = () => !!window.__TAURI_INTERNALS__;
const placeholder = (u) => !u || /noimagemid/i.test(u);
const resolver = (title) => apiUrl(`/read/api/cover?t=${enc(title)}`);

export function coverImg(url, title, options = {}) {
  const useResolver = typeof options === "boolean" ? options : options.useResolver !== false;
  const eager = typeof options === "object" && options.eager === true;
  // only the surfaces you look at with no network carry the lookup key for a stored copy
  const keep = typeof options === "object" && options.offline === true;
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
  return `<img src="${esc(src)}"${cf}${nu}${offline}${hide} loading="${eager ? "eager" : "lazy"}"${eager ? ' fetchpriority="high"' : ""} alt="">`;
}

let installed = false;
export function installCoverFallback() {
  if (installed) return;
  installed = true;
  // a lazy img created while offline is not fetched at all — it just sits there pending, so no
  // error ever fires and the fallback below would never run. swap in the stored copy up front.
  const hydrate = async (img) => {
    if (!img?.dataset?.cover || img.dataset.coverDone) return;
    img.dataset.coverDone = "1";
    const blob = await localCover(img.dataset.cover).catch(() => null);
    if (!blob || !img.isConnected) return;
    const url = URL.createObjectURL(blob);
    img.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
    img.src = url;
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
    if (navigator.onLine !== false) return;
    for (const record of records) for (const node of record.addedNodes) hydrateSoon(node);
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener(
    "error",
    async (e) => {
      const img = e.target;
      if (img?.tagName !== "IMG" || !(img.dataset.cf || img.dataset.nu || 'hideError' in img.dataset)) return;
      // the host died while we are online, or the resolver is gone too: the stored copy is the
      // last thing that can still paint this tile
      if (img.dataset.cover && !img.dataset.coverDone && (img.dataset.cfDone || !img.dataset.cf)) {
        const before = img.dataset.coverDone;
        img.dataset.coverDone = "1";
        const blob = await localCover(img.dataset.cover).catch(() => null);
        if (blob && img.isConnected) {
          const url = URL.createObjectURL(blob);
          img.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
          img.src = url;
          return;
        }
        if (before) img.dataset.coverDone = before;
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
