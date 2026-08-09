// Import flow for local EPUBs: file picker + drag-drop overlay, progress sheet,
// named-error / confirm sheets, dedupe by content hash and replace-with-progress.
// The heavy parser is loaded lazily so the main bundle stays lean.

import { library, touchLibrary, dropLibrary, readSet, saveRead, posGet, posSet } from '../lib/store.js'
import { go } from '../lib/router.js'
import { $, esc } from '../lib/dom.js'
import { storeBook, getLocalMeta, deleteBook } from '../lib/localbooks.js'
import { PICKER_MAX } from '../lib/epub.js'

let wiredDrop = false
let busy = false

// drag-drop overlay on the Den; wired once from the library screen (the home view)
export function installImportDrops() {
  if (wiredDrop) return
  wiredDrop = true
  let depth = 0
  const overlay = $('#imp-overlay')
  const hasFiles = (e) => e.dataTransfer?.types?.includes('Files')

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth++
    overlay.hidden = false
  })
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault()
  })
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return
    depth = Math.max(0, depth - 1)
    if (!depth) overlay.hidden = true
  })
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth = 0
    overlay.hidden = true
    const file = [...(e.dataTransfer?.files || [])][0]
    if (file) importFile(file)
  })
}

export async function openImport(opts = {}) {
  const file = await pickFile()
  if (file) await importFile(file, { replaceSlug: opts.replaceSlug })
}

function pickFile() {
  return new Promise((res) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.epub,application/epub+zip'
    input.style.display = 'none'
    let done = false
    const finish = (f) => {
      if (done) return
      done = true
      input.remove()
      res(f)
    }
    input.onchange = () => finish(input.files?.[0] || null)
    // modern browsers fire `cancel` when the picker is dismissed without a file; where it
    // is missing the promise simply stays pending, which is a harmless no-op for the app
    if ('oncancel' in input) input.oncancel = () => finish(null)
    document.body.appendChild(input)
    input.click()
  })
}

// instant feedback without reading the file; the parser re-validates everything
function precheck(file) {
  const name = String(file.name || '')
  if (/\.pdf$/i.test(name) || file.type === 'application/pdf') {
    showError('PDF isn’t supported — Vellum reads EPUB files. PDFs are fixed-layout documents that don’t fit the reading view.')
    return true
  }
  if (file.size > PICKER_MAX) {
    showError('books larger than 100 MB are not supported')
    return true
  }
  return false
}

export async function importFile(file, opts = {}) {
  if (busy || !file || precheck(file)) return
  busy = true
  try {
    await runImport(file, opts?.replaceSlug)
  } finally {
    busy = false
  }
}

async function runImport(file, replaceSlug) {
  showProgress('reading book…')
  let book
  try {
    const { parseEpub } = await import('../lib/epub.js')
    book = await parseEpub(file, setProgress)
  } catch (e) {
    hideSheet()
    showError(e.message || 'couldn’t read this file')
    return
  }

  // same hash already imported: never a duplicate entry, resume the existing one
  const existing = library().find((e) => e.slug === book.slug)
  if (existing) {
    const meta = await getLocalMeta(book.slug)
    if (meta) {
      hideSheet()
      showDialog(existing.title, 'This book is already in your library.', [
        { label: 'Continue', primary: true, act: () => go(`#/series/${encodeURIComponent(book.slug)}`) },
      ])
      return
    }
    // an entry without stored data is a broken import, repair it below
  }

  // replacing an existing book keeps its progress; a changed file with the same
  // title asks whether the old read positions should carry over. the old book is
  // only removed once the new one is stored, so a failed save loses nothing
  let carryFrom = null
  let dropAfter = null
  if (replaceSlug) {
    if (replaceSlug === book.slug) {
      hideSheet()
      showDialog(book.meta.title, 'The file hasn’t changed.', [
        { label: 'Continue', primary: true, act: () => go(`#/series/${encodeURIComponent(book.slug)}`) },
      ])
      return
    }
    carryFrom = replaceSlug
  } else {
    const clash = library().find(
      (e) =>
        e.kind === 'local' &&
        e.slug !== book.slug &&
        String(e.title || '').toLowerCase() === String(book.meta.title || '').toLowerCase(),
    )
    if (clash) {
      hideSheet()
      const pick = await confirmDialog(
        `“${clash.title}” changed — keep your progress?`,
        'This file differs from the one you imported before. Keep your read positions and replace the old copy, or start this file fresh.',
        [{ label: 'Start fresh' }, { label: 'Keep progress', primary: true }],
      )
      if (pick == null) return // cancelled, nothing was written
      if (pick === 1) carryFrom = clash.slug
      else dropAfter = clash.slug
      showProgress('storing book…')
    }
  }

  showProgress('storing book…')
  book.meta.toc = book.chapters.map((c) => ({ n: c.n, t: c.t }))
  book.meta.total = book.chapters.length
  try {
    await storeBook(book.slug, book.meta, book.chapters, book.images, book.cover)
  } catch (e) {
    hideSheet()
    showError(`couldn’t save this book (${e.message || 'storage error'})`)
    return
  }

  if (carryFrom) {
    const set = readSet(carryFrom)
    if (set.size) saveRead(book.slug, set)
    const pos = posGet(carryFrom)
    if (pos) posSet(book.slug, pos)
    dropAfter = carryFrom
  }
  if (dropAfter) {
    await deleteBook(dropAfter)
    dropLibrary(dropAfter)
  }

  touchLibrary({
    kind: 'local',
    slug: book.slug,
    id: book.slug,
    title: book.meta.title,
    author: book.meta.author,
    total: book.chapters.length,
  })
  hideSheet()
  go(`#/series/${encodeURIComponent(book.slug)}`)
}

// ---------------------------------------------------------------- sheets

const setProgress = (msg) => {
  const m = $('#imp-msg')
  if (m) m.textContent = msg
}

function showProgress(msg) {
  showSheet(`<div class="imp-title">Importing</div>
    <div class="imp-prog"><span class="impspin"></span><span class="imp-msg" id="imp-msg">${esc(msg)}</span></div>`)
}

function showSheet(html) {
  $('#impsheet').innerHTML = html
  $('#impsheet').classList.add('open')
  $('#impbd').classList.add('open')
  $('#impbd').onclick = null // no stale cancel handler from a previous dialog
}

function hideSheet() {
  $('#impsheet').classList.remove('open')
  $('#impbd').classList.remove('open')
}

function showError(message) {
  showDialog('Couldn’t import this book', message, [{ label: 'OK', primary: true }])
}

function showDialog(title, body, buttons) {
  showSheet(dialogHtml(title, body, buttons))
  const sheet = $('#impsheet')
  for (const [i, b] of buttons.entries()) {
    sheet.querySelector(`[data-i="${i}"]`).onclick = () => {
      hideSheet()
      b.act?.()
    }
  }
}

// resolves with the button index, or null when dismissed
export function confirmDialog(title, body, buttons) {
  return new Promise((res) => {
    showSheet(dialogHtml(title, body, buttons))
    const sheet = $('#impsheet')
    for (const [i] of buttons.entries()) {
      sheet.querySelector(`[data-i="${i}"]`).onclick = () => {
        hideSheet()
        res(i)
      }
    }
    $('#impbd').onclick = () => {
      hideSheet()
      res(null)
    }
  })
}

function dialogHtml(title, body, buttons) {
  return `<div class="imp-title">${esc(title)}</div>
    <div class="imp-body">${esc(body)}</div>
    <div class="imp-actions">${buttons
      .map((b, i) => `<button class="btn ${b.primary ? 'primary' : ''}" data-i="${i}">${esc(b.label)}</button>`)
      .join('')}</div>`
}
