import {
  getSeries,
  getChapters,
  getChapter,
  prefetchChapter,
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

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

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
  // reader scrolls the document (so Safari minimises its toolbar); paint the page bg to match during rubber band
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

const scrollY = () => window.scrollY;
const viewH = () => window.innerHeight;
const docH = () => document.documentElement.scrollHeight;

if ("scrollRestoration" in history) history.scrollRestoration = "manual";

prose.addEventListener(
  "load",
  (e) => {
    const img = e.target;
    if (img.tagName !== "IMG" || state.view !== "reader") return;
    const r = img.getBoundingClientRect();
    if (r.top < 0) window.scrollBy(0, Math.min(0, r.bottom) - r.top);
  },
  true,
);

export async function showReader(slug, n) {
  state.view = "reader";
  R.classList.add("active");
  // takeover: hide the shell and let the document scroll through the reader
  document.documentElement.classList.add("reading");
  document.body.classList.add("reading");
  applySettings();

  if (state.slug !== slug || !state.chapters.length) {
    prose.innerHTML = `<div class="spinner"></div>`;
    rfoot.innerHTML = "";
    try {
      const { chapters } = await getChapters(slug);
      state.slug = slug;
      state.chapters = chapters;
    } catch (e) {
      prose.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      return;
    }
  }
  if (state.series?.nfSlug !== slug) hydrateSeries(slug);

  const idx = Math.max(0, chapterIndex(n));
  const pos = posGet(slug);
  await startAt(slug, idx, pos && pos.n === n ? pos.p : 0);
}

async function hydrateSeries(slug) {
  const key = slug.includes(":") ? slug : "nf:" + slug;
  try {
    const s = await getSeries(key);
    if (rd.slug !== slug) return;
    state.series = { ...s, key: s.key ?? key };
    if (rd.cur >= 0) updateLibrary(rd.cur);
  } catch {}
}

export const closeReader = () => {
  posSave();
  closeSheet();
  closeDrawer();
  R.classList.remove("active");
  document.documentElement.classList.remove("reading");
  document.body.classList.remove("reading");
  document.body.style.background = "";
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

const makeBlock = (idx, c, ch) => {
  const block = document.createElement("section");
  block.className = "ch-block";
  block.dataset.idx = idx;
  // paragraphs as <div> not <p> so Safari doesn't flag the page as a Reader-mode article (which kills our JS scroll)
  const body = ch.html
    .replace(/<p>/g, '<div class="rp">')
    .replace(/<\/p>/g, "</div>");
  const title = ch.title || c.t;
  block.innerHTML =
    `<div class="reader-ch-meta">chapter ${c.n} of ${state.chapters.length}</div>` +
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

  prose.appendChild(makeBlock(idx, c, ch));
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
      ensureBuffer();
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
  prose.prepend(makeBlock(idx, c, ch));
  rd.first = idx;
  renderPrevHint();
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
}

function setCurrent(idx) {
  if (idx < 0 || idx === rd.cur) return;
  rd.cur = idx;

  const c = state.chapters[idx];
  $("#r-title").textContent = c.t;
  history.replaceState(null, "", `#/read/${hashSlug(rd.slug)}/${c.n}`);

  for (let i = rd.first; i < idx; i++) markChapterRead(state.chapters[i].n);
  updateLibrary(idx);
}

const topChapterIdx = () => {
  const y = scrollY() + 90;
  let idx = rd.first;
  for (const b of prose.querySelectorAll(".ch-block")) {
    if (b.offsetTop <= y) idx = Number(b.dataset.idx);
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

const updateLibrary = (idx) => {
  const s = state.series;
  const c = state.chapters[idx];
  touchLibrary({
    slug: rd.slug,
    id: s?.id,
    title: s?.title || rd.slug.replace(/-/g, " "),
    cover: s?.cover || "",
    lastN: c.n,
    total: state.chapters.length,
    readCount: readSet(rd.slug).size,
  });
};

const chapterProgress = () => {
  const b = blockFor(rd.cur);
  if (!b) return 0;
  return Math.min(
    1,
    Math.max(
      0,
      (scrollY() + viewH() - b.offsetTop) / Math.max(1, b.offsetHeight),
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
  }) => `<a class="chap${set.has(c.n) ? " read" : ""}${i === rd.cur ? " current" : ""}" href="#/read/${hashSlug(rd.slug)}/${c.n}">
      <span class="n">#${c.n}</span><span class="t">${esc(c.t)}</span><span class="dot"></span></a>`;
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
  syncSheet();
  updateProgress();
};
