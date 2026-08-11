import test from 'node:test'
import assert from 'node:assert/strict'
import { kisskh, kisskhKkey } from '../adapter/providers/kisskh.mjs'
import { cached } from '../adapter/anime-adapter.mjs'

const request = () => new Request('https://vellum.test/')
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const ctx = fetchImpl => ({ env: {}, fetchImpl, request: request(), cached })

test('derives the deterministic episode kkey (verified against the live API)', () => {
    // episode 129348's kkey as captured live from kisskh.co — a regression pin on the AES constants
    assert.equal(kisskhKkey('129348'), 'EF805D6FC5CD6C5DF45B52E7930CE404532E353421D3AE946AC00329DDB04B4B65481F11653D3A9D454DAED78B253155A2099E95CDBA1166035A186FF0413836E00807F255CFDC7B3A731A887001FE7F39703399E1AF6C1E4523E63503CECBB60ABAFC853DAE481F8BE0DCE25304A1C5513CB61F3E1D343EE4833B594CC0C350')
})

test('normalizes KissKH recent feed rows', async () => {
    const fetchImpl = async url => {
        assert.match(String(url), /\/DramaList\/LastUpdate\?ispc=1$/)
        return response([{ id: 7302, title: 'Mashle', thumbnail: 'https://img.test/m.jpg', episodesCount: 13, label: '' }])
    }
    const result = await kisskh.discover(ctx(fetchImpl))
    assert.deepEqual(result.rows, [{ key: 'kiss:7302', kind: 'drama', title: 'Mashle', source: 'KissKH', poster: 'https://img.test/m.jpg' }])
    assert.equal(result.hasMore, false)
    assert.equal(result.partial, false)
})

test('maps KissKH detail to series and sorted episodes', async () => {
    const fetchImpl = async url => {
        assert.match(String(url), /\/DramaList\/Drama\/7302\?isq=true$/)
        return response({
            id: 7302, title: 'Mashle', thumbnail: 'https://img.test/m.jpg', description: 'Muscles.',
            country: 'Japan', status: 'Completed', releaseDate: '2023-04-07T00:00:00', episodesCount: 13,
            episodes: [{ id: 129348, number: 12, sub: 0 }, { id: 129337, number: 1, sub: 0 }],
        })
    }
    const s = await kisskh.series(ctx(fetchImpl), 'kiss:7302')
    assert.equal(s.country, 'Japan')
    assert.equal(s.year, '2023')
    assert.equal(s.status, 'Completed')
    assert.equal(s.episodeCount, 13)
    const eps = await kisskh.episodes(ctx(fetchImpl), 'kiss:7302')
    assert.deepEqual(eps.map(episode => episode.number), [1, 12])
    assert.deepEqual(eps[0], { id: '129337', number: 1, title: 'Episode 1', description: null, image: null, airDate: null })
})

test('resolves Type-1 episodes to direct HLS', async () => {
    const fetchImpl = async url => {
        assert.match(String(url), /\/DramaList\/Episode\/129348\.png\?err=false&ts=&time=&kkey=/)
        return response({ Video: 'https://hls10.cdnvideo11.shop/hls10/x/ep.12.m3u8', Type: 1, ThirdParty: 'https://awish.pro/e/x', dataSaver: null })
    }
    const result = await kisskh.playback(ctx(fetchImpl), 'kiss:7302', 'sub', '129348')
    assert.deepEqual(result.sources, [{ kind: 'direct', url: 'https://hls10.cdnvideo11.shop/hls10/x/ep.12.m3u8', type: 'application/vnd.apple.mpegurl' }])
    assert.equal(result.providerLabel, 'KissKH')
})

test('fails closed on Type-2 third-party embeds', async () => {
    const fetchImpl = async () => response({ Video: 'https://awish.pro/e/fzypihecnc1t', Type: 2, ThirdParty: 'https://awish.pro/e/fzypihecnc1t' })
    await assert.rejects(kisskh.playback(ctx(fetchImpl), 'kiss:7302', 'sub', '129348'), error => error?.code === 'stream_unavailable')
})

test('rejects non-numeric KissKH keys and episode ids', async () => {
    await assert.rejects(kisskh.series(ctx(() => { throw new Error('must not fetch') }), 'kiss:not-a-number'), error => error?.code === 'invalid_request')
    await assert.rejects(kisskh.playback(ctx(() => { throw new Error('must not fetch') }), 'kiss:7302', 'sub', 'nope'), error => error?.code === 'invalid_request')
})

test('reports KissKH discover failures as partial with a provider error', async () => {
    const fetchImpl = async () => { throw Object.assign(new Error('KissKH blocked this server'), { code: 'provider_blocked' }) }
    const result = await kisskh.discover(ctx(fetchImpl))
    assert.equal(result.partial, true)
    assert.equal(result.error?.provider, 'kiss')
    assert.equal(result.error?.code, 'provider_blocked')
})
