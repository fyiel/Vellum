import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dlEntries, dlEntry, dlRegister, dlUnregister, dlTotalSize } from '../src/lib/downloads.js'

let raw = null
let writeError = false
globalThis.localStorage = {
    getItem: () => raw,
    setItem: (_, value) => {
        if (writeError) throw new Error('quota exceeded')
        raw = value
    },
}
const entry = (id, extra = {}) => ({ kind: 'novel', key: 'nf:fixture', id: String(id), title: 'Fixture', size: 100, ...extra })

test('indexes a download snapshot once for repeated chapter lookups', () => {
    raw = JSON.stringify(Array.from({ length: 1000 }, (_, i) => entry(i)))
    const parse = JSON.parse
    let parses = 0
    JSON.parse = value => { parses++; return parse(value) }
    try {
        for (let i = 0; i < 3000; i++) assert.equal(dlEntry('novel', 'nf:fixture', i)?.id ?? null, i < 1000 ? String(i) : null)
        assert.equal(parses, 1)
    } finally { JSON.parse = parse }
})

test('observes storage replacement and clearing from another tab or caller', () => {
    raw = JSON.stringify([entry(1)])
    assert.equal(dlEntry('novel', 'nf:fixture', 1)?.title, 'Fixture')
    raw = JSON.stringify([entry(2, { title: 'Replacement' })])
    assert.equal(dlEntry('novel', 'nf:fixture', 1), null)
    assert.equal(dlEntry('novel', 'nf:fixture', 2)?.title, 'Replacement')
    raw = null
    assert.equal(dlEntry('novel', 'nf:fixture', 2), null)
})

test('callers cannot mutate the cached registry through returned entries', () => {
    raw = JSON.stringify([entry(1)])
    dlEntry('novel', 'nf:fixture', 1).title = 'Changed'
    const entries = dlEntries()
    entries[0].title = 'Changed again'
    entries.push(entry(2))
    assert.equal(dlEntry('novel', 'nf:fixture', 1).title, 'Fixture')
    assert.equal(dlEntries().length, 1)
})

test('registration and removal refresh the index and totals', async () => {
    raw = null
    dlRegister(entry(1))
    dlRegister(entry(2, { size: 200 }))
    assert.equal(dlTotalSize(), 300)
    assert.equal(dlEntry('novel', 'nf:fixture', 2).size, 200)
    dlRegister(entry(2, { size: 400 }))
    assert.equal(dlEntries().length, 2)
    assert.equal(dlTotalSize(), 500)
    await dlUnregister('novel', 'nf:fixture', 1)
    assert.equal(dlEntry('novel', 'nf:fixture', 1), null)
    assert.equal(dlTotalSize(), 400)
})

test('a failed storage write does not appear in the cached registry', () => {
    raw = JSON.stringify([entry(1)])
    assert.equal(dlEntries().length, 1)
    writeError = true
    try { assert.throws(() => dlRegister(entry(2)), /Could not save/) }
    finally { writeError = false }
    assert.equal(dlEntry('novel', 'nf:fixture', 2), null)
    assert.equal(dlEntries().length, 1)
})

test('malformed registry data degrades to an empty list', () => {
    for (const value of ['{broken', '{}', 'null', '12', '[null]']) {
        raw = value
        assert.deepEqual(dlEntries(), [])
        assert.equal(dlEntry('novel', 'nf:fixture', 1), null)
    }
})

test('provider and chapter separators do not collide in the index', () => {
    raw = JSON.stringify([entry('one:two', { key: 'nf:fixture' }), entry('two', { key: 'nf:fixture:one' })])
    assert.equal(dlEntry('novel', 'nf:fixture', 'one:two').key, 'nf:fixture')
    assert.equal(dlEntry('novel', 'nf:fixture:one', 'two').key, 'nf:fixture:one')
})
