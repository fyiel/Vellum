import { apiUrl } from "./http.js";
import { esc } from "./dom.js";

const enc = encodeURIComponent;

const isNu = (u) => /novelupdates\.com/i.test(u || "");
const isTauri = () => !!window.__TAURI_INTERNALS__;
const placeholder = (u) => !u || /noimagemid/i.test(u);
const resolver = (title) => apiUrl(`/read/api/cover?t=${enc(title)}`);

// the src a cover image should load from: nucover in tauri (now cors-open so
// canvases can read it), the api resolver elsewhere, empty when there is none
export function coverSrc(url, title) {
  const fb = title ? resolver(title) : "";
  let src = placeholder(url) ? fb : url;
  if (isNu(url) && !placeholder(url)) src = isTauri() ? `nucover://cover/?u=${enc(url)}` : fb;
  return src || "";
}

export function coverImg(url, title) {
  const fb = title ? resolver(title) : "";
  const src = coverSrc(url, title);
  let nu = "";
  if (src.startsWith("nucover://")) nu = ` data-nu="${esc(src)}"`;
  if (!src) return "";
  const cf = fb && fb !== src ? ` data-cf="${esc(fb)}"` : "";
  return `<img src="${esc(src)}"${cf}${nu} loading="lazy" alt="">`;
}

let installed = false;
export function installCoverFallback() {
  if (installed) return;
  installed = true;
  document.addEventListener(
    "error",
    (e) => {
      const img = e.target;
      if (img?.tagName !== "IMG" || !(img.dataset.cf || img.dataset.nu)) return;
      // one hop to the resolver, then give up quietly so a broken icon never shows over the placeholder
      if (img.dataset.cf && !img.dataset.cfDone) {
        img.dataset.cfDone = "1";
        img.src = img.dataset.cf;
        return;
      }
      img.style.display = "none";
    },
    true,
  );
}
