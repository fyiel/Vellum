import test from 'node:test'
import assert from 'node:assert/strict'
import { discover, episodes, playback, series } from '../adapter/providers/dramacooli.mjs'
import { cached } from '../adapter/anime-adapter.mjs'

const ORIGIN = 'https://dramacoolt.top'
const request = () => new Request('https://vellum.test/')
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const htmlPage = value => new Response(value, { headers: { 'content-type': 'text/html' } })
// the provider resolves the live DramaCool host before its first query and probes the entry with a
// manual-redirect request; dramacoolt.top answers 200 with the theme's own markup, so the fixtures
// answer that one lookup the same way
const CATALOGUE = '<!doctype html><html><head><title>DramaCool</title></head><body><div class="bsx"><a href="https://dramacoolt.top/">Latest</a></div></body></html>'
const live = handler => async (url, init) => {
    if (init?.redirect !== 'manual') return handler(url, init)
    assert.equal(url, ORIGIN)
    return htmlPage(CATALOGUE)
}
const ctx = fetchImpl => ({ env: {}, fetchImpl, request: request(), cached })
const liveCtx = handler => ctx(live(handler))
// an episode page always references its own host; the player frame is the only iframe the live
// theme serves, and the REST content field is empty, so playback has nothing else to read
const episodePage = frames => htmlPage(`<!doctype html><html><head><title>Family Register (2026)</title></head><body>${frames}<a href="${ORIGIN}/">DramaCool</a></body></html>`)

test('normalizes DramaCooli categories into dc: rows', async () => {
    const fetchImpl = async url => {
        assert.equal(url, 'https://dramacoolt.top/wp-json/wp/v2/categories?orderby=count&order=desc&hide_empty=true&per_page=100&page=1&_fields=id,slug,name,description,count')
        return response([
            { id: 697, count: 53, description: '', name: 'Family Register (2026)', slug: 'family-register-2026' },
            { id: 422, count: 41, description: '', name: 'Someone Someday (2026)', slug: 'someone-someday-2026' },
            { id: 257, count: 33, description: '', name: 'Our Happy Days (2026)', slug: 'our-happy-days-2026' },
        ])
    }
    const result = await discover(liveCtx(fetchImpl))
    assert.deepEqual(result.rows, [
        { key: 'dc:family-register-2026', kind: 'drama', title: 'Family Register (2026)', source: 'DramaCooli', poster: null },
        { key: 'dc:someone-someday-2026', kind: 'drama', title: 'Someone Someday (2026)', source: 'DramaCooli', poster: null },
        { key: 'dc:our-happy-days-2026', kind: 'drama', title: 'Our Happy Days (2026)', source: 'DramaCooli', poster: null },
    ])
    assert.equal(result.hasMore, false)
    assert.equal(result.partial, false)
    assert.equal(result.error, null)
})

test('orders DramaCooli episodes from -episode-N slugs', async () => {
    const posts = [11, 10, 3, 2, 1].map(n => ({
        id: 2730 + n,
        slug: `family-register-2026-episode-${n}`,
        link: `https://dramacoolt.top/family-register-2026-episode-${n}/`,
        title: { rendered: `Family Register (2026) Episode ${n}` },
        excerpt: { rendered: '' },
    }))
    const fetchImpl = async url => {
        const parsed = new URL(url)
        if (parsed.pathname.endsWith('/categories')) {
            assert.equal(parsed.searchParams.get('slug'), 'family-register-2026')
            return response([{ id: 697, count: 53, description: '', name: 'Family Register (2026)', slug: 'family-register-2026' }])
        }
        assert.equal(parsed.searchParams.get('categories'), '697')
        assert.equal(parsed.searchParams.get('page'), '1')
        return response(posts)
    }
    const result = await episodes(liveCtx(fetchImpl), 'dc:family-register-2026')
    assert.deepEqual(result.map(item => item.id), ['family-register-2026-episode-1', 'family-register-2026-episode-2', 'family-register-2026-episode-3', 'family-register-2026-episode-10', 'family-register-2026-episode-11'])
    assert.deepEqual(result.map(item => item.number), [1, 2, 3, 10, 11])
    assert.equal(result[0].title, 'Family Register (2026) Episode 1')
})

test('derives DramaCooli series metadata from the category and first post', async () => {
    const fetchImpl = async url => {
        const parsed = new URL(url)
        if (parsed.pathname.endsWith('/categories')) {
            assert.equal(parsed.searchParams.get('slug'), 'family-register-2026')
            return response([{ id: 697, count: 53, description: '', name: 'Family Register (2026)', slug: 'family-register-2026' }])
        }
        assert.equal(parsed.searchParams.get('categories'), '697')
        // the poster only ever comes from the newest episode, so the seo block is asked for on page 1
        assert.equal(parsed.searchParams.get('_fields'), 'id,slug,link,title,excerpt,yoast_head_json')
        return response([{
            id: 2748,
            slug: 'family-register-2026-episode-54',
            link: 'https://dramacoolt.top/family-register-2026-episode-54/',
            title: { rendered: 'Family Register (2026) Episode 54' },
            excerpt: { rendered: '<p>Surgeons &amp; love.</p>' },
            yoast_head_json: { og_image: [{ width: 900, height: 1343, url: 'https://dramacoolt.top/wp-content/uploads/2026/09/Family-Register-2026.jpg', type: 'image/jpeg' }] },
        }])
    }
    const result = await series(liveCtx(fetchImpl), 'dc:family-register-2026')
    assert.equal(result.key, 'dc:family-register-2026')
    assert.equal(result.kind, 'drama')
    assert.equal(result.title, 'Family Register (2026)')
    assert.equal(result.source, 'DramaCooli')
    assert.equal(result.poster, 'https://dramacoolt.top/wp-content/uploads/2026/09/Family-Register-2026.jpg')
    assert.equal(result.synopsis, 'Surgeons & love.')
})

test('resolves DramaCooli playback to an https embed from the first iframe', async () => {
    const fetchImpl = async url => {
        assert.equal(url, 'https://dramacoolt.top/family-register-2026-episode-3/')
        return episodePage('<p>watch</p><iframe width="640" src="https://embedload.cfd/watch?v=57342" allowfullscreen></iframe><iframe src="https://ignored.test/"></iframe>')
    }
    const result = await playback(liveCtx(fetchImpl), 'dc:family-register-2026', 'sub', 'family-register-2026-episode-3')
    assert.deepEqual(result.sources, [{ kind: 'embed', url: 'https://embedload.cfd/watch?v=57342' }])
    assert.equal(result.providerLabel, 'DramaCooli')
})

test('rejects non-https iframe embeds at the DramaCooli boundary', async () => {
    const fetchImpl = async url => {
        assert.equal(url, 'https://dramacoolt.top/family-register-2026-episode-3/')
        return episodePage('<iframe src="http://embedload.cfd/watch?v=57342"></iframe>')
    }
    await assert.rejects(playback(liveCtx(fetchImpl), 'dc:family-register-2026', 'sub', 'family-register-2026-episode-3'), error => error?.code === 'stream_unavailable')
})

test('rejects embeds pointing back at the app origin', async () => {
    // the app asking for the stream can itself be served from a supported player host, so an embed
    // pointing back at the app has to be rejected even though the host is otherwise allowed
    const fetchImpl = async url => {
        assert.equal(url, 'https://dramacoolt.top/family-register-2026-episode-3/')
        return episodePage('<iframe src="https://embedload.cfd/watch?v=57342"></iframe>')
    }
    const req = new Request('https://api.vellum.test/', { headers: { origin: 'https://embedload.cfd' } })
    await assert.rejects(playback({ ...liveCtx(fetchImpl), request: req }, 'dc:family-register-2026', 'sub', 'family-register-2026-episode-3'), error => error?.code === 'stream_unavailable')
})
