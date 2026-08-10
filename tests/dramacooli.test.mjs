import test from 'node:test'
import assert from 'node:assert/strict'
import { discover, episodes, playback, series } from '../adapter/providers/dramacooli.mjs'
import { cached } from '../adapter/anime-adapter.mjs'

const request = () => new Request('https://vellum.test/')
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const ctx = fetchImpl => ({ env: {}, fetchImpl, request: request(), cached })

test('normalizes DramaCooli categories into dc: rows', async () => {
    const fetchImpl = async url => {
        assert.equal(url, 'https://dramacooli.ws/wp-json/wp/v2/categories?orderby=count&per_page=100&page=1&hide_empty=true')
        return response([{ id: 7, name: 'Korean Drama' }, { id: 12, name: 'Chinese Drama' }])
    }
    const result = await discover(ctx(fetchImpl))
    assert.deepEqual(result.rows, [
        { key: 'dc:7', kind: 'drama', title: 'Korean Drama', source: 'DramaCooli', poster: null },
        { key: 'dc:12', kind: 'drama', title: 'Chinese Drama', source: 'DramaCooli', poster: null },
    ])
    assert.equal(result.hasMore, false)
    assert.equal(result.partial, false)
    assert.equal(result.error, null)
})

test('orders DramaCooli episodes from -episode-N slugs', async () => {
    const posts = [1, 2, 3, 10, 11].map(n => ({
        slug: `doctor-slump-episode-${n}`,
        title: { rendered: `Doctor Slump Ep ${n}` },
        excerpt: { rendered: '' },
        _embedded: {},
    }))
    const fetchImpl = async url => {
        const page = Number(new URL(url).searchParams.get('page'))
        assert.equal(new URL(url).searchParams.get('categories'), '7')
        return response(page === 1 ? posts : [])
    }
    const result = await episodes(ctx(fetchImpl), 'dc:7')
    assert.deepEqual(result.map(item => item.id), ['doctor-slump-episode-1', 'doctor-slump-episode-2', 'doctor-slump-episode-3', 'doctor-slump-episode-10', 'doctor-slump-episode-11'])
    assert.deepEqual(result.map(item => item.number), [1, 2, 3, 10, 11])
    assert.equal(result[0].title, 'Doctor Slump Ep 1')
})

test('derives DramaCooli series metadata from the category and first post', async () => {
    const fetchImpl = async url => {
        if (url === 'https://dramacooli.ws/wp-json/wp/v2/categories/7') return response({ id: 7, name: 'Doctor Slump' })
        assert.match(url, /wp\/v2\/posts\?categories=7/)
        return response([{
            slug: 'doctor-slump-episode-1',
            title: { rendered: 'Doctor Slump Ep 1' },
            excerpt: { rendered: '<p>Surgeons &amp; love.</p>' },
            _embedded: { 'wp:featuredmedia': [{ source_url: 'https://img.test/ds.jpg' }] },
        }])
    }
    const result = await series(ctx(fetchImpl), 'dc:7')
    assert.equal(result.key, 'dc:7')
    assert.equal(result.kind, 'drama')
    assert.equal(result.title, 'Doctor Slump')
    assert.equal(result.source, 'DramaCooli')
    assert.equal(result.poster, 'https://img.test/ds.jpg')
    assert.equal(result.synopsis, 'Surgeons & love.')
})

test('resolves DramaCooli playback to an https embed from the first iframe', async () => {
    const fetchImpl = async url => {
        assert.match(url, /wp\/v2\/posts\?slug=doctor-slump-episode-3/)
        return response([{
            slug: 'doctor-slump-episode-3',
            content: { rendered: '<p>watch</p><iframe width="640" src="https://player.test/embed/abc?q=1" allowfullscreen></iframe><iframe src="https://ignored.test/"></iframe>' },
        }])
    }
    const result = await playback(ctx(fetchImpl), 'dc:7', 'sub', 'doctor-slump-episode-3')
    assert.deepEqual(result.sources, [{ kind: 'embed', url: 'https://player.test/embed/abc?q=1' }])
    assert.equal(result.providerLabel, 'DramaCooli')
})

test('rejects non-https iframe embeds at the DramaCooli boundary', async () => {
    const fetchImpl = async () => response([{ slug: 'x-episode-1', content: { rendered: '<iframe src="http://player.test/embed/abc"></iframe>' } }])
    await assert.rejects(playback(ctx(fetchImpl), 'dc:7', 'sub', 'x-episode-1'), error => error?.code === 'stream_unavailable')
})
