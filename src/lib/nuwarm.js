const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

let warmed = false;

// cloudflare can take a while to clear, retry the cookie read a few times before
// retiring the warm webview so a slow challenge still lands
const ATTEMPTS = 4;
const RETRY_MS = 9000;

export async function warmNuClearance() {
  if (warmed || !window.__TAURI_INTERNALS__) return;
  warmed = true;
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const { invoke } = await import("@tauri-apps/api/core");
    const old = await WebviewWindow.getByLabel("nuwarm");
    if (old) await old.close().catch(() => {});

    const w = new WebviewWindow("nuwarm", {
      url: "https://www.novelupdates.com/",
      visible: false,
      skipTaskbar: true,
      focus: false,
      width: 1200,
      height: 900,
      userAgent: CHROME_UA,
    });

    let tries = 0;
    const attempt = async () => {
      tries++;
      try {
        const ok = await invoke("nu_refresh", { ua: CHROME_UA });
        if (ok) {
          await w.close().catch(() => {});
          retryNuCovers();
          return;
        }
      } catch {}
      if (tries < ATTEMPTS) setTimeout(attempt, RETRY_MS);
      else await w.close().catch(() => {});
    };
    setTimeout(attempt, 18000);
  } catch (e) {
    console.warn("nu clearance warm failed", e);
  }
}

export function retryNuCovers() {
  document.querySelectorAll("img[data-nu]").forEach((img) => {
    delete img.dataset.cfDone;
    img.style.display = "";
    img.src = img.dataset.nu;
  });
}
