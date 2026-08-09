// Local (imported EPUB) books: raw chapter xhtml + extracted images live in the
// IndexedDB 'books' store of the shared 'vellum' database, keyed by the content
// hash slug. Metadata and progress stay in localStorage like every other series;
// the meta row doubles as the commit marker for an import (a book is complete
// only when its meta row exists), so an interrupted import leaves no usable entry.
//
// Keys:  local:<hash8>:meta         book metadata
//        local:<hash8>:<n>          chapter record { t, html, imgs }
//        local:<hash8>:img:<name>   image blob (canonical member name)

import { db } from './cache.js'
import { esc } from './dom.js'

export const isLocal = (slug) => String(slug || '').startsWith('local:')
export const localSlug = (hash8) => `local:${hash8}`

const mk = (slug, part) => `${slug}:${part}`

function getKey(store, key) {
  return db().then((d) => {
    if (!d) return null
    return new Promise((res) => {
      const r = d.transaction(store, 'readonly').objectStore(store).get(key)
      r.onsuccess = () => res(r.result ?? null)
      r.onerror = () => res(null)
    })
  })
}

export async function storeBook(slug, meta, chapters, images, coverName) {
  const d = await db()
  if (!d) throw new Error('storage is unavailable')
  await new Promise((res, rej) => {
    const tx = d.transaction('books', 'readwrite')
    const st = tx.objectStore('books')
    for (const c of chapters) st.put({ t: c.t, html: c.html, imgs: c.imgs || [] }, mk(slug, c.n))
    for (const img of images) st.put(new Blob([img.data]), mk(slug, `img:${img.name}`))
    // the cover is re-exposed under a fixed name so renders don't need its path
    const cov = images.find((i) => i.name === coverName)
    if (cov) st.put(new Blob([cov.data]), mk(slug, 'img:cover'))
    st.put(meta, mk(slug, 'meta')) // commit marker, written last in the same transaction
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
    tx.onabort = () => rej(tx.error || new Error('store aborted'))
  })
}

export const getLocalMeta = (slug) => getKey('books', mk(slug, 'meta'))
export const getLocalChapter = (slug, n) => getKey('books', mk(slug, n))

export async function getLocalChapters(slug) {
  const meta = await getLocalMeta(slug)
  return { chapters: Array.isArray(meta?.toc) ? meta.toc : [] }
}

export const getLocalImage = (slug, name) => getKey('books', mk(slug, `img:${name}`))

// blob URLs are session-scoped, cache them so covers and chapter images resolve
// instantly on re-render and never leak duplicates
const objUrls = new Map()
export async function localImageUrl(slug, name) {
  const key = mk(slug, name)
  if (objUrls.has(key)) return objUrls.get(key)
  const blob = await getLocalImage(slug, name)
  if (!blob) return ''
  const url = URL.createObjectURL(blob)
  objUrls.set(key, url)
  return url
}

// resolves every [data-localcover] placeholder in a rendered view to its blob url
export function mountLocalCovers(root = document) {
  for (const el of root.querySelectorAll('[data-localcover]')) {
    if (el.dataset.lcBusy) continue
    el.dataset.lcBusy = '1'
    const slug = el.dataset.localcover
    localImageUrl(slug, 'cover').then((url) => {
      if (!el.isConnected) return
      if (url) el.innerHTML = `<img src="${esc(url)}" alt="">`
      else el.textContent = ''
    })
  }
}

export async function deleteBook(slug) {
  const d = await db()
  if (!d) return
  const prefix = `${slug}:`
  await new Promise((res) => {
    const tx = d.transaction('books', 'readwrite')
    const st = tx.objectStore('books')
    const cur = st.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`))
    cur.onsuccess = (e) => {
      const c = e.target.result
      if (c) {
        c.delete()
        c.continue()
      }
    }
    tx.oncomplete = () => res()
    tx.onerror = () => res()
    tx.onabort = () => res()
  })
}
