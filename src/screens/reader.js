import DOMPurify from "dompurify";
import {
  getSeries,
  getChapters,
  getChapter,
  prefetchChapter,
  seriesKey,
} from "../lib/api.js";
import { go, back, hashSlug } from "../lib/router.js";
import { loadDownloadedNovelChapter } from "../lib/dl-novel.js";
import {
  readSet,
  saveRead,
  posGet,
  posSet,
  touchLibrary,
  loadSettings,
  saveSettings,
  SET_DEFAULT,
} from "../lib/store.js";
import { $, $$, esc } from "../lib/dom.js";

let settings = loadSettings();
const THEME_BG = {
  dark: "#181818",
  black: "#000000",
  sepia: "#f4ecd8",
  light: "#fbfbfd",
};
const WIDTHS = { narrow: "34em", normal: "40em", wide: "46em" };
const applySettings = () => {
  const r = $("#reader");
  r.dataset.theme = settings.theme;
  r.style.setProperty("--rsize", settings.size + "px");
  r.style.setProperty("--rlh", settings.lh);
  r.style.setProperty("--rwidth", WIDTHS[settings.width] ?? WIDTHS.normal);
  r.style.setProperty(
    "--rfont",
    settings.font === "sans" ? "var(--font)" : "var(--serif)",
  );

  const bg = THEME_BG[settings.theme];
  document.querySelector("meta[name=theme-color]").content = bg;
  // reader scrolls the document (so Safari minimises its toolbar. paint the page bg to match during rubber band)
  if (state.view === "reader") document.body.style.background = bg;
};

const state = { view: "home", series: null, slug: null, chapters: [] };

const R = $("#reader");
const prose = $("#reader-prose");
const rfoot = $("#reader-foot");
let chromeHidden = false;
const rd = {
  slug: null,
  gen: 0,
  first: 0,
  last: -1,
  cur: -1,
  loading: false,
  ploading: false,
  buffering: false,
  end: false,
  failed: false,
  ctrl: null,
};

const chapterIndex = (n) => state.chapters.findIndex((c) => c.n === n);
const blockFor = (idx) => prose.querySelector(`.ch-block[data-idx="${idx}"]`);

// block geometry is read on every scroll frame, cache it and rebuild only when the
// stream mutates or the viewport changes so layout is not forced per frame
let offCache = new Map();
const rebuildOffsets = () => {
  offCache = new Map();
  for (const b of prose.querySelectorAll(".ch-block")) {
    offCache.set(Number(b.dataset.idx), { top: b.offsetTop, h: b.offsetHeight });
  }
};
const offOf = (idx, b) => offCache.get(idx) ?? { top: b.offsetTop, h: b.offsetHeight };

const scrollY = () => window.scrollY;
const viewH = () => window.innerHeight;
const docH = () => document.documentElement.scrollHeight;

prose.addEventListener(
  "load",
  (e) => {
    const img = e.target;
    if (img.tagName !== "IMG" || state.view !== "reader") return;
    const r = img.getBoundingClientRect();
    // compensate the full growth so the reading text never drifts, this is exact
    // because chapter images always grow from zero height
    if (r.top < 0) window.scrollBy(0, r.bottom - r.top);
    rebuildOffsets();
  },
  true,
);

window.addEventListener("resize", rebuildOffsets);

export async function showReader(slug, n) {
  rd.ctrl?.abort();
  const ctrl = new AbortController();
  rd.ctrl = ctrl;
  const routeGen = ++rd.gen;
  state.view = "reader";
  state.series = null; // never carry the previous series metadata into this slug's library entry
  R.classList.add("active");
  // takeover hides the shell and lets the document scroll through the reader
  document.documentElement.classList.add("reading");
  document.body.classList.add("reading");
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  applySettings();

  if (state.slug !== slug || !state.chapters.length) {
    prose.innerHTML = `<div class="spinner"></div>`;
    rfoot.innerHTML = "";
    try {
      const { chapters } = await getChapters(slug, { signal: ctrl.signal });
      if (routeGen !== rd.gen) return; // closed or re navigated while the list was loading
      if (!Array.isArray(chapters)) throw new Error("couldn't load the chapter list");
      state.slug = slug;
      state.chapters = chapters;
    } catch (e) {
      if (routeGen !== rd.gen) return; // a dead route must not render into the live view
      prose.innerHTML = `<div class="empty">${esc(e.message)}<button class="btn" id="reader-list-retry">retry</button></div>`;
      $("#reader-list-retry").onclick = () => showReader(slug, n);
      return;
    }
  }
  if (document.fonts?.ready) document.fonts.ready.then(rebuildOffsets);
  if (state.series?.nfSlug !== slug) hydrateSeries(slug, ctrl);

  const idx = chapterIndex(n);
  if (idx < 0) {
    prose.innerHTML = `<div class="empty">chapter ${esc(n)} isn’t available</div>`;
    rfoot.innerHTML = "";
    return;
  }
  const pos = posGet(slug);
  await startAt(slug, idx, pos && pos.n === n ? pos.p : 0);
}

async function hydrateSeries(slug, ctrl) {
  const key = seriesKey(slug);
  try {
    const s = await getSeries(key, { signal: ctrl.signal });
    if (rd.ctrl !== ctrl || ctrl.signal.aborted || state.view !== "reader") return;
    state.series = { ...s, key: s.key ?? key };
    if (rd.cur >= 0) updateLibrary(rd.cur);
  } catch {}
}

export const closeReader = () => {
  rd.ctrl?.abort();
  rd.ctrl = null;
  rd.gen++; // invalidate any pending chapter load so it can't keep mutating the hidden reader
  clearTimeout(idleTimer);
  posSave();
  closeSheet();
  closeDrawer();
  R.classList.remove("active");
  document.documentElement.classList.remove("reading");
  document.body.classList.remove("reading");
  document.body.style.background = "";
  state.slug = null;
  state.chapters = [];
  if ("scrollRestoration" in history) history.scrollRestoration = "auto";
  if (state.view === "reader") state.view = "home";
};

async function startAt(slug, idx, p = 0) {
  const gen = ++rd.gen;
  Object.assign(rd, {
    slug,
    first: idx,
    last: idx - 1,
    cur: -1,
    loading: false,
    ploading: false,
    buffering: false,
    end: false,
    failed: false,
  });
  prose.innerHTML = `<div class="spinner" id="boot-spin"></div>`;
  rfoot.innerHTML = "";
  setChrome(false);

  const ok = await appendNext(gen);
  if (gen !== rd.gen) return;
  $("#boot-spin")?.remove();
  if (!ok) {
    prose.innerHTML = `<div class="empty">(x_x)\n\ncouldn’t load this chapter</div>`;
    return;
  }

  renderPrevHint();
  rebuildOffsets(); // the hint button shifts every block top
  const b = blockFor(idx);
  window.scrollTo(
    0,
    p > 0 && b ? Math.max(0, b.offsetTop + p * b.offsetHeight - viewH()) : 0,
  );
  setCurrent(idx);
  updateProgress();
  ensureBuffer();
}

// a downloaded chapter reads from disk even online — it is the offline copy;
// on network failure fall back to it as well
const fetchChapter = async (n) =>
  (await loadDownloadedNovelChapter(rd.slug, n).catch(() => null)) ??
  getChapter(rd.slug, n, { signal: rd.ctrl?.signal }).catch(async (error) => {
    const local = await loadDownloadedNovelChapter(rd.slug, n).catch(() => null);
    if (local) return local;
    throw error;
  });

const prefetch = (idx) => {
  const c = state.chapters[idx];
  if (c) prefetchChapter(rd.slug, c.n, { signal: rd.ctrl?.signal });
};

// chapter html is third party scraped content, allow only the formatting the reader styles
// and never event handlers, ids or styles, so a hostile source cannot run script in the app
const CLEAN = {
  ALLOWED_TAGS: [
    "p", "div", "br", "b", "strong", "i", "em", "u", "s", "del", "ins",
    "ul", "ol", "li", "dl", "dt", "dd", "blockquote",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "pre", "code", "hr", "table", "thead", "tbody", "tr", "th", "td",
    "img", "figure", "figcaption", "span", "sub", "sup", "a",
  ],
  ALLOWED_ATTR: ["href", "src", "class"],
  // a data uri may not hide behind an http prefix, fail closed on the whole value;
  // blob: covers downloaded chapter images served from local storage
  ALLOWED_URI_REGEXP: /^(?:(?:https?|blob):(?!.*data:)|(?!\/\/)\/|data:image\/(?:png|jpe?g|gif|webp|avif|bmp))/i,
};

// dompurify's data uri allowlist is additive only, so scrub any data uri that
// is not a raster image after sanitizing (its serializer quotes attrs with ")
const scrubDataUri = s => s.replace(/\s(?:src|href)="data:(?!image\/(?:png|jpe?g|gif|webp|avif|bmp))[^"]*"/gi, "");

// chapters are immutable for their cache ttl, memoize the clean so re entries
// and prev hints do not re sanitize the same body
const cleanCache = new Map();
const CLEAN_MAX = 20;
const cleanBody = (slug, n, html) => {
  const key = `${slug}:${n}`;
  let body = cleanCache.get(key);
  if (body === undefined) {
    body = scrubDataUri(DOMPurify.sanitize(html, CLEAN))
      .replace(/<img\b/g, '<img loading="lazy" decoding="async"');
    cleanCache.set(key, body);
    if (cleanCache.size > CLEAN_MAX) cleanCache.delete(cleanCache.keys().next().value);
  }
  return body
    .replace(/<p>/g, '<div class="rp">')
    .replace(/<\/p>/g, "</div>");
};

const makeBlock = (idx, c, ch) => {
  if (typeof ch?.html !== "string") throw new Error("bad chapter body");
  const block = document.createElement("section");
  block.className = "ch-block";
  block.dataset.idx = idx;
  // paragraphs as <div> not <p> so Safari doesn't flag the page as a Reader article (which kills our JS scroll)
  const body = cleanBody(rd.slug, c.n, ch.html);
  const title = ch.title || c.t;
  block.innerHTML =
    `<div class="reader-ch-meta">chapter ${esc(c.n)} of ${state.chapters.length}</div>` +
    (title ? `<h2>${esc(title)}</h2>` : "") +
    body;
  return block;
};

async function appendNext(gen = rd.gen) {
  if (rd.loading || rd.end || rd.failed) return false;
  const idx = rd.last + 1;
  const c = state.chapters[idx];
  if (!c) {
    rd.end = true;
    renderFoot();
    return false;
  }

  rd.loading = true;
  renderFoot();
  let ch;
  try {
    ch = await fetchChapter(c.n);
  } catch {
    if (gen !== rd.gen) return false;
    rd.loading = false;
    rd.failed = true;
    renderFoot();
    return false;
  }
  if (gen !== rd.gen) return false;
  try {
    prose.appendChild(makeBlock(idx, c, ch));
    rebuildOffsets();
  } catch {
    rd.loading = false;
    if (gen === rd.gen) {
      rd.failed = true;
      renderFoot();
    }
    return false;
  }
  rd.last = idx;
  rd.loading = false;
  renderFoot();
  prefetch(idx + 1);
  prefetch(idx + 2);
  return true;
}

const renderFoot = () => {
  if (rd.failed) {
    const c = state.chapters[rd.last + 1];
    rfoot.innerHTML = `<div class="rfoot-err">(x_x) couldn’t load ${esc(c ? c.t : "the next chapter")}<button class="btn" id="rfoot-retry">retry</button></div>`;
    $("#rfoot-retry").onclick = () => {
      rd.failed = false;
      renderFoot();
      // boot failure never rendered a block, restart it so chrome and progress come up
      if (rd.last < rd.first) startAt(rd.slug, rd.first, 0);
      else ensureBuffer();
    };
  } else if (rd.end) {
    const s = state.series;
    const ongoing = /ongoing/i.test(s?.nfStatus || s?.status || "");
    rfoot.innerHTML = `<div class="rfoot-end">
          <div class="rfoot-end-mark">(￣▽￣)b</div>
          <div class="rfoot-end-title">all caught up</div>
          <div class="rfoot-end-sub">${ongoing ? "this novel is ongoing. new chapters will appear here." : `all ${state.chapters.length} chapters read.`}</div>
          <button class="btn" id="rfoot-back">back to series</button></div>`;
    $("#rfoot-back").onclick = exitReader;
  } else if (rd.loading) {
    rfoot.innerHTML = `<div class="rfoot-load"><span class="minispin"></span></div>`;
  } else rfoot.innerHTML = "";
};

async function ensureBuffer() {
  if (state.view !== "reader" || rd.buffering) return;
  const gen = rd.gen;
  rd.buffering = true;
  let guard = 0;
  while (
    gen === rd.gen &&
    state.view === "reader" &&
    !rd.end &&
    !rd.failed &&
    guard++ < 10 &&
    docH() - (scrollY() + viewH()) < viewH() * 2
  ) {
    if (!(await appendNext(gen))) break;
  }
  if (gen === rd.gen) rd.buffering = false;
}

const renderPrevHint = () => {
  $("#ch-prev")?.remove();
  if (rd.first <= 0) return;
  const c = state.chapters[rd.first - 1];
  prose.insertAdjacentHTML(
    "afterbegin",
    `<button class="ch-prev" id="ch-prev">‹ ${esc(c.t)}</button>`,
  );
  $("#ch-prev").onclick = loadPrev;
};

async function loadPrev() {
  if (rd.ploading || rd.first <= 0) return;
  const gen = rd.gen;
  const idx = rd.first - 1;
  const c = state.chapters[idx];
  rd.ploading = true;
  const btn = $("#ch-prev");
  if (btn) btn.disabled = true;

  let ch;
  try {
    ch = await fetchChapter(c.n);
  } catch {
    if (gen !== rd.gen) return;
    rd.ploading = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "couldn’t load · try again";
    }
    return;
  }
  if (gen !== rd.gen) return;

  const h = docH();
  $("#ch-prev")?.remove();
  try {
    prose.prepend(makeBlock(idx, c, ch));
    rebuildOffsets();
  } catch {
    rd.ploading = false;
    renderPrevHint();
    return;
  }
  rd.first = idx;
  renderPrevHint();
  rebuildOffsets(); // the hint button shifts every block top
  window.scrollTo(0, scrollY() + (docH() - h));
  rd.ploading = false;
}

function trimTop() {
  while (true) {
    const first = prose.querySelector(".ch-block");
    if (!first || Number(first.dataset.idx) >= rd.cur - 2) break;
    if (first.offsetTop + first.offsetHeight > scrollY() - viewH()) break;

    const h = docH();
    first.remove();
    rd.first = Number(first.dataset.idx) + 1;
    renderPrevHint();
    window.scrollTo(0, Math.max(0, scrollY() - (h - docH())));
  }
  rebuildOffsets();
}

function setCurrent(idx) {
  if (idx < 0 || idx === rd.cur) return;
  rd.cur = idx;

  const c = state.chapters[idx];
  $("#r-title").textContent = c.t;
  history.replaceState(null, "", `#/read/${hashSlug(rd.slug)}/${c.n}`);

  // jumping past chapters marks them read, opening 300 implies the rest are behind you
  const crossed = [];
  for (let i = 0; i < idx; i++) crossed.push(state.chapters[i].n);
  // the chapter you land on is being read right now, do not wait for the 98% idle mark
  crossed.push(state.chapters[idx].n);
  let readSize = null;
  if (crossed.length) {
    const set = readSet(rd.slug);
    let changed = false;
    for (const n of crossed) {
      if (!set.has(n)) {
        set.add(n);
        changed = true;
      }
    }
    if (changed) {
      saveRead(rd.slug, set);
      readSize = set.size;
    }
  }
  // a revisit that marks nothing must not rewind lastN or bump recency
  if (readSize != null) updateLibrary(idx, readSize);
}

const topChapterIdx = () => {
  const y = scrollY() + 90;
  let idx = rd.first;
  for (const b of prose.querySelectorAll(".ch-block")) {
    if (offOf(Number(b.dataset.idx), b).top <= y) idx = Number(b.dataset.idx);
    else break;
  }
  return idx;
};

const markChapterRead = (n) => {
  const set = readSet(rd.slug);
  if (set.has(n)) return;
  set.add(n);
  saveRead(rd.slug, set);
};

const updateLibrary = (idx, readSize) => {
  const s = state.series;
  if (!s) return; // nothing is known about this series yet, do not write junk into the library
  const c = state.chapters[idx];
  touchLibrary({
    slug: rd.slug,
    id: s.id,
    title: s.title,
    cover: s.cover,
    lastN: c.n,
    total: state.chapters.length,
    readCount: readSize ?? readSet(rd.slug).size,
  });
};

const chapterProgress = () => {
  const b = blockFor(rd.cur);
  if (!b) return 0;
  const o = offOf(rd.cur, b);
  return Math.min(
    1,
    Math.max(
      0,
      (scrollY() + viewH() - o.top) / Math.max(1, o.h),
    ),
  );
};

const posSave = () => {
  if (state.view !== "reader" || rd.cur < 0) return;
  const c = state.chapters[rd.cur];
  if (c) posSet(rd.slug, { n: c.n, p: chapterProgress(), at: Date.now() });
};

const setChrome = (hide) => {
  chromeHidden = hide;
  R.classList.toggle("hide-chrome", hide);
};
const updateProgress = () => {
  if (rd.cur < 0) return;
  const p = chapterProgress();
  $("#rprogbar").style.width = (p * 100).toFixed(1) + "%";
  $("#r-pos").textContent =
    `${state.chapters[rd.cur].n} / ${state.chapters.length} · ${Math.round(p * 100)}%`;
};

let ticking = false;
let idleTimer;
let trimTick = 0;
window.addEventListener(
  "scroll",
  () => {
    if (state.view !== "reader") return;
    if (!ticking) {
      ticking = true;
      const gen = rd.gen;
      requestAnimationFrame(() => {
        if (state.view !== "reader" || gen !== rd.gen) {
          ticking = false;
          return;
        }
        if (!chromeHidden && scrollY() > 40) setChrome(true);
        setCurrent(topChapterIdx());
        updateProgress();
        ensureBuffer();
        // a binge never idles long enough for the idle trim, shed old blocks on a timer
        if (++trimTick % 120 === 0 && rd.last - rd.first > 20) trimTop();
        ticking = false;
      });
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(onScrollIdle, 300);
  },
  { passive: true },
);

const onScrollIdle = () => {
  if (state.view !== "reader" || rd.cur < 0) return;
  trimTop();
  posSave();
  if (chapterProgress() >= 0.98) {
    markChapterRead(state.chapters[rd.cur].n);
    updateLibrary(rd.cur);
  }
};

window.addEventListener("pagehide", posSave);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") posSave();
});

R.addEventListener("click", (e) => {
  if (e.target.closest("a, button")) return;
  if (String(window.getSelection?.() ?? "")) return;
  setChrome(!chromeHidden);
});

const exitReader = () => {
  closeReader();
  if (state.series) go(`#/series/${encodeURIComponent(state.series.key)}`);
  else back();
};
$("#r-back").onclick = exitReader;

const jumpBy = (d) => {
  const c = state.chapters[rd.cur + d];
  if (c) go(`#/read/${hashSlug(rd.slug)}/${c.n}`);
};
window.addEventListener("keydown", (e) => {
  if (state.view !== "reader" || e.target.closest("input")) return;
  if (e.key === "ArrowRight") jumpBy(1);
  if (e.key === "ArrowLeft") jumpBy(-1);
});

const drawer = $("#drawer"),
  drawerBd = $("#drawer-backdrop");
const dw = { lo: 0, hi: 0, q: "" };

const openDrawer = () => {
  if (!state.chapters.length) return;
  dw.q = "";
  $("#dw-q").value = "";
  dw.lo = Math.max(0, rd.cur - 25);
  dw.hi = Math.min(state.chapters.length, rd.cur + 75);
  renderDrawer();
  drawer.classList.add("open");
  drawerBd.classList.add("open");
  $("#drawer-list .chap.current")?.scrollIntoView({ block: "center" });
};
const closeDrawer = () => {
  drawer.classList.remove("open");
  drawerBd.classList.remove("open");
};
$("#r-list").onclick = openDrawer;
drawerBd.onclick = closeDrawer;
$("#drawer-list").addEventListener("click", (e) => {
  if (e.target.closest("a")) closeDrawer();
});
$("#dw-q").addEventListener("input", (e) => {
  dw.q = e.target.value.trim();
  renderDrawer();
});

function renderDrawer() {
  const listEl = $("#drawer-list");
  const set = readSet(rd.slug);
  const total = state.chapters.length;

  let rows;
  if (dw.q) {
    const f = dw.q.toLowerCase();
    const asNum = Number(dw.q);
    rows = state.chapters
      .map((c, i) => ({ c, i }))
      .filter(
        ({ c }) =>
          (c.t || "").toLowerCase().includes(f) ||
          (Number.isFinite(asNum) && c.n === asNum),
      )
      .slice(0, 200);
  } else {
    rows = state.chapters
      .slice(dw.lo, dw.hi)
      .map((c, k) => ({ c, i: dw.lo + k }));
  }

  const row = ({
    c,
    i,
  }) => `<a class="chap${set.has(c.n) ? " read" : ""}${i === rd.cur ? " current" : ""}" href="#/read/${hashSlug(rd.slug)}/${esc(c.n)}">
      <span class="n">#${esc(c.n)}</span><span class="t">${esc(c.t)}</span><span class="dot"></span></a>`;
  listEl.innerHTML =
    (!dw.q && dw.lo > 0
      ? `<button class="drawer-more" id="dw-earlier">${dw.lo} earlier…</button>`
      : "") +
    (rows.length
      ? rows.map(row).join("")
      : `<div class="empty">(´д｀)\n\nno matching chapters</div>`) +
    (!dw.q && dw.hi < total
      ? `<button class="drawer-more" id="dw-later">${total - dw.hi} later…</button>`
      : "");

  $("#dw-earlier")?.addEventListener("click", () => {
    const h = listEl.scrollHeight;
    dw.lo = Math.max(0, dw.lo - 150);
    renderDrawer();
    listEl.scrollTop += listEl.scrollHeight - h;
  });
  $("#dw-later")?.addEventListener("click", () => {
    dw.hi = Math.min(total, dw.hi + 150);
    renderDrawer();
  });
}

const sheet = $("#sheet"),
  backdrop = $("#sheet-backdrop");
const openSheet = () => {
  syncSheet();
  sheet.classList.add("open");
  backdrop.classList.add("open");
};
const closeSheet = () => {
  sheet.classList.remove("open");
  backdrop.classList.remove("open");
};
$("#r-settings").onclick = openSheet;
backdrop.onclick = closeSheet;

// fullscreen is unavailable in some embedded contexts (iPhone Safari); hide the button there
const fullscreenBtn = $("#r-fullscreen");
if (fullscreenBtn && document.fullscreenEnabled) {
    fullscreenBtn.hidden = false;
    fullscreenBtn.onclick = async () => {
        try {
            if (document.fullscreenElement) await document.exitFullscreen?.();
            else await document.documentElement.requestFullscreen?.();
        } catch {}
    };
}

const syncSheet = () => {
  $$("#set-theme .swatch").forEach((b) =>
    b.classList.toggle("on", b.dataset.theme === settings.theme),
  );
  $$("#set-font button").forEach((b) =>
    b.classList.toggle("on", b.dataset.font === settings.font),
  );
  $$("#set-lh button").forEach((b) =>
    b.classList.toggle("on", Number(b.dataset.lh) === settings.lh),
  );
  $$("#set-width button").forEach((b) =>
    b.classList.toggle("on", b.dataset.width === settings.width),
  );
};
$("#set-theme").onclick = (e) => {
  const b = e.target.closest("[data-theme]");
  if (!b) return;
  settings.theme = b.dataset.theme;
  commit();
};
$("#set-font").onclick = (e) => {
  const b = e.target.closest("[data-font]");
  if (!b) return;
  settings.font = b.dataset.font;
  commit();
};
$("#set-lh").onclick = (e) => {
  const b = e.target.closest("[data-lh]");
  if (!b) return;
  settings.lh = Number(b.dataset.lh);
  commit();
};
$("#set-width").onclick = (e) => {
  const b = e.target.closest("[data-width]");
  if (!b) return;
  settings.width = b.dataset.width;
  commit();
};
$("#set-size").onclick = (e) => {
  const b = e.target.closest("[data-size]");
  if (!b) return;
  if (b.dataset.size === "reset") settings.size = SET_DEFAULT.size;
  else
    settings.size = Math.max(
      14,
      Math.min(28, settings.size + (b.dataset.size === "+" ? 1 : -1)),
    );
  commit();
};
const commit = () => {
  saveSettings(settings);
  applySettings();
  rebuildOffsets(); // size and spacing changes reflow every block
  syncSheet();
  updateProgress();
};
