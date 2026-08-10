/*
Client-side AniList access for the anime browse/search. AniList's public GraphQL API is
CORS-open (access-control-allow-origin: *), so nothing about it needs the pumg.fyi proxy.
Episodes and playback still go through the proxy (anidb.app is Cloudflare-gated and the
media comes from the slipgate pipeline). Miruro.tv is itself an AniList client.

Query semantics mirror the adapter: search is unfiltered (unreleased titles show when looked
up), the no-query feed excludes NOT_YET_RELEASED; format is filtered client-side because
AniList returns empty when search is combined with an explicit null format.
*/

const ANILIST = 'https://graphql.anilist.co'
// identical to the adapter's field set so client rows match the server contract
const MEDIA_FIELDS = `id title { romaji english native userPreferred } synonyms description status format season seasonYear episodes duration genres studios(isMain: true) { nodes { name } } coverImage { extraLarge large } bannerImage`
const PAGE_QUERY = `query($page:Int,$perPage:Int,$search:String){Page(page:$page,perPage:$perPage){pageInfo{hasNextPage} media(type:ANIME,search:$search,sort:[TRENDING_DESC,POPULARITY_DESC]){${MEDIA_FIELDS}}}}`
const FEED_QUERY = `query($page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){pageInfo{hasNextPage} media(type:ANIME,status_not:NOT_YET_RELEASED,sort:[TRENDING_DESC,POPULARITY_DESC]){${MEDIA_FIELDS}}}}`

const str = value => typeof value === 'string' ? value : null
const num = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
const cleanDescription = value => str(value)?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || null

export const anilistAnimeRow = value => {
    const id = value?.id == null ? null : String(value.id)
    const title = value?.title?.english || value?.title?.userPreferred || value?.title?.romaji || value?.title?.native
    if (!id || !title) return null
    return {
        key: `miruro:${id}`,
        kind: 'anime',
        title,
        alternateTitles: [...new Set([value?.title?.romaji, value?.title?.english, value?.title?.native, ...(Array.isArray(value?.synonyms) ? value.synonyms : [])].filter(Boolean))],
        cover: str(value?.coverImage?.extraLarge) || str(value?.coverImage?.large),
        banner: str(value?.bannerImage),
        synopsis: cleanDescription(value?.description),
        status: str(value?.status)?.toLowerCase() || null,
        format: str(value?.format)?.toLowerCase() || null,
        season: str(value?.season)?.toLowerCase() || null,
        year: num(value?.seasonYear),
        totalEpisodes: num(value?.episodes),
        duration: num(value?.duration),
        genres: Array.isArray(value?.genres) ? value.genres.filter(str) : [],
        studios: Array.isArray(value?.studios?.nodes) ? value.studios.nodes.map(node => str(node?.name)).filter(Boolean) : [],
        source: 'Miruro',
        provider: 'vellum',
    }
}

async function graphql(query, variables, signal) {
    // bounded timeout, caller abort preserved (manual controller for old-webview compat)
    const ctrl = new AbortController()
    const onAbort = () => ctrl.abort()
    if (signal?.aborted) ctrl.abort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => ctrl.abort(), 15_000)
    try {
        const response = await fetch(ANILIST, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query, variables }),
            signal: ctrl.signal,
        })
        if (!response.ok) {
            const error = new Error(`AniList ${response.status}`)
            error.status = response.status
            throw error
        }
        const data = await response.json()
        // GraphQL errors arrive as 200 + {errors} (e.g. rate limiting); never treat them as an empty feed
        if (!data || Array.isArray(data?.errors) || !data?.data) {
            const error = new Error(data?.errors?.[0]?.message || 'AniList returned no data')
            error.status = Number(data?.errors?.[0]?.status) || 502
            throw error
        }
        return data
    } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
    }
}

export async function anilistDiscover({ q = '', page = 1, limit = 30, signal } = {}) {
    const search = String(q).trim() || null
    const data = await graphql(search ? PAGE_QUERY : FEED_QUERY, search ? { page, perPage: limit, search } : { page, perPage: limit }, signal)
    const pageData = data?.data?.Page
    if (!pageData || !Array.isArray(pageData.media)) throw new Error('AniList returned an unexpected payload')
    const rows = pageData.media.map(anilistAnimeRow).filter(Boolean)
    return { rows, hasMore: Boolean(pageData.pageInfo?.hasNextPage) }
}
