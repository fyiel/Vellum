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
  hlGet,
  saveHls,
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

window.addEventListener("resize", () => {
  hideHlbar();
  rebuildOffsets();
});

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
  hideHlbar();
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
  // marginalia marks ride along on every mount, before the caller rebuilds offsets
  applyMarks(block, idx);
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
    if (hlbar?.classList.contains("open")) hideHlbar();
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
  // marks open the note sheet and the hlbar is chrome of its own, neither toggles the reader chrome
  if (e.target.closest("a, button, .hl, .hlbar")) return;
  if (String(window.getSelection?.() ?? "")) return;
  setChrome(!chromeHidden);
});

prose.addEventListener("click", (e) => {
  const m = e.target.closest("mark.hl");
  if (m && m._hl) openNoteSheet(m._hl);
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
  if (state.view !== "reader" || e.target.closest("input, textarea")) return;
  if (e.key === "Escape") {
    hideHlbar();
    closeAnySheet();
    return;
  }
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
  backdrop = $("#sheet-backdrop"),
  noteSheet = $("#note-sheet"),
  marksSheet = $("#marks-sheet");
const allSheets = [sheet, noteSheet, marksSheet];
// one backdrop for every sheet, opening one closes the rest
const openAnySheet = (el) => {
  allSheets.forEach((s) => s.classList.toggle("open", s === el));
  backdrop.classList.add("open");
};
const closeAnySheet = () => {
  allSheets.forEach((s) => s.classList.remove("open"));
  backdrop.classList.remove("open");
};
const openSheet = () => {
  syncSheet();
  openAnySheet(sheet);
};
const closeSheet = () => closeAnySheet();
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

/* ---------------------------------------------------------------- marginalia */

const LEAF_SEL = ".rp, p, li, td, blockquote";
const HL_MAX = 500;
const HL_MAX_LEN = 2000;

const leafAt = (block, p) => block.querySelectorAll(LEAF_SEL)[p] ?? null;

// verify a stored record against the mounted chapter: exact offsets while the text at
// p,s..e still matches the excerpt head/tail, else a substring scan, else orphaned
const resolveRecord = (container, r) => {
  const text = container.textContent;
  // exact offsets while the text at p,s..e still matches the excerpt head/tail
  const at = r.s >= 0 && r.e <= text.length && r.s < r.e ? text.slice(r.s, r.e) : "";
  if (
    at.slice(0, 24) === r.excerpt.slice(0, 24) &&
    at.slice(-24) === r.excerpt.slice(-24)
  ) {
    return { s: r.s, e: r.e };
  }
  // the chapter may have shifted, hunt for the excerpt anywhere in the container
  const i = text.indexOf(r.excerpt);
  return i >= 0 ? { s: i, e: i + r.excerpt.length } : null;
};

// re-anchor every mark of this chapter on each mount; marks never add text nodes so
// the offsets stay valid no matter how many marks wrap the same container
const applyMarks = (block, idx) => {
  const c = state.chapters[idx];
  if (!c) return;
  const all = hlGet(rd.slug);
  const recs = all
    .filter((r) => r.n === c.n)
    .sort((a, b) => (a.at || 0) - (b.at || 0));
  if (!recs.length) return;
  let dirty = false;
  for (const r of recs) {
    const container = leafAt(block, r.p);
    const pos = container && resolveRecord(container, r);
    if (!container || !pos) {
      if (!r.orphan) {
        r.orphan = true;
        dirty = true;
      }
      continue;
    }
    if (r.orphan || r.s !== pos.s || r.e !== pos.e) {
      r.orphan = false;
      r.s = pos.s;
      r.e = pos.e;
      dirty = true;
    }
    drawMark(container, r);
  }
  // persist corrected anchors and orphan flags, one write per mount
  if (dirty) saveHls(rd.slug, all);
};

const textNodeAt = (root, target) => {
  let left = target;
  let hit = null;
  (function walk(el) {
    if (hit) return;
    for (const c of el.childNodes) {
      if (hit) return;
      if (c.nodeType === 3) {
        if (left <= c.length) {
          hit = { node: c, off: left };
          return;
        }
        left -= c.length;
      } else walk(c);
    }
  })(root);
  return hit;
};

const rangeFromOffsets = (container, s, e) => {
  if (!(e > s)) return null;
  const a = textNodeAt(container, s);
  const b = textNodeAt(container, e);
  if (!a || !b) return null;
  const range = document.createRange();
  range.setStart(a.node, a.off);
  range.setEnd(b.node, b.off);
  return range;
};

// wrap each covered text node in its own <mark> via extractContents; a range is
// never forced across a partial node, so marks stay class-only and add no text
const drawMark = (container, rec) => {
  const range = rangeFromOffsets(container, rec.s, rec.e);
  if (!range) return false;
  const color = Math.min(4, Math.max(1, rec.color || 1));
  const parts = [];
  (function walk(el) {
    for (const c of el.childNodes) {
      if (c.nodeType === 3) {
        if (!range.intersectsNode(c)) continue;
        let a = 0;
        let b = c.length;
        if (range.startContainer === c) a = range.startOffset;
        if (range.endContainer === c) b = range.endOffset;
        if (a < b) parts.push({ node: c, a, b });
      } else walk(c);
    }
  })(container);
  let drew = false;
  for (const { node, a, b } of parts) {
    const r = document.createRange();
    r.setStart(node, a);
    r.setEnd(node, b);
    const frag = r.extractContents();
    const m = document.createElement("mark");
    m.className = "hl c" + color;
    m._hl = rec;
    m.appendChild(frag);
    r.insertNode(m);
    drew = true;
  }
  return drew;
};

const blockOf = (node) =>
  node.nodeType === 1
    ? node.closest(".ch-block")
    : (node.parentElement?.closest(".ch-block") ?? null);

const leafContainerOf = (node, block) => {
  let n = node;
  while (n && n !== block && n !== prose) {
    if (n.nodeType === 1 && n.matches(LEAF_SEL)) return n;
    n = n.parentElement;
  }
  return null;
};

const rangeOffsets = (container, range) => {
  const pre = document.createRange();
  pre.setStart(container, 0);
  pre.setEnd(range.startContainer, range.startOffset);
  const s = pre.toString().length;
  pre.setEnd(range.endContainer, range.endOffset);
  return { s, e: pre.toString().length };
};

const clearSel = () => window.getSelection()?.removeAllRanges();

const copyText = (text) => {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  } else {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {}
    ta.remove();
  }
};

let hlSel = null;
let hlLastColor = 1;
let hlCapShed = false;
let hlTimer = null;

document.addEventListener("selectionchange", () => {
  if (state.view !== "reader") return;
  clearTimeout(hlTimer);
  hlTimer = setTimeout(handleSelection, 150);
});

function handleSelection() {
  if (state.view !== "reader") return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    hideHlbar();
    return;
  }
  const range = sel.getRangeAt(0);
  if (range.collapsed) {
    hideHlbar();
    return;
  }
  const startBlock = blockOf(range.startContainer);
  if (!startBlock || !prose.contains(startBlock)) {
    hideHlbar();
    return;
  }
  // a drag that spills into another chapter clamps silently to the anchor block
  let r = range.cloneRange();
  if (blockOf(range.endContainer) !== startBlock) {
    r.setEnd(startBlock, startBlock.childNodes.length);
  }
  const container = leafContainerOf(r.startContainer, startBlock);
  if (!container) {
    hideHlbar();
    return;
  }
  // and to the anchor leaf container, a cross paragraph drag stays in the first
  if (!container.contains(r.endContainer)) {
    r.setEnd(container, container.childNodes.length);
  }
  const text = r.toString();
  if (text.trim().length < 2 || text.length > HL_MAX_LEN) {
    hideHlbar();
    return;
  }
  const { s, e } = rangeOffsets(container, r);
  const lead = text.length - text.trimStart().length;
  const tail = text.length - text.trimEnd().length;
  showHlbar(
    { container, s: s + lead, e: e - tail, excerpt: text.trim() },
    r,
  );
}

let hlbar = null;
const ensureHlbar = () => {
  if (hlbar) return;
  hlbar = document.createElement("div");
  hlbar.className = "hlbar";
  hlbar.innerHTML =
    `<button class="hlsw on c1" data-c="1" title="mark yellow"></button>` +
    `<button class="hlsw c2" data-c="2" title="mark green"></button>` +
    `<button class="hlsw c3" data-c="3" title="mark blue"></button>` +
    `<button class="hlsw c4" data-c="4" title="mark pink"></button>` +
    `<button class="hlb" data-act="note" title="mark with a note">✎</button>` +
    `<button class="hlb" data-act="copy" title="copy">⧉</button>` +
    `<button class="hlb" data-act="close" title="dismiss">✕</button>`;
  hlbar.addEventListener("click", (e) => {
    const sw = e.target.closest(".hlsw");
    if (sw) {
      hlLastColor = Number(sw.dataset.c);
      if (hlSel) createHl(hlSel, hlLastColor);
      hideHlbar();
      clearSel();
      return;
    }
    const act = e.target.closest(".hlb")?.dataset.act;
    if (act === "note") {
      const rec = hlSel ? createHl(hlSel, hlLastColor) : null;
      hideHlbar();
      clearSel();
      if (rec) openNoteSheet(rec);
    } else if (act === "copy") {
      if (hlSel) copyText(hlSel.excerpt);
    } else if (act === "close") {
      hideHlbar();
      clearSel();
    }
  });
  document.body.appendChild(hlbar);
};

const hideHlbar = () => {
  hlSel = null;
  hlbar?.classList.remove("open");
};

const showHlbar = (info, range) => {
  ensureHlbar();
  hlSel = info;
  hlbar.querySelectorAll(".hlsw").forEach((b) =>
    b.classList.toggle("on", Number(b.dataset.c) === hlLastColor),
  );
  const rr = range.cloneRange();
  rr.collapse(false);
  const rect = rr.getBoundingClientRect();
  hlbar.classList.remove("open");
  hlbar.style.visibility = "hidden";
  const w = hlbar.offsetWidth;
  const h = hlbar.offsetHeight;
  const left = Math.max(8, Math.min(innerWidth - w - 8, Math.round(rect.left)));
  // above the range end, flipped below when the selection ends near the top edge
  const top =
    rect.top < 150 ? Math.round(rect.bottom) + 8 : Math.round(rect.top) - h - 8;
  hlbar.style.left = left + "px";
  hlbar.style.top = Math.max(8, top) + "px";
  hlbar.style.visibility = "visible";
  void hlbar.offsetWidth; // commit the hidden->visible state so the open transition runs
  hlbar.classList.add("open");
};

const createHl = (info, color) => {
  const arr = hlGet(rd.slug);
  if (arr.length >= HL_MAX) {
    arr.sort((a, b) => (a.at || 0) - (b.at || 0));
    arr.shift(); // cap at HL_MAX marks per book, shed the oldest
    hlCapShed = true;
  }
  const block = info.container.closest(".ch-block");
  const c = state.chapters[Number(block.dataset.idx)];
  const p = [...block.querySelectorAll(LEAF_SEL)].indexOf(info.container);
  if (!c || p < 0) return null;
  const rec = {
    id: "hl" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    n: c.n,
    p,
    s: info.s,
    e: info.e,
    excerpt: info.excerpt,
    color,
    note: "",
    at: Date.now(),
  };
  arr.push(rec);
  saveHls(rd.slug, arr);
  drawMark(info.container, rec);
  return rec;
};

let curHl = null;
const openNoteSheet = (rec) => {
  curHl = rec;
  $("#hln-ch").textContent = rec.n;
  const c = Math.min(4, Math.max(1, rec.color || 1));
  $("#hln-quote").style.setProperty("--hlq", `var(--hl${c})`);
  $("#hln-quote-text").textContent = rec.excerpt;
  $("#hln-text").value = rec.note || "";
  openAnySheet(noteSheet);
};
const saveNote = () => {
  if (!curHl) return;
  const arr = hlGet(rd.slug);
  const rec = arr.find((x) => x.id === curHl.id);
  if (!rec) return;
  rec.note = $("#hln-text").value.trim();
  saveHls(rd.slug, arr);
  closeAnySheet();
};
const removeNote = () => {
  if (!curHl) return;
  saveHls(rd.slug, hlGet(rd.slug).filter((x) => x.id !== curHl.id));
  $$("mark.hl").forEach((m) => {
    if (m._hl && m._hl.id === curHl.id) m.remove();
  });
  closeAnySheet();
};
$("#hln-save").onclick = saveNote;
$("#hln-remove").onclick = removeNote;

const renderMarksSheet = () => {
  const arr = hlGet(rd.slug);
  $("#marks-count").textContent = `${arr.length} mark${arr.length === 1 ? "" : "s"}`;
  $("#marks-cap").textContent = hlCapShed ? "500 mark cap — oldest removed" : "";
  const groups = new Map();
  for (const r of [...arr].sort((a, b) => (a.at || 0) - (b.at || 0))) {
    if (!groups.has(r.n)) groups.set(r.n, []);
    groups.get(r.n).push(r);
  }
  const rows = [];
  for (const [n, list] of [...groups].sort((a, b) => a[0] - b[0])) {
    rows.push(`<div class="marks-g">chapter ${esc(n)}</div>`);
    for (const r of list) {
      const c = Math.min(4, Math.max(1, r.color || 1));
      rows.push(
        `<button class="mark-row" data-id="${esc(r.id)}" style="--hlq: var(--hl${c})">` +
          `<span class="mr-bar"></span><span class="mr-txt">` +
          `<span class="mr-q">${esc(r.excerpt)}</span>` +
          (r.note ? `<span class="mr-note">${esc(r.note)}</span>` : "") +
          (r.orphan ? `<span class="mr-moved">moved</span>` : "") +
          `</span><span class="mr-n">#${esc(n)}</span></button>`,
      );
    }
  }
  $("#marks-list").innerHTML = rows.length
    ? rows.join("")
    : `<div class="empty">(・ω・)\n\nno marks yet — select text in a chapter to add one</div>`;
};
$("#r-marks").onclick = () => {
  renderMarksSheet();
  openAnySheet(marksSheet);
};

$("#marks-list").addEventListener("click", (e) => {
  const row = e.target.closest(".mark-row");
  if (!row) return;
  const rec = hlGet(rd.slug).find((r) => r.id === row.dataset.id);
  if (rec) gotoMark(rec);
});

// close the sheet, mount the chapter if trimTop shed it, then scroll to and flash the mark
const gotoMark = async (rec) => {
  closeAnySheet();
  const idx = chapterIndex(rec.n);
  if (idx < 0) return;
  let guard = 0;
  while (rd.first > idx && guard++ < 300) {
    const before = rd.first;
    await loadPrev();
    if (rd.first === before) break;
  }
  guard = 0;
  while (rd.last < idx && guard++ < 300) {
    if (!(await appendNext())) break;
  }
  const block = blockFor(idx);
  if (!block) return;
  const segs = $$("mark.hl", block).filter((m) => m._hl && m._hl.id === rec.id);
  if (segs.length) {
    segs[0].scrollIntoView({ block: "center" });
    segs.forEach((m) => m.classList.add("flash"));
    setTimeout(() => segs.forEach((m) => m.classList.remove("flash")), 800);
  } else {
    block.scrollIntoView({ block: "start" });
  }
};
