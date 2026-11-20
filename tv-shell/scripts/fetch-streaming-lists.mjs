#!/usr/bin/env node
/**
 * Downloads, from TMDB, the titles each streaming service carries in one region
 * and writes them as `<outDir>/assets/streaming/streaming.json` (arrays of TMDB
 * ids), which the app matches against the provider's library.
 *
 *   TMDB_API_KEY=... node fetch-streaming-lists.mjs <web-output-dir> [region]
 *
 * Never fails the build: without a key, or when TMDB cannot be reached, it
 * writes an empty list and the app simply shows no Streaming categories.
 * Test hook: TMDB_BASE overrides the API address.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2];
const regions = (process.argv[3] || process.env.TMDB_REGION || 'CA').toUpperCase().split(',').map((r) => r.trim()).filter(Boolean);
const region = regions.join('+');
const key = process.env.TMDB_API_KEY;
const base = process.env.TMDB_BASE || 'https://api.themoviedb.org/3';
if (!outDir) {
    console.error('usage: fetch-streaming-lists.mjs <web-output-dir> [region]');
    process.exit(2);
}

// TMDB watch-provider ids; names are checked against TMDB's list for the region.
const SERVICES = [
    { name: 'Netflix', match: [/^netflix$/i] },
    { name: 'Disney+', match: [/^disney\s*(plus|\+)$/i] },
    { name: 'Prime Video', match: [/^amazon prime video$/i] },
    { name: 'Apple TV+', match: [/^apple tv(\s*(plus|\+))?$/i] },
    { name: 'Max / Crave (HBO)', match: [/^(hbo )?max$/i, /^crave$/i] },
    { name: 'Paramount+', match: [/^paramount\s*(plus|\+)$/i] },
    { name: 'Hulu', match: [/^hulu$/i] },
    { name: 'Peacock', match: [/^peacock(\s*premium)?$/i] },
];
const MAX_PAGES = 500; // TMDB serves at most 500 pages per query
const CONCURRENCY = 6;

// Each title is stored as one number: tmdbId * 2^21 + a mask of the app's genres. The bit order
// matches GENRES in the app (streaming-groups.ts): 0 Action, 1 Adventure, 2 Animation, 3 Anime,
// 4 Comedy, 5 Crime, 6 Documentary, 7 Drama, 8 Family, 9 Fantasy, 10 History, 11 Horror,
// 12 Music, 13 Mystery, 14 Romance, 15 Sci-Fi, 16 Thriller, 17 War, 18 Western,
// 19 Reality & Talk, 20 Kids.
const MASK_SPAN = 2 ** 21;
const GENRE_BITS = {
    28: [0], 12: [1], 10759: [0, 1], 35: [4], 80: [5], 99: [6], 18: [7], 10751: [8], 14: [9],
    10765: [9, 15], 36: [10], 27: [11], 10402: [12], 9648: [13], 10749: [14], 878: [15],
    53: [16], 10752: [17], 10768: [17, 0], 37: [18], 10764: [19], 10763: [19], 10767: [19],
};

/** The app's genre mask for one TMDB result (genre ids and original language). */
function genreMask(result) {
    const ids = result.genre_ids || [];
    let mask = 0;
    for (const id of ids) for (const bit of GENRE_BITS[id] || []) mask |= 1 << bit;
    if (ids.includes(16)) mask |= result.original_language === 'ja' ? 1 << 3 : 1 << 2;
    // Kids: TMDB's own Kids genre, or animated family titles that are not horror or crime.
    if (ids.includes(10762) || (ids.includes(16) && ids.includes(10751) && !ids.includes(27) && !ids.includes(80))) {
        mask |= 1 << 20;
    }
    return mask;
}

function write(services, note) {
    const dir = join(outDir, 'assets', 'streaming');
    mkdirSync(dir, { recursive: true });
    const file = { format: 2, region, generatedAt: new Date().toISOString(), services };
    writeFileSync(join(dir, 'streaming.json'), JSON.stringify(file));
    console.log(`streaming.json: ${services.map((s) => `${s.name} ${s.movie.length}/${s.tv.length}`).join(', ') || 'empty'}${note ? ' (' + note + ')' : ''}`);
}

async function api(path, params, attempt = 0) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries({ api_key: key, ...params })) url.searchParams.set(k, String(v));
    try {
        const res = await fetch(url);
        if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
    } catch (err) {
        if (attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        return api(path, params, attempt + 1);
    }
}

/** Runs `tasks` (functions returning promises) with a fixed number in flight. */
async function pool(tasks) {
    const results = [];
    let next = 0;
    await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
            while (next < tasks.length) {
                const i = next++;
                results[i] = await tasks[i]();
            }
        })
    );
    return results;
}

/** Every id of one query; a range that hits the 500-page cap is split in two by year. */
async function collect(kind, providerId, regionCode, from, to, ids) {
    const dateField = kind === 'movie' ? 'primary_release_date' : 'first_air_date';
    const params = (page) => ({
        with_watch_providers: providerId,
        watch_region: regionCode,
        with_watch_monetization_types: 'flatrate',
        'vote_count.gte': 0,
        sort_by: kind === 'movie' ? 'primary_release_date.asc' : 'first_air_date.asc',
        [`${dateField}.gte`]: `${from}-01-01`,
        [`${dateField}.lte`]: `${to}-12-31`,
        page,
    });
    const first = await api(`/discover/${kind}`, params(1));
    if (first.total_pages >= MAX_PAGES && from < to) {
        const mid = Math.floor((from + to) / 2);
        await collect(kind, providerId, regionCode, from, mid, ids);
        await collect(kind, providerId, regionCode, mid + 1, to, ids);
        return;
    }
    for (const r of first.results || []) ids.set(r.id, (ids.get(r.id) || 0) | genreMask(r));
    const pages = Math.min(first.total_pages || 1, MAX_PAGES);
    const tasks = [];
    for (let page = 2; page <= pages; page++) {
        tasks.push(async () => {
            const data = await api(`/discover/${kind}`, params(page));
            for (const r of data.results || []) ids.set(r.id, (ids.get(r.id) || 0) | genreMask(r));
        });
    }
    await pool(tasks);
}

async function main() {
    if (!key) {
        write([], 'no TMDB_API_KEY');
        return;
    }
    const namesByRegion = new Map();
    for (const code of regions) {
        const names = new Map();
        for (const kind of ['movie', 'tv']) {
            const list = await api(`/watch/providers/${kind}`, { watch_region: code });
            for (const p of list.results || []) names.set(p.provider_id, p.provider_name);
        }
        namesByRegion.set(code, names);
    }
    const thisYear = new Date().getFullYear() + 1;
    const out = [];
    for (const service of SERVICES) {
        const movie = new Map();
        const tv = new Map();
        // TMDB's ids differ by region (Prime Video is 9 in the US and 119 in Canada): find the
        // service by its name in each region's list and gather the titles of every region.
        for (const code of regions) {
            const ids = [...namesByRegion.get(code)].filter(([, name]) => service.match.some((re) => re.test(name))).map(([id]) => id);
            for (const providerId of ids) {
                console.log(`${service.name} in ${code}: TMDB provider ${providerId} ("${namesByRegion.get(code).get(providerId)}")`);
                await collect('movie', providerId, code, 1900, thisYear, movie);
                await collect('tv', providerId, code, 1900, thisYear, tv);
            }
        }
        if (!movie.size && !tv.size) {
            console.log(`skip ${service.name}: not offered in ${region}`);
            continue;
        }
        const codes = (map) => [...map].map(([id, mask]) => id * MASK_SPAN + mask).sort((a, b) => a - b);
        out.push({ name: service.name, movie: codes(movie), tv: codes(tv) });
        console.log(`${service.name}: ${movie.size} movies, ${tv.size} series`);
    }
    write(out);
}

main().catch((err) => {
    console.error('could not download the streaming lists:', err.message);
    write([], 'download failed');
});
