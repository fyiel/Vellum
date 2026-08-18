import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMaster, looksFragmentedMp4, parseMaster, parseMedia, pickVariant, resolveUri, segmentIv } from '../src/lib/hls-dl.js'

test('parses master playlists and picks the highest bandwidth variant', () => {
    const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720
hi/index.m3u8
`
    assert.equal(isMaster(text), true)
    const variants = parseMaster(text)
    assert.equal(variants.length, 2)
    assert.deepEqual(pickVariant(variants), { bandwidth: 2400000, uri: 'hi/index.m3u8' })
})

test('parses media playlists with init map, keys, and sequence numbers', () => {
    const text = `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001
#EXTINF:8.0,
seg-7.m4s
#EXTINF:8.0,
seg-8.m4s
`
    assert.equal(isMaster(text), false)
    const { init, segments } = parseMedia(text)
    assert.equal(init, 'init.mp4')
    assert.equal(segments.length, 2)
    assert.deepEqual(segments[0], { uri: 'seg-7.m4s', key: { method: 'AES-128', uri: 'key.bin', iv: '0x00000000000000000000000000000001' }, sequence: 7 })
    assert.equal(segments[1].sequence, 8)
})

test('key method NONE clears the encryption context', () => {
    const text = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:4.0,
a.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:4.0,
b.ts
`
    const { segments } = parseMedia(text)
    assert.equal(segments[0].key.method, 'AES-128')
    assert.equal(segments[1].key, null)
})

test('segmentIv falls back to the big-endian media sequence', () => {
    const explicit = segmentIv({ iv: '0x0000000000000000000000000000000a' }, 3)
    assert.equal(explicit[15], 10)
    const derived = segmentIv({}, 258)
    assert.equal(derived[14], 1)
    assert.equal(derived[15], 2)
})

test('resolves relative uris and detects fragmented mp4', () => {
    assert.equal(resolveUri('https://cdn.test/a/b/list.m3u8', '../seg.ts'), 'https://cdn.test/a/seg.ts')
    assert.equal(looksFragmentedMp4('init.mp4', 's.ts'), true)
    assert.equal(looksFragmentedMp4(null, 'seg-1.m4s'), true)
    assert.equal(looksFragmentedMp4(null, 'seg-1.ts'), false)
})
