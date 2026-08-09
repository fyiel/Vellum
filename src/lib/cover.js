import { apiUrl } from "./http.js";
import { esc } from "./dom.js";

const enc = encodeURIComponent;

const isNu = (u) => /novelupdates\.com/i.test(u || "");
const isTauri = () => !!window.__TAURI_INTERNALS__;
const placeholder = (u) => !u || /noimagemid/i.test(u);
const resolver = (title) => apiUrl(`/read/api/cover?t=${enc(title)}`);

export function coverImg(url, title, useResolver = true) {
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
  return `<img src="${esc(src)}"${cf}${nu}${hide} loading="lazy" alt="">`;
}

let installed = false;
export function installCoverFallback() {
  if (installed) return;
  installed = true;
  document.addEventListener(
    "error",
    (e) => {
      const img = e.target;
      if (img?.tagName !== "IMG" || !(img.dataset.cf || img.dataset.nu || 'hideError' in img.dataset)) return;
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
