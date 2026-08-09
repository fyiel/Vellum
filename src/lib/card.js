// quote card renderer: the single source of truth for the F12 card image.
// pure canvas 2d, fixed 1080x1350 (4:5) terminal-window layout. theme tokens
// come in from the caller (the reader's computed data-theme vars) so the card
// always matches what is on screen; the bundled palette is only a fallback.
const W = 1080;
const H = 1350;
const PAD = 72;
const TITLE_H = 84; // title baseline zone plus the rule under it
const Q_X = PAD + 4 + 30; // quote text x, after the 4px accent rule
const Q_W = W - PAD * 2 - 4 - 30; // max quote line width
const Q_TOP = TITLE_H + 10 + 62; // first quote line box top (accent bar + gap)
const ATT_TOP = H - PAD - 52 - 240; // attribution band top (footer line + band)
const SEP_Y = ATT_TOP - 56; // dashed separator between quote and attribution
const FOOT_Y = H - PAD; // '$ vellum' baseline
const COVER_W = 150;
const COVER_H = 215;
const COVER_X = W - PAD - COVER_W;
const MAX_LINES = 8;

// fallback palettes mirror the reader data-theme tokens, used only when the
// caller passes no computed colors (standalone render, tests)
const THEMES = {
  dark: { bg: "#181818", text: "#c9c9c9", muted: "#6e6e6e", line: "#ffffff14" },
  black: { bg: "#000000", text: "#d6d6d6", muted: "#5f5f5f", line: "#ffffff14" },
  sepia: { bg: "#f4ecd8", text: "#5b4636", muted: "#8a7866", line: "#00000018" },
  light: { bg: "#fbfbfd", text: "#2a2a2c", muted: "#8e8e93", line: "#00000014" },
};

// css vars may carry 8-digit hex, which not every canvas parses, spill it to rgba
const norm = (c, fb) => {
  const s = String(c ?? "").trim();
  const m = /^#([0-9a-f]{8})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 24) & 255},${(n >> 16) & 255},${(n >> 8) & 255},${(n & 255) / 255})`;
  }
  return s || fb;
};

// Gohu and Pixellari are latin-only bitmaps, map the common unicode punctuation
// to ascii so a curly quote or em dash never renders as a tofu box on the card
const ASCII = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u2013": "-",
  "\u2014": "-",
  "\u2026": "...",
  "\u00a0": " ",
};
const ascii = (s) =>
  String(s ?? "").replace(
    /[\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u00a0]/g,
    (c) => ASCII[c],
  );

const wrapLines = (ctx, text, maxW) => {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (ctx.measureText(test).width <= maxW) {
      cur = test;
      continue;
    }
    if (cur) lines.push(cur);
    if (ctx.measureText(w).width > maxW) {
      // a word longer than the line is hard-broken, never spilled
      let rest = w;
      while (rest) {
        let n = rest.length;
        while (n > 1 && ctx.measureText(rest.slice(0, n)).width > maxW) n--;
        lines.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      cur = "";
    } else cur = w;
  }
  if (cur) lines.push(cur);
  return lines;
};

// wrap at the full size, shrink one step if it overflows, then truncate the
// last kept line with '...' so the quote never exceeds the block
const fitQuote = (ctx, text, maxW) => {
  const fit = (size) => {
    ctx.font = `400 ${size}px Gohu`;
    return { lines: wrapLines(ctx, text, maxW), size, lh: Math.round(size * 1.45) };
  };
  let q = fit(44);
  if (q.lines.length > MAX_LINES) {
    q = fit(Math.round(44 * 0.85));
    if (q.lines.length > MAX_LINES) {
      const last = MAX_LINES - 1;
      let line = q.lines[last];
      while (line.length && ctx.measureText(line + "...").width > maxW) line = line.slice(0, -1);
      q.lines = [...q.lines.slice(0, last), line + "..."];
    }
  }
  return q;
};

const fitOne = (ctx, s, maxW) => {
  if (ctx.measureText(s).width <= maxW) return s;
  let t = s;
  while (t.length && ctx.measureText(t + "...").width > maxW) t = t.slice(0, -1);
  return t + "...";
};

const loadFonts = async () => {
  if (!document.fonts?.load) return;
  const faces = [
    "400 44px Gohu",
    "400 34px Gohu",
    "400 28px Gohu",
    "400 26px Gohu",
    "400 40px Pixellari",
  ];
  try {
    await Promise.all(faces.map((f) => document.fonts.load(f).catch(() => null)));
  } catch {}
};

// the cover is best effort: only a same-origin or cors-clean image is drawn,
// anything else (load error, taint) skips it and the typography is untouched
const loadCover = async (url) => {
  if (!url) return null;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  img.src = url;
  try {
    await Promise.race([img.decode(), new Promise((r) => setTimeout(r, 4000))]);
  } catch {
    return null;
  }
  if (!img.complete || !img.naturalWidth) return null;
  // decode success does not prove the pixels are readable, probe on a scratch
  // canvas so a tainted source is dropped before it poisons the real one
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    g.getImageData(0, 0, 1, 1);
  } catch {
    return null;
  }
  return img;
};

export async function renderQuoteCard({
  quote = "",
  series = "",
  chapter = 0,
  chapterTotal = 0,
  theme = "dark",
  colors = null,
  cover = null,
}) {
  await loadFonts();

  const t = THEMES[theme] ?? THEMES.dark;
  const bg = norm(colors?.bg, t.bg);
  const text = norm(colors?.text, t.text);
  const muted = norm(colors?.muted, t.muted);
  const line = norm(colors?.line, t.line);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // terminal window frame
  ctx.strokeStyle = line;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  // title bar: ':: vellum' left, 'ch. N' right, rule underneath
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = text;
  ctx.font = "400 34px Gohu";
  ctx.fillText(":: vellum", PAD, 58);
  ctx.textAlign = "right";
  ctx.fillStyle = muted;
  if (chapter > 0) ctx.fillText(`ch. ${chapter}`, W - PAD, 58);
  ctx.strokeStyle = line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, TITLE_H);
  ctx.lineTo(W - PAD, TITLE_H);
  ctx.stroke();

  // 4px striped accent bar, same pattern as the reader progress bar
  ctx.fillStyle = muted;
  for (let x = PAD; x < W - PAD; x += 6) ctx.fillRect(x, TITLE_H + 6, 4, 4);

  // quote body with the 4px left accent rule
  const q = fitQuote(ctx, ascii(quote).trim(), Q_W);
  const lh = q.lh;
  ctx.textAlign = "left";
  ctx.fillStyle = text;
  let y = Q_TOP + lh;
  for (const ln of q.lines) {
    ctx.fillText(ln, Q_X, y);
    y += lh;
  }
  if (q.lines.length) {
    ctx.fillStyle = text;
    ctx.fillRect(PAD, Q_TOP, 4, q.lines.length * lh);
  }

  // dashed separator
  ctx.strokeStyle = line;
  ctx.lineWidth = 2;
  ctx.setLineDash([16, 10]);
  ctx.beginPath();
  ctx.moveTo(PAD, SEP_Y);
  ctx.lineTo(W - PAD, SEP_Y);
  ctx.stroke();
  ctx.setLineDash([]);

  // attribution: series title in Pixellari, chapter line in muted Gohu
  ctx.textAlign = "left";
  ctx.fillStyle = text;
  ctx.font = "400 40px Pixellari";
  ctx.fillText(fitOne(ctx, ascii(series), COVER_X - PAD - 24), PAD, ATT_TOP + 96);
  ctx.fillStyle = muted;
  ctx.font = "400 28px Gohu";
  const chLine =
    chapterTotal > 1
      ? `chapter ${chapter} of ${chapterTotal}`
      : chapter > 0
        ? `chapter ${chapter}`
        : "";
  if (chLine) ctx.fillText(chLine, PAD, ATT_TOP + 156);

  // '$ vellum' footer prompt
  ctx.fillStyle = muted;
  ctx.font = "400 26px Gohu";
  ctx.fillText("$ vellum", PAD, FOOT_Y);

  const img = await loadCover(cover);
  if (img) {
    ctx.drawImage(img, COVER_X, ATT_TOP + (240 - COVER_H) / 2, COVER_W, COVER_H);
    ctx.strokeStyle = line;
    ctx.lineWidth = 2;
    ctx.strokeRect(COVER_X + 1, ATT_TOP + (240 - COVER_H) / 2 + 1, COVER_W - 2, COVER_H - 2);
  }

  return { canvas };
}
