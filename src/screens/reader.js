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
} from "../lib/store.js";
import { $, $$, esc } from "../lib/dom.js";
import { writeClip } from "../lib/clip.js";
import { coverSrc } from "../lib/cover.js";
import { renderQuoteCard } from "../lib/card.js";

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
  closeDrawer();
  qHide();
  closeQuoteSheet();
  qcache = null; // a stale card must not leak into the next book
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

/* quote cards: selection chip, pre rendered card, copy / share sheet */
const qchip = $("#quote-chip");
const qsheet = $("#rquote"),
  qbd = $("#rquote-backdrop");
const qimg = $("#rquote-img");
const qcopyText = $("#rquote-copy-text"),
  qcopyImg = $("#rquote-copy-img"),
  qshare = $("#rquote-share");
let qcur = null; // the selection the chip is anchored to: { text, range }
let qcache = null; // pre rendered card for the current selection: { text, dataUrl, blob }
let qrendering = null; // { text, promise } dedupe for the in flight render

const qSel = () => {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  if (state.view !== "reader") return null;
  const range = sel.getRangeAt(0);
  if (!range || range.collapsed) return null;
  // the selection must sit entirely inside the prose, chrome and foot are not quotable
  for (const n of [sel.anchorNode, sel.focusNode]) {
    if (!n || !prose.contains(n.nodeType === 3 ? n.parentNode : n)) return null;
  }
  if (!prose.contains(range.commonAncestorContainer)) return null;
  const text = sel.toString().replace(/\s+/g, " ").trim();
  if (text.length < 2) return null;
  return { text, range };
};

const qAnchor = () => {
  if (!qcur) return;
  const r = qcur.range.getBoundingClientRect();
  if (!r || (!r.width && !r.height)) return;
  const w = qchip.offsetWidth || 0;
  const h = qchip.offsetHeight || 0;
  const x = Math.max(8, Math.min(r.left, innerWidth - w - 8));
  const y = r.bottom + 10 + h > innerHeight - 8 ? Math.max(8, r.top - h - 10) : r.bottom + 10;
  qchip.style.left = x + "px";
  qchip.style.top = y + "px";
};

const qHide = () => {
  qcur = null;
  qchip.hidden = true;
};

const qShow = (s) => {
  qcur = s;
  qchip.hidden = false;
  qAnchor();
  renderQuote(s.text); // pre render so a copy gesture never waits on the renderer
};

// the current data-theme tokens as canvas colors, the card must match the display
const qColors = () => {
  const cs = getComputedStyle(R);
  return {
    bg: cs.getPropertyValue("--rbg"),
    text: cs.getPropertyValue("--rtext"),
    muted: cs.getPropertyValue("--rmuted"),
    line: cs.getPropertyValue("--rline"),
  };
};

const renderQuote = (text) => {
  if (qrendering?.text === text) return qrendering.promise;
  const p = (async () => {
    const c = state.chapters[rd.cur];
    const { canvas } = await renderQuoteCard({
      quote: text,
      series: state.series?.title ?? "",
      chapter: c?.n ?? 0,
      chapterTotal: state.chapters.length,
      theme: R.dataset.theme ?? "dark",
      colors: qColors(),
      cover: coverSrc(state.series?.cover, state.series?.title),
    });
    const dataUrl = canvas.toDataURL("image/png");
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    // a newer selection may have superseded this render, drop the stale one
    if (qcur?.text === text) {
      qcache = { text, dataUrl, blob };
      if (qsheet.classList.contains("open")) qimg.src = dataUrl;
    }
  })().catch(() => {
    if (qrendering?.promise === p) qrendering = null;
  });
  qrendering = { text, promise: p };
  return p;
};

let qTick = false;
document.addEventListener("selectionchange", () => {
  if (state.view !== "reader") {
    if (qcur) qHide();
    return;
  }
  if (qTick) return;
  qTick = true;
  // a timer rather than a frame: selectionchange bursts during a drag and the
  // frame callback is throttled when the window is occluded, which would leave
  // the chip stuck hidden while the user is still selecting
  setTimeout(() => {
    qTick = false;
    const s = qSel();
    if (!s) {
      if (qcur) qHide();
      return;
    }
    qShow(s);
  }, 0);
});

window.addEventListener(
  "scroll",
  () => {
    if (qcur && state.view === "reader") qAnchor();
  },
  { passive: true },
);
window.addEventListener("resize", () => {
  if (qcur) qAnchor();
});

const openQuoteSheet = () => {
  if (!qcache) return;
  qimg.src = qcache.dataUrl;
  qsheet.classList.add("open");
  qbd.classList.add("open");
};
const closeQuoteSheet = () => {
  qsheet.classList.remove("open");
  qbd.classList.remove("open");
};
qbd.onclick = closeQuoteSheet;
$("#rquote-close").onclick = closeQuoteSheet;

// keep the selection alive while the chip is pressed so a slow tap cannot collapse it
qchip.addEventListener("mousedown", (e) => e.preventDefault());
qchip.onclick = async () => {
  const s = qcur;
  if (!s) return;
  if (!qcache || qcache.text !== s.text) await renderQuote(s.text);
  openQuoteSheet();
};

const qFlash = (btn, label) => {
  const orig = btn.textContent;
  btn.textContent = label;
  btn.classList.add("on");
  setTimeout(() => {
    btn.textContent = orig;
    btn.classList.remove("on");
  }, 900);
};

qcopyText.onclick = () => {
  if (!qcache) return;
  writeClip(qcache.text);
  qFlash(qcopyText, "copied");
};

// image copy prefers the async clipboard api (best effort, some engines deny
// the write even when ClipboardItem exists), then falls back to saving the png
const saveBlob = (blob) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "vellum-quote.png";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
};
const copyImage = async (blob) => {
  if (window.ClipboardItem && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return true;
    } catch {}
  }
  saveBlob(blob);
  return false;
};
qcopyImg.onclick = async () => {
  if (!qcache?.blob) return;
  try {
    qFlash(qcopyImg, (await copyImage(qcache.blob)) ? "copied" : "saved");
  } catch {
    qFlash(qcopyImg, "failed");
  }
};

const shareOk = () => {
  if (!navigator.share) return false;
  if (navigator.canShare) {
    try {
      return navigator.canShare({
        files: [new File([new Blob(["x"])], "x.png", { type: "image/png" })],
      });
    } catch {
      return false;
    }
  }
  return true;
};
qshare.onclick = async () => {
  if (!qcache?.blob || !navigator.share) return;
  const f = new File([qcache.blob], "vellum-quote.png", { type: "image/png" });
  try {
    await navigator.share({ files: [f], title: "Vellum quote", text: qcache.text });
  } catch {}
};
// entries with no reachable pipeline are hidden rather than dead buttons
qcopyImg.hidden = !(window.ClipboardItem || "download" in document.createElement("a"));
qshare.hidden = !shareOk();
