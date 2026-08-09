import DOMPurify from "dompurify";
import "../styles/reader.css";
import {
  getSeries,
  getChapters,
  getChapter,
  prefetchChapter,
  seriesKey,
} from "../lib/api.js";
import { go, back, hashSlug } from "../lib/router.js";
import {
  readSet,
  saveRead,
  posGet,
  posSet,
  touchLibrary,
  loadSettings,
  saveSettings,
  SET_DEFAULT,
  statsGet,
  statsAdd,
  statsSweep,
  loadFocus,
  saveFocus,
  FOCUS_KEY,
} from "../lib/store.js";
import { localDayKey } from "../lib/time.js";
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
      const { chapters } = await getChapters(slug);
      if (routeGen !== rd.gen) return; // closed or re navigated while the list was loading
      if (!Array.isArray(chapters)) throw new Error("couldn't load the chapter list");
      state.slug = slug;
      state.chapters = chapters;
    } catch (e) {
      if (routeGen !== rd.gen) return; // a dead route must not render into the live view
      prose.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      return;
    }
  }
  if (document.fonts?.ready) document.fonts.ready.then(rebuildOffsets);
  if (state.series?.nfSlug !== slug) hydrateSeries(slug);

  const idx = Math.max(0, chapterIndex(n));
  const pos = posGet(slug);
  await startAt(slug, idx, pos && pos.n === n ? pos.p : 0);
}

async function hydrateSeries(slug) {
  const key = seriesKey(slug);
  try {
    const s = await getSeries(key);
    if (rd.slug !== slug) return;
    state.series = { ...s, key: s.key ?? key };
    if (rd.cur >= 0) updateLibrary(rd.cur);
  } catch {}
}

export const closeReader = () => {
  rd.gen++; // invalidate any pending chapter load so it can't keep mutating the hidden reader
  posSave();
  closeSheet();
  closeFocusSheet();
  closeDrawer();
  R.classList.remove("active");
  document.documentElement.classList.remove("reading");
  document.body.classList.remove("reading");
  document.body.style.background = "";
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

const fetchChapter = (n) => getChapter(rd.slug, n);

const prefetch = (idx) => {
  const c = state.chapters[idx];
  if (c) prefetchChapter(rd.slug, c.n);
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
  // a data uri may not hide behind an http prefix, fail closed on the whole value
  ALLOWED_URI_REGEXP: /^(?:(?:https?):(?!.*data:)|(?!\/\/)\/|data:image\/(?:png|jpe?g|gif|webp|avif|bmp))/i,
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
    body = scrubDataUri(DOMPurify.sanitize(html, CLEAN));
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
    rd.loading = false;
    if (gen === rd.gen) {
      rd.failed = true;
      renderFoot();
    }
    return false;
  }
  if (gen !== rd.gen) {
    rd.loading = false;
    return false;
  }
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
  if (rd.buffering) return;
  rd.buffering = true;
  let guard = 0;
  while (
    !rd.end &&
    !rd.failed &&
    guard++ < 10 &&
    docH() - (scrollY() + viewH()) < viewH() * 2
  ) {
    if (!(await appendNext())) break;
  }
  rd.buffering = false;
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
    rd.ploading = false;
    if (btn) btn.disabled = false;
    return;
  }
  if (gen !== rd.gen) {
    rd.ploading = false;
    return;
  }

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
  for (let i = rd.first; i < idx; i++) crossed.push(state.chapters[i].n);
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
      requestAnimationFrame(() => {
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

window.addEventListener("pagehide", () => {
  posSave();
  flushAccrual();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    posSave();
    flushAccrual();
  } else {
    fx.lastAcc = performance.now(); // a hidden gap must never be credited as reading time
  }
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
  closeFocusSheet();
  closeCelebration();
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

// ---- focus timer + reading goals ----
// the session lives in one vellum:focus blob and the countdown is always derived from
// timestamps (monotonic for the live tick, the persisted startWall for kill recovery),
// never decremented, so background throttling and wall clock jumps cannot corrupt it.
// reading minutes accrue only while a session runs AND the reader is visible, through
// the F5 no-shed statsAdd path, latched per session by the live ticker
let focus = loadFocus();
let fx = { ticker: null, lastAcc: 0, pendingMs: 0, accruedMs: 0 };

const sessionMs = () => focus.sessionMs || focus.focusMin * 60000;
const fmtClock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const fmtMin = (ms) => {
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};
const fmtGoal = (min) => (min >= 60 ? `${Math.floor(min / 60)}h` : `${min}m`);

const weekMs = () => {
  const t = new Date();
  let sum = 0;
  for (let i = 6; i >= 0; i--) {
    const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() - i);
    sum += statsGet(localDayKey(d.getTime()))?.ms ?? 0;
  }
  return sum;
};

const focusRemaining = () => {
  if (!focus.sessionId || focus.acked) return focus.focusMin * 60000; // idle hint
  if (focus.pausedAt != null) return Math.max(0, sessionMs() - focus.elapsedSoFar);
  return Math.max(0, focus.endMonotonic - performance.now());
};

const startTicker = () => {
  if (fx.ticker) return;
  fx.lastAcc = performance.now();
  fx.pendingMs = 0;
  fx.accruedMs = 0;
  fx.ticker = setInterval(focusTick, 1000);
};
const stopTicker = () => {
  if (fx.ticker) {
    clearInterval(fx.ticker);
    fx.ticker = null;
  }
};

const flushAccrual = () => {
  if (fx.pendingMs < 1) return;
  statsAdd(localDayKey(Date.now()), Math.round(fx.pendingMs), 0);
  fx.pendingMs = 0;
};

const accrue = () => {
  const now = performance.now();
  if (document.visibilityState !== "visible" || state.view !== "reader") {
    fx.lastAcc = now;
    return;
  }
  const d = now - fx.lastAcc;
  fx.lastAcc = now;
  if (d > 3000 || d < 0) return; // a throttled gap must never be credited
  fx.pendingMs += d;
  fx.accruedMs += d;
  flushAccrual();
};

const startSession = () => {
  const wall = Date.now();
  focus = {
    ...focus,
    sessionId: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    sessionMs: focus.focusMin * 60000,
    startWall: wall,
    startDate: localDayKey(wall),
    endMonotonic: performance.now() + focus.focusMin * 60000,
    elapsedSoFar: 0,
    pausedAt: null,
    pausedWall: null,
    acked: false,
  };
  saveFocus(focus);
  hideNote();
  startTicker();
  renderFocus();
  askNotify(); // permission only on the start gesture
};

const pauseSession = () => {
  if (!focus.sessionId || focus.pausedAt != null) return;
  const rem = Math.max(0, focus.endMonotonic - performance.now());
  focus = {
    ...focus,
    elapsedSoFar: Math.min(sessionMs(), sessionMs() - rem),
    pausedAt: performance.now(),
    pausedWall: Date.now(),
    endMonotonic: 0,
  };
  saveFocus(focus);
  stopTicker();
  flushAccrual();
  renderFocus();
};

const resumeSession = () => {
  if (!focus.sessionId || focus.pausedAt == null) return;
  const wall = Date.now();
  focus = {
    ...focus,
    endMonotonic: performance.now() + Math.max(0, sessionMs() - focus.elapsedSoFar),
    startWall: wall,
    startDate: localDayKey(wall),
    pausedAt: null,
    pausedWall: null,
  };
  saveFocus(focus);
  hideNote();
  startTicker();
  renderFocus();
};

const discardSession = () => {
  stopTicker();
  focus = { ...focus, sessionId: null, sessionMs: 0, startWall: 0, startDate: null,
    endMonotonic: 0, elapsedSoFar: 0, pausedAt: null, pausedWall: null, acked: false };
  saveFocus(focus);
  hideNote();
  renderFocus();
};

const completeSession = () => {
  flushAccrual(); // write before celebrate, so the settled goal line is already in the bucket
  const readMin = Math.floor(fx.accruedMs / 60000);
  focus = { ...focus, elapsedSoFar: sessionMs(), endMonotonic: 0,
    pausedAt: null, pausedWall: null, acked: true };
  saveFocus(focus);
  stopTicker();
  renderFocus();
  showCelebration(readMin);
  notifyDone(readMin);
};

const focusTick = () => {
  if (!focus.sessionId || focus.pausedAt != null) return;
  if (focus.endMonotonic - performance.now() <= 0) {
    completeSession();
    return;
  }
  accrue();
  renderFocus();
};

const renderFocus = () => {
  renderTimer();
  renderGoalChip();
  renderStrip();
  renderFocusStats();
};

const renderTimer = () => {
  const btn = $("#r-timerbtn");
  const txt = $("#r-timertxt");
  const running = focus.sessionId != null && focus.pausedAt == null && !focus.acked && focusRemaining() > 0;
  btn.textContent = running ? "❚❚" : "▶";
  btn.title = !focus.sessionId ? "Start focus" : running ? "Pause focus" : "Resume focus";
  txt.textContent = fmtClock(focusRemaining());
  txt.classList.toggle("run", running);
};

const renderGoalChip = () => {
  const chip = $("#r-goalchip");
  if (!chip) return;
  const on = focus.goalDay > 0 || focus.goalWeek > 0;
  chip.hidden = !on;
  if (!on) return;
  chip.textContent =
    focus.goalDay > 0
      ? `◎ ${Math.floor((statsGet(localDayKey())?.ms ?? 0) / 60000)}/${focus.goalDay}m`
      : `◎ ${fmtMin(weekMs())}/${fmtGoal(focus.goalWeek)}`;
};

const renderStrip = () => {
  const s = $("#rtimerbar");
  if (!s) return;
  const active = focus.sessionId != null && !focus.acked;
  s.classList.toggle("on", active);
  s.style.width = active
    ? `${Math.max(0, Math.min(100, (1 - focusRemaining() / sessionMs()) * 100))}%`
    : "0%";
};

const renderFocusStats = () => {
  const dayMs = statsGet(localDayKey())?.ms ?? 0;
  const wk = weekMs();
  const drow = $("#r-focus-daystat");
  const wrow = $("#r-focus-weekstat");
  if (drow) drow.hidden = !focus.goalDay;
  if (wrow) wrow.hidden = !focus.goalWeek;
  if (focus.goalDay) {
    $("#r-focus-daylabel").textContent = `${Math.floor(dayMs / 60000)}/${focus.goalDay}m`;
    $("#r-focus-dayfill").style.width = `${Math.min(100, (dayMs / (focus.goalDay * 60000)) * 100)}%`;
  }
  if (focus.goalWeek) {
    $("#r-focus-weeklabel").textContent = `${fmtMin(wk)}/${fmtGoal(focus.goalWeek)}`;
    $("#r-focus-weekfill").style.width = `${Math.min(100, (wk / (focus.goalWeek * 60000)) * 100)}%`;
  }
  const days = $("#r-focus-days");
  if (days) {
    const t = new Date();
    const todayKey = localDayKey(t.getTime());
    const cols = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() - i);
      const key = localDayKey(d.getTime());
      cols.push({ key, ms: statsGet(key)?.ms ?? 0, today: key === todayKey });
    }
    const max = Math.max(1, ...cols.map((c) => c.ms));
    days.innerHTML = cols
      .map((c) => {
        const h = c.ms > 0 ? Math.max(2, Math.round((c.ms / max) * 40)) : 1;
        return `<span class="r-focus-day${c.ms > 0 ? " has" : ""}${c.today ? " today" : ""}" style="height:${h}px" title="${c.key} · ${Math.floor(c.ms / 60000)}m"></span>`;
      })
      .join("");
  }
};

const focusSheet = $("#focus-sheet");
const focusBd = $("#focus-sheet-backdrop");
const openFocusSheet = () => {
  closeSheet();
  closeCelebration();
  syncFocusConfig();
  renderFocusStats();
  focusSheet.classList.add("open");
  focusBd.classList.add("open");
};
const closeFocusSheet = () => {
  focusSheet.classList.remove("open");
  focusBd.classList.remove("open");
};
$("#r-goalchip").onclick = (e) => {
  e.stopPropagation();
  openFocusSheet();
};
$("#r-timertxt").onclick = (e) => {
  e.stopPropagation();
  openFocusSheet();
};
focusBd.onclick = closeFocusSheet;

const syncFocusConfig = () => {
  $$("#r-set-min button").forEach((b) =>
    b.classList.toggle("on", Number(b.dataset.min) === focus.focusMin),
  );
  $$("#r-set-day button").forEach((b) =>
    b.classList.toggle("on", Number(b.dataset.day) === focus.goalDay),
  );
  $$("#r-set-week button").forEach((b) =>
    b.classList.toggle("on", Number(b.dataset.week) === focus.goalWeek),
  );
};
$("#r-set-min").onclick = (e) => {
  const b = e.target.closest("[data-min]");
  if (!b) return;
  focus = { ...focus, focusMin: Number(b.dataset.min) };
  saveFocus(focus);
  syncFocusConfig();
  renderFocus();
};
$("#r-set-day").onclick = (e) => {
  const b = e.target.closest("[data-day]");
  if (!b) return;
  focus = { ...focus, goalDay: Number(b.dataset.day) };
  saveFocus(focus);
  syncFocusConfig();
  renderFocus();
};
$("#r-set-week").onclick = (e) => {
  const b = e.target.closest("[data-week]");
  if (!b) return;
  focus = { ...focus, goalWeek: Number(b.dataset.week) };
  saveFocus(focus);
  syncFocusConfig();
  renderFocus();
};
$("#r-timerbtn").onclick = () => {
  if (!focus.sessionId) startSession();
  else if (focus.pausedAt != null) resumeSession();
  else pauseSession();
};

const celebration = $("#r-focus-done");
const celebrationBd = $("#r-focus-done-backdrop");
const showCelebration = (readMin) => {
  closeSheet();
  closeFocusSheet();
  $("#r-focus-donestats").textContent = `${fmtClock(sessionMs())} session · ${readMin}m read`;
  const goal = $("#r-focus-donegoal");
  const dayMs = statsGet(localDayKey())?.ms ?? 0;
  if (focus.goalDay > 0) {
    goal.hidden = false;
    const m = Math.floor(dayMs / 60000);
    goal.textContent =
      dayMs >= focus.goalDay * 60000
        ? `daily goal reached · ${m}/${focus.goalDay}m`
        : `daily goal ${m}/${focus.goalDay}m`;
  } else if (focus.goalWeek > 0) {
    goal.hidden = false;
    goal.textContent = `weekly goal ${fmtMin(weekMs())}/${fmtGoal(focus.goalWeek)}`;
  } else goal.hidden = true;
  celebration.classList.add("open");
  celebrationBd.classList.add("open");
};
const closeCelebration = () => {
  celebration.classList.remove("open");
  celebrationBd.classList.remove("open");
};
$("#r-focus-donebtn").onclick = () => {
  closeCelebration();
  discardSession();
};
celebrationBd.onclick = () => {
  closeCelebration();
  discardSession();
};

const askNotify = () => {
  try {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  } catch {}
};
const notifyDone = (readMin) => {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    new Notification("Focus complete", { body: `${fmtClock(sessionMs())} session · ${readMin}m read` });
  } catch {}
};

let noteTimer = null;
const hideNote = () => {
  clearTimeout(noteTimer);
  $("#r-focus-note").hidden = true;
};
const showNote = (text, { auto = false, resumeLabel = "resume", onResume = null } = {}) => {
  const note = $("#r-focus-note");
  clearTimeout(noteTimer);
  note.hidden = false;
  $("#r-focus-note-txt").textContent = text;
  const resumeBtn = $("#r-focus-note-resume");
  const discardBtn = $("#r-focus-note-discard");
  resumeBtn.hidden = !onResume;
  discardBtn.hidden = !onResume;
  resumeBtn.textContent = resumeLabel;
  resumeBtn.onclick = onResume;
  discardBtn.onclick = discardSession;
  if (auto) noteTimer = setTimeout(() => (note.hidden = true), 4000);
};

// boot recovery: a persisted session shows resume/discard, dead time is never credited
const recoverSession = () => {
  if (!focus.sessionId || focus.acked) return;
  const rem = focus.pausedWall != null
    ? Math.max(0, sessionMs() - focus.elapsedSoFar)
    : Math.max(0, sessionMs() - focus.elapsedSoFar - (Date.now() - focus.startWall));
  if (rem > 0) {
    showNote("focus session in progress", {
      resumeLabel: "resume",
      onResume: () => { hideNote(); resumeSession(); },
    });
  } else {
    showNote("focus session ended while away", {
      resumeLabel: "start fresh",
      onResume: () => { hideNote(); startSession(); },
    });
  }
};

// another window took over the session, stop ticking and say so
window.addEventListener("storage", (e) => {
  if (e.key !== FOCUS_KEY || !e.newValue) return;
  const incoming = loadFocus();
  if (fx.ticker && incoming.sessionId !== focus.sessionId) {
    stopTicker();
    showNote("session replaced in another window", { auto: true });
  }
  focus = incoming;
  if (focus.acked) hideNote();
  renderFocus();
});

statsSweep();
recoverSession();
syncFocusConfig();
renderFocus();
