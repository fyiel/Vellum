// Zero-dependency EPUB reader.
//
// Hand-rolled zip (EOCD + central directory + local headers) and RFC 1951 inflate
// via the DecompressionStream framing trick: prepend a zlib header (0x78 0x9C) to the
// raw deflate member, stream-decompress, then append the CORRECT Adler-32 of the output
// as a trailer (two-phase: the first pass collects the output while the missing trailer
// makes the stream error at the very end, the second pass feeds the real trailer and the
// decoder then verifies the deflate stream end to end). Every member is then CRC-32
// verified against the central directory, so a corrupt stream that still decodes cannot
// slip through silently.
//
// Bombs: 100 MB picker cap, 200 MB total expanded refusal (50 MB soft budget), a per
// member cap, an entry count cap, and a running budget while inflating.

export class EpubError extends Error {
  constructor(message, code = 'invalid') {
    super(message)
    this.name = 'EpubError'
    this.code = code
  }
}

export const PICKER_MAX = 100 * 1024 * 1024 // file size cap at the picker
export const EXPANDED_MAX = 200 * 1024 * 1024 // hard refusal; books between 50 MB and the cap import fine (the running budget keeps memory bounded)
export const ENTRY_MAX = 20 * 1024 * 1024 // single member expanded cap
export const ENTRY_CAP = 5000 // member count cap

const EOCD = 0x06054b50
const CDIR = 0x02014b50
const LHD = 0x04034b50

const dec = new TextDecoder('utf-8') // strips the BOM by default
const decU8 = (u8) => {
  try { return dec.decode(u8) } catch { throw new EpubError('couldn’t decode this book', 'invalid') }
}

// ---------------------------------------------------------------- zip structure

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf[i] !== 0x50 || buf[i + 1] !== 0x4b || buf[i + 2] !== 0x05 || buf[i + 3] !== 0x06) continue
    const dv = new DataView(buf.buffer, buf.byteOffset + i, 22)
    return {
      total: dv.getUint16(10, true),
      cdSize: dv.getUint32(12, true),
      cdOff: dv.getUint32(16, true),
    }
  }
  return null
}

function readEntries(buf, eocd) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const out = []
  let p = eocd.cdOff
  for (let k = 0; k < eocd.total; k++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== CDIR) {
      throw new EpubError('corrupt zip central directory', 'corrupt')
    }
    const flags = dv.getUint16(p + 8, true)
    const method = dv.getUint16(p + 10, true)
    const crc = dv.getUint32(p + 16, true)
    const csize = dv.getUint32(p + 20, true)
    const usize = dv.getUint32(p + 24, true)
    const nlen = dv.getUint16(p + 28, true)
    const xlen = dv.getUint16(p + 30, true)
    const clen = dv.getUint16(p + 32, true)
    const off = dv.getUint32(p + 42, true)
    if (usize === 0xffffffff || csize === 0xffffffff || off === 0xffffffff) {
      throw new EpubError('this EPUB uses zip64, which Vellum can’t read yet', 'zip64')
    }
    const name = decU8(buf.subarray(p + 46, p + 46 + nlen))
    out.push({ name, method, flags, crc, csize, usize, off })
    p += 46 + nlen + xlen + clen
  }
  return out
}

// a path may not escape the archive root
function normPath(p) {
  const parts = String(p).replace(/\\/g, '/').split('/')
  const out = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!out.length) throw new EpubError('a file in this book escapes its own folder', 'invalid')
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

const dirOf = (p) => {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

// ---------------------------------------------------------------- checksums

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(u8) {
  let c = 0xffffffff
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function adler32(u8) {
  let a = 1
  let b = 0
  for (let i = 0; i < u8.length; i++) {
    a = (a + u8[i]) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

// ---------------------------------------------------------------- inflate

const ZLIB_HDR = new Uint8Array([0x78, 0x9c])

// Streams one input through DecompressionStream('deflate'). `budget` (when given)
// enforces the running expanded-size cap and its `used` counter is shared across
// members. `verifyOnly` discards the output (used for the trailer pass).
async function streamInflate(input, budget, verifyOnly) {
  const ds = new DecompressionStream('deflate')
  const reader = ds.readable.getReader()
  const writer = ds.writable.getWriter()
  const chunks = []
  let total = 0
  let err = null
  const feed = (async () => {
    try {
      await writer.write(input)
      await writer.close()
    } catch (e) {
      err = e
    }
  })()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (budget) {
        budget.used += value.length
        if (budget.used > budget.max) {
          await reader.cancel()
          throw new EpubError('this book expands beyond the supported size', 'size')
        }
      }
      if (!verifyOnly) chunks.push(value)
    }
  } catch (e) {
    err = e
  }
  await feed
  return { out: verifyOnly ? null : concat(chunks, total), total, err }
}

function concat(chunks, total) {
  const out = new Uint8Array(total)
  let p = 0
  for (const c of chunks) {
    out.set(c, p)
    p += c.length
  }
  return out
}

async function inflateRaw(data, budget) {
  // the first pass decompresses the whole member; the missing Adler-32 trailer makes
  // the stream error at the very end and that error is expected here, the data came out whole
  const first = await streamInflate(concat([ZLIB_HDR, data], ZLIB_HDR.length + data.length), budget, false)
  const out = first.out
  // the second pass feeds the correct trailer: the decoder now verifies the deflate
  // stream end to end, so a truncated or garbage stream errors instead of yielding
  // silently truncated content (the crc check below catches content corruption)
  const a = adler32(out)
  const trailer = new Uint8Array([a >>> 24, (a >>> 16) & 255, (a >>> 8) & 255, a & 255])
  const second = await streamInflate(concat([ZLIB_HDR, data, trailer], ZLIB_HDR.length + data.length + 4), null, true)
  if (second.err) throw new EpubError('corrupt data inside the book', 'corrupt')
  return out
}

// ---------------------------------------------------------------- tiny xml

function unescapeXml(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

// A minimal well-formed-XML reader producing a tiny tree {tag, attrs, children, text}.
// Kept deliberately small: OPF/NCX/nav are simple documents.
export function parseXml(src) {
  const text = String(src).replace(/^\uFEFF/, '')
  const root = { tag: '#root', attrs: {}, children: [], text: '' }
  const stack = [root]
  const attrRe = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let i = 0
  const pushText = (s) => {
    if (s) stack[stack.length - 1].text += s
  }
  while (i < text.length) {
    const lt = text.indexOf('<', i)
    if (lt < 0) {
      pushText(text.slice(i))
      break
    }
    pushText(text.slice(i, lt))
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4)
      i = end < 0 ? text.length : end + 3
      continue
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9)
      pushText(text.slice(lt + 9, end < 0 ? text.length : end))
      i = end < 0 ? text.length : end + 3
      continue
    }
    if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt)
      i = end < 0 ? text.length : end + 1
      continue
    }
    const gt = text.indexOf('>', lt)
    if (gt < 0) break
    const raw = text.slice(lt + 1, gt)
    const selfClose = raw.endsWith('/')
    const inner = selfClose ? raw.slice(0, -1) : raw
    if (inner.startsWith('/')) {
      stack.pop()
      i = gt + 1
      continue
    }
    const name = inner.split(/[\s/]/)[0].trim()
    const el = { tag: name, attrs: {}, children: [], text: '' }
    attrRe.lastIndex = name.length
    let m
    while ((m = attrRe.exec(inner))) el.attrs[m[1].toLowerCase()] = unescapeXml(m[3] ?? m[4] ?? '')
    stack[stack.length - 1].children.push(el)
    if (!selfClose && !/^(br|hr|img|image|meta|link|input|source|col|wbr|base|area|embed|param|track)$/i.test(name)) {
      stack.push(el)
    }
    i = gt + 1
  }
  return root
}

export function findAll(el, tag) {
  const out = []
  const walk = (n) => {
    for (const c of n.children) {
      // metadata uses dc: prefixes, match on the local name
      if (c.tag === tag || c.tag.endsWith(`:${tag}`)) out.push(c)
      walk(c)
    }
  }
  walk(el)
  return out
}

const allText = (el) => {
  let s = el.text
  for (const c of el.children) s += allText(c)
  return s
}

// ---------------------------------------------------------------- epub

// canonical member name for an href relative to a base dir
const resolveHref = (base, href) => normPath(base ? `${base}/${href}` : href)

async function sha8(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf)
  const h = new Uint8Array(d)
  let s = ''
  for (let i = 0; i < 4; i++) s += h[i].toString(16).padStart(2, '0')
  return s
}

async function readMember(buf, ent, budget) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const p = ent.off
  if (p + 30 > buf.length || dv.getUint32(p, true) !== LHD) {
    throw new EpubError(`corrupt zip entry for ${ent.name}`, 'corrupt')
  }
  const nlen = dv.getUint16(p + 26, true)
  const xlen = dv.getUint16(p + 28, true)
  const start = p + 30 + nlen + xlen
  if (ent.csize > ENTRY_MAX || ent.usize > ENTRY_MAX) {
    throw new EpubError('a file inside this book is larger than the supported limit', 'size')
  }
  const data = buf.subarray(start, start + ent.csize)
  if (data.length !== ent.csize) throw new EpubError(`truncated zip entry for ${ent.name}`, 'corrupt')

  let raw
  if (ent.method === 0) raw = data
  else if (ent.method === 8) raw = await inflateRaw(data, budget)
  else throw new EpubError(`unsupported compression inside ${ent.name}`, 'corrupt')

  if (raw.length !== ent.usize) throw new EpubError(`size mismatch in ${ent.name}`, 'corrupt')
  if (crc32(raw) !== ent.crc) throw new EpubError(`corrupt data in ${ent.name} (checksum mismatch)`, 'corrupt')
  return raw
}

// every <img src> in tag order; non-member refs (data:/http) become null so the list
// stays 1:1 with the sanitized output the reader re-links
function extractImgRefs(html, base) {
  const out = []
  const re = /<img\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)')/gi
  let m
  while ((m = re.exec(html))) {
    const ref = m[2] ?? m[3] ?? ''
    if (!ref || /^(?:data|https?:|blob:)/i.test(ref)) {
      out.push(null)
      continue
    }
    try {
      out.push(resolveHref(base, ref))
    } catch {
      out.push(null)
    }
  }
  return out
}

export async function parseEpub(file, onPhase = () => {}) {
  const name = String(file?.name || '')
  if (/\.pdf$/i.test(name) || file.type === 'application/pdf') {
    throw new EpubError('PDF isn’t supported — Vellum reads EPUB files. PDFs are fixed-layout documents that don’t fit the reading view.', 'pdf')
  }
  if (file.size > PICKER_MAX) {
    throw new EpubError('books larger than 100 MB are not supported', 'size')
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new EpubError('this device’s browser can’t decompress EPUB files (an update may be needed)', 'unsupported')
  }

  onPhase('reading book…')
  const buf = new Uint8Array(await file.arrayBuffer())
  if (buf.length < 30 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
    throw new EpubError('this doesn’t look like an EPUB file', 'type')
  }
  const eocd = findEOCD(buf)
  if (!eocd) throw new EpubError('this doesn’t look like an EPUB file (no zip directory)', 'type')
  const entries = readEntries(buf, eocd)
  if (entries.length > ENTRY_CAP) throw new EpubError('this book contains too many files', 'size')

  // DRM gate before any member is read
  for (const e of entries) {
    if (/^META-INF\//i.test(e.name) && /(?:encryption\.xml|rights\.xml|\.acsm)$/i.test(e.name)) {
      throw new EpubError('this book is protected by DRM and can’t be read in Vellum', 'drm')
    }
  }

  // total expanded budget from the central directory (cheap, no inflate needed)
  let expanded = 0
  for (const e of entries) expanded += e.usize
  if (expanded > EXPANDED_MAX) {
    throw new EpubError('this book expands beyond the supported size (200 MB)', 'size')
  }
  const budget = { used: 0, max: EXPANDED_MAX }
  const byName = new Map()
  for (const e of entries) {
    if (!byName.has(e.name)) byName.set(e.name, e)
  }
  const entryOf = (raw) => {
    const exact = byName.get(raw)
    if (exact) return exact
    let n
    try {
      n = normPath(raw)
    } catch {
      return null
    }
    return byName.get(n) || null
  }

  if (!entryOf('META-INF/container.xml')) {
    throw new EpubError('this doesn’t look like an EPUB file (missing container)', 'type')
  }

  onPhase('reading metadata…')
  const container = parseXml(decU8(await readMember(buf, entryOf('META-INF/container.xml'), budget)))
  const rootfile = findAll(container, 'rootfile')[0]
  const opfPath = rootfile?.attrs['full-path'] || rootfile?.attrs['fullpath']
  if (!opfPath) throw new EpubError('no package document found in this EPUB', 'invalid')
  const opfName = normPath(opfPath)
  const opfEnt = entryOf(opfName)
  if (!opfEnt) throw new EpubError(`missing package document ${opfName}`, 'invalid')
  const opf = parseXml(decU8(await readMember(buf, opfEnt, budget)))

  // ---------------------------------------------------------------- metadata
  const dc = (tag) => {
    const el = findAll(opf, tag)[0]
    if (!el) return ''
    return allText(el).replace(/\s+/g, ' ').trim()
  }
  const identifiers = findAll(opf, 'identifier')
  const isbnEl = identifiers.find((el) => /isbn/i.test(el.attrs.scheme || '')) ||
    identifiers.find((el) => /isbn/i.test(allText(el) || ''))
  const meta = {
    title: dc('title') || 'Untitled',
    author: dc('creator') || dc('contributor') || '',
    language: dc('language'),
    publisher: dc('publisher'),
    isbn: isbnEl ? allText(isbnEl).replace(/\s+/g, '').trim() : '',
    description: dc('description'),
    size: file.size,
    importedAt: Date.now(),
  }

  // ---------------------------------------------------------------- manifest + spine
  const manifest = {}
  for (const it of findAll(opf, 'item')) {
    const id = it.attrs.id
    const href = it.attrs.href
    if (!id || href == null) continue
    try {
      manifest[id] = {
        href: resolveHref(dirOf(opfName), href),
        media: (it.attrs['media-type'] || '').toLowerCase(),
        properties: it.attrs.properties || '',
      }
    } catch { /* path escapes the archive, ignore the item */ }
  }
  const itemrefs = findAll(opf, 'itemref').filter((r) => manifest[r.attrs.idref])
  let spine = itemrefs.filter((r) => r.attrs.linear !== 'no')
  if (!spine.length) spine = itemrefs
  if (!spine.length) throw new EpubError('this book has no readable content', 'invalid')

  // ---------------------------------------------------------------- toc
  const navItem = Object.values(manifest).find((m) => /(^|\s)nav(\s|$)/i.test(m.properties)) ||
    Object.values(manifest).find((m) => m.media === 'application/x-dtbncx+xml')
  const tocEntries = []
  if (navItem) {
    const navEnt = entryOf(navItem.href)
    if (navEnt) {
      const nav = parseXml(decU8(await readMember(buf, navEnt, budget)))
      if (navItem.media === 'application/x-dtbncx+xml') {
        for (const np of findAll(nav, 'navPoint')) {
          const a = findAll(np, 'text')[0]
          const c = findAll(np, 'content')[0]
          if (a && c) tocEntries.push({ href: c.attrs.src || '', t: allText(a).replace(/\s+/g, ' ').trim() })
        }
      } else {
        const tocNav = findAll(nav, 'nav').find((n) => /toc/i.test(n.attrs['epub:type'] || '')) ||
          findAll(nav, 'nav')[0]
        if (tocNav) {
          for (const a of findAll(tocNav, 'a')) {
            const t = allText(a).replace(/\s+/g, ' ').trim()
            if (a.attrs.href) tocEntries.push({ href: a.attrs.href, t })
          }
        }
      }
    }
  }
  const tocByDoc = new Map()
  for (const e of tocEntries) {
    let key
    try {
      key = resolveHref(dirOf(navItem.href), e.href.split('#')[0])
    } catch {
      continue
    }
    if (!tocByDoc.has(key)) tocByDoc.set(key, e.t)
  }

  // ---------------------------------------------------------------- chapters + images
  onPhase('extracting chapters…')
  const chapters = []
  const images = []
  const imageNames = new Set()
  for (let i = 0; i < spine.length; i++) {
    const item = manifest[spine[i].attrs.idref]
    const ent = entryOf(item.href)
    if (!ent) throw new EpubError(`missing content file ${item.href}`, 'invalid')
    const html = decU8(await readMember(buf, ent, budget))
    const imgs = []
    for (const ref of extractImgRefs(html, dirOf(item.href))) {
      imgs.push(ref)
      if (!ref || imageNames.has(ref)) continue
      const ie = entryOf(ref)
      if (!ie) continue // broken reference, the reader hides the image quietly
      const data = await readMember(buf, ie, budget)
      imageNames.add(ref)
      images.push({ name: ref, data })
    }
    chapters.push({
      n: i + 1,
      t: tocByDoc.get(item.href) || `Section ${i + 1}`,
      html,
      imgs,
    })
  }

  // ---------------------------------------------------------------- cover
  onPhase('picking the cover…')
  let coverName = ''
  const coverMeta = findAll(opf, 'meta').find((el) => (el.attrs.name || '').toLowerCase() === 'cover')
  if (coverMeta && manifest[coverMeta.attrs.content]) {
    coverName = manifest[coverMeta.attrs.content].href
    if (!manifest[coverMeta.attrs.content].media.startsWith('image/')) coverName = ''
  }
  if (!coverName) {
    const guide = findAll(opf, 'reference').find((el) => /cover/i.test(el.attrs.type || ''))
    if (guide) {
      const g = Object.values(manifest).find((m) => m.href === resolveHref(dirOf(opfName), guide.attrs.href))
      if (g && g.media.startsWith('image/')) coverName = g.href
    }
  }
  if (!coverName) {
    const first = Object.values(manifest).find((m) => m.media.startsWith('image/'))
    if (first) coverName = first.href
  }
  if (coverName && !imageNames.has(coverName)) {
    const ce = entryOf(coverName)
    if (ce) {
      const data = await readMember(buf, ce, budget)
      imageNames.add(coverName)
      images.push({ name: coverName, data })
    }
  }

  const hash = await sha8(buf)
  return {
    slug: `local:${hash}`,
    meta,
    chapters,
    images,
    cover: coverName,
    expanded: budget.used,
  }
}
